# API Module Map

API routes live under `app/api/`. When adding, removing, or changing routes, update this file and the short index in `AGENTS.md`.

| Route | Methods | Purpose |
| --- | --- | --- |
| `sessions/` | GET | Session browser/list API. Modes: `?view=projects` returns lightweight project summaries for the sidebar; `?cwd=<path>&limit=10&before=&beforePath=` returns one mtime-ordered page of active sessions for a project (bounded JSONL parse + parent-closure ancestors) with `total` / `hasMore` / `nextBefore` / `nextBeforePath`; default (no view/cwd) remains the full active session list for Usage/compat callers. Always includes `archivedCwds` / `archivedCounts`. |
| `sessions/search/` | GET | Workspace-scoped full session search independent of recent/archived pagination. Query: `cwd` (required), `q` / `query`, `includeArchived` (default true), `limit` (default 50, hard cap 100). Matches indexed `name` + `firstMessage` only (not full chat bodies). Response: `{ sessions, total, hasMore, query, cwd, limit }` with flat newest-first rows and `archived` flags. |
| `sessions/[id]/` | GET/PATCH/DELETE | Read session detail, rename, delete. Returns `archived: true` for archived sessions. GET reuses a matching live RPC session's parsed manager and falls back to disk for inactive sessions; `sessionStats` aggregates every persisted billed entry so compacted and abandoned-branch history matches the Pi CLI lifetime totals. Optional `sessionPerformance` is a separate accurate aggregate (weighted TPS / TTFT / sample count / provider-model breakdown) from the WebUI sidecar; missing/empty/corrupt sidecars return `null` without failing the detail request. DELETE awaits live wrapper destroy+flush, then removes artifacts plus both the changed-file and performance sidecars. |
| `sessions/[id]/context/` | GET | Get context for a specific `leafId`; reuses a matching live parsed manager when available. |
| `sessions/[id]/changes/` | GET | List files changed by tracked agent file tools in this session from non-Git sidecar data. |
| `sessions/[id]/changes/file/` | GET | Return the stored unified diff or metadata-only reason for one tracked session-changed file. |
| `sessions/[id]/snflow-task/` | GET | Resolve the SnFlow task associated with one pi session. Uses an exact `current.json.sessionId` match or explicit task evidence from that session transcript; cwd-global or unbound pointers alone never surface the floating widget. |
| `sessions/[id]/export/` | GET | Export session as Markdown. |
| `sessions/new/` | 410 | Deprecated route kept for compatibility. |
| `agent/new/` | POST | Create a new session and send the first message. |
| `agent/[id]/` | GET/POST | Get agent state or send a command. |
| `agent/[id]/events/` | GET | SSE event stream. Ordinary subagent progress is coalesced per tool call to 300 ms and carries bounded summary metadata only (no partial output); terminal/failure/timeout/attention states remain immediate. Terminal result text is capped to an 8k preview; full bounded detail remains in session artifacts. |
| `agent/subagent-children/` | GET | On-demand direct-child/detail projection for a native `session.jsonl` artifact under the canonical sessions root. Requires depth 1–3, performs bounded async head/tail parsing, caps children/output, returns truncation/fingerprint metadata, supports ETag/304, and never recursively scans descendants. |
| `files/[...path]/` | GET/PUT | List/read/watch/preview workspace files for the file viewer and safely save existing editable text files. |
| `files/search/` | GET | Bounded async filename search for Composer `@` mentions and future quick-open surfaces. Breadth-first traversal ignores dependency/build directories, honors request cancellation, and stops at fixed result, entry, or time budgets; additive `truncated` / `scannedEntries` fields report partial scans. |
| `files/definitions/` | GET | Lightweight workspace text/code symbol definition search for editor drill-down actions. |
| `files/implementations/` | GET | Lightweight workspace search for Java symbol implementations/references used by the Monaco file editor. |
| `files/references/` | GET | Lightweight workspace text/code symbol reference search for editor “find usages” actions. |
| `files/upload/` | POST | Upload files for chat/file workflows into a controlled `getAgentDir()/uploads/<sessionId>/` tree. Multipart `File.name` is sanitized to a basename, containment-checked, and written with exclusive create (`wx`); response `{ name, storageName, path, size }` keeps a human display name while `path` never leaves the upload root. |
| `models/` | GET | List cwd-scoped available models and the project-aware default model, including `supportsImage` capability metadata used by Vision settings and attachment routing, plus WebUI-only `primaryCandidate` flags from the independent model-favorites store (chat picker short list). Complete metadata is cached briefly per canonical cwd with in-flight deduplication; `?refresh=1` rebuilds and replaces that cache entry after model/auth/favorite changes. |
| `model-favorites/` | GET/PATCH | Read or immediately toggle user-global WebUI model favorites for built-in, subscription, extension, and custom models. The first write seeds `~/.pi/agent/model-favorites.json` from legacy `models.json` `primaryCandidate` flags; after the sidecar exists it is authoritative. |
| `models-config/` | GET/PUT | Read/write `~/.pi/agent/models.json`. |
| `models-config/discover/` | POST | Fetch an OpenAI-compatible draft provider's remote `/models` list server-side and return selectable model candidates without mutating `models.json`. |
| `models-config/test/` | POST | Test a model config with a completion request. |
| `model-pricing/` | GET/POST | GET returns cache summary, cached model-id lookup (`?model=&provider=`), ambiguous provider/model/cost candidates for manual matching, or the normalized catalog (`?catalog=1`, including `contextWindow`); POST fetches `https://pi.dev/api/models`, validates, persists atomically, and returns sync result. GET never performs upstream network I/O. |
| `skills/` | GET | List installed skills for a cwd. |
| `skills/search/` | GET | Search skills.sh for available skills. |
| `skills/install/` | POST | Install a skill via `npx skills add`. |
| `commands/` | GET | List slash commands from extension commands, prompt templates, and skills for a cwd, with provenance metadata and diagnostics. |
| `pi/resources/` | GET | Inspect Pi SDK resource discovery for a cwd: configured packages, WebUI-bundled extension status/duplicate suppression, loaded extensions, tools, extension commands, skills, prompts, agent dir, and diagnostics. |
| `pi/extension-settings/` | GET/PUT | Discover registered `pi-extension-settings` definitions for a cwd, read current `settings-extensions.json` values (including orphan keys), and apply patch/replace writes. |
| `cwd/validate/` | POST | Validate a candidate workspace path. |
| `cwd/browse/` | GET | List child directories on the WebUI server machine for the project path picker (`?path=`). Empty/missing path returns top-level roots (Home + Windows drives or `/`). Directories only; does not read file contents. Selecting a project still requires `POST /api/cwd/validate`. |
| `cwd/pick-native/` | GET/POST | Local-only host OS folder chooser for Add Project. GET probes loopback local-access + OS backend support (`preferNative`). POST opens the server-side native dialog (Windows FolderBrowserDialog, macOS `osascript` choose folder, Linux zenity/kdialog) and returns `{ path }` or structured `cancelled` / `unavailable` / `busy` / `timeout` codes. Requires proven direct loopback; remote clients fall back to `cwd/browse`. |
| `cwd/open/` | POST | Open an authorized workspace directory in the host OS file manager (Windows `explorer.exe`, macOS `open`, Linux `xdg-open`). Body `{ cwd }`; rejects paths outside allowed roots. Opens on the WebUI server machine, not the browser client. |
| `git/worktrees/` | GET/POST/DELETE | Inspect, create, and remove Git worktrees from the selected cwd; removal also deletes sessions for that worktree cwd. Git subprocesses have a 120-second kill timeout so hooks/locks/filesystems cannot hold the API indefinitely. |
| `sessions/archive/` | POST | Archive one or more sessions (moves to `sessions-archive/`). |
| `sessions/unarchive/` | POST | Unarchive one or more sessions (moves back to `sessions/`). |
| `sessions/archive-all/` | POST | Archive all sessions for a cwd. |
| `sessions/archived/` | GET | List archived sessions for a cwd. Optional pagination: `limit` (default 20), `before`, `beforePath` → paged response with `total` / `hasMore` / `nextBefore` / `nextBeforePath`. Without pagination params, returns the full archived list for the cwd (compat). |
| `git/worktrees/archive/` | POST | Squash, push, merge, and remove a Git worktree after user risk confirmation; archive also deletes sessions for that worktree cwd. |
| `git/info/` | GET | Return best-effort Git branch/worktree metadata for a cwd. |
| `git/status/` | GET | Return detailed Git status (branch, commits, staged/unstaged changes, untracked files, stash) for a cwd. |
| `git/graph/` | GET | Return decorated commit graph data (commits, parents, refs, local branches) for the Git panel branch visualization; optional `branch` previews one validated local branch. |
| `git/commit/` | GET | Return read-only metadata and first-parent/root changed-file stats for a selected commit in the Git panel. |
| `git/diff/` | GET | Return a bounded read-only unified diff, or binary/too-large/unavailable fallback metadata. Commit mode uses `hash`; working-tree mode uses `scope=staged|unstaged`. Both require `cwd` + `path` and support `oldPath` for renames. |
| `git/switch/` | POST | Switch the current workspace to a local branch. Validates cwd, branch existence, and working tree cleanliness before executing `git switch`. Returns `switchedTo` on success or an error message. |
| `subagents/config/` | GET/PUT | Read/write native `pi-subagents` model configuration in Pi `settings.json` for user-global or selected-project scope. GET returns managed fields, discovered agents, discovery diagnostics, and user-scope projection for project scope. PUT applies a managed-field patch with revision-based conflict detection, validates model ids against the Pi model registry, and returns the refreshed projection. |
| `mcp/config/` | GET/PUT | Read/write adapter-native MCP configuration files owned by `pi-mcp-adapter` (not `pi-web.json`). GET returns package configured state (settings metadata only), ordered source/precedence summaries (including read-only `~/.agents` paths), selected target redacted projection, revision, and parse diagnostics. PUT applies a bounded operation list with revision compare-before-write and atomic same-directory rename. Existing `env`/`headers`/`bearerToken`/`oauth.clientSecret` values are never returned; secret edits use preserve/replace/clear. Successful writes return `reloadRequired: true` and never restart sessions. |
| `web-tools/config/` | GET/PUT | Read/write the XDG-aware adapter-native `rpiv-web-tools/config.json`. GET returns the pinned provider catalog, effective/persisted default provider and environment-source metadata, redacted configured-key state, non-secret self-hosted URLs, revision, and parse diagnostics—never API-key values. PUT accepts a known default `provider`, an optional independent `credentialProvider` (defaults to `provider` for compatibility), and explicit key/URL preserve/replace/clear operations. It rejects raw/path payloads and stale revisions, preserves unknown package fields, and writes atomically. Successful changes apply to subsequent Web tool calls without restarting sessions. |
| `web-config/` | GET/PUT | Read/write `~/.pi/agent/pi-web.json` for WorkTree defaults, Usage scan scope, Vision fallback enablement/model selection, Web Terminal settings, ChatGPT usage panel/warmup schedule settings, Editor implementation/shortcut settings, Grok usage panel toggle, per-bundle core extension enablement, and SnFlow panel preferences such as `includeArchived` (compat key `workflow`; legacy `enabled` ignored). Public config exposes only supported sections; PUT rejects unsupported keys and preserves unknown raw root keys such as legacy `trellis` without consuming them. Also lazily ensures the local ChatGPT warmup scheduler. |
| `terminal/env/assist/` | POST | Use the configured Terminal env assistant model to parse complex raw env text into normalized key-value env entries. |
| `terminal/sessions/` | POST | Create a local Web Terminal session for an authorized workspace cwd when the Terminal setting is enabled. |
| `terminal/sessions/[id]/` | DELETE | Close a Web Terminal session and terminate its process. |
| `terminal/sessions/[id]/events/` | GET | Stream Web Terminal output through SSE. |
| `terminal/sessions/[id]/input/` | POST | Write user input to a Web Terminal session. |
| `terminal/sessions/[id]/resize/` | POST | Resize a Web Terminal PTY. |
| `quick-commands/` | GET | List enabled project quick commands for an authorized `cwd`, plus active/recent run summaries. Project-scoped; follows workspace isolation. |
| `quick-commands/config/` | GET/PUT | Read/write `<cwd>/.pi/quick-commands.json` with revision compare-before-write. PUT accepts command definitions only (name/command required; relative cwd; env overrides). Never executes commands. |
| `quick-commands/runs/` | GET/POST | GET lists in-memory recent/active runs for a cwd. POST starts a one-shot run by saved `commandId` only (server re-reads project config; rejects client-supplied command text). May return `428` + trust preview when first-run/changed/always-confirm. Duplicate active command returns the existing run with `alreadyRunning`. |
| `quick-commands/runs/[id]/` | GET/DELETE | GET run detail + bounded recent output. DELETE dismisses a finished run from the recent list (does not affect active processes). |
| `quick-commands/runs/[id]/events/` | GET | SSE stream: snapshot, output chunks, status transitions, heartbeats. Reconnect replays bounded buffer. |
| `quick-commands/runs/[id]/cancel/` | POST | Cancel an active run and terminate its process tree. |
| `browser/status/` | GET | Browser control feature/bridge status, paired installations, optional session binding projection (`?sessionId=`), and `pendings[]` (all open bind requests). `pendingGlobal` is only set when exactly one pending exists. Never returns raw Chrome tab ids or installation secrets. |
| `browser/pair/` | GET/POST | Issue/exchange installation pairing codes, issue short-lived WebSocket connect tokens, and enable/configure the loopback browser bridge. A WebUI-issued code may carry a one-time real-session binding intent; exchange creates that session's pending bind request, while the active tab is still authorized only by the extension's authenticated WebSocket accept triggered by the explicit popup click. Pairing credentials alone never grant tab access. Persists to atomic `browser-bridge.json`. In server mode, WebUI `issue`/`configure` stay behind access-key auth + exact origin; extension-owned `exchange`/`connect_token` skip cookie/same-origin only so the unpacked extension can reach `http://127.0.0.1`, and those actions still require a proven loopback TCP peer. |
| `browser/unpair/` | POST | Revoke one or all paired extension installations and their temporary tab bindings. Extension calls are cookie-free on loopback; the route always requires a proven loopback peer. |
| `browser/bindings/` | GET/POST | Session-scoped pending bind requests, list/set-primary/revoke bindings, closed-tab diagnostics, extension accept flow, and explicit per-binding debug enable/disable. Pending list action returns `pendings[]` (optional `sessionId` filter); single `pending` only when unambiguous. Uses real Pi `sessionId` only (rejects temporary `new-*` ids). HTTP accept is rejected — accept is WS-only. |
| `workflows/setup/status/` | GET | Inspect SnFlow project initialization, bundled vs project asset version, and managed extension/skill/agent/script presence for an authorized cwd. Not gated on the panel enable switch so Settings can configure SnFlow while the drawer is off. |
| `workflows/setup/init/` | POST | Create `.pi/snflows/tasks` + `archived`, install managed SnFlow assets (extension/skill/agents/script), and write `.pi/snflows/.version`. Project init alone activates SnFlow for that cwd. |
| `workflows/setup/update/` | POST | Rewrite managed SnFlow assets and bump `.version` for an already-initialized project without touching task data. |
| `workflows/current/` | GET | Return the cwd current SnFlow task pointer and detail for an authorized cwd. |
| `workflows/tasks/` | GET/POST | List or create WebUI-owned SnFlow tasks under `<cwd>/.pi/snflows/tasks/` for an authorized cwd. Uninitialized projects return an empty state. POST may seed from `sessionId` / `seedText`. |
| `workflows/tasks/[taskId]/` | GET/PUT | Read or revision-checked update one SnFlow task metadata/documents. |
| `workflows/tasks/[taskId]/runs/` | POST | Validate the selected SnFlow task/revision/phase and return an exact current-chat native `subagent` dispatch instruction. The run starts only when that marked tool call passes the server lifecycle validator. |
| `workflows/runs/[runId]/` | GET | Reconcile and return one SnFlow run plus parent task projection. |
| `workflows/runs/[runId]/cancel/` | POST | Stop an active native SnFlow run and reconcile. |
| `workflows/tasks/[taskId]/complete/` | POST | Record commit metadata and/or mark a SnFlow task completed. |
| `workflows/tasks/[taskId]/archive/` | POST | Archive a completed/cancelled SnFlow task by moving it to `.pi/snflows/archived/<task-id>/`. |
| `default-cwd/` | POST | Create and return `~/pi-cwd-<YYYYMMDD>`. |
| `home/` | GET | Return `os.homedir()`. |
| `server-auth/status/` | GET | Public probe: `{ authRequired, httpWarning }` only — no project/session metadata. |
| `health/` | GET | Public minimal runtime health: `pid`, `instanceId`, `mode`, `bind`, `liveSessions`, `sseListeners`, `singleInstance`, and Automation `scheduler` role/aggregates. No session ids, cwds, paths, or secrets. |
| `version-check/` | GET | Compare running web/spi (`@twofive/snail-pi-web`) and pi (`@earendil-works/pi-coding-agent`) versions against the public npm registry latest tags. Returns `{ web, pi, checkedAt, cached }` with per-package `current` / `latest` / `updateAvailable`; registry failures stay `updateAvailable: false` (no 5xx). Optional `?refresh=1` bypasses the in-process cache. Used by the empty new-session version row. |
| `server-auth/login/` | POST | Exchange access key for a 7-day HttpOnly session cookie (server mode). Requires effective HTTPS by default, exact same-origin, a bounded 4 KiB streamed JSON body, and a socket-IP attempt budget; generic errors. |
| `server-auth/logout/` | POST | Revoke current server session hash and clear cookie (idempotent). |
| `usage/` | GET | Aggregate persisted token/cost usage across active-only or active-plus-archived parent sessions and their nested native subagent sessions, including main/subagent splits. Query: `from`/`to` (`YYYY-MM-DD`, default last 7 local days), optional `cwd`, optional `timeline=auto`. Default response keeps daily `byDay` rows for compatibility. `timeline=auto` attaches a self-describing day/ISO-week/month `timeline` (zero-filled buckets clipped to the selected range) and omits `byDay` chart rows; thresholds are ≤31 day, 32–180 week (Monday start), ≥181 month. Totals/model/provider/session accounting and declared server-local `scope.timezone` are unchanged. |
| `auth/providers/` | GET | List OAuth/subscription providers. `loggedIn` is true only when the active auth is OAuth (API-key-only credentials on dual-auth providers like `xai` do not count). |
| `auth/all-providers/` | GET | List API-key-capable built-in providers (excludes primary OAuth-only ids and `models.json` custom keys). `configured` is true only for non-OAuth auth so an xAI subscription login does not also surface a separate active "xAI" API-key row. |
| `auth/accounts/[provider]/` | GET/POST/PATCH/DELETE | List saved OAuth accounts, import one or more raw/CPA/SUB2API OAuth account JSON entries, update account remarks/extra info, return cached quota reset metadata, and soft-delete inactive saved accounts for supported providers (`openai-codex`). |
| `auth/accounts/[provider]/activate/` | POST | Activate a saved OAuth account and reload live RPC auth state. |
| `auth/login/[provider]/` | GET/POST | Initiate OAuth login for a provider; `openai-codex?accountMode=add` saves another account without replacing active auth. |
| `auth/logout/[provider]/` | POST | Clear OAuth tokens for a provider. |
| `auth/api-key/[provider]/` | GET/POST/DELETE | GET returns API-key auth status (never the key); OAuth credentials do not count as configured. POST sets a stored API key. DELETE clears the stored credential. |
| `auth/balance/[provider]/` | GET | Query DeepSeek account balance. |
| `auth/quota/[provider]/` | GET/POST | GET queries OpenAI Codex subscription quota and reset-credit availability for the active account, or for a saved account with `?accountId=...`; queries update the saved account's cached quota/reset-credit metadata and refresh expired saved-account OAuth tokens when possible. POST consumes one available Codex reset credit for the active account or JSON `{ accountId }`, then returns freshly queried quota. |
| `auth/usage/grok-cli/` | GET | Query Grok subscription structured weekly billing usage. Cache mode is local-only. Refresh resolves env/stored `grok-cli` or built-in `xai` credentials directly without AgentSession/extension initialization, then fetches weekly billing (`/billing?format=credits`) with a 15-second deadline. Cache overwrites only on weekly success. Optional `accountId` + `provider` (`grok-cli`\|`xai`) query a saved OAuth account without activating it, writing weekly progress into that account's `quotaCache` (and the shared cache when the account is active). Returns browser-safe structured data with no credentials. |
| `auth/warmup/openai-codex/` | GET/POST | GET returns recent ChatGPT/Codex warmup history and lazily ensures the local scheduler. POST warms selected saved OAuth accounts by sending a tiny real Codex request without activating them; returns per-account results, records manual run history, and refreshes quota cache when possible. |
| `chatgpt/usage-refresh/status/` | GET | Ensure and inspect the backend ChatGPT usage auto-refresh scheduler, including lock diagnostics and last-run state. |
| `chatgpt/usage-refresh/ensure/` | POST | Start or re-arm the backend ChatGPT usage auto-refresh scheduler according to `pi-web.json`. |
| `chatgpt/usage-refresh/repair-lock/` | POST | Risk-gated stale lock repair for the ChatGPT usage auto-refresh scheduler. Requires `{ confirm: true }`. |
| `chatgpt/usage-refresh/run/` | POST | Trigger a best-effort immediate ChatGPT usage refresh cycle through the backend scheduler. |
| `grok/usage-refresh/status/` | GET | Ensure and inspect the backend Grok usage auto-refresh scheduler (xAI + grok-cli accounts), including lock diagnostics and last-run state. |
| `grok/usage-refresh/ensure/` | POST | Start or re-arm the backend Grok usage auto-refresh scheduler according to `pi-web.json`. |
| `grok/usage-refresh/repair-lock/` | POST | Risk-gated stale lock repair for the Grok usage auto-refresh scheduler. Requires `{ confirm: true }`. |
| `grok/usage-refresh/run/` | POST | Trigger a best-effort immediate Grok usage refresh cycle through the backend scheduler. |

