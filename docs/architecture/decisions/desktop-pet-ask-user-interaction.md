# Desktop Pet ask_user Single-Select Interaction (U5a)

- **Status:** Proposed
- **Date:** 2026-08-14
- **Scope:** Narrow, provenance-gated desktop response to trusted bundled `pi-ask-user` single-select questions. Does not change the U5 (general needs_input response) No-go.
- **Requirements:** `docs/brainstorms/2026-08-14-desktop-pet-ask-user-interaction-requirements.md`
- **Parent plan:** `docs/plans/2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md` (U5)
- **Implementation plan:** `docs/plans/2026-08-14-003-feat-desktop-pet-ask-user-interaction-plan.md`
- **Supersedes in scope only:** `desktop-pet-needs-input-response.md`（通用 U5 判定保持不变）
- **Related:** `desktop-pet-task-observer.md`

## Decision Summary

**Proceed with a narrow, provenance-gated MVP — this is a new decision, not a reversal of U5.** General U5 remains **No-go**. The only new capability is: when a **trusted bundled `pi-ask-user` single-select** request (`options.length > 0`, `allowMultiple=false`, `allowFreeform=false`, `allowComment=false`) arrives, the desktop pet may show the structured `question` + option `title`s and return a single selection or cancel. Everything else (multi-select, freeform, comment, optionless input, editor, and **all** non-`pi-ask-user` `confirm`/`select`/`input`/`editor`) stays on the current "notify `needs_input` + open WebUI" path.

The MVP is **hard-gated on a verifiable structured provenance** that does not exist in the protocol today. The bridge currently emits `extension_ui_request{method:"select"}` with only a concatenated `title` and a bare `options[]`; there is no field distinguishing an `ask_user` single-select from an ordinary extension `select`. Therefore **`pi-ask-user` must be adjusted** to emit provenance, and the WebUI bridge must forward and validate it. This decision records the chosen provenance mechanism and the control-API/capability/state-machine design. It **does not claim that security review has passed**; Phase 0 is domain/state-machine verification and the capability/control surface must receive independent review before Phase 2 implementation.

## Context

### Why U5 stays No-go, and why U5a is different

U5 (`desktop-pet-needs-input-response.md`) is No-go because extension `confirm/select/input/editor` bodies are arbitrary strings that embed command text, paths, and Prompt fragments; exposing them to the renderer reverses the observer privacy boundary, and exposing only method names enables blind approval.

`ask_user` is structurally different: it is a **decision-request surface**, not an approval surface. Its `question` and `options[].title` are the decision body itself, already shown verbatim in the WebUI modal. Showing the same bounded content in the desktop pet does not expand what the user can see; it relocates an existing decision surface. The security posture therefore rests on **deterministically identifying this exact trusted surface** and never widening it to approvals or arbitrary dialogs.

### Verified protocol facts (see requirements §4)

- `pi-ask-user@0.13.1` is a pinned project dependency, registered as bundled (`lib/bundled-pi-extension-registry.ts`), and annotated `source: "webui-bundled:pi-ask-user@0.13.1"` by `lib/bundled-pi-extensions.ts`. Server can deterministically recognize the trusted package.
- `ask_user` tool has `executionMode: "sequential"`; its RPC fallback for a single-select with all flags off is exactly one `ctx.ui.select(prompt, titles, {timeout})` where `prompt = question + "\n\nContext:\n" + context` (see `pi-ask-user/index.ts` `askViaDialogs`).
- `ExtensionWebUiBridge.select(title, options, opts)` forwards only `{ method, title, options, timeout }`; the third `opts` argument is the existing, unused extension point. `custom` is hardwired `undefined` (forces the fallback).
- `respond()` is already first-response-wins (`pending.get(id)` → delete → resolve; second call returns `false`). `rejectAll()` on destroy; settle clears `blockingUiIds`.
- Observer (`lib/task-observer-agent.ts`) exposes only `attention=needs_input` + bounded phase; `blockingUiIds`, method names, ids, and text never enter the public snapshot. Observer gate = direct IPv4 loopback + short-lived hashed token (15 min) + server-mode access key.
- `/api/agent/[id]` response route has **no** loopback/capability gate in local mode — any local process holding an id can respond. This is the gap the capability model closes.
- Electron main holds observer token + access key in memory only; renderer is sandboxed, allowlisted IPC, no tokens/absolute URLs.

