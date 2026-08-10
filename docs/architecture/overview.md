# Architecture Overview

This document holds the architecture details that should not live in `AGENTS.md`.

## Runtime Flow

```text
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions?view=projects ─▶ project dir scan   │
  ├─ GET /api/sessions?cwd=&limit=10 ─▶ recent page        │
  │   (+ optional before/beforePath cursor)                │
  ├─ GET /api/sessions/archived?cwd=&limit= ─▶ archive page│
  ├─ GET /api/sessions (default) ─────▶ full active list   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  │                        │                               │
  ├─ send message ────────▶ POST /api/agent/[id]           │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ─────────▶ GET /api/agent/[id]/events     │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ────────│                               │
```

Sidebar browsing is intentionally split from full-scan consumers: project discovery and per-cwd recent/archived pages use filesystem metadata plus bounded JSONL parsing with mtime cursors (`before` + `beforePath`) and a small parent-closure so fork children are not flattened when their parent falls outside the current page. Usage and other bulk features keep calling `listAllSessions()` / `listAllArchivedSessions()`.

Project discovery and per-cwd candidate collection are accelerated by a rebuildable on-disk index (`lib/session-index.ts` -> `pi-web-session-index.json` under the agent data dir). Entries cache header summaries keyed by `path + mtimeMs + size` (and archived flag). Unchanged files skip header re-reads; create/modify/delete/archive/unarchive are discovered on the next refresh from disk stats. Per-file isolation skips unreadable or typed-malformed headers (for example non-string `cwd`) without dropping sibling valid sessions. The index is never the authority: corrupt/missing/version-mismatched files rebuild automatically, write failures are ignored, and Windows encoding collisions still group by real `header.cwd`. AppShell owns `activeCwd` as the single workspace source of truth; `SessionSidebar` is a controlled consumer composed from `components/sidebar/*` (including `WorkspacePicker`). Session deletion uses latest-state refs so WorkTree removal fallbacks and newer project selections are not clobbered by stale async callbacks.

## Key Boundaries

- **Instance access gate:** root `proxy.ts` enforces optional global access-key authentication when `PI_WEB_SERVER_MODE=1` (set by `--server`, non-loopback bind, or env). It rejects cross-origin state-changing requests, requires effective HTTPS by default, and returns `401` only after those security gates pass. Opaque HttpOnly sessions live in `server-access.json` (verifier + token hashes only). This gate is independent of and does **not** relax Automation, native picker, or browser-bridge loopback-only policies.
- **Single process:** ordinary chat wrappers, SSE listeners, and access-auth rate limits are process-local. Official launchers and instrumentation refuse known PM2/Node cluster multi-instance markers by default; sticky routing is not a supported multi-replica mode. `GET /api/health` exposes pid/instanceId/live session and SSE aggregates plus Automation scheduler role for ops.
- Session browsing does not create an AgentSession: API routes read `.jsonl` files through `lib/session-reader.ts`; the only write side effect is pruning stale sessions whose cwd points at a deleted WorkTree.
- Sending commands creates or reuses an in-process AgentSession through `lib/rpc-manager.ts`.
- Session detail/context routes reuse the live wrapper's already-parsed `SessionManager` when its canonical session file matches, avoiding another synchronous JSONL parse during active-chat refreshes; inactive sessions still open from disk as the source of truth.
- Client state and SSE streaming behavior are centralized in `hooks/useAgentSession.ts`.
- File viewing and workspace metadata use explicit API routes under `app/api/files/`, `app/api/cwd/`, and `app/api/git/`. The standalone `/file?path=...&line=...` page reuses the same `FileViewer` and API authorization; it never reads arbitrary paths directly. Historical root-level Windows links (`/D:/.../File.java:11`) are compatibility redirects only.

## Project Invariants

### Server access authentication