## Implementation Pointers

- Agent command routes should go through `lib/rpc-manager.ts`.
- Session-file routes should use `lib/session-reader.ts` and shared types in `lib/types.ts`.
- Client-side command calls should use `lib/agent-client.ts`.
- Normalize streamed/file-loaded tool calls through `lib/normalize.ts`.

## Desktop observer routes

Attach-only desktop pet API. **Direct IPv4 loopback (`127.0.0.1`) only** — Host must be `127.0.0.1` (not `localhost`). Server mode is allowed on proven loopback; when global access-key auth is on, `session` requires a valid access key in the JSON body. Snapshot/events require a short-lived hashed token from `session`. Root server-access auth never relaxes the loopback gate. Proxy may skip the browser session cookie for proven loopback peers on these paths. Ordinary Agent activities may include the bounded current provider/model identifier plus numeric-only context usage, lifetime billing/Token totals, and weighted TPS. Payloads never include cwd, Prompt/firstMessage, tool args, command text, or raw errors.

| Route | Methods | Purpose |
| --- | --- | --- |
| `desktop-observer/protocol/` | GET | Loopback protocol/product/mode probe. Reports `authRequired:true` in server mode; always `compatible:true` for loopback-capable builds. Additive `capabilities` may include `quick_session`. No token. |
| `desktop-observer/session/` | POST | Mint short-lived observer token (`x-spi-desktop-observer-token`). Origin exact loopback match or absent (Electron main). Server mode body: `{ accessKey }`. |
| `desktop-observer/snapshot/` | GET | Current bounded multi-source snapshot (`?reset=1` for baseline). Token required. `Cache-Control: no-store`. |
| `desktop-observer/events/` | GET | Full-snapshot SSE + heartbeat comments. Initial event is always `reset`. Token expiry closes the stream. |

