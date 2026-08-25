---
title: "fix: Restore complete session transcripts after compaction"
type: fix
status: completed
date: 2026-08-24
---

# fix: Restore complete session transcripts after compaction

## 交接目标

修复 WebUI 在会话发生上下文压缩后，重新打开会话只能看到“压缩摘要 + 保留消息 + 压缩后消息”的问题。实现时必须把两个概念彻底分开：

- **模型上下文（model context）**：继续遵循 Pi 的压缩语义，只给模型发送摘要和近期保留消息。
- **用户会话记录（display transcript）**：沿当前分支展示完整原始历史，并通过分页/懒加载控制浏览器负载。

本计划是新会话实施的权威交接文档。当前会话只完成诊断和方案设计，没有修改功能代码。

---

## 已确认根因

1. Pi 的压缩是追加式的：原始消息仍保存在 session JSONL 中，压缩只追加 `compaction` entry。
2. `@earendil-works/pi-coding-agent` 的 `buildSessionContext()` 明确用于生成 LLM/runtime context。其 `buildContextEntries()` 只保留最新压缩摘要、`firstKeptEntryId` 起的近期 entry 和压缩后的 entry，主动省略更早的原始消息。
3. `lib/session-reader.ts` 当前在 WebUI 会话展示链路中调用 Pi 的 `buildSessionContext()`，把模型上下文误当成了用户 transcript。
4. `app/api/sessions/[id]/route.ts` 和 `app/api/sessions/[id]/context/route.ts` 返回该压缩后 context；`hooks/useAgentSession.ts` 随后直接用 `d.context.messages` 覆盖页面消息。
5. 初次打开会话仍会执行 `scrollToBottom("instant")`；不存在“滚动到压缩点”的逻辑。压缩摘要成为最早可见记录，是因为服务端根本没有返回更早消息。

关键代码：

- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`：`buildContextEntries()` / `buildSessionContext()`，SDK 注释明确说明它是 LLM context。
- `lib/session-reader.ts`：WebUI `buildSessionContext()` 包装器及 compaction-aware `entryIds` 映射。
- `app/api/sessions/[id]/route.ts`：详情 GET 使用上述 context。
- `app/api/sessions/[id]/context/route.ts`：分支切换使用上述 context。
- `hooks/useAgentSession.ts`：`loadSession()` / `loadContext()` 直接设置 `context.messages`。

本地真实数据验证（只统计元数据，没有读取或输出消息内容）：

- 会话 `01a01de9-b13b-7114-9493-a127fb790509`
- 当前分支原始 message entry：354
- Pi/WebUI context message：89
- 仍在 JSONL 中但被展示链路省略的原始 message：266

代码历史也表明该行为从项目早期实现时就存在，不是近期 Sidebar 分页、分支树压缩或 Pi 0.84.1 升级引入的回归。

---

## 需求与完成标准

- **R1 完整历史**：压缩后重新打开会话，用户仍可逐页查看当前分支压缩前后的全部原始消息。
- **R2 模型语义不变**：AgentSession 继续使用 Pi 的 compaction-aware context，不把完整历史重新发送给模型。
- **R3 有界首屏**：首次加载只返回最近一页 transcript，不一次性把大型 JSONL 的全部消息发送并渲染到浏览器。
- **R4 稳定分页**：可重复加载更早记录，无重复、无缺口；切换 leaf 后游标和旧页必须隔离。
- **R5 entryId 对齐**：每条展示消息与 `entryIds[]` 严格平行，历史消息的 Fork、编辑/导航入口不能映射错位。
- **R6 压缩标记**：每个 `compaction` 在实际时间位置显示一次折叠标记；摘要默认折叠，不能再伪装成普通 user message。
- **R7 完整回合**：分页不能把 assistant toolCall 与对应 toolResult 随意拆开；优先按完整用户回合切页。
- **R8 生命周期正确**：agent settle、手动/自动压缩、SSE 追加和加载旧页并存时，不丢已加载历史、不重复乐观消息、不错误自动滚顶。
- **R9 元数据正确**：详情中的 `messageCount` 和 `firstMessage` 基于真实原始消息，不以压缩摘要作为第一条用户消息。
- **R10 兼容与数据安全**：不改写现有 JSONL，不修改 Pi SDK/node_modules，不改变 archive/Fork/branch/sessionStats/sessionPerformance 语义。

完成后的用户行为：

1. 打开会话默认仍定位到底部。
2. 顶部存在“加载更早记录”入口；加载后视口锚点保持稳定。
3. 多次加载最终可到达会话第一条真实消息。
4. 压缩位置显示一个折叠的“上下文已压缩”记录，可展开查看摘要。
5. 切换分支后只显示目标分支，并重新建立该分支的分页状态。

---

## 范围边界

- 不修改 Pi 的压缩算法、`firstKeptEntryId` 规则、自动压缩阈值或 Agent runtime context。
- 不删除、迁移或重写已有 session JSONL。
- 不把完整 transcript 放回模型 Prompt。
- 不在本次实现 JSONL 流式索引或随机文件 seek；服务端仍可使用 `SessionManager.open()`，本次重点是 API payload 与浏览器渲染有界。
- 不实现全文消息搜索、跨分支混合时间线、无限虚拟列表框架或 transcript 导出重做。
- 不因本任务重构无关 Sidebar、Usage、Subagent 或 Markdown 系统。
- 不直接修改 `node_modules/@earendil-works/pi-coding-agent/**`。

---

## 关键技术决策

### 1. 建立独立 transcript domain

新增纯模块 `lib/session-transcript.ts`，不要继续扩张或复用名为 `buildSessionContext()` 的模型语义函数。模块职责：

- 根据 `entries + leafId` 构造目标分支完整 path；
- 将可展示 entry 投影为 `AgentMessage[] + entryIds[]`；
- 生成有界的最近页/更早页；
- 计算真实 `messageCount` 与第一条真实 user message；
- 校验 `beforeEntryId` 必须位于目标分支的可分页边界上。

建议新增共享类型：

- `SessionContextState`：仅 `thinkingLevel` 和当前 model 等模型状态元数据；
- `SessionTranscriptPage`：`messages`、`entryIds`、`leafId`、`hasMoreBefore`、`nextBeforeEntryId`、真实消息计数；
- transcript compaction marker 使用稳定 custom type（例如 `pi-web:compaction`），不要伪装成 user message。

原始 entry 投影需保持现有策略：

- `message`：继续调用 `normalizeToolCalls()`；user 文本继续应用 `stripVisualEvidenceFromMessage()`；
- `custom_message`：保留其 `display/details` 语义；
- `compaction`：投影为专用、默认折叠的展示 marker，entryId 使用 compaction id；
- `branch_summary`：先 characterization 当前显示行为，再保持兼容投影；
- `model_change`、`thinking_level_change`、`session_info`、`label`、普通 `custom` 等 state-only entry 不生成普通聊天行。

### 2. 分页按完整回合而不是任意数组切片

默认首屏建议约 100 条展示消息，硬上限建议 200；最终常量按项目风格落地。分页从目标 leaf 向前选择完整用户回合：

- 一个 user message 到下一个 user message 前的 assistant/toolResult/custom rows 视为一组；
- toolCall 位于 assistant message 内，对应 toolResult 必须与该 assistant 保持同页；
- 单个回合超过页上限时允许该页只返回这个完整回合，优先保证语义完整；
- `nextBeforeEntryId` 必须是稳定的分支 entry 游标，不使用消息时间戳。

### 3. API 使用 chat view，保留兼容边界

推荐新增：

- `app/api/sessions/[id]/transcript/route.ts`
  - 参数：`leafId`（可选）、`beforeEntryId`（可选）、`limit`（可选且服务端 clamp）；
  - 返回 `SessionTranscriptPage`；
  - 复用详情路由的 exact-id 校验、archive 支持和 matching live `SessionManager`。

首次打开不应额外串行等待两次请求。建议让 `GET /api/sessions/[id]?view=chat&includeState` 同时返回：

- session detail/tree/stats/performance/agentState；
- `contextState`（model/thinking metadata，不包含给模型的完整 messages）；
- 最近一页 `transcript`。

默认未带 `view=chat` 的旧详情响应是否保留原 `context`，由实施前全仓消费者搜索决定；优先采用 additive/兼容策略，但 WebUI 的 `view=chat` 响应不得再次序列化无界的 model context messages。现有 `/context` 路由可保留为 compaction-aware 兼容接口，ChatWindow 分支切换改用 `/transcript`。

### 4. 客户端按 entryId 合并，不按对象或文本去重

新增纯客户端分页/合并 helper（可放 `lib/session-transcript-client.ts`），让 `hooks/useAgentSession.ts` 只编排请求和状态：

- 首次打开/切换 leaf：replace 当前页；
- 加载更早：按 `entryIds` prepend 并去重；
- agent settle/compaction end 的最近页 refresh：替换重叠尾部、保留已经加载的旧页；
- 乐观 user message 没有 entryId，settle 后应由持久化页收敛，不能复制两条；
- session/leaf/request sequence 不匹配的迟到响应必须丢弃；
- 加载更早页不能触发自动滚到底部。

### 5. 压缩标记是展示事件，不是用户消息

在 `components/MessageView.tsx` 中为 transcript compaction custom type 增加轻量专用渲染：

- 标题和按钮使用 zh/en i18n；
- 默认只显示“上下文已压缩”和时间；
- 用户主动展开后才渲染摘要；
- marker 不提供编辑/Fork user-message 操作；
- 不使用任意新高 z-index；静态样式放 `app/globals.css` 的现有 message class 体系。

---

## 数据流草图

> 此图是实现方向，不是要求照抄的方法签名。

```mermaid
flowchart LR
    JSONL[完整 session JSONL] --> SM[SessionManager entries / branch]
    SM --> MODEL[Pi buildSessionContext]
    MODEL --> AGENT[Agent runtime / LLM]
    SM --> TRANSCRIPT[session-transcript projection]
    TRANSCRIPT --> INITIAL[detail view=chat 最近页]
    TRANSCRIPT --> OLDER[/transcript 更早页]
    INITIAL --> HOOK[useAgentSession]
    OLDER --> HOOK
    HOOK --> CHAT[ChatWindow + scroll anchor]
```

核心不变量：`MODEL` 与 `TRANSCRIPT` 是两个独立投影，任何一方都不能复用另一方的“消息列表”作为自己的事实来源。

---

## 实施单元

- [x] U1. **Characterize 并实现 transcript 纯领域层**

**目标：** 在不接 UI/API 的前提下，确定完整分支投影、压缩 marker、回合分页和游标行为。

**文件：**

- Create: `lib/session-transcript.ts`
- Modify: `lib/types.ts`
- Create/Test: `scripts/smoke-session-transcript.ts`
- Modify: `package.json`（新增 `test:session-transcript`）

**执行要求：** 先写失败 smoke，再实现纯逻辑。

**测试场景：**

1. 无压缩线性会话：全部 message 按顺序投影，entryIds 完全对齐。
2. 单次压缩：压缩前消息仍可通过更早页加载；marker 只出现一次；model context 对照仍然省略旧消息。
3. 多次压缩：每个 marker 恰好一次，原始消息无重复/遗漏。
4. 分支：给定不同 leaf，只返回各自 root-to-leaf path，不混入 sibling branch。
5. 自定义消息和视觉证据：保持现有展示/清理策略。
6. 回合边界：assistant toolCall 与 toolResult 不跨页。
7. 游标：连续翻页无重复无缺口；非法/不属于该 leaf 的游标明确失败。
8. 极端回合：单回合超过 limit 仍完整返回，不死循环。
9. 元数据：`firstMessage` 来自第一条真实 user message，`messageCount` 不计 synthetic marker。

**完成标准：** 纯 smoke 能证明完整 transcript 与压缩 model context 同时成立。

---

- [x] U2. **接入 session detail 与 transcript API**

**目标：** 首次 chat view 和历史分页都使用独立 transcript，同时保持 live manager、archive、鉴权和现有 stats 语义。

**文件：**

- Create: `app/api/sessions/[id]/transcript/route.ts`
- Modify: `app/api/sessions/[id]/route.ts`
- Review/compat: `app/api/sessions/[id]/context/route.ts`
- Modify: `lib/session-reader.ts`
- Test: `scripts/smoke-session-transcript.ts`

**实施重点：**

- 全仓搜索旧 detail/context response 消费者后再确定兼容字段；不要猜测。
- `view=chat` 返回最近 transcript page 和 context metadata，不发送无界 model context messages。
- 复用 live wrapper 中已经解析的 `SessionManager`，inactive/archived 回退到磁盘。
- exact session id、malformed body、无效 leaf/cursor、archive 路径行为与现有详情路由一致。
- 修正详情 `messageCount` / `firstMessage`，不能使用压缩摘要。

**测试场景：**

1. compacted session 的 chat detail 最近页包含 marker/近期消息并返回 `hasMoreBefore=true`。
2. 连续 transcript 请求最终能取回第一条真实消息。
3. archived session 可只读分页；不存在/畸形 session 继续返回正确 404。
4. live manager 与 disk manager 对同一 fixture 返回相同 page contract。
5. 非法 leaf/cursor 返回有界 4xx，不退化成其他分支或最新页。
6. sessionStats/sessionPerformance/tree/agentState shape 不因 transcript 改造发生回归。

---

- [x] U3. **接入客户端分页、合并、滚动锚定和压缩标记 UI**

**目标：** 用户可稳定加载更早记录；后台 refresh、SSE、分支切换和乐观消息不会破坏分页状态。

**文件：**

- Create: `lib/session-transcript-client.ts`（如纯合并逻辑值得独立）
- Modify: `hooks/useAgentSession.ts`
- Modify: `components/ChatWindow.tsx`
- Modify: `components/MessageView.tsx`
- Modify: `app/globals.css`
- Modify: `lib/i18n/messages/chat.ts`
- Test: `scripts/smoke-session-transcript.ts`
- Test: `scripts/check-i18n-keys.ts`
- Test: `scripts/smoke-ui-theme-contract.ts`（仅在新增稳定 class/focus/responsive contract 时扩展）

**实施重点：**

- hook 暴露 `hasMoreBefore/loadingOlder/loadOlder`，UI 顶部显示明确按钮/状态。
- prepend 前记录 scrollHeight/scrollTop，DOM 更新后按高度差恢复视口。
- 初次打开仍滚到底部；加载更早、迟到页和 marker 展开不能误触发自动滚底。
- agent settle/compaction end 只刷新最近页并按 entryId 合并，不能清空已加载旧页。
- leaf 切换必须取消/隔离旧请求并重置该 leaf 的页面。
- `parsePersistedSubagentRuns()`、tool result pairing、minimap、稳定 React key 和 Fork entryId 继续基于当前已加载消息正确工作。

**测试场景：**

1. prepend 两页后 entryIds 顺序稳定且去重。
2. 最近页 refresh 覆盖重叠 persisted rows、保留旧页，并移除等价 optimistic duplicate。
3. leaf/session 切换后旧响应不污染新 transcript。
4. compaction event 后旧消息仍保留，新 marker/最近消息出现一次。
5. 加载更早前后视口锚点不跳；初次打开仍在底部。
6. compaction marker 默认折叠、可键盘展开、zh/en 文案齐全、无 user/Fork 操作。
7. 历史 assistant/toolResult/Subagent 行在加载旧页后恢复配对。

---

- [x] U4. **文档、回归与交付收尾**

**目标：** 把“模型上下文与展示 transcript 分离”写成项目不变量，并完成自动/手动验证。

**文件：**

- Modify: `AGENTS.md`（增加测试命令/顶层不变量，保持简洁）
- Modify: `docs/architecture/overview.md`
- Modify: `docs/modules/api.md`
- Modify: `docs/modules/frontend.md`
- Modify: `docs/modules/library.md`
- Modify: `docs/standards/code-style.md`
- Modify: `docs/plans/README.md`
- Modify: 本计划状态和 unit 勾选

**验证命令：**

```bash
npm run test:session-transcript
npm run test:agent-stream
npm run test:session-stats
npm run test:i18n
npm run test:ui-theme
npm run lint
node_modules/.bin/tsc --noEmit
```

不要直接运行 `next build`；本任务不是发布验证。

**手动验证：**

1. 打开已有 compacted session，确认默认在底部且可逐页加载到首条消息。
2. 展开/折叠 compaction marker，确认摘要与原始消息都存在且不重复成普通 user row。
3. 加载两页历史后继续发消息，等待 agent settle，确认旧页没有消失。
4. 触发一次手动压缩，确认已加载历史仍在、marker 新增一次、模型可继续对话。
5. 切换有分支的 leaf，再切回；确认各分支不串页、游标不污染。
6. 检查 Fork 历史消息、tool result、Subagent 持久化行和 archived 只读会话。

全部验证完成后把本计划 `status` 改为 `completed`，更新 `docs/plans/README.md` 的状态/交付说明。

---

## 风险与规避

| 风险 | 规避 |
| --- | --- |
| 直接全量返回恢复了历史但造成大型会话卡顿 | chat view 首屏有界，旧页显式懒加载；不把完整 context 序列化给浏览器。 |
| 分页切开 toolCall/toolResult | 服务端按完整用户回合分页；单个超大回合优先完整。 |
| `agent_settled` 的 `loadSession()` 覆盖已加载旧页 | 区分 initial replace 与 tail refresh merge，按 entryId 合并。 |
| 乐观消息没有 entryId 导致重复 | 最近 persisted page 到达时执行明确的 optimistic reconciliation，不按全文做全局模糊去重。 |
| branch/session 迟到请求污染当前页面 | 保留并扩展现有 request sequence + sessionId/leafId 校验。 |
| compaction marker 被当作 user message影响 firstMessage/Fork | 使用专用 custom transcript marker，metadata 只统计真实 message entry。 |
| 老 API 消费者依赖 `context` | 实施前搜索全部消费者；优先新增 chat view/transcript contract，旧接口按证据兼容。 |
| Subagent/tool 解析只能看到当前页 | 每次 prepend 后从已加载消息重建/合并持久化投影；完整回合边界保持关联数据同页。 |
| 服务端仍需解析完整 JSONL | 接受为本次范围边界；live manager 复用避免活跃会话重复 parse，后续性能项目再考虑文件级索引。 |

---

## 当前工作区交接警告

截至 2026-08-24，当前分支为 `self-run...origin/self-run`，并存在另一项“Web directory picker”相关未提交修改：

```text
M components/sidebar/DirectoryPickerDialog.tsx
M docs/modules/api.md
M docs/modules/frontend.md
M docs/modules/library.md
M lib/cwd-browse.ts
M lib/i18n/messages/sidebar.ts
M scripts/smoke-cwd-browse.ts
?? app/api/cwd/create/
```

新会话必须：

- 不 reset、checkout、覆盖或清理这些改动；
- 本任务后期也需要更新 `docs/modules/api.md`、`docs/modules/frontend.md`、`docs/modules/library.md`，编辑前先查看 diff，只追加本任务内容并保留现有 directory picker 变更；
- 除非用户另行要求，不 commit/push/开 PR；
- 如果发现上述文件状态与交接记录不同，先重新盘点，以实际工作区为准。

---

## 新会话执行提示词

将下面整段直接发送给新的实现会话：

```markdown
# 任务：修复会话压缩后历史记录不可见，并实现 transcript 分页加载

你是当前仓库的实现 Agent。根因已确认，不需要重新 brainstorm；请按交接计划直接实施，但必须先读代码和写 characterization smoke。

## 必读顺序
1. `AGENTS.md`
2. `docs/plans/2026-08-24-001-fix-session-transcript-after-compaction-plan.md`
3. `docs/architecture/overview.md` 中 AgentSession、Branching model、Session file format
4. `docs/modules/api.md`
5. `docs/modules/frontend.md`
6. `docs/modules/library.md`
7. `docs/standards/code-style.md`
8. 相关源码：
   - `lib/session-reader.ts`
   - `lib/types.ts`
   - `app/api/sessions/[id]/route.ts`
   - `app/api/sessions/[id]/context/route.ts`
   - `hooks/useAgentSession.ts`
   - `components/ChatWindow.tsx`
   - `components/MessageView.tsx`
   - Pi SDK 的 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`（只读，确认 buildSessionContext 的 LLM 语义）

## 已确认事实
- 压缩不会删除原始 JSONL 消息，只追加 `compaction` entry。
- 当前 WebUI 错把 Pi 的 `buildSessionContext()`（给模型的压缩上下文）当成聊天 transcript。
- 真实样本中原始 message 354 条，WebUI context 仅 89 条，266 条仍在 JSONL 但未返回页面。
- 这不是 Sidebar 分页或分支树长度优化造成的。

## 目标
- 模型继续使用压缩后 context，绝不能把完整历史重新发给模型。
- WebUI 使用独立完整 transcript 投影。
- 首次只加载最近一页，顶部可加载更早记录；按 entryId 游标分页。
- 分页按完整用户回合切分，避免拆开 assistant toolCall/toolResult。
- compaction 显示为默认折叠的专用 marker，不伪装成 user message。
- 初次打开仍滚到底部；prepend 历史时保持视口锚点。
- agent settle/compaction refresh 不能清空已加载旧页；切换 leaf/session 必须隔离迟到响应。
- `messageCount` / `firstMessage` 使用真实原始消息。

## 严格范围
- 不修改 Pi SDK/node_modules，不修改压缩算法和阈值。
- 不重写/迁移 session JSONL。
- 不做全文搜索、跨分支混合时间线或大型虚拟列表框架。
- 不进行无关重构。
- 不使用 SnFlow；按普通直接开发执行。

## 实施顺序
按计划 U1 → U2 → U3 → U4：
1. U1 先创建 `scripts/smoke-session-transcript.ts` 的失败 characterization，再实现 `lib/session-transcript.ts` 和共享类型/分页纯逻辑。
2. U2 增加 transcript API/chat detail contract，复用 live SessionManager，保留 archive/exact-id/stats 行为。
3. U3 接入 hook/UI 的分页合并、滚动锚定、分支隔离和 compaction marker。
4. U4 更新架构/模块/标准/计划文档并跑完整验证。

每完成一个 unit，立即在计划文件中勾选 `[x]` 并执行该 unit 的相关 smoke；全部完成后将 plan status 改为 completed 并更新 `docs/plans/README.md`。

## 工作区安全
当前存在另一项 Web directory picker 的未提交修改，禁止 reset/覆盖：
- `components/sidebar/DirectoryPickerDialog.tsx`
- `docs/modules/api.md`
- `docs/modules/frontend.md`
- `docs/modules/library.md`
- `lib/cwd-browse.ts`
- `lib/i18n/messages/sidebar.ts`
- `scripts/smoke-cwd-browse.ts`
- `app/api/cwd/create/`

本任务也会更新三个 `docs/modules/*.md`，编辑前先看现有 diff，只合并追加本任务内容。

## 最终验证
- `npm run test:session-transcript`
- `npm run test:agent-stream`
- `npm run test:session-stats`
- `npm run test:i18n`
- `npm run test:ui-theme`
- `npm run lint`
- `node_modules/.bin/tsc --noEmit`

不要直接运行 `next build`。未经要求不要 commit/push/PR。

现在先检查工作区与全部消费者，然后从 U1 的失败 smoke 开始实施。
```
