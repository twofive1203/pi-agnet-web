# 桌宠结构化 ask_user 交互 MVP — Requirements

- **Status:** Proposed
- **Date:** 2026-08-14
- **Scope:** 仅可信 bundled `pi-ask-user` 的结构化用户决策（单选 + 取消）在 Windows 桌宠内就近应答；不处理任意 extension confirm/select/input/editor。
- **Related ADR:** `docs/architecture/decisions/desktop-pet-ask-user-interaction.md`
- **Related plan:** `docs/plans/2026-08-14-003-feat-desktop-pet-ask-user-interaction-plan.md`
- **Supersedes within scope:** `docs/architecture/decisions/desktop-pet-needs-input-response.md`（通用 U5 仍为 No-go；本文是 U5 的一个窄化子集，即 U5a）。

## 1. Background and Problem

通用 U5「桌宠 needs_input 桌面响应」在当前协议下已被判 **No-go**（`desktop-pet-needs-input-response.md`）：`extension_ui_request` 的 `title/message/options/prefill` 是扩展作者任意字符串，常内嵌命令文本、路径与 Prompt 片段；observer 有意不向 renderer 下发这些正文，payload 也没有任何结构化安全摘要字段，因此桌宠无法安全批准/拒绝任何 confirm/select/input/editor。

本 MVP 不推翻该结论，而是识别出其中**唯一一个服务端可验证、结构化、非权限类**的子集：可信 bundled `pi-ask-user` 的**单选问题**。`ask_user` 不是"批准危险操作"，而是模型向用户索取一个明确决策；其 `question`/`options[].title` 本身就是决策正文，WebUI 已在模态框里原样展示，桌宠展示同样的正文**不扩大用户可见内容**，只是把既有的决策面就近搬到了桌宠。

因此 MVP 只做一件窄事：当（且仅当）一个可信 `ask_user` 单选请求到达时，桌宠展示 question + 选项 title，用户选择后 Agent 继续执行。其余所有阻塞 UI 维持现状（needs_input 提示 + 打开 WebUI）。

## 2. Goals

- 让桌宠对**可信 bundled `pi-ask_user` 的单选**提供就地应答（选择或取消），减少用户从桌宠切回 WebUI 的上下文切换。
- 保持 observer 隐私边界、attach-only、服务端权威不变。
- 用**可验证的结构化 provenance** 取代"按时间/工具名/字符串解析"的脆弱关联，使"ask_user 单选"与"普通 select"能够被确定性地、非猜测地区分。
- 用一个独立的、capability 门控的控制通道承载桌面应答，绝不扩展现有 public observer snapshot，绝不把能力或正文写入 renderer/settings/日志/审计/系统通知。

## 3. Non-Goals

以下**明确不做**，且不得借本 MVP 顺带实现：

- 不支持 `pi-ask-user` 的多选（`allowMultiple`）、自由文本（`allowFreeform`）、附加评论（`allowComment`）、无选项自由输入（`options.length === 0` → `ctx.ui.input`）、以及任何需要编辑器的形式。
- 不支持任意 extension 的 `confirm` / `select` / `input` / `editor`（含权限门、危险命令授权、`rm -rf` 确认等）。这些继续走「needs_input + 打开 WebUI」。
- 不实现权限审批、危险命令授权、auto-approve、`ctx.ui.confirm` 名义绕过 extension response 生命周期。
- 不修改 `ctx.ui.custom()` 的 RPC 降级语义，不把 TUI overlay 渲染进桌宠。
- 不把 ask_user 正文/选项/capability 放进 public observer snapshot、settings、日志、审计正文或系统通知。
- 不实现全局热键应答（需要前台归属 + 可见请求绑定 + 防误触，另行评审）。

## 4. Verified Protocol Facts（调研结论）

以下事实已对照源码核实，是本文与 ADR 的判定依据：

### 4.1 pi-ask-user 的真实来源识别

- `pi-ask-user@0.13.1` 是本项目 **pinned 依赖**（`package.json` L116），并由 `lib/bundled-pi-extension-registry.ts` 注册为 bundled 扩展：`{ id: "pi-ask-user", packageName: "pi-ask-user", version: "0.13.1", extensionEntryPoints: ["index.ts"], skillPaths: ["skills"] }`。
- `lib/bundled-pi-extensions.ts` 的 `createBundledPiResourceLoader` 以 `additionalExtensionPaths` 注入其包根，并对已加载资源打 `sourceInfo = { source: "webui-bundled:pi-ask-user@0.13.1", scope: "temporary", origin: "package", baseDir }`。因此**服务端能够确定性地识别"该扩展来自可信 bundled pi-ask-user"**（路径/包根/sourceInfo）。
- 该扩展注册的工具有 `name: "ask_user"`、`executionMode: "sequential"`（同一 assistant turn 内阻塞兄弟工具，直到用户回答）。