- Official launchers default to `127.0.0.1` with auth off; any official non-loopback listen enables auth. Explicit `--server` enables auth even on loopback (reverse-proxy layout).
- Server mode requires effective HTTPS unless `--allow-insecure-http` / `PI_WEB_ALLOW_INSECURE_HTTP=1` explicitly opts into compatibility. Auth-bypassed mesh clients do not transmit a key or session and may use their already encrypted transport.
- Server mode must fail closed when auth state is missing/corrupt — never silently open the instance.
- Access keys are shown once; only scrypt verifiers and session hashes are persisted. Logout, expiry, and key rotation invalidate server-side sessions.
- Every state-changing protected request must have an exact browser-facing Origin/Referer match; SameSite alone does not protect against sibling-origin CSRF.
- Auth bypass uses socket client IP only and rejects loopback/world-open rules so a local reverse proxy cannot become an authentication bypass.
- Trusted proxy headers (`X-Forwarded-Proto`, `X-Forwarded-Host`) are ignored unless `PI_WEB_TRUST_PROXY=1` **and** the backend bind is loopback; headers never decide whether auth is required.

### AgentSession lifecycle

- Keep one `AgentSessionWrapper` per session id in `globalThis.__piSessions`; hot reload makes plain module-level maps unsafe.
- Idle timeout is 10 minutes.
- Concurrent `startRpcSession()` calls must share `globalThis.__piStartLocks`.
- After `send("fork")`, capture the new session id and destroy the wrapper immediately. `AgentSession.fork()` mutates `inner.sessionId`; leaving the old wrapper alive can corrupt `parentSession` chains.
- WebUI-owned wrapper teardown emits the SDK `session_shutdown` lifecycle event before `AgentSession.dispose()`. This is required for extension timers, pollers, and UI contexts to release references before the SDK marks them stale.

### Branching model

- Fork creates a new `.jsonl` file and is shown as a child in the sidebar via the header `parentSession` field.
- In-session branch uses `navigate_tree` within the same file. Multiple entries may share a `parentId`; switching branches calls `/api/sessions/[id]/context?leafId=`.

### Session files

- `parentSession` is display metadata only and does not affect chat content.
- Session files are fully rewritable when updating display metadata such as cascade reparenting on delete.
- Deleting or archiving a linked Git WorkTree also deletes session JSONL files whose `cwd` points at that WorkTree; session listing also prunes stale missing `*.worktrees/*` cwd sessions left by older versions.
- Orphaned sessions whose first line cannot be parsed as a valid header are marked `orphaned: true` and displayed as incomplete, not clickable.

### Archive path

Archived sessions are stored at:

