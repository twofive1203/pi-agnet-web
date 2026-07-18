# Extension Web UI P0 — widgets + dialogs

## Goal

让 Pi 扩展在蜗牛派 Web UI 中可用的基础交互不再降级为 `console` / `window.alert`：

1. `setStatus` / `setWidget` 在会话聊天区可见
2. `confirm` / `select` / `input` / `editor` / `notify` 使用正经 Web 对话框与 toast

## Background

- `lib/extension-web-ui.ts` 已把扩展 UI 请求经 SSE 发到浏览器。
- `hooks/useAgentSession.ts` 对 dialog 使用 `window.confirm/prompt/alert`；`setStatus`/`setWidget` 仅 `console.info`。
- `lib/types.ts` 已定义 `ExtensionStatusItem` / `ExtensionWidgetItem` / `ExtensionUiRequest` 契约。
- Pi SDK `select` 的 options 仍是 `string[]`（无独立 description 字段）；UI 需支持长选项换行展示，便于 title+description 拼在同一字符串时可读。

## Confirmed Decisions

1. **Scope = P0 only**：不做扩展资源面板、不做 `settings-extensions.json` 设置页。
2. **Widget/status 挂在当前会话聊天区**（ChatWindow 输入区上下），不进全局 AppShell 顶栏，避免与 Usage/Grok/Subagent 顶栏抢位。
3. **notify 非阻塞 toast**；dialog 类阻塞式 modal（与 bridge pending promise 对齐）。
4. **不扩展 Pi SDK select 协议**；在现有 `string[]` 上做更好的列表 UI。

## Requirements

### Status + Widget surface

- 处理 SSE `extension_ui_request`：
  - `setStatus`: upsert by `statusKey`；`statusText` 为空/undefined 时移除
  - `setWidget`: upsert by `widgetKey`；`widgetLines` undefined 时移除；尊重 `widgetPlacement`（`aboveEditor` | `belowEditor`，默认 above）
- 会话切换 / 新会话时清空 status 与 widget 状态。
- 多 key 并存；widget 多行纯文本渲染（等宽可选）；status 以 compact chip/row 展示。
- 空状态不占布局。

### Dialog + notify surface

- `notify` → 非阻塞 toast（info/warning/error 样式），自动消失，可手动关闭。
- `confirm` → modal：title、message、确认/取消；Esc/取消 → `confirmed:false` 或 cancelled 语义与现 bridge 一致。
- `select` → modal：可点击选项列表，支持长文本换行；取消/Esc → cancelled。
- `input` → modal：单行输入 + 确认/取消。
- `editor` → modal：多行 textarea + 确认/取消；prefill 预填。
- 响应继续走现有 `extension_ui_response` RPC。
- 同时只展示一个 dialog（服务端 bridge 本就 per-request pending）。
- 若 request 带 `timeout`，超时后关闭并 cancelled（与 bridge 超时双保险；以用户未操作为准）。

### Non-goals

- 资源面板、packages 设置页
- `custom` TUI 组件、powerbar segment 协议扩展
- 修改 Pi SDK 或扩展包本身

## Acceptance Criteria

- [x] 扩展调用 `setStatus` 后聊天输入区附近出现对应 chip；清空 text 后消失
- [x] 扩展调用 `setWidget` 后在 above/below editor 显示多行内容；清除后消失
- [x] 切换会话后旧 status/widget 不残留
- [x] confirm/select/input/editor 不再使用 `window.prompt/confirm`；使用应用内 modal
- [x] notify 不再使用 `window.alert`；使用 toast
- [x] select 长选项可读（换行），取消不会卡死 agent（发送 cancelled）
- [x] `npm run lint` 与 `tsc --noEmit` 通过
- [x] 更新 `docs/modules/frontend.md`（及如有必要 `docs/architecture/overview.md`）说明扩展 UI 行为

## Notes

- 可与仍 in_progress 的 grok-usage-panel 任务并行于不同文件；实现时避免无关注改。