### The provenance gap (the gating fact)

Without modifying `pi-ask-user`, the bridge cannot know whether a `select` came from `ask_user`. Tool-name correlation (`tool_execution_start{toolName:"ask_user"}`), execution ordering, and string-parsing `title` are all fragile: nested dialogs, queued follow-ups, and `ask_user`'s own freeform/multi/comment fallbacks would break them, and they would misclassify ordinary extension `select`s as `ask_user`. A verifiable structured provenance is therefore a **precondition**, not an optimization.

## Provenance Mechanism Decision

### Chosen: patch `pi-ask-user` (patch-package) + parallel upstream PR

- **Mechanism:** a minimal, backward-compatible patch to `pi-ask-user`'s `askViaDialogs` so the single-select `ctx.ui.select` call passes `opts` carrying a structured, namespaced provenance object; the WebUI `ExtensionWebUiBridge.select(title, options, opts)` forwards it onto the `extension_ui_request` event. The patch is version-locked (patch-package fails install if `pi-ask-user` drifts), tracked in-repo, and changes no existing behavior for any other caller.
- **Provenance shape (strict schema, validated server-side):**
  ```ts
  {
    source: "pi-ask-user",
    kind: "ask_user_select",
    question: string,
    context?: string,
    options: { title: string; description?: string }[],
    allowMultiple: false,
    allowFreeform: false,
    allowComment: false,
  }
  ```
- **Why patch over vendor/upstream:**
  - Patch keeps `pi-ask-user` a normal pinned dependency, consistent with the other three bundled extensions (KISS, DRY, reuse of the existing bundled-extension model). The patch is a single reviewable hunk that only **adds** the `opts` provenance field.
  - patch-package is version-locked, so a future `pi-ask-user` bump without updating the patch fails loudly — no silent drift in a security-critical path.
  - Vendor (forking source into the repo) would fork maintenance and break the uniform "pin + resolve from node_modules" loading model for one extension, disproportionate to a ~20-line additive change.
  - Upstream PR (MIT, active author, `github.com/edlsh/pi-ask-user`) is filed **in parallel but non-blocking**; when merged + released, drop the patch and bump the pinned version. This is the clean long-term exit, but the MVP does not wait on it.
- **Fallback:** if a postinstall patch mechanism is rejected for the repo, vendor `pi-ask-user` into a repo-owned path as the alternative (same provenance field, same schema).

### Verification (why this is "verifiable", not "time-based")

