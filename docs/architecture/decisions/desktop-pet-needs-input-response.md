# Desktop Pet needs_input Response Channel

- **Status:** Proposed
- **Date:** 2026-08-14
- **Scope:** Whether the Windows desktop pet may safely respond to part of `needs_input` requests without leaking Prompt/tool arguments or bypassing the Pi extension UI lifecycle.
- **Requirements:** `docs/brainstorms/2026-08-14-desktop-pet-needs-input-response-requirements.md`
- **Parent plan:** `docs/plans/2026-08-14-001-feat-desktop-pet-competitive-optimization-plan.md` (U5)
- **Related:** `docs/architecture/decisions/desktop-pet-task-observer.md`

## Decision Summary

**No-go for implementation in the current protocol.** The extension UI request payload carries no non-sensitive, structured summary field; `title` / `message` / `options` / `prefill` are extension-authored arbitrary strings that routinely embed command text, file paths, and Prompt fragments — exactly the content the observer privacy boundary exists to exclude from the renderer. Therefore no desktop `confirm` / `select` / `input` / `editor` response can be safely approved or rejected from the pet today, including confirm-only. The pet keeps its current behavior: notify `needs_input` and open the WebUI.

A conditional architecture (separate control API + unguessable single-use capabilities) is specified below, but it is **gated on a future safe-summary source that does not exist today** and is out of scope for this task. This decision does not claim security review has passed; it records the negative result and the gated path.

## Context

### Verified protocol facts

- The blocking dialog `id` is generated **WebUI-side** (`lib/extension-web-ui.ts`, `randomUUID()`), not by Pi. Extensions reach it through `ExtensionWebUiBridge.createContext()` bound in `lib/rpc-manager.ts` with `mode: "rpc"`.
- Payloads (`docs/rpc.md` Extension UI Protocol): `confirm { title, message, timeout? }` → `{ confirmed }`/`{ cancelled }`; `select { title, options[], timeout? }` → `{ value }`/`{ cancelled }`; `input { title, placeholder?, timeout? }` → `{ value }`/`{ cancelled }`; `editor { title, prefill?, timeout? }` → `{ value }`/`{ cancelled }`.
- `title` / `message` / `options` / `prefill` are extension-authored arbitrary strings with no structured provenance, risk category, or safe label. Examples embed command text (`permission-gate.ts`) and session context (`confirm-destructive.ts`).
- Response path: `useExtensionUi.respondExtensionDialog` → `sendAgentCommand(sid, {type:"extension_ui_response", ...})` → `POST /api/agent/[id]` → `extensionUiBridge.respond(response)`. `respond()` matches only `pending.get(id)`; there is no capability/ownership/binding check beyond the (crypto-random) id.
- Expiry/cancel/settled/destroy: WebUI bridge fallback timeout `opts.timeout ?? (hasListener() ? undefined : 120_000)`; Pi agent auto-resolves default when `timeout` present; `AbortSignal` → `cancelled`; new dialog cancels the prior one; session destroy → `rejectAll()`; settle clears `blockingUiIds`; `noteExtensionUiResolved` clears on response accept.
- Observer exposes only `attention=needs_input` + bounded phase; `BLOCKING_EXTENSION_UI_METHODS` is server-side only; method name/id/text/response capability never enter the pet payload (`task-observer-types.ts` forbidden-fields + `desktop-pet-task-observer.md`).
- Gates: observer API is loopback + short-lived hashed token + server-mode access key. `/api/agent/[id]` (response route) has **no loopback/capability gate in local mode**; any local process can POST an `extension_ui_response` whose id it knows. IPC is a narrow allowlist; renderer never holds tokens/absolute URLs.

### Why the observer only exposes attention

The observer privacy boundary deliberately omits cwd, Prompt/firstMessage, messages/output, tool arguments, file paths/content, and raw errors. Extension dialog `title`/`message`/`options` are the approval body itself and, for permission gates, contain the command/path. Exposing them to the renderer would reverse the core privacy decision; exposing only the method name would enable blind approval.

## Threat Model