```text
~/.pi/agent/sessions-archive/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

Archive/unarchive moves the parent JSONL and its path-derived companion directory between `sessions/` and `sessions-archive/`. The session JSONL content is never modified. Active RPC sessions are destroyed before the artifacts move. Reads retain compatibility with older archives that moved only the parent JSONL and left the companion directory under active sessions.

The archive directory is scanned separately from `SessionManager.listAll()` (which only scans `sessions/`). Project visibility is preserved by returning `archivedCwds` and `archivedCounts` from `GET /api/sessions` (including `view=projects` and per-cwd recent modes), allowing the CWD picker to include projects that have only archived sessions.

Recent-session browse order uses file mtime (then filename timestamp, then path). That differs from historical `SessionManager.listAll()` `modified`, which prefers last message activity time. Page cursors compare `(mtimeMs, path)` so same-second files stay stable. `total` is the header-matched candidate count; `sessions.length` is successfully parsed rows on the page (plus optional parent-closure ancestors). Document this when changing ordering semantics.

### Usage accounting

- The chat top bar's parent-session token/cost totals use the same lifetime billing scope as the Pi CLI: every persisted assistant/tool-result usage plus compaction and branch-summary calls, including compacted-away and abandoned-branch entries. Context percentage remains a separate current-branch, compaction-aware value.
- Usage starts from top-level sessions returned by the active/archive session readers. It never recursively scans the global sessions tree, so orphaned subagent directories whose parent was deleted are not billed.
- For each parent `<session>.jsonl`, `lib/session-artifacts.ts` discovers nested pi-subagents `session.jsonl` files only under the path-derived `<session>/` companion directory. Nested assistant usage contributes to daily/model/provider totals and is attributed to the parent in `bySession`.
- API results expose `mainTotals`, `subagentTotals`, and `subagentSessions` globally and per parent session. Persisted message `usage.cost.total` remains authoritative; Usage does not reprice historical calls from the current model catalog.

### Tool calls and events

- Pi stores tool calls as `{type:"toolCall", id, name, arguments}`.
- Web UI types use `{toolCallId, toolName, input}`.
- Normalize with `normalizeToolCalls()` in `lib/normalize.ts`; it is used during file load and streaming.
- In-process SDK `message_update` events (AgentSession.subscribe, used by the WebUI) remain cumulative token-level snapshots through pi 0.84.1. JSON/RPC wire `message_update` events from 0.84.0+ emit only `assistantMessageEvent` deltas (no cumulative `message` / `partial`) to avoid quadratic growth. `hooks/useAgentSession.ts` prefers `event.message` and falls back to `assistantMessageEvent.partial` when present. `lib/agent-event-throttler.ts` keeps the first and latest snapshots, caps browser delivery to 20 updates/second, and flushes pending text before lifecycle/tool events so SSE ordering is preserved. Hidden browser tabs apply a second 500 ms presentation coalescer; they still consume lifecycle and extension events normally.
- The Subagent panel uses `lib/subagent-runs.ts` for both live tool-call row expansion and persisted message replay. Session/branch loads pair normalized assistant `subagent` calls with tool results to restore final status, output, routing, and child session paths. Live progress/recent-tool snapshots are not persisted by the session format and intentionally degrade after reload.
- Newer pi emits `compaction_start` / `compaction_end`; older pi emits `auto_compaction_start` / `auto_compaction_end`. Handle both.

### Session file-change projection

- Session changed-file UI is sidecar-based and non-Git; do not derive it from `git status` or `git diff`.
- `lib/rpc-manager.ts` forwards live edit/write tool events to `lib/session-file-changes.ts`, which captures bounded before/after text snapshots and persists `~/.pi/agent/session-changes/<session-id>.json`. Projection captures bounded target-file snapshots synchronously at the start/end event boundary so rapid tool mutation cannot corrupt the baseline, then moves sidecar read/parse/diff/write behind asynchronous filesystem operations and a per-session promise queue. This preserves read-modify-write ordering and atomic rename while removing the growing sidecar from the SDK event callback; wrapper teardown drains queued writes.
- Session JSONL files are not modified for this UI-only projection.
- MVP tracks built-in `edit` and `write` tools only; arbitrary `bash` file mutations are not shown unless a future scanner/sandbox design adds explicit support.

### Models and tools

- `GET /api/models` returns `defaultModel` from `~/.pi/agent/settings.json`.
- New-session tool selection is passed to `POST /api/agent/new` as `toolPreset`: `all`, `read-only`, or `none`; legacy `toolNames[]` remains supported.
- Web sessions default to `all`, which expands dynamically through `getAllTools()` so built-in, extension, and custom tools are enabled without editing preset constants. `read-only` enables whichever of `read`, `grep`, `find`, and `ls` are loaded.
- `GET /api/commands` builds a lightweight in-memory SDK session so extension commands registered with `pi.registerCommand()` appear beside prompt templates and skills with source/provenance metadata. `GET /api/pi/resources` exposes the corresponding extension/tool/command diagnostics for debugging package discovery and version mismatches.
- Ordinary Web sessions and their inspection/discovery paths use `lib/bundled-pi-extensions.ts` to load exact pinned copies of `pi-subagents`, `rpiv-web-tools`, `pi-ask-user`, and `pi-manage-todo-list`. `pi-web.json → bundledExtensions` defaults each bundle on. When an enabled package also appears through Pi user/project configuration, the bundled path is kept and the other factory/resource copy is filtered before extension binding; Pi settings remain untouched. Source metadata is rewritten to `webui-bundled:*` for consistent diagnostics. Automation never uses this loader.
- Existing live sessions infer presets via `get_tools` and `getPresetFromTools()`.
- Auth changes call `reloadRpcAuthState()` so live AgentSessions reload auth/model state. The same path also cleans pi-ai session resources because OpenAI Codex keeps reusable WebSockets keyed by session id, and those sockets must reconnect after ChatGPT account activation to pick up new auth headers.
- ChatGPT usage auto-refresh is backend-owned, not browser-tab-owned. The scheduler state lives on `globalThis.__piChatGptUsageRefreshScheduler` and uses `~/.pi/agent/chatgpt-usage-refresh.lock` to reduce duplicate refresh loops across Node processes. Stale lock detection follows the configured refresh cycle dynamically.
- Grok usage auto-refresh mirrors the ChatGPT model: backend-owned on `globalThis.__piGrokUsageRefreshScheduler` with `~/.pi/agent/grok-usage-refresh.lock`, cycling saved accounts under both `xai` and `grok-cli` stores and writing weekly `seven_day` quota caches.
- Before creating an SDK `AgentSession`, `lib/pi-runtime-resolver.ts` prepares a local `pi` shim under `~/.pi/agent/pi-web-runtime/bin/`, prepends it to `PATH`, and makes the WebUI's pi package resolvable from the agent npm directory. Unix-like runtimes also receive `PI_SUBAGENT_PI_BINARY` when unset; Windows relies on package resolution because shell-less Node spawns cannot execute `.cmd` shims directly.
- Web sessions bind Pi extensions in RPC mode through `lib/extension-web-ui.ts`. Simple extension UI requests (`notify`, `confirm`, `select`, `input`, `editor`, status/widget/title/editor text updates) are forwarded through the existing SSE stream; browser responses are returned with `extension_ui_response`. The chat UI renders `setStatus` chips and generic `setWidget` stacks around the composer; the standard `todo-list` widget is projected into a floating task panel with progress and parsed task rows. Blocking dialogs use `ExtensionDialogHost`, and non-blocking `notify` uses `ExtensionToastHost` (no `window.alert`/`confirm`/`prompt`). For `setWidget`, string arrays are forwarded directly; TUI component factories (e.g. `manage_todo_list`) are invoked with a passthrough theme and materialized via `render(width)` into plain text lines. pi-subagents TUI HUDs that overlap the top-bar SubagentPanel (`subagent-fleet-status`, `subagent-async`) are intentionally suppressed in the Web bridge (no materialize/SSE) so subagent observability stays on the top-bar panel only. Fully interactive TUI-only APIs (`custom` components, powerbar chrome, etc.) still degrade with `extension_error` diagnostics instead of blocking silently.
- Extension slash commands (e.g. `/brainstorm`) complete inside `prompt()` without `agent_start`/`agent_end`. The RPC wrapper buffers SSE events until a browser listener attaches, replays pending extension UI requests, and emits `prompt_settled` when `prompt()` finishes without an active stream so the chat UI does not stick on "Waiting for model...". Active sessions keep an SSE connection open while the chat is mounted.
- Prompt-level running state settles on `agent_settled`, not bare `agent_end`. `agent_end` may be followed by auto-retry backoff, auto-compaction recovery, or queued follow-ups; the WebUI keeps `agentRunning` true across that gap and only clears on `agent_settled` (or `prompt_error` / non-agent `prompt_settled`).
- Some relay providers return empty assistant messages with `stopReason: "stop"` + `rawStopReason: "completed"` and zero usage after tool results. Interactive sessions load the hidden inline extension from `lib/empty-completed-retry.ts`, which rewrites those responses into a retryable assistant error so Pi's existing auto-retry path can continue without injecting a user "继续" message. Opt-in is provider-scoped: set `emptyCompletedRetry: true` on a provider in `~/.pi/agent/models.json` (Models UI → provider → **Retry empty completed responses**). The flag is a WebUI extension field; Pi ignores unknown provider keys. It applies to every model under that provider and is re-read from disk on each check so a Models save is enough (no process restart). Final failures surface as a persistent chat error card plus assistant `errorMessage` rendering.
- Slash-command discovery annotates known TUI-only extension commands as `webSupport: "cli-only"` (and some as `partial`) so autocomplete can badge them.
- The sidebar **Extensions** modal inspects SDK resource discovery (`GET /api/pi/resources`, including configured packages and WebUI-bundled status) and edits `settings-extensions.json` through `GET/PUT /api/pi/extension-settings` after discovering registrations emitted on the shared `pi-extension-settings:register` event bus during package load.
- Settings → **Web Search** owns a separate adapter-native config boundary. It projects `rpiv-web-tools` provider/key/base-URL state without returning secrets, separates the persisted default provider from the credential configuration target, honors environment precedence, and writes preserve/replace/clear operations with revision comparison and atomic rename. Because the extension reads its config per execution, these changes apply to later `web_search`/`web_fetch` calls without tearing down the live AgentSession; bundle enable/disable still requires a new session or `/reload`.

## Configuration Boundary: Native Pi Subagents and SnFlow

Native pi-subagent model configuration is owned by Settings → Agents and persists
to `settings.json → subagents` at user scope (`~/.pi/agent/settings.json`) or
project scope (`<cwd>/.pi/settings.json`). SnFlow implement/check agents read
models only from that native path. `pi-web.json → workflow` stores SnFlow panel
preferences such as `includeArchived` and `trackInGit` (legacy `enabled` is
ignored). Unknown raw `pi-web.json` root keys such as legacy `trellis` are never
consumed by the public config projection and are left untouched on disk.

Historical session transcripts may still contain the legacy tool name
`trellis_subagent`. Live SSE and persisted JSONL replay treat that name as an
alias of native `subagent` for Subagent panel projection only; it is not active
product support for a separate Trellis workflow surface.

### SnFlow

Snail Pi Web owns a first-class, opt-in development flow named SnFlow. There is
no global enable switch: project initialization (`.pi/snflows/tasks/` exists)
makes SnFlow resources available but does not route ordinary development through
the workflow. A request enters SnFlow only when the user explicitly asks for it,
invokes `snflow-dev`, asks to create/run a SnFlow task, or continues an active
non-terminal task. For clearly cross-module, high-risk, or long-running work the
agent may ask once whether SnFlow would help; declining keeps the normal direct
path. The SF drawer is always available so users can inspect or initialize the
current workspace. Task documents live under `<cwd>/.pi/snflows/tasks/` (archived
tasks move to the sibling `<cwd>/.pi/snflows/archived/`). SnFlow never shares
schema, import, or writeback with legacy `.trellis/` workflow data; while that
directory remains present in a repository, agents must not write it for SnFlow
work. Implement/check phases run as foreground native `pi-subagents` tool calls
using the managed project agents `snflow-implement` and `snflow-check` in the
current chat session with `agentContract: { version: 1 }`. Legacy marked calls
without the optional run/spec binding remain readable, while newly prepared
calls always use the bound snapshot contract. Their agent definitions
own stable phase responsibilities and safety boundaries: `snflow-check` declares
`acceptanceRole: read-only` and disables the implementation completion guard,
while `snflow-implement` keeps mutation-effect observation so an explicit,
validated `validated_no_change` recovery can be distinguished from plan-only
output. Each marked dispatch carries only task-specific context and the
structured result contract. Check findings are severity-gated:
only `error` findings block and project `changes_requested`; `warning` and
`info` findings remain advisory, pass the check, and are presented to the user
as optional follow-up work. The task-bound API prepares a strict dispatch marker with the selected task id,
phase, canonical cwd, reserved run id, mutable task-state revision, and immutable
specification revision. At reservation, SnFlow revalidates both revisions and
copies the exact approved requirements/design/plan bytes into the run-owned
`runs/<run-id>/snapshot/` directory. Agents verify the marker against the active
run record and read only those snapshot paths; lifecycle projection changes and
later edits to live task documents cannot change an in-flight run's scope.
Before any structured terminal result is projected, SnFlow recomputes the snapshot
digest and fails the run with `snapshot_integrity` if its bytes or canonical paths
no longer match the reserved specification.
`lib/workflow-chat-lifecycle.ts` validates the marker before execution and
projects native tool progress/end events into SnFlow run records through the
shared native-result adapter and terminal reducer. Only structured execution
fields can terminate a run; wrapper prose is display/diagnostic material and
cannot release the active-run lock. Live events, persisted chat recovery, and
native status reconciliation share this policy. This keeps the
existing top-bar Subagent panel authoritative for live progress and removes the
blocking CLI implement/check/wait path. `lib/workflow-run-manager.ts` retains
artifact/session reconciliation for restart and terminal-projection repair, but
is no longer the normal execution host. SnFlow agent models come only from
native `settings.json → subagents`.
`trackInGit` defaults to false so init/update writes a managed block into the
project `.gitignore` covering SnFlow assets and the task store; set it true if
the team wants those files committed.

Project setup (Settings → SnFlow or the panel empty-state) installs managed
assets from the bundled manifest in `lib/snflow-assets.ts`:
`.pi/extensions/snflow/`, `.pi/skills/snflow-dev/`, `.pi/agents/snflow-*.md`,
`scripts/snflow-task.ts`, and `.pi/snflows/.version`. Update rewrites only that
whitelist and never touches task data. Old projects that only have a tasks
directory remain initialized and are prompted to update.

After a request opts into SnFlow, chat stays task-bound: the agent reads and
maintains task docs, uses the current-task pointer, and continues planning or
implementation without requiring the user to re-create the task from the panel.
Initialization controls resource availability, not default workflow entry. If a
project is not initialized, managed project extension/skill/agent files are
filtered out of the session resource loader so leftover assets cannot expose an
unavailable SnFlow path.

The managed project extension also registers `/snflow-spec-review` as an
explicit, optional project-learning review for the current physical,
non-archived task. The command performs deterministic cwd/current-task/document/
Spec preflight, then sends a task-bound, read-only instruction to the current
main Agent; it never dispatches a child or changes workflow state. That first
turn compares task docs, available run results, the relevant diff, and existing
`.pi/snflows/spec/`, then returns stable candidates or `本任务无需更新规范`.
Candidates remain conversation-scoped and are not approval. Only a later user
message accepting or editing candidate ids permits the main Agent to revalidate
current state and update the selected Spec files and affected indexes. V1 has no
task-id/history mode, sidecar, panel action, CLI runner, automatic post-check
trigger, or mandatory `ready_to_commit` gate. Existing initialized projects need
SnFlow Update to receive a newer managed command asset; update still never
overwrites project-owned Spec content.

### Spec Bootstrap and AGENTS.md Managed Section

The bootstrap task `00-bootstrap-spec` fills the specification skeleton under
`.pi/snflows/spec/` with project-specific conventions. After filling specs, it
also creates or idempotently updates the project-root `AGENTS.md` with a bounded
managed section (`<!-- BEGIN SNFLOW SPEC -->` / `<!-- END SNFLOW SPEC -->`).
That section directs future agents to read the root spec index and relevant
layer indexes before implementation or review, follow applicable specs, and
update specs when reusable conventions are learned.

`lib/snflow-spec-templates.ts` owns the exact managed block and embeds it in the
bootstrap task plan. The task replaces only a complete, correctly ordered block,
appends when neither marker exists, and fails visibly on malformed one-marker or
reversed-marker files. Content outside the managed block remains byte-for-byte
unchanged. SnFlow setup itself does not write `AGENTS.md`; the bootstrap task
agent performs that project-specific update after completing the specs.

When active and the project extension is installed, it owns `before_agent_start`
guidance (and skips subagent children via `PI_SUBAGENT_CHILD`). Otherwise, for
backward compatibility, RPC chat sessions still receive active-task breadcrumbs
via `lib/workflow-guidance.ts`. Agents create/start/implement/check through
`scripts/snflow-task.ts` (project) or `scripts/workflow-task.ts` (WebUI package),
and a current-task pointer lives at `.pi/snflows/current.json`. That pointer is
workspace workflow state, not sufficient evidence for the floating chat widget:
the widget resolves through `/api/sessions/[id]/snflow-task` and requires either
an exact pointer `sessionId` match or explicit SnFlow task evidence in that
session's transcript. Blank/new sessions therefore do not inherit another
session's widget, while the owning session can restore it after a browser reload.

### Pi Settings Precedence

Effective model for a subagent child (highest to lowest):

1. Runtime tool-call override (`model` in subagent() call)
2. Chain step / parallel task override
3. Agent frontmatter (`model:` in `.md`)
4. Settings `agentOverrides.<name>.model` (project scope)
5. Settings `agentOverrides.<name>.model` (user scope)
6. Settings `defaultModel` (project scope)
7. Settings `defaultModel` (user scope)
8. Parent session model

Clearing a scope-level field removes the key and restores normal inheritance.
The UI marks inherited values clearly and does not claim selected-scope values
are the final runtime model.

- Nested pi-subagent child processes run through the local pi package CLI prepared by `lib/pi-runtime-resolver.ts` (`node node_modules/@earendil-works/pi-coding-agent/dist/cli.js` when available, or an explicit `PI_WEB_PI_CLI_JS` / legacy `TRELLIS_PI_CLI_JS`); they do not silently rely on a bare `pi` command that may be missing from the WebUI process `PATH`. Session-bound extensions and tools resolve workspace paths from the active SDK session context (`ctx.cwd`), with the server process cwd used only as a compatibility fallback.
- Session-scoped SnFlow task association for the floating chat widget remains high-confidence only (session transcript evidence or an exact per-session current-task pointer). Blank or new sessions do not inherit another session's widget.
- When all tools are disabled, `lib/rpc-manager.ts` clears the agent system prompt.

## Scheduled Agent Automation

Automation is independent of SnFlow and ordinary project sessions:

- Control plane data lives under `getAgentDir()/automations/` (`tasks.json`, store/scheduler locks, claims, runs, promotions, audit, sessions).
- Default task cwd is the once-persisted canonical `~/pi-automation-cwd` (or an explicit project cwd). Runtime never falls back to the server process cwd.
- Next Node `instrumentation.ts` starts the scheduler leader lease. Ordinary WebUI remains available if Automation fails closed.
- `/api/automations/**` is local-only: proven direct loopback via server-derived socket remote address (Host/URL alone are not trusted), same-origin/control-session, and one-time approval challenges bound to action/task/run/revision/policy hash/canonical cwd (and proposed-config hash for sensitive updates). Browser approvals are two-step: create returns the normalized authority summary without a consumable secret; after a real AppDialog confirmation the UI calls `/api/automations/approvals/confirm` to receive the one-time secret, then the mutation consumes it. Body flags such as `confirmed: true` cannot assert approval. This is a loopback UX/control-plane trust boundary, not remote identity authentication.
- Headless runs use frozen authority snapshots ∩ live policy, reviewed immutable web adapters (`web_search`/`web_fetch`), hard outer deadlines, and seal transcripts only after dispose/drain. After the execution barrier, uncertain stale claims become `ambiguous` and are never auto-redispatched.
- Automation JSONL is invisible to default `/api/sessions` lists; sealed terminal runs may be promoted into ordinary project sessions after JSONL structure + SHA-256 seal checks.
- Detailed decision record: `docs/architecture/decisions/automation-scheduler.md`.

## Session File Format

Default location:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

Typical records:

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...]}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":0}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is parallel to `messages[]` and maps displayed messages back to `.jsonl` entry ids for fork and `navigate_tree` commands.