- The bridge validates the provenance against the strict schema and **only** marks the request desktop-answerable when `source === "pi-ask-user"`, `kind === "ask_user_select"`, all three flags are `false`, and `options` is a non-empty structured array.
- The server additionally cross-checks the emitting extension against the trusted bundled `pi-ask-user` allowlist (exact pinned version + `sourceInfo`/package root). This is a structural/schema check, not a timing inference.
- Threat model note: extensions run with full system permissions, so a **malicious arbitrary extension** spoofing the provenance field is out of scope for U5a (the MVP's threat is misclassification of benign selects, not a hostile extension — that is addressed by the bundled-trust model and would be a separate extension-trust problem). The field is not treated as a security boundary against a hostile extension; it is an **allowlisted classification signal from a trusted pinned package**.

## Recommended Architecture

### 1. Provenance-instrumented bridge (server)

- `ExtensionWebUiBridge.select` (and `createDialogPromise`) forwards a validated `provenance` field onto `extension_ui_request` when present.
- A server-side `AskUserRequestClassifier` decides `desktopAnswerable(request)` purely from the provenance + allowlist. Non-answerable requests carry no capability and stay WebUI-only.
- The `extension_ui_request` event continues to flow to WebUI exactly as today (WebUI keeps rendering the modal regardless); provenance is additive and never removes the WebUI path.

### 2. Private control API (separate from observer)

- New loopback-only namespace `/api/desktop-control/**` with the same gate strength as `/api/desktop-observer/**`: direct IPv4 loopback + Host 127.x, short-lived hashed control token, server-mode access key, exact same-origin or absent Origin (Electron main). The public `TaskObserverSnapshot` is **never extended** with request bodies, ids, or capabilities.
- Endpoints (shape):
  - `POST /api/desktop-control/session` — mint a short-lived control token (independent TTL from the observer token).
  - `GET /api/desktop-control/events` (SSE) — deliver, to the authenticated main process only, the **desktop-answerable** request descriptor + a capability reference. The descriptor carries only the bounded structured content (`question`, `context`, `options[{title,description}]`, `expiresAt`, opaque `requestId`); the capability secret is delivered only to main, never to renderer.
  - `POST /api/desktop-control/[requestId]/respond` — `{ capability, selection: <title> | cancelled: true }`. Validates capability, resolves the owning `ExtensionWebUiBridge.respond()`, invalidates the registry, and emits a synthesized settle event to the WebUI SSE so the browser dismisses a stale modal.

### 3. Capability model

- Server mints, per desktop-answerable request, a ≥256-bit crypto-random, short-lived (recommended 60–120 s, ≪ observer 15 min) **single-use** capability bound to `instanceId + sessionId + activityId(promptEpoch) + requestId`.
- The capability is recorded in a server-side registry keyed by `requestId`, cross-checked against the owning wrapper's `ExtensionWebUiBridge.pending` at consume time. Consume is atomic compare-and-delete; a second consume is a no-op; a consumed/expired/unbound request returns a definitive stale result and falls back to WebUI.
- Invalidation triggers: any-source response accepted, `AbortSignal`, settle, `session destroy → rejectAll()`, new-dialog-cancel, request timeout, instance change.

### 4. Electron main + renderer boundary

- Main subscribes to the observer SSE (unchanged, for `needs_input` attention + Activity tray) **and** the control SSE (new, for desktop-answerable descriptors). It holds the capability in memory only.
- On `needs_input`: if a desktop-answerable `ask_user` request is pending, the feature is enabled, and DND is off, main pushes a bounded renderer view (`question`, `options[{title,description}]`, collapsed `context`, `expiresAt`) via a narrow new IPC channel. The renderer never sees the capability, observer token, access key, or raw `extension_ui_request` id.
- Renderer action vocabulary is finite: select an option index (main maps it back to the exact `title`) or cancel. Main posts the response with the capability to the control API. Free-form text, multi-select, and editor are not renderer verbs.

### 5. first-response-wins across WebUI + desktop

- Both surfaces converge on the same `ExtensionWebUiBridge.respond()`. Whoever resolves first wins; the second is a no-op (`respond` returns `false`).
- When the desktop consumes the capability, the server emits a synthesized `extension_ui_settled`/response-echo event so the WebUI dismisses an already-open modal. The WebUI's own `respond()` already returns `false` on a stale id, so a late browser click is harmless.

### 6. Expiry / cancel / settled / concurrency

- Every desktop response is validated against live pending state + capability registry atomically; expired/cancelled/settled/consumed → definitive stale result → WebUI fallback (`openActivity` deep link), never a silent approve/reject.
- The observer snapshot may lag the bridge pending set; the capability check, not the snapshot, is authoritative.

### 7. DND and privacy

- DND suppresses the desktop question UI and disables desktop response affordances; the Activity tray still shows `needs_input` and single-click still opens WebUI. DND never auto-approves/auto-rejects and never writes acknowledged/notified state.
- `question`/`context`/`options` stay in server memory + (transiently) the main→renderer safe projection; never in the public observer snapshot, settings, logs, audit bodies, or system notification text.
- Audit records only structured non-sensitive fields (capability hash, instance/session/activity/request ids, timestamp, outcome, failure reason).

### 8. Settings and migration

- New desktop setting `askUserInteraction.enabled` defaults to `false`, normalized/migrated in `desktop/main/settings-store.ts` (missing key → `false`). Distinct from `pi-web.json`'s `bundledExtensions["pi-ask-user"]` (which gates whether the tool exists) and from the WebUI dialog (which works regardless of this flag).
- The setting is a presentation/behavior preference, never carries tokens, Prompt text, cwd, or request bodies; `DESKTOP_SETTINGS_FORBIDDEN_KEYS` discipline applies.

### 9. Explicitly out of scope (unchanged from U5)

- No permission approval, no dangerous-command authorization, no auto-approve, no `ctx.ui.confirm` nominal bypass, no global hotkeys (separate review), no change to `ctx.ui.custom()` RPC degradation, no extension of the public observer snapshot.

## Threat Model

| # | Threat | Finding / mitigation |
| --- | --- | --- |
| T1 | 普通 select 被误判为 ask_user | 结构化 provenance + 严格 schema + bundled allowlist；不做时间/工具名/字符串关联（FR-1/FR-2）。 |
| T2 | 多选/freeform/comment 被当成单选 | 形态锁定：三个 flag 必须全 false 且 options 非空，否则不可桌宠应答（FR-2）。 |
| T3 | request id 猜测 / 重放 / 串会话 | capability ≥256-bit、单次、绑定 instance+session+activity+request；`/api/agent/[id]` 无门控路径不被桌面复用（SR-3/SR-4）。 |
| T4 | 请求已过期但桌宠仍显示 | 响应时用 capability 注册表 + live pending 交叉校验，不信 observer 快照（CR-4）。 |
| T5 | renderer compromise 重放 capability | capability 留在 main；renderer 只见描述符 + 有限动作词汇，不接触明文（SR-2）。 |
| T6 | 恶意 Prompt 诱导 | 桌面与 WebUI 呈现同一决策语义，不新增批准语义；上下文默认折叠；本 MVP 不含权限/危险命令（SR-6）。 |
| T7 | 正文/选项泄露到 observer/settings/日志/通知 | 正文只存内存与瞬时 main→renderer 投影；审计只记结构化非敏感字段（SR-1/SR-5/FR-10）。 |
| T8 | DND/隐藏窗口下静默决策 | DND 抑制弹出且禁用应答；托盘保留 needs_input 并回退 WebUI；绝不自动批准/拒绝（FR-6）。 |
| T9 | WebUI/桌宠并发双答 | 共享 `respond()` 首命中；capability 单次消费；服务端合成结算事件关闭陈旧模态（FR-7/CR-3）。 |
| T10 | 跨会话/跨 Subagent 串响应 | capability 绑定 instance+session+activity(promptEpoch)+requestId（T3/SR-4）。 |

## Options

### A. 维持现状（桌宠只提示 + 打开 WebUI）

- **Go/No-go:** 对非 ask_user 的请求保持 **Go（现状）**；对 ask_user 单选不再作为默认，因为本 MVP 的价值正是消除这部分切屏。

### B. 本 MVP：provenance 门控的 ask_user 单选应答

- **用户价值:** 减少 ask_user 决策的切屏。
- **所需数据:** pi-ask-user 结构化 provenance（需 patch）+ 服务端 capability。
- **observer/API/IPC 变化:** 新增独立 `/api/desktop-control/**`、capability 生命周期、main 控制订阅、renderer 有限动作通道。
- **隐私影响:** question/options 瞬时进入 main→renderer 安全投影；不进入 observer/settings/日志/审计/通知。
- **安全风险:** T1–T10 均已映射到缓解；仍须独立安全评审后才允许 Phase 2 实现。
- **Go/No-go:** **Go（Proposed，Phase 0 先验证，Phase 2 前须评审）**。

### C. 通用 U5 桌面响应（confirm/select/input/editor）

- **Go/No-go:** **No-go**，维持 `desktop-pet-needs-input-response.md` 结论不变。

### D. 通用授权 / auto-approve

- **Go/No-go:** **No-go，永远**。

## Consequences

### Positive

- 在不扩大 observer 隐私边界、不引入批准语义的前提下，为最高频、最安全的一类交互（ask_user 单选）提供就近应答。
- 以可验证 provenance 取代脆弱关联，形成可复用的"可信结构化请求"判定模式。
- 保留 U5 的 No-go 结论与 capability 架构草稿，二者不冲突。

### Costs / Risks

- 需要 patch 一个 pinned 第三方依赖（provenance），并承担版本升级时的补丁复核成本；上游 PR 合并前补丁长期存在。
- 新增一个 loopback 控制 API 与 capability 生命周期，攻击面/测试面扩大，须独立安全评审。
- question/options 瞬时进入 renderer 投影，虽不超 WebUI 已展示范围，仍需 renderer 内存清理与 CSP/沙箱回归。
- 若 provenance 校验被放宽或 patch 漂移，可能把普通 select 误判为 ask_user，须以版本锁 + 严格 schema 兜底。

## Open Decisions

1. provenance 注入方式的最终落点（本 ADR 定案为 patch + 并行 upstream PR；若团队拒绝 postinstall patch，则转 vendor）。
2. control token 是否与 observer token 分离（本 ADR 倾向分离，独立 TTL）。
3. capability TTL 取值（建议 60–120 s）与审计 retention 窗口。
4. 独立安全评审的触发时点与范围（Phase 2 实现前必须完成，本文不声称已通过）。