Implementation: `lib/desktop-observer-access.ts`, `lib/task-observer-hub.ts`, adapters under `lib/task-observer-*.ts`. Activity `deepLink` values are allowlisted relative WebUI paths from `lib/desktop-deep-link.ts` (Agent `?session=`, SnFlow `inspector=snflow&task=`, Automation `panel=automation`, Quick Command `panel=quick-commands`).

## Desktop control routes

Narrow write API for the desktop pet first-message composer. **Not a public or cookie-trusted API.** Same proven-loopback Host/`127.0.0.1` gate as observer; server mode requires the access key at session mint. Control tokens (`x-spi-desktop-control-token`, 5-minute TTL, `quick_session` scope) are independent of observer tokens and never accepted on observer routes. Body budget for create is 32 KiB / 8,000 characters. Success means the session was created and the first Prompt dispatched; provider outcome stays on the observer.

| Route | Methods | Purpose |
| --- | --- | --- |
| `desktop-control/session/` | POST | Mint scoped control token. Origin exact loopback match or absent (Electron main). Server mode body: `{ accessKey }`. |
| `desktop-control/projects/` | GET | Bounded path-free project catalog (`projectRef`, safe labels, recency, truncation). No cwd/firstMessage. Token required. |
| `desktop-control/quick-sessions/` | POST | `{ projectRef, message, requestId }` creates one session via the shared new-session starter. Same requestId is idempotent inside one instance. Token required. |