### 4.2 ask_user execute 与 RPC fallback

`pi-ask-user/index.ts` 的 `execute()` 逻辑：

- `signal.aborted` → 直接返回 cancelled。
- 选项全部畸形（`rawOptions.length > 0 && options.length === 0`）→ `isError` 返回，不进入 UI。
- `!ctx.hasUI || !ctx.ui` → `isError` 返回文本提示。
- `options.length === 0` → 直接 `ctx.ui.input(prompt, ...)`（自由输入），并 `pi.events.emit("herdr:blocked", ...)`。**这不是桌宠可应答的单选形态。**
- `options.length > 0` → 先 `onUpdate({ details: { question, context, options, response: null, cancelled: false } })`，然后 `ctx.ui.custom(customFactory, ...)`。
  - 在 TUI 下 `custom()` 返回 AskComponent 结果。
  - 在 RPC/WebUI 下，`ExtensionWebUiBridge.custom` 恒为 `async () => undefined`（`lib/extension-web-ui.ts`），故 `customResult === undefined`，降级到 `askViaDialogs(ctx.ui, question, context, options, allowMultiple, allowFreeform, allowComment, timeout)`。
- `askViaDialogs` 对单选（`allowMultiple=false`）路径：
  - `selectOptions = options.map(o => o.title)`；若 `allowFreeform` 追加 `FREEFORM_SENTINEL`。
  - `selected = await ui.select(prompt, selectOptions, dialogOpts)`，其中 `prompt = context ? `${question}\n\nContext:\n${context}` : question`，`dialogOpts = timeout ? { timeout } : undefined`。
  - 命中 `FREEFORM_SENTINEL` → 再 `ui.input()`。
  - `allowComment` → 再 `ui.input()`。

**结论**：仅当 `options.length > 0 && allowMultiple === false && allowFreeform === false && allowComment === false` 时，ask_user 恰好产生**一次** `ctx.ui.select(title, titles[], {timeout})`，且 `title` 是 `question` 与 `context` 的拼接。这正是 MVP 唯一的桌宠可应答形态。

### 4.3 extension_ui_request / response 生命周期（WebUI）

- `ExtensionWebUiBridge.createContext()` 提供 `select/confirm/input/editor`（阻塞对话框）与 `notify/setStatus/setWidget/setTitle/set_editor_text`（fire-and-forget）；`custom` 恒为 `undefined`。
- `createDialogPromise` 生成 `id = randomUUID()`，构造 `{ type: "extension_ui_request", id, method, title, options, timeout }`，存入 `this.pending` 并 `emit`。**当前 event 不含任何来源/结构字段。**
- `respond(response)`：`pending.get(id)` 命中即 `delete` 并 `resolve`，二次响应返回 `false`（**桥接层已具 first-response-wins**）。
- `rejectAll()`：session destroy 时对全部 pending 以 `cancelled` 结算。
- 响应路径：`useExtensionUi.respondExtensionDialog` → `sendAgentCommand(sid, {type:"extension_ui_response", ...})` → `POST /api/agent/[id]` → `AgentSessionWrapper.send("extension_ui_response")` → `extensionUiBridge.respond(response)` → `noteExtensionUiResolved(id)` → `scheduleIdleTeardownIfEligible()`。
- 超时/取消/竞态：桥接 fallback 超时 `opts.timeout ?? (hasListener() ? undefined : 120_000)`；AbortSignal → cancelled；新对话框到达会取消旧对话框（`useExtensionUi` 内对旧 id 发送 cancelled）；settle 清空 `blockingUiIds`。

### 4.4 如何避免"脆弱时间关联"误判

