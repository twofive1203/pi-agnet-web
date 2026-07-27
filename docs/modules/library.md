# Library Module Map

Shared logic lives under `lib/`. Prefer adding behavior here when it is used by multiple API routes, hooks, or components.

| File | Purpose |
| --- | --- |
| `lib/rpc-manager.ts` | `AgentSessionWrapper`, global registry, `startRpcSession()`, cwd-scoped session cleanup, lifecycle handling. |
| `lib/pi-session-lifecycle.ts` | Shared AgentSession disposal helper that awaits extension `session_shutdown` cleanup before SDK context invalidation. |
| `lib/session-reader.ts` | Parse `.jsonl` session files, resolve session paths, prune/delete sessions for removed WorkTree cwd paths, read model/default config. Sidebar browsing uses `listProjectSummaries()` and `listRecentSessionsForCwd(cwd, { limit, before, beforePath })` (mtime/filename candidate selection, bounded page parse, optional parent-closure ancestors, `total`/`hasMore`/`nextBefore` cursors). Project/candidate collection prefers `lib/session-index.ts` and falls back to direct disk scans. Archived sidebar pages use `listArchivedSessionsForCwd(cwd, options)` the same way; no-options call remains a full cwd list. `listAllSessions()` / `listAllArchivedSessions()` stay full-scan for Usage and bulk consumers. `resolveSessionPath` prefers filename scan before full list. Archive helpers move/restore the parent JSONL together with its subagent companion directory through `lib/session-artifacts.ts` and invalidate the session index. |
| `lib/session-reader-header.ts` | Bounded first-line session header peek and filename id extraction shared by reader and index (avoids circular imports). Requires session `type`, string `id`, and string `cwd` before treating a header as valid. |
| `lib/session-index.ts` | Rebuildable WebUI session/project index persisted at `~/.pi/agent/pi-web-session-index.json` (versioned). Fingerprints entries by `path + mtimeMs + size` (+ archived flag), reuses unchanged headers, isolates malformed/unreadable files (including typed-malformed non-string `cwd`) per file so one bad JSONL cannot abort refresh or hide valid entries, atomically writes via temp+rename, and serializes refresh/write in-process via `globalThis`. Index is an acceleration layer only — disk JSONL remains the source of truth. |
| `lib/session-reader-constants.ts` | Client-safe constants shared with session-reader (`RECENT_SESSIONS_LIMIT`, `ARCHIVED_SESSIONS_LIMIT`, `PARENT_CLOSURE_LIMIT`). |
| `lib/sidebar-session-tree.ts` | Pure sidebar fork-tree builder (`buildSessionTree`) and session-page merge helper used by the session browser. |
| `lib/types.ts` | Shared TypeScript types for messages, sessions, Git status/graph/commit/diff wire payloads, and API payloads. |
| `lib/pi-types.ts` | `AgentSessionLike` wrapper interface expected by hooks/components. |
| `lib/normalize.ts` | Normalize pi tool-call fields to web UI shape. |
| `lib/subagent-runs.ts` | Shared Subagent panel projection types and logic. Expands single/parallel/chain execution calls and rebuilds completed/failed run rows from persisted assistant tool calls plus tool results, including output, routing, and child session paths. Used by session reload and nested-child JSONL parsing. |
| `lib/session-file-changes.ts` | Non-Git session file-change tracker: observes edit/write tool events, persists sidecar summaries, and serves browser-safe changed-file projections. |
| `lib/unified-diff.ts` | Wrapper around the `diff` package for bounded unified diff generation and addition/deletion counting. |
| `lib/agent-client.ts` | Client-side helper for `POST /api/agent/[id]`. |
| `lib/file-paths.ts` | Path normalization utilities for file viewer APIs. |
| `lib/cwd.ts` | Cwd validation and normalization helpers. |
| `lib/git-worktree.ts` | Git worktree creation, status, archive, and removal helpers. |
| `lib/deepseek-balance.ts` | Query DeepSeek account balance. |
| `lib/pi-auth.ts` | pi 0.80.10+ (pinned `0.82.1`) auth/model facade helpers around `ModelRuntime`/`ModelRegistry`, OAuth provider listing, API-key write/delete, and request-auth mapping. |
| `lib/file-credential-store.ts` | File-backed `CredentialStore` for `~/.pi/agent/auth.json`; used by multi-account Codex helpers after public `AuthStorage` removal. |
| `lib/grok-usage.ts` | Resolve Grok subscription OAuth/env token (`GROK_CLI_OAUTH_TOKEN`, then `grok-cli` or Pi built-in `xai` credentials, with registry fallback), fetch xAI monthly/weekly billing, persist last-known successful usage to `~/.pi/agent/grok-cli-usage-cache.json` (success-only writes, no tokens), and return browser-safe structured results. |
| `lib/quota-display.ts` | Shared ChatGPT/Codex quota display helpers: tier labels, utilization colors, quota/reset-credit countdowns, earliest reset-credit expiration, relative refresh time, and known-tier filtering. |
| `lib/oauth-accounts.ts` | Persist, import raw/converted credential JSON, sanitize, sync, label, activate, quota/reset-credit cache metadata, and soft-delete saved `openai-codex` OAuth accounts without exposing tokens. |
| `lib/oauth-account-converters.ts` | Shared OAuth account import mode registry, raw credential validation, and CPA/SUB2API-to-raw conversion used by the UI and account import API; SUB2API exports may convert to multiple raw credentials. |
| `lib/subscription-quota.ts` | Query OpenAI Codex subscription quota, degrade reset-credit lookup failures without blocking quota results, consume Codex reset credits server-side, and update saved-account quota/reset-credit caches. |
| `lib/openai-codex-warmup.ts` | Send minimal real Codex warmup requests for selected saved `openai-codex` OAuth accounts without changing the active account, then refresh per-account quota cache. |
| `lib/openai-codex-warmup-history.ts` | Persist bounded manual/scheduled ChatGPT warmup run history separately from credentials and `pi-web.json`, including duplicate scheduled-run keys. |
| `lib/openai-codex-warmup-scheduler.ts` | Local in-process ChatGPT warmup scheduler guarded by `globalThis`, reading `pi-web.json` each tick and running due saved schedules once per local date/time key. |
| `lib/npx.ts` | Cross-platform `npx` wrapper that avoids shell quoting issues. |
| `lib/usage-stats.ts` | Aggregate persisted assistant token/cost across configured active-only or active-plus-archived parent sessions and their nested subagent session files, with global/per-parent main-vs-subagent splits. |
| `lib/session-artifacts.ts` | Own path-derived session companion discovery and lifecycle. Lists nested subagent `session.jsonl` files from a known parent, supports legacy archived layouts, and safely moves/deletes the companion directory with the parent JSONL. |
| `lib/pi-subagent-settings.ts` | Read/write native Pi `settings.json` `subagents` section for user-scope (`getAgentDir()/settings.json`) and project-scope (`<cwd>/.pi/settings.json`). Provides strict parsing with revision hashing, managed-field projection extraction, patch validation with model id validation, surgical field merge/delete with empty-object cleanup, and atomic write through a same-directory temporary file and rename. Rejects malformed content and revision conflicts. |
| `lib/pi-subagent-discovery.ts` | Agent discovery using the pi-subagents extension's public management tool surface. Creates a lightweight in-memory Pi SDK session, invokes the registered `subagent` tool's `list` action, and parses output into structured agent records with name, source, description, and defaultContext. Returns clear extension-missing/parse diagnostics without inventing fallback agents. Also provides `mergeSettingsOnlyAgents()` to merge selected and inherited settings-only override names into the display list so stale/hidden configured entries remain visible and clearable. |
| `lib/pi-web-config.ts` | Read/write/validate `~/.pi/agent/pi-web.json` for WorkTree, Usage scan scope, Web Terminal settings and env assistant model policy, ChatGPT usage panel, warmup schedule, and backend auto-refresh settings, Grok usage panel toggle, and SnFlow panel preferences such as `includeArchived` (compat key `workflow`; legacy `enabled` ignored). Legacy `trellis` config remains parsed/preserved for compatibility until a later ownership cleanup. |
| `lib/pi-runtime-resolver.ts` | Prepares a deterministic local Pi CLI shim for extension tools such as `pi-subagents` that spawn nested Pi processes from the WebUI server environment. |
| `lib/extension-web-ui.ts` | Web/RPC-style Pi extension UI adapter for SDK sessions; forwards simple extension UI requests and diagnostics to the browser SSE stream and resolves dialog responses. Suppresses pi-subagents TUI HUDs (`subagent-fleet-status`, `subagent-async`) that overlap the top-bar SubagentPanel. |
| `lib/extension-settings.ts` | Read/write `~/.pi/agent/settings-extensions.json`, discover registered extension setting definitions via a shared Pi event bus during package load, and build effective value rows (stored/default/orphan). |
| `lib/extension-command-web-support.ts` | Classify extension slash commands as full / partial / cli-only for Web autocomplete badges. |
| `lib/intercom-hub.ts` | Short-lived pi-intercom broker hub client for listing peers and sending one-shot messages from the Web UI. |
| `lib/allowed-roots.ts` | Shared authorized-workspace root discovery and path checks for file and workflow APIs. |
| `lib/terminal-manager.ts` | Web Terminal PTY manager: setting-gated session creation, cwd authorization, platform-aware Unix/Windows shell and custom path resolution, env injection, SSE subscription fan-out, input/resize handling, and process cleanup. |
| `lib/browser-protocol.ts` | Shared browser-bridge protocol constants, envelopes, binding/capability/error contracts, and model-safe binding views (no raw `tabId`/credentials). |
| `lib/browser-binding-state.ts` | Pure binding state machine: pending/active/debug/suspended/revoked, single-tab ownership, multi-tab session membership, primary selection, navigation policy. |
| `lib/browser-pairing.ts` | Installation pairing codes, secret verifiers, connect-token challenge handshake, and atomic `~/.pi/agent/browser-bridge.json` persistence (temp+rename; corrupt files quarantined). |
| `lib/browser-bridge.ts` | Loopback-only authenticated WebSocket broker (`127.0.0.1`) with heartbeat, deadlines, cancel, duplicate-response cache, and frame limits. Separate from Agent SSE/`extension_ui_request`. |
| `lib/browser-binding-manager.ts` | Session-scoped binding manager routing commands only to the owning extension client; multi-session pending isolation (`listOpenPendingRequests` / scoped `getOpenPendingRequest`); fork/destroy invalidation; rate limits; audit hooks. |
| `lib/browser-tools.ts` | Pi custom tools (`browser_*`) that inject `sessionId` from `ctx.sessionManager.getSessionId()` and never accept model-supplied session ids. |
| `lib/browser-action-policy.ts` | Deterministic `browser_act` safety policy (source of truth). Extension copies are generated via `scripts/generate-browser-extension-shared.ts`. |
| `lib/browser-redaction.ts` | URL/header/console/network redaction and sensitive-control detection for tool outputs (source of truth for extension `redaction.js`). |
| `lib/browser-audit.ts` | Bounded browser-control audit metadata (no page payloads or secrets). |
| `lib/workflow-types.ts` | Versioned SnFlow task/run/status/transition and browser projection types for the WebUI-owned development flow. |
| `lib/workflow-store.ts` | Project-local SnFlow task store under `.pi/snflows/tasks/` (archived tasks in sibling `.pi/snflows/archived/`): canonical cwd resolution, strict parsing with agent-hand-write leniency, atomic writes, revision checks, run records, complete/archive. Never reads/writes `.trellis/`. |
| `lib/snflow-assets.ts` | Bundled SnFlow project asset manifest (SemVer) and embedded file contents for the project extension, skill, agents, and CLI wrapper. |
| `lib/snflow-spec-templates.ts` | Project-owned specification skeleton, exact `AGENTS.md` managed section, and `00-bootstrap-spec` task documents. The bootstrap task fills specs first, then creates/appends/replaces only its bounded root `AGENTS.md` section. |
| `lib/workflow-setup.ts` | SnFlow project init/update/status: task directories, managed asset install from the bundled manifest, `.pi/snflows/.version`, optional `.gitignore` policy via `trackInGit`, and extension-presence checks used to avoid double guidance injection. |
| `lib/workflow-gitignore.ts` | Maintains a marked SnFlow block in the project `.gitignore` when `workflow.trackInGit` is false (default). |
| `lib/workflow-guidance.ts` | Legacy WebUI-side SnFlow system-prompt breadcrumbs for initialized projects without the project extension; applies the same soft entry policy as the managed skill, so ordinary development remains direct unless the user opts in. |
| `lib/workflow-session-link.ts` | Session-scoped SnFlow task resolver for the floating widget. Accepts an exact `current.json.sessionId` match or explicit task evidence from that session transcript; unbound cwd-global pointers do not associate blank/new sessions. |
| `lib/workflow-prompts.ts` | SnFlow dispatch marker, concise task-context prompt builders, phase routing to managed project agents `snflow-implement` / `snflow-check`, parser, and structured-output normalizers. Check normalization treats only `error` findings as blockers; advisory-only `changes_requested` results are normalized to `pass` for user choice. |
| `lib/workflow-chat-lifecycle.ts` | Current-chat SnFlow native-subagent boundary: prepares selected-task-bound dispatch instructions, validates marked `subagent` calls before execution, correlates session/tool-call progress and terminal results, and persists task/run projections without affecting ordinary subagents. |
| `lib/workflow-run-manager.ts` | Restart/reconnect reconciliation for SnFlow run records and native artifacts, including exact parent session/tool-call recovery, stale-run handling, and idempotent terminal task-projection repair. The hidden RPC host remains compatibility code, not the normal implement/check path. |
| `lib/workspace-title.ts` | Shared workspace title formatting from cwd and Git metadata. |
| `lib/i18n/` | Lightweight zh/en i18n core: locale types, browser/storage detection, nested message catalogs, and `translate()` with `{param}` interpolation. Consumed by `components/I18nProvider.tsx`. |

## Reuse Rules

- Do not duplicate JSONL parsing or tool-call normalization in UI code.
- If a route and a component need the same derived value, put it in `lib/` and import it from both sides.
- Keep wire types in `lib/types.ts` synchronized with route responses and hook consumers.