Implementation: `lib/desktop-control-access.ts`, `lib/desktop-project-catalog.ts`, `lib/desktop-quick-session.ts`, `lib/new-agent-session.ts`. Smoke: `npm run test:desktop-quick-session`.

**Desktop client packaging** is separate from this API and from npm `spi`: Electron pet sources live under `desktop/`, pack contract in `forge.config.ts`, validation in `docs/operations/desktop-pet-validation.md`, smoke `npm run test:desktop-package`. The pet consumes these routes from main only (token never reaches the renderer).

## Automation routes

Local-only (`direct loopback` + Automation control session). Sensitive mutations require a one-time approval challenge.

| Route | Methods | Purpose |
| --- | --- | --- |
| `automations/session/` | POST | Issue HttpOnly SameSite=Strict control-session cookie. |
| `automations/approvals/` | POST | Create one-time approval challenge bound to action/revision/policy/cwd. |
| `automations/tasks/` | GET/POST | List tasks / create draft. |
| `automations/tasks/[taskId]/` | GET/PUT/DELETE | Get/update/archive task. |
| `automations/tasks/[taskId]/actions/` | POST | activate/resume/pause/archive. |
| `automations/tasks/[taskId]/runs/` | GET/POST | List runs / run-now. |
| `automations/runs/` | GET | List runs (optional `taskId`). |
| `automations/runs/[runId]/` | GET | Run detail. |
| `automations/runs/[runId]/session/` | GET | Read-only Automation transcript by run id. |
| `automations/runs/[runId]/changes/` | GET | Changed-file sidecar projection for a run session. |
| `automations/runs/[runId]/changes/file/` | GET | Single-file diff for a run session. |
| `automations/runs/[runId]/cancel/` | POST | Best-effort cancel. |
| `automations/runs/[runId]/promote/` | POST | Promote sealed transcript to ordinary project session. |
| `automations/runs/[runId]/export/` | POST | Export JSONL (approval required). |
| `automations/runs/[runId]/artifacts/` | DELETE | Delete retained artifacts; keep tombstone/audit. |
| `automations/scheduler/status/` | GET | Leader/heartbeat/disable/repair diagnostics. |
| `automations/scheduler/repair-lock/` | POST | Repair corrupt/stale scheduler lock. |
| `automations/catalog/` | GET | Headless tool catalog descriptors. |