- `extension_ui_request` 的 `select` 事件**没有**任何字段说明"我是 ask_user 单选"：`title` 是被拼接的 prompt，`options` 是标题数组。凭工具名（`tool_execution_start {toolName:"ask_user"}`）、执行时序、或字符串解析 `title` 来判断来源，都是**脆弱关联**，可能把普通 extension 的 `select` 误判为 ask_user（或被 ask_user 的 freeform/input 形态干扰）。
- 因此**必须调整 pi-ask-user**，让它在 RPC fallback 的 `ctx.ui.select` 第三参 `opts` 里携带**结构化 provenance**，由 WebUI 桥接层透传到 `extension_ui_request`，再由服务端按严格 schema + 可信来源 allowlist 校验。这是本 MVP 的硬前置（详见 ADR §Recommended Architecture 与计划 Phase 0）。

### 4.5 私有交互 API 与 observer API 的边界

- 现有 observer（`lib/task-observer-agent.ts`）从阻塞 `extension_ui_request` 的 method 派生 `attention=needs_input`、`phase=needs_input`，`blockingUiIds` 仅存服务端。public snapshot（`/api/desktop-observer/snapshot` + SSE）**绝不携带** method/id/question/options/response/capability。
- observer 访问门控：`/api/desktop-observer/**` 仅直接 IPv4 loopback（127.x Host）+ 短时哈希 token（15 分钟 TTL，`x-spi-desktop-observer-token`）+ server-mode access key。
- `/api/agent/[id]`（WebUI 响应路由）在本地模式**没有** loopback/capability 门控，任何本地进程拿到 id 即可响应——这是桌面应答必须引入独立 capability 门控的根本原因。
- Electron main 持有 observer token + access key 于内存；renderer 经窄 allowlist IPC 只收到 sanitized view，永不接触 token/access key/绝对 URL（`desktop/preload/pet-preload.ts`、`desktop/main/ipc-contract.ts`）。

## 5. Functional Requirements

**FR-1 来源锁定**：只有来自可信 bundled `pi-ask-user`（版本精确匹配 `0.13.1`，经 `sourceInfo`/包根验证）且携带合法结构化 provenance 的 `select` 请求，才被视为"桌宠可应答"。

**FR-2 形态锁定**：桌宠可应答形态必须是 `ask_user` 单选且 `options.length > 0`、`allowMultiple=false`、`allowFreeform=false`、`allowComment=false`。多选、freeform、comment、无选项自由输入一律不可桌宠应答，回退 WebUI。

**FR-3 展示内容**：桌宠展示 `question` 与 `options[].title`（可含 `options[].description` 作为次要信息）；`context` 默认折叠，用户可展开（折叠时不得预加载正文到可见区）。

**FR-4 应答动作**：桌宠只支持两类动作——选择某一选项（返回其 `title`）或取消（等价 `cancelled: true`）。返回的 `value` 必须与结构化 `options[].title` 精确匹配，不允许自由文本。

**FR-5 默认关闭**：该能力默认关闭，需用户显式开启（桌面设置新增独立开关，见 FR-9）。关闭时桌宠维持现状（needs_input 提示 + 打开 WebUI）。

**FR-6 DND 行为**：DND 启用时不主动弹出桌面问题 UI；Activity tray 仍保留 `needs_input`，单击仍打开 WebUI。绝不自动批准/拒绝，绝不写入 acknowledged/notified 状态。

**FR-7 first-response-wins**：WebUI 与桌宠并发应答时，只有第一个被服务端接受的响应生效；第二个为 no-op。桌宠 consume capability 成功后，WebUI 已打开的模态框须被服务端合成的"已结算"事件驱动关闭（或用户手动关闭）。

**FR-8 capability 生命周期**：每次"桌宠可应答"请求由服务端 mint 一个短期、单次、不可猜测（≥256-bit）、绑定 `instanceId + sessionId + activityId(promptEpoch) + requestId` 的 capability。在 timeout、abort、settled、session destroy、实例变化、新对话框取消、或 WebUI 已响应时立即失效。

**FR-9 设置与迁移**：桌面设置新增 `askUserInteraction.enabled`（默认 `false`）；旧设置文件缺失该键时按 `false` 迁移，schema 版本不变或升一个可回滚的小版本；该设置**不得**与 `pi-web.json` 的 `bundledExtensions["pi-ask-user"]`（控制工具是否存在）混淆。

**FR-10 审计最小化**：只记录结构化非敏感字段（capability 哈希、instance/session/activity/request id、时间戳、outcome、失效原因）。绝不记录 question/context/选项正文/所选值原文/工具参数/路径。

## 6. Privacy and Security Requirements

**SR-1 正文只存内存**：ask_user 的 question/context/options 仅在服务端内存与（应答期间）Electron main→renderer 的安全投影中存在；不进入 public observer snapshot、settings 文件、日志、审计正文、系统通知正文。

