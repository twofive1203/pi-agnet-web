---
date: 2026-08-14
topic: desktop-pet-needs-input-response
status: proposed
parent: docs/plans/2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md
architecture: docs/architecture/decisions/desktop-pet-needs-input-response.md
---

# 桌宠 needs_input 桌面响应通道需求（调研与设计）

## Problem Frame

蜗牛派桌宠目前只对 `attention=needs_input` 做状态提示：播放提示音、显示气泡、单击直达 WebUI。用户仍需切回浏览器才能批准、拒绝、选择或输入。竞品（Anthropic `claude-desktop-buddy`、Clawd on Desk）把“等待授权”做成就近、显式的桌面交互，因此 U5 提出“桌宠直接响应部分 needs_input”。

本需求的目标不是直接实现，而是**判断是否能在不泄露 Prompt/工具参数、不绕过 Pi extension UI 生命周期**的前提下，让桌宠安全响应部分 needs_input 请求。本需求不实现桌面批准/拒绝/输入/全局热键或任何新的写 API。

## Current Facts（已核对）

以下事实来自当前源码与 Pi 文档，是需求与后续威胁模型的基线。

### 1. extension_ui_request / response 的真实 request identity

- 阻塞对话框的 `id` 由 **WebUI 侧** `lib/extension-web-ui.ts` 的 `createDialogPromise()` 用 `randomUUID()` 生成（crypto 随机，不可猜测）；**不是 Pi 内核生成的请求 id**。
- Pi 扩展调用 `ctx.ui.confirm/select/input/editor` 时，走 `ExtensionWebUiBridge.createContext()`（`lib/rpc-manager.ts` `bindExtensions({ uiContext, mode: "rpc" })`），因此这些 `ctx.ui` 方法的“请求”实际由 WebUI bridge 构造。
- fire-and-forget 方法（`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`）也用 `randomUUID()` 生成 `id`，但**不进入 pending 表、不期望响应**。

### 2. confirm / select / input / editor 的 payload 与响应结构

依据 `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`（Extension UI Protocol）、`lib/extension-web-ui.ts`、`hooks/useExtensionUi.ts`：

| method | 请求字段（除 `type`/`id`/`method`） | 响应字段 |
| --- | --- | --- |
| `confirm` | `title`、`message`、`timeout?` | `{ confirmed: true\|false }` 或 `{ cancelled: true }` |
| `select` | `title`、`options[]`、`timeout?` | `{ value }`（所选 option 字符串）或 `{ cancelled: true }` |
| `input` | `title`、`placeholder?`、`timeout?` | `{ value }` 或 `{ cancelled: true }` |
| `editor` | `title`、`prefill?`、`timeout?` | `{ value }` 或 `{ cancelled: true }` |

关键点：`title`、`message`、`options`、`placeholder`、`prefill` 全部是**扩展作者任意字符串**，没有结构化的来源、风险类别、安全标签或“安全摘要”字段。`permission-gate.ts` 示例把危险命令拼进 `title`（`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`）；`confirm-destructive.ts` 把会话上下文拼进 `title`/`message`。即：这些字段就是“审批正文”，通常包含命令文本、路径或 Prompt 片段。

### 3. 请求过期、取消、Agent settled、session destroy 行为

- WebUI bridge 超时：`timeoutMs = opts?.timeout ?? (hasListener() ? undefined : 120_000)`。浏览器 SSE 已挂载时默认无超时（等扩展自带 timeout）；无监听器时 120s 兜底取消。
- Pi 侧：请求若带 `timeout` 字段，agent 超时自动按默认值解析（select/input/editor→`undefined`，confirm→`false`）；客户端无需跟踪超时。
- `AbortSignal` 中止 → `finish({ id, cancelled: true })`。
- 新对话框出现而旧对话框仍打开时，WebUI `handleExtensionUiRequest` 主动给旧 id 回 `cancelled: true`（避免 bridge 悬挂）。
- session destroy：`destroyWithReason` → `extensionUiBridge.rejectAll()`（全部 `cancelled: true`）。
- `AgentTaskObserver.forceSettle` 清空 `blockingUiIds`；`noteExtensionUiResolved(id)` 在 bridge 接受响应后清除对应阻塞 id（即使没有 SSE echo）。
- idle teardown 以 `blockingUiCount <= 0` 为前提，不会在仍有阻塞对话框时销毁 wrapper。

### 4. WebUI 当前如何发送 response

`useExtensionUi.respondExtensionDialog` → `sendAgentCommand(sid, { type: "extension_ui_response", id, ... })` → `POST /api/agent/[id]` → `AgentSessionWrapper.handleCommand` case `extension_ui_response` → `extensionUiBridge.respond(response)`。

`respond()` 仅 `pending.get(response.id)` 匹配。**没有除 id 之外的 capability、会话归属或调用方校验**：任何能命中该 id 的调用方都能解析该会话里挂起的对话框。id 的不可猜测性（`randomUUID`）是当前唯一保护。

### 5. observer 为什么只暴露 attention 而不暴露请求正文

- `AgentTaskObserver.onExtensionUiRequest` 只把 `id` 加入 `blockingUiIds`，`deriveAttention()` 据此返回 `needs_input`；public activity 只含 `attention`、`phase`、`reasonCode`、`blockingUiCount`（数量，不含 id/方法名/正文）。
- `BLOCKING_EXTENSION_UI_METHODS` 仅服务端用于识别阻塞方法；方法名、request id、Prompt、options、响应能力**从未进入桌宠 payload**。
- 依据 `docs/architecture/decisions/desktop-pet-task-observer.md` 的隐私边界：payload 禁止 cwd、Prompt/firstMessage、消息/输出、工具参数、文件路径/内容、Quick Command 文本/env、raw error。扩展对话框的 `title/message/options/prefill` 是扩展作者任意字符串，经常内嵌命令/路径/Prompt——它们正是该边界要排除的内容。