| # | Threat | Finding |
| --- | --- | --- |
| T1 | 盲批 / 缺少上下文 | 仅 `method`/`attention` 不足以决策；`title/message` 又不可安全下发 → 当前无法两全。 |
| T2 | request id 猜测 / 重放 / 串会话 | id 为 `randomUUID`，猜测不可行；但 `/api/agent/[id]` 本地无 capability，任何本地进程一旦拿到 id 即可解析。若把 id 下发桌宠/日志则风险放大。 |
| T3 | WebUI / 终端 / 桌宠并发响应 | 桥接 `respond()` 首命中即删除；二次响应返回 `false`。但多个客户端各自持 id 时仍可能竞速，需 capability 单次消费语义兜底。 |
| T4 | 请求已过期但桌宠仍显示 | observer 快照可能滞后于 bridge 实际 pending 集合（settle/destroy/新对话框取消）；桌宠显示的 needs_input 可能已失效。capability 必须即时校验，不能只信快照。 |
| T5 | renderer compromise | 桌宠 renderer 沙箱化，但任何下发到 renderer 的摘要/capability 都可能被 compromise 读取并重放。capability 必须留在 main、renderer 只触发布尔/有限枚举动作。 |
| T6 | 恶意 Prompt 诱导 | 扩展对话框文本可被 LLM 影响（`permission-gate` 内嵌命令）；若安全摘要缺上下文，恶意 Prompt 可诱导用户批准危险操作。 |
| T7 | 敏感输入 / 隐私泄露 | `input/editor` 需用户输入自由文本并回传，双向暴露面最大；`select/confirm` 的 title/message 也可能含路径/命令。 |
| T8 | 全局热键误触 | 热键需前台归属 + 可见请求绑定 + 高风险禁用；误触可造成错误批准。 |
| T9 | DND 与隐藏窗口 | DND/隐藏时若仍可响应，等于静默自动决策；必须抑制气泡并回退 WebUI，绝不自动批准/拒绝。 |
| T10 | server mode / access key / CSRF | server mode 下 `/api/agent/*` 受根 proxy access-key + 同源保护；本地模式下无 capability 门控。独立 control API 必须自带 loopback + capability，与 observer 门控一致。 |
| T11 | 审计日志泄密 | 若记录请求正文/摘要/选项，审计成为新的泄露面；必须只记录结构化非敏感字段。 |
| T12 | Subagent 与父会话身份混淆 | 阻塞对话框归属具体 `AgentSessionWrapper`/bridge；capability 必须绑定 instance+session+activity+request，防止跨会话/跨 Subagent 串响应。 |

## Options

### A. 保持现状（桌宠只提示 + 打开 WebUI）

- **用户价值:** 无新增价值；保留现有低打扰提示。
- **所需数据:** 无（当前 `attention` + deep link 已够）。
- **observer/API/IPC 变化:** 无。
- **隐私影响:** 无扩大。
- **安全风险:** 无新增。
- **测试成本:** 无新增；回归现有 `test:desktop-*`。
- **Go/No-go:** **Go（推荐）**。当前边界内唯一安全路径。

### B. confirm-only（仅处理带安全摘要的布尔确认）

- **用户价值:** 减少批准类确认的切屏。
- **所需数据:** 需要一个**非敏感、结构化、服务端派生**的安全摘要。**当前不存在**。
- **observer/API/IPC 变化:** 需新增独立 control API、capability 生命周期、main 侧 capability 持有、renderer 布尔动作通道。
- **隐私影响:** 摘要若透传 title/message 会泄露命令/路径；若仅分类则退回盲批。
- **安全风险:** T1/T4/T5/T6 未解决；恶意 Prompt 诱导风险高。
- **测试成本:** 高（capability 生命周期、竞态、过期、DND、审计、妥协面）。
- **Go/No-go:** **No-go（当前）**，除非未来引入安全摘要来源。即便有，也必须先过独立安全评审。

### C. 完整桌面表单（select/input/editor）

- **用户价值:** 完整桌面交互，接近 WebUI。
- **所需数据:** 完整 options/prefill/placeholder 等正文——全部敏感/不可信。
- **observer/API/IPC 变化:** 最大：表单状态、自由文本回传、焦点/IME/多行编辑。
- **隐私影响:** 双向泄露面最大；input/editor 文本回传服务端。
- **安全风险:** T7 全部命中；renderer 表单是主要攻击面。
- **测试成本:** 极高（表单、IME、焦点、剪贴板、CSP、IPC 校验）。
- **Go/No-go:** **No-go**，且仅可在重新评审后考虑，与本需求边界冲突。

### D. 通用授权 / auto-approve