**SR-2 capability 不落 renderer**：Electron renderer 永不接触 observer token、access key、capability 明文、或原始 `extension_ui_request` id。renderer 只收到有界的结构化描述符 + 有限动作词汇。

**SR-3 控制通道独立**：桌面应答走新的独立 loopback-only 控制 API（如 `/api/desktop-control/**`），门控强度与 observer 一致（直接 IPv4 loopback + 短时哈希 token + server-mode access key + 同源/缺省 Origin）。不扩展 observer snapshot，不复用 `/api/agent/[id]` 的无门控响应路径。

**SR-4 单次消费原子性**：capability 消费为原子 compare-and-delete；重复消费、过期、跨会话/跨 Subagent、绑定不匹配均为拒绝，返回确定性的 stale 结果并回退 WebUI。

**SR-5 renderer 内存清理**：对话框关闭、过期、settled、session destroy、DND 切换、窗口隐藏时，renderer 立即丢弃展示的 question/options 引用（DOM 移除 + 状态清空），不留历史缓存。

**SR-6 不误导用户**：桌宠 UI 必须与 WebUI 呈现同一决策语义（同一 question + 同一选项集合 + 明确的取消），不得在桌面呈现比 WebUI 更"宽松"或更"危险"的批准含义。

## 7. Concurrency and Lifecycle Requirements

**CR-1** 服务端维护一个按 `requestId` 索引的 capability 注册表，响应时与所属 wrapper 的 `ExtensionWebUiBridge.pending` 集合交叉校验；只有 pending 中仍存在该请求时才允许消费。

**CR-2** 触发失效的事件：`extension_ui_response` 被任意来源接受、`AbortSignal` 触发、`agent_settled`/settle 清空 `blockingUiIds`、`session destroy → rejectAll()`、新对话框取消旧请求、`extension_ui_request` 超时。

**CR-3** WebUI 与桌宠共享同一 `respond()` 首命中语义；桌宠经控制 API 消费 capability 后，服务端把结果写回同一 `ExtensionWebUiBridge.respond()`，保证两侧幂等收敛。

**CR-4** 桌宠展示的 needs_input 可能滞后于真实 pending（observer 快照延迟）。桌面应答前必须用 capability 即时校验，不能只信快照；校验失败回退打开 WebUI。

**CR-5** instance 变化 / 服务重启后，旧 capability 全部失效；Electron main 重新建立控制会话。

## 8. Out of Scope（明确排除）

- 多选、freeform、comment、无选项自由输入、编辑器形态。
- 任意 extension confirm/select/input/editor 的桌面应答（权限门/危险命令）。
- 权限审批、危险命令授权、auto-approve。
- 全局热键应答。
- 修改 public observer snapshot 结构或 `TaskObserverSnapshot` 字段。
- 修改 `ctx.ui.custom()` RPC 降级语义。

## 9. Acceptance Criteria

1. 普通 extension `select`（如权限门）**绝不**被误判为 ask_user，桌宠不为其弹出可应答 UI（回归现有 needs_input 行为）。
2. ask_user 单选在能力开启且非 DND 时，桌宠展示 question + 选项 title，选择/取消后 Agent 继续执行。
3. ask_user 的多选/freeform/comment/无选项形态在桌宠侧不出现，均回退 WebUI。
4. capability 单次消费：WebUI 先答则桌宠不答；桌宠先答则 WebUI 模态框被结算事件关闭；重复/过期/跨会话/绑定不匹配均拒绝。
5. 全程 question/context/options/capability 不进入 observer snapshot、settings、日志、审计正文、系统通知。
6. DND 时不弹出、不自动批准/拒绝；托盘仍 needs_input 且单击打开 WebUI。
7. 默认关闭，旧设置迁移为关闭，不误伤 `bundledExtensions["pi-ask-user"]`。
8. renderer 在关闭/过期/销毁后不再持有展示正文。

## 10. Open Questions（进入 ADR/计划前需定案）

1. provenance 的注入方式（已确认必须调整 pi-ask-user，具体为 patch / vendor / upstream 见 ADR 定案）。
2. 控制 API 的 token 与 observer token 是否分离（倾向分离，独立 TTL 与能力边界）。
3. capability TTL 的具体取值（建议 ≪ observer 15 分钟，如 60–120 秒）。
4. 审计 retention 窗口与最小字段集。