### 6. 当前门控

- **observer API**（`/api/desktop-observer/**`，`lib/desktop-observer-access.ts`）：直接 IPv4 loopback TCP peer + IPv4 loopback Host（`127.0.0.1`，不接受 `localhost`）；短时 token（TTL 15 分钟，只存 hash，绑定 `instanceId` + `boundRemote`）；server mode 在 mint 时校验 access key；Origin 精确同源或缺省（Electron main）。根 server-access auth 从不放松 loopback 门控。
- **`/api/agent/[id]`（响应路径）**：本地模式下**没有 loopback/capability 门控**（浏览器跨源 JSON POST 受 CORS preflight 拦截，但本机任意进程可直接 POST）。server mode 下受根 `proxy.ts` access-key auth + 精确同源保护。响应路径不校验“调用方是否拥有该会话”。
- **IPC**（`desktop/main/ipc-contract.ts`、`desktop/preload/pet-preload.ts`）：窄 allowlist；renderer 不能收发 token、不能传绝对 URL、只能 `pet:open-activity`（by activityId）或相对 allowlisted `pet:open-external-url`。main 只收服务端产出的相对 allowlisted 链接。
- **deep link**（`lib/desktop-deep-link.ts`）：仅 `/?session=` 等相对 allowlisted 形式，main 在 `shell.openExternal` 前二次校验；禁止 cwd/path/url/token 等查询键。

## Actors

- A1. 蜗牛派用户：任务运行中，希望就近批准/拒绝/选择/输入。
- A2. 桌宠客户端：只读观察 + 未来潜在的受控响应能力（本需求仅设计）。
- A3. 蜗牛派服务：权威执行方，持有 `AgentSessionWrapper` 与 `ExtensionWebUiBridge`。
- A4. Pi 扩展（`ctx.ui` 调用方）：发起 confirm/select/input/editor。

## Key Flows（目标能力，非本需求交付）

### F1. 就近知情批准（未来，需先满足安全摘要前提）

- **Trigger:** 普通 Agent 活动进入 `attention=needs_input`，且为可安全摘要的低风险请求。
- **Steps:** 服务端生成不可猜测、短期、单次 capability，绑定 instance/session/activity/request；桌宠展示服务端产出的最小知情摘要；用户批准/拒绝；response 经独立 control API 回写并命中同一 request。
- **Outcome:** 用户无需打开浏览器即可完成单一、未过期请求。
- **Gate:** 本需求**不承诺** F1 可交付，见“No-go 范围”。

### F2. 回退 WebUI（当前唯一确定可用路径）

- **Trigger:** 任意 needs_input，或 capability 失效/过期/并发冲突。
- **Steps:** 桌宠只提示并 `openActivity` 直达 WebUI 原生对话框。
- **Outcome:** 用户获得完整上下文后决策；这是当前边界内唯一安全路径。

## Requirements

### R1. 知情决策优先于便捷

任何桌面响应都必须基于**足以让用户做出知情决定的信息**。仅有 `method=confirm` 或工具名不能构成知情决定；不允许盲批、盲拒或通用 auto-approve。

### R2. 安全摘要来源必须是服务端、非敏感、结构化

“最小知情摘要”必须由服务端从可证明非敏感的来源派生，不得直接透传 `title/message/options/prefill`。**当前 extension_ui_request payload 不包含此类字段**（见 Current Facts §2），因此当前无法满足本需求。

### R3. 不扩展 public observer snapshot

请求正文、id、方法名、摘要不得进入现有 `TaskObserverSnapshot` 及其 SSE。若未来引入，必须走独立 control API，与只读观察器隔离。

### R4. capability 语义

若未来实现，每个响应授权必须是：不可猜测（crypto 随机）、短期（秒～分钟级，短于 observer token TTL）、单次使用（一次性消费/失效）、绑定 instance/session/activity/request，且不进入 renderer。

### R5. 生命周期与竞态

必须正确处理过期、cancel、settled、session destroy、终端/WebUI 已响应后的幂等/撤销语义；并发多端响应只能有一个生效，其余视为已失效。

### R6. 回退与 DND

capability 失效、DND 开启、窗口隐藏时只能回退 WebUI 原生流程；DND 不得自动批准或拒绝。

### R7. 审计

若实现，必须可审计；但审计不得记录 Prompt、摘要正文、工具参数、命令文本、路径或选项值。

### R8. 全局热键延期

全局热键不进入本需求范围，需单独评估前台归属、可见请求绑定与防误触。

## No-go 范围

- 不实现桌面批准/拒绝/输入/editor、全局热键、任何新写 API。
- 不修改 TypeScript、API route、IPC、preload、renderer。
- 不扩展 observer payload，不创建可运行授权原型，不声称已通过安全评审。
- 在安全摘要来源存在之前，confirm-only 桌面响应亦为 No-go。

## Open Questions

1. 是否愿意为“安全摘要”引入**上游 Pi 协议变更**（在 extension_ui_request 中增加扩展作者声明的、可验证非敏感的 `safeLabel`/`risk`/`category` 结构化字段）？这是本需求可行的唯一现实前提。
2. 是否接受首期只做 **Phase 0 协议验证与纯领域模型**（capability、摘要分类可行性、威胁 fixture），不触碰运行时代码？
3. 审计的最小字段集与保留期？
