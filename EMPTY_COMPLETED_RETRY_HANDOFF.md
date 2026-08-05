# 空 Completed 响应自动重试与 WebUI 状态修复交接

## 背景

部分中转 Provider 在工具执行完成后的下一轮模型请求中，会返回：

```json
{
  "role": "assistant",
  "content": [],
  "usage": {
    "input": 0,
    "output": 0,
    "totalTokens": 0
  },
  "stopReason": "stop",
  "rawStopReason": "completed"
}
```

Pi 会把它视为正常结束，因此不会触发已有自动重试。用户只能手动发送“继续”开启新 turn。

参考会话：

`C:\Users\lichong\.pi\agent\sessions\--D--workspace-aiwork-pi-agnet-web--\2026-08-05T08-53-28-159Z_019fd120-afdf-7424-93a9-79d9987d94f1.jsonl`

## 本次目标

1. 增加空 `completed` 响应的 Provider 定向规范化。
2. WebUI 改用 `agent_settled` 判断 Agent 最终结束。
3. 展示错误原因、自动重试次数及最终失败状态。

## 1. Provider 定向规范化

### 检测条件

仅对明确配置的问题 Provider/模型启用。建议同时满足以下条件：

- Assistant `stopReason === "stop"`；
- `rawStopReason === "completed"`；
- `content` 为空，或没有有效文本、思考和工具调用；
- usage 为 0 或明显异常；
- 当前请求发生在工具结果之后，Agent 按正常流程仍应继续；
- 未发生用户主动停止。

命中后，将消息规范化为可重试错误，例如：

```ts
{
  ...message,
  stopReason: "error",
  errorMessage: "Provider returned an empty completed response after tool results"
}
```

错误文本必须能被现有 `isRetryableAssistantError()` 识别，或者同步增加明确的可重试错误分类。

### 推荐接入位置

优先通过 Pi 扩展的 `message_end` 消息替换能力完成，避免直接修改 `node_modules`。若必须放到项目代码，应集中封装为 Provider 响应规范化模块，不要在 React 组件或 SSE 层判断。

相关代码：

- `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`
- `node_modules/@earendil-works/pi-ai/dist/utils/retry.js`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
- `lib/rpc-manager.ts`

### 安全限制

- 仅 Provider/模型白名单生效；
- 最多沿用现有 3 次重试和指数退避；
- 400、401、403、配额耗尽、内容过滤及用户中止不得重试；
- 连续空响应达到上限后停止并展示错误；
- 不通过自动发送“继续”实现，以免产生额外用户消息或重复副作用。

## 2. WebUI 使用 `agent_settled` 判断最终结束

Pi 的 `agent_end` 可能只是一次底层执行结束，之后仍可能进行自动重试或上下文压缩恢复；`agent_settled` 才表示整个 prompt 生命周期最终完成。

修改 `hooks/useAgentSession.ts`：

- 收到 `agent_end` 时读取 `event.willRetry`；
- `willRetry === true` 时保持 `agentRunning`，不要清除阶段和重试信息；
- 新增 `agent_settled` 处理，在此事件中清除最终运行状态；
- 保留 `prompt_settled` 作为未产生 Agent 生命周期的 slash command 等场景兜底；
- 重试退避期间仍应允许 SSE 自动重连；
- 防止 `agent_end → auto_retry_start → agent_start` 期间输入框错误恢复可发送状态。

相关代码：

- `hooks/useAgentSession.ts:958-970`
- `hooks/useAgentSession.ts:1136`
- `lib/rpc-manager.ts:286-310`

## 3. 展示错误、重试和最终失败状态

### 重试中

处理已有事件：

- `auto_retry_start`：展示当前次数、最大次数和错误原因；
- `auto_retry_end`：成功时清理提示；失败时保留最终错误；
- `agent_end.willRetry`：不得显示为任务已完成。

示例：

> 中转服务返回空完成响应，正在进行第 1/3 次重试……

### 最终失败

在重试耗尽或 `prompt_error` 时展示持久错误卡片：

- Provider 和模型；
- 简化后的错误原因；
- 已重试次数；
- “重试”或“继续”操作入口；
- 技术详情可折叠查看。

不要仅执行 `console.error`。当前 `prompt_error` 只写控制台，Assistant 的 `errorMessage` 也未在消息视图中展示。

相关代码：

- `hooks/useAgentSession.ts`
- `components/MessageView.tsx`
- `components/ChatWindow.tsx`
- 相关 i18n 文案文件

## 验收标准

1. 工具结果后的空 `completed` 响应会触发自动重试，无需用户发送“继续”。
2. 仅目标 Provider/模型命中该规则，其他 Provider 行为保持不变。
3. 重试退避期间 WebUI 始终保持运行状态。
4. `agent_settled` 后才将会话标记为最终结束。
5. 页面能看到错误原因和 `当前次数/最大次数`。
6. 重试耗尽后显示明确的最终失败状态，不再静默停止。
7. 超时、429、5xx 继续重试；400、401、403 和配额错误不重试。

## 建议测试

- 工具调用 → 工具结果 → 空 `completed` → 自动重试成功；
- 连续空 `completed` 达到上限 → 最终失败提示；
- 正常非空 `completed` 不重试；
- 非白名单 Provider 的空响应不被误判；
- `agent_end.willRetry === true` 时 UI 仍为 running；
- `agent_settled` 后 UI 结束；
- `prompt_error` 和 Assistant `errorMessage` 可见；
- SSE 在重试退避期间断开后能够恢复。

最低验证命令：

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:agent-stream
```

## 注意事项

不要直接修改安装目录下的 SDK 文件；优先使用扩展钩子或项目内适配层。实现前确认目标 Provider/模型白名单配置方式，并避免记录 API Key、完整请求正文等敏感信息。
