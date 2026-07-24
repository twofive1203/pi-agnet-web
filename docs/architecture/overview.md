# Architecture Overview

This document holds the architecture details that should not live in `AGENTS.md`.

## Runtime Flow

```text
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ───▶ reads ~/.pi/agent/sessions/    │
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

## Key Boundaries

- Session browsing does not create an AgentSession: API routes read `.jsonl` files through `lib/session-reader.ts`; the only write side effect is pruning stale sessions whose cwd points at a deleted WorkTree.
- Sending commands creates or reuses an in-process AgentSession through `lib/rpc-manager.ts`.
- Client state and SSE streaming behavior are centralized in `hooks/useAgentSession.ts`.
- File viewing and workspace metadata use explicit API routes under `app/api/files/`, `app/api/cwd/`, and `app/api/git/`.

## Project Invariants

### AgentSession lifecycle

- Keep one `AgentSessionWrapper` per session id in `globalThis.__piSessions`; hot reload makes plain module-level maps unsafe.
- Idle timeout is 10 minutes.
- Concurrent `startRpcSession()` calls must share `globalThis.__piStartLocks`.
- After `send("fork")`, capture the new session id and destroy the wrapper immediately. `AgentSession.fork()` mutates `inner.sessionId`; leaving the old wrapper alive can corrupt `parentSession` chains.

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

Archive/unarchive is a pure file move (`renameSync`) between `sessions/` and `sessions-archive/`. The session JSONL content is never modified. Active RPC sessions are destroyed before the file is moved.

The archive directory is scanned separately from `SessionManager.listAll()` (which only scans `sessions/`). Project visibility is preserved by returning `archivedCwds` and `archivedCounts` from `GET /api/sessions`, allowing the CWD picker to include projects that have only archived sessions.

### Tool calls and events

- Pi stores tool calls as `{type:"toolCall", id, name, arguments}`.
- Web UI types use `{toolCallId, toolName, input}`.
- Normalize with `normalizeToolCalls()` in `lib/normalize.ts`; it is used during file load and streaming.
- Newer pi emits `compaction_start` / `compaction_end`; older pi emits `auto_compaction_start` / `auto_compaction_end`. Handle both.

### Session file-change projection

- Session changed-file UI is sidecar-based and non-Git; do not derive it from `git status` or `git diff`.
- `lib/rpc-manager.ts` forwards live edit/write tool events to `lib/session-file-changes.ts`, which captures bounded before/after text snapshots and persists `~/.pi/agent/session-changes/<session-id>.json`.
- Session JSONL files are not modified for this UI-only projection.
- MVP tracks built-in `edit` and `write` tools only; arbitrary `bash` file mutations are not shown unless a future scanner/sandbox design adds explicit support.

### Models and tools

- `GET /api/models` returns `defaultModel` from `~/.pi/agent/settings.json`.
- New-session tool selection is passed to `POST /api/agent/new` as `toolPreset`: `all`, `read-only`, or `none`; legacy `toolNames[]` remains supported.
- Web sessions default to `all`, which expands dynamically through `getAllTools()` so built-in, extension, and custom tools are enabled without editing preset constants. `read-only` enables whichever of `read`, `grep`, `find`, and `ls` are loaded.
- `GET /api/commands` builds a lightweight in-memory SDK session so extension commands registered with `pi.registerCommand()` appear beside prompt templates and skills with source/provenance metadata. `GET /api/pi/resources` exposes the corresponding extension/tool/command diagnostics for debugging package discovery and version mismatches.
- Existing live sessions infer presets via `get_tools` and `getPresetFromTools()`.
- Auth changes call `reloadRpcAuthState()` so live AgentSessions reload auth/model state. The same path also cleans pi-ai session resources because OpenAI Codex keeps reusable WebSockets keyed by session id, and those sockets must reconnect after ChatGPT account activation to pick up new auth headers.
- ChatGPT usage auto-refresh is backend-owned, not browser-tab-owned. The scheduler state lives on `globalThis.__piChatGptUsageRefreshScheduler` and uses `~/.pi/agent/chatgpt-usage-refresh.lock` to reduce duplicate refresh loops across Node processes. Stale lock detection follows the configured refresh cycle dynamically.
- Before creating an SDK `AgentSession`, `lib/pi-runtime-resolver.ts` prepares a local `pi` shim under `~/.pi/agent/pi-web-runtime/bin/`, prepends it to `PATH`, and makes the WebUI's pi package resolvable from the agent npm directory. Unix-like runtimes also receive `PI_SUBAGENT_PI_BINARY` when unset; Windows relies on package resolution because shell-less Node spawns cannot execute `.cmd` shims directly.
- Web sessions bind Pi extensions in RPC mode through `lib/extension-web-ui.ts`. Simple extension UI requests (`notify`, `confirm`, `select`, `input`, `editor`, status/widget/title/editor text updates) are forwarded through the existing SSE stream; browser responses are returned with `extension_ui_response`. The chat UI renders `setStatus` chips and generic `setWidget` stacks around the composer; the standard `todo-list` widget is projected into a floating Trellis-style task panel with progress and parsed task rows. Blocking dialogs use `ExtensionDialogHost`, and non-blocking `notify` uses `ExtensionToastHost` (no `window.alert`/`confirm`/`prompt`). For `setWidget`, string arrays are forwarded directly; TUI component factories (e.g. `manage_todo_list`) are invoked with a passthrough theme and materialized via `render(width)` into plain text lines. Fully interactive TUI-only APIs (`custom` components, powerbar chrome, etc.) still degrade with `extension_error` diagnostics instead of blocking silently.
- Extension slash commands (e.g. `/brainstorm`) complete inside `prompt()` without `agent_start`/`agent_end`. The RPC wrapper buffers SSE events until a browser listener attaches, replays pending extension UI requests, and emits `prompt_settled` when `prompt()` finishes without an active stream so the chat UI does not stick on "Waiting for model...". Active sessions keep an SSE connection open while the chat is mounted.
- Slash-command discovery annotates known TUI-only extension commands as `webSupport: "cli-only"` (and some as `partial`) so autocomplete can badge them.
- Top-bar **Intercom** lists local `pi-intercom` broker peers and can send one-shot messages without the TUI overlay.
- When the agent calls `interactive_shell` with a new command, the Web UI opens the existing Web Terminal dock and optionally seeds the command into that PTY instead of relying on the extension's TUI overlay.
- The sidebar **Extensions** modal inspects SDK resource discovery (`GET /api/pi/resources`, including configured packages) and edits `settings-extensions.json` through `GET/PUT /api/pi/extension-settings` after discovering registrations emitted on the shared `pi-extension-settings:register` event bus during package load.
## Configuration Boundary: Native Pi vs Trellis Routing

The Web UI supports two independent subagent configuration systems:

| System | File | Managed By | Purpose |
|--------|------|------------|---------|
| Native pi-subagents | `settings.json → subagents` | Settings → Agents | pi-subagents extension native model config (defaultModel, agentOverrides) |
| Trellis routing | `pi-web.json → trellis.subagents` | Settings → Trellis | Web UI Trellis workflow routing policy only |

Each system is edited through its own Settings section and does not affect the
other. The native config persists to `~/.pi/agent/settings.json` (user) or
`<cwd>/.pi/settings.json` (project); the Trellis routing config persists to
`~/.pi/agent/pi-web.json`.

### SnFlow (separate from Trellis)

Snail Pi Web also owns a first-class development flow named SnFlow. There is no
global enable switch: a project uses SnFlow only after it is initialized
(`.pi/snflows/tasks/` exists). The SF drawer is always available so users can
inspect or initialize the current workspace. Task documents live under
`<cwd>/.pi/snflows/tasks/` (archived tasks move to the sibling
`<cwd>/.pi/snflows/archived/`) and never share schema, import, or writeback with
`.trellis/tasks/`. Implement/check phases run as foreground native
`pi-subagents` tool calls (`worker` / `reviewer`) in the current chat session.
The task-bound API prepares a strict dispatch marker with the selected task id,
revision, phase, and canonical cwd; `lib/workflow-chat-lifecycle.ts` validates
that marker before execution and projects native tool progress/end events into
SnFlow run records. This keeps the existing top-bar Subagent panel authoritative
for live progress and removes the blocking CLI implement/check/wait path.
`lib/workflow-run-manager.ts` retains artifact/session reconciliation for restart
and terminal-projection repair, but is no longer the normal execution host.
SnFlow agent models come only from native
`settings.json → subagents`; SnFlow code must not read `trellis.subagents`.
`pi-web.json → workflow` only keeps panel preferences such as
`includeArchived` and `trackInGit` (legacy `enabled` is ignored).
`trackInGit` defaults to false so init/update writes a managed block into the
project `.gitignore` covering SnFlow assets and the task store; set it true if
the team wants those files committed.

Project setup (Settings → SnFlow or the panel empty-state) installs managed
assets from the bundled manifest in `lib/snflow-assets.ts`:
`.pi/extensions/snflow/`, `.pi/skills/snflow-dev/`, `.pi/agents/snflow-*.md`,
`scripts/snflow-task.ts`, and `.pi/snflows/.version`. Update rewrites only that
whitelist and never touches task data. Old projects that only have a tasks
directory remain initialized and are prompted to update.

Chat experience is intentionally Trellis-like, but only when the selected project
is initialized for SnFlow. If it is not, the WebUI does not force SnFlow —
managed project extension/skill/agent files are filtered out of the session
resource loader so leftover assets cannot pull chat onto the SnFlow path.

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

- Trellis subagent child processes run through the local pi package CLI (`node node_modules/@earendil-works/pi-coding-agent/dist/cli.js`) when available, or an explicit `TRELLIS_PI_CLI_JS`; they do not silently rely on a bare `pi` command that may be missing from the WebUI process `PATH`. The Trellis extension resolves task files and child-process `cwd` from the active SDK session context (`ctx.cwd`), with the server process cwd used only as a compatibility fallback.
- Trellis subagent child processes resolve model policy from `pi-web.json` `trellis.subagents`: explicit tool input wins, then per-agent fixed policy, then optional route table policy, then default policy, then `.pi/agents/*` frontmatter, then Pi CLI defaults. Automatic routing is opt-in and classifies `text`/`multimodal` plus `simple`/`standard`/`complex`/`critical`; router failures fall back to configured safe route/default behavior. The default policy follows the main session model when the Pi extension context exposes it; otherwise it safely falls back to Pi default. If the selected child model process fails, existing `.pi/agents/*` `fallbackModels` frontmatter entries are retried in order; if those also fail and the main session model is known, the child finally falls back to the main session model.
- Session-scoped Trellis task association remains high-confidence only (session transcript evidence or exact per-session runtime pointers). When evidence identifies a child task, the web projection promotes it to the nearest available parent task so the floating widget represents the main task context without mutating Trellis metadata.
- When all tools are disabled, `lib/rpc-manager.ts` clears the agent system prompt.

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