- **用户价值:** 表面便利，实际消除人工把关。
- **所需数据:** 无。
- **隐私影响:** 无新增，但绕开所有人工决策。
- **安全风险:** 直接违反“知情决策优先”；等于给 LLM 自批权限。
- **测试成本:** 无意义。
- **Go/No-go:** **No-go**，永远。不符合当前 attach-only、服务端权威、最小隐私边界。

## Recommended Architecture (conditional, gated)

The following is **not** implementable today because no safe-summary source exists. It is recorded as the shape to adopt **if and only if** a future protocol adds a server-verifiable non-sensitive summary.

1. **Independent control API, not an extension of the public observer snapshot.** A new loopback-only route family (e.g. under a distinct `/api/desktop-control/` namespace) with the same gate strength as `/api/desktop-observer/**`: direct IPv4 loopback peer + Host, short-lived hashed token mint, server-mode access key, exact same-origin or absent Origin (Electron main). The read-only `TaskObserverSnapshot` never carries request bodies, ids, or summaries.
2. **Capability model.** Server mints, on a blocking `extension_ui_request`, an unguessable (≥256-bit crypto random), short-lived (seconds–minutes, ≪ observer token TTL), single-use capability that binds `instanceId + sessionId + activityId (promptEpoch) + requestId`. Only the capability holder (Electron main) can post the response; consumption is one-shot and atomic; a second response is a no-op.
3. **Binding.** The capability is recorded in a server-side registry keyed by `requestId`, cross-checked against the owning wrapper's `ExtensionWebUiBridge.pending` set at response time so a stale/consumed/expired request cannot be satisfied. Instance change, settle, destroy, and new-dialog-cancel invalidate the registry entry.
4. **Minimal informed summary.** Server derives a bounded, non-sensitive descriptor from an **allowlisted classification** (extension id + declared category + a server-verified safe label), never from `title/message/options/prefill` verbatim. If no classification exists, the request is **not desktop-answerable** and falls back to WebUI.
5. **Never into the renderer.** Prompt text, tool arguments, command text, paths, option values, and the capability secret itself stay in main/server. The renderer receives at most: a bounded safe descriptor + a finite action vocabulary (approve/reject for a specific classified confirm). Free-form input/select/editor are excluded from renderer handling.
6. **Expiry / cancel / settled / concurrency.** Every response is validated against live pending state; expired/cancelled/settled requests return a definitive "stale" result and trigger WebUI fallback; concurrent responses race on one-shot consumption and only one wins.
7. **WebUI fallback.** On any capability failure, stale state, DND, hidden window, or unclassifiable request, the pet only `openActivity`s the deep link; the browser owns the dialog.
8. **DND.** DND suppresses the desktop bubble and disables desktop response affordances; it never auto-approves/auto-rejects, and it never writes `acknowledgedTransitionIds` or observer/task state.
9. **Audit.** Record only structured, non-sensitive fields (capability id hash, session/activity/request ids, timestamp, outcome, failure reason). Never record Prompt, summary text, tool args, command text, paths, or option values. This mirrors the observer forbidden-fields discipline.
10. **Global hotkeys deferred.** Any global hotkey needs its own foreground-ownership, visible-request-binding, and mis-trigger design; it is out of scope and must not precede the base capability work.

Because no safe-summary source exists, **the recommended near-term outcome is Option A**, and the conditional architecture above remains a design sketch, not an approval to build.

## Consequences

### Positive

- Preserves the observer privacy boundary and attach-only model unchanged.
- Avoids shipping a blind-approval or summary-leaking surface.
- Records a reusable, gated control-API/capability sketch for when a safe-summary source appears.

### Costs / Risks

- No desktop needs_input response in the near term; users keep switching to WebUI.
- The gated architecture depends on an upstream Pi protocol addition (a declared, verifiable non-sensitive summary field) that is neither specified nor scheduled.
- If a future implementation proceeds without that source, it would reintroduce T1/T5/T6 (blind approval or summary leakage) and must be rejected at review.

## Open Decisions

1. Whether to invest in an upstream Pi `extension_ui_request` safe-summary field (structured `safeLabel`/`category`/`risk`, extension-declared and server-validated). This is the gating decision.
2. Whether Phase 0 (protocol verification + pure domain model, no runtime code) is authorized as the only immediately permitted work.
3. Audit retention window and minimum field set.
