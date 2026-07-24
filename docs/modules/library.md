# Library Module Map

Shared logic lives under `lib/`. Prefer adding behavior here when it is used by multiple API routes, hooks, or components.

| File | Purpose |
| --- | --- |
| `lib/rpc-manager.ts` | `AgentSessionWrapper`, global registry, `startRpcSession()`, cwd-scoped session cleanup, lifecycle handling. |
| `lib/session-reader.ts` | Parse `.jsonl` session files, resolve session paths, prune/delete sessions for removed WorkTree cwd paths, read model/default config. Archive helpers: `getSessionsArchiveDir()`, `archiveSessionFile()`, `unarchiveSessionFile()`, `scanArchivedCwds()`, `listArchivedSessionsForCwd()`, `resolveArchivedSessionPath()`. |
| `lib/types.ts` | Shared TypeScript types for messages, sessions, Git status/graph/commit/diff wire payloads, and API payloads. |
| `lib/pi-types.ts` | `AgentSessionLike` wrapper interface expected by hooks/components. |
| `lib/normalize.ts` | Normalize pi tool-call fields to web UI shape. |
| `lib/session-file-changes.ts` | Non-Git session file-change tracker: observes edit/write tool events, persists sidecar summaries, and serves browser-safe changed-file projections. |
| `lib/unified-diff.ts` | Wrapper around the `diff` package for bounded unified diff generation and addition/deletion counting. |
| `lib/agent-client.ts` | Client-side helper for `POST /api/agent/[id]`. |
| `lib/file-paths.ts` | Path normalization utilities for file viewer APIs. |
| `lib/cwd.ts` | Cwd validation and normalization helpers. |
| `lib/git-worktree.ts` | Git worktree creation, status, archive, and removal helpers. |
| `lib/deepseek-balance.ts` | Query DeepSeek account balance. |
| `lib/pi-auth.ts` | pi 0.80.10+ auth/model facade helpers around `ModelRuntime`/`ModelRegistry`, OAuth provider listing, API-key write/delete, and request-auth mapping. |
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
| `lib/usage-stats.ts` | Aggregate token/cost across configured active-only or active-plus-archived sessions by day, model, provider, and session. |
| `lib/pi-subagent-settings.ts` | Read/write native Pi `settings.json` `subagents` section for user-scope (`getAgentDir()/settings.json`) and project-scope (`<cwd>/.pi/settings.json`). Provides strict parsing with revision hashing, managed-field projection extraction, patch validation with model id validation, surgical field merge/delete with empty-object cleanup, and atomic write through a same-directory temporary file and rename. Rejects malformed content and revision conflicts. |
| `lib/pi-subagent-discovery.ts` | Agent discovery using the pi-subagents extension's public management tool surface. Creates a lightweight in-memory Pi SDK session, invokes the registered `subagent` tool's `list` action, and parses output into structured agent records with name, source, description, and defaultContext. Returns clear extension-missing/parse diagnostics without inventing fallback agents. Also provides `mergeSettingsOnlyAgents()` to merge selected and inherited settings-only override names into the display list so stale/hidden configured entries remain visible and clearable. |
| `lib/pi-web-config.ts` | Read/write/validate `~/.pi/agent/pi-web.json` for WorkTree, Usage scan scope, Web Terminal settings and env assistant model policy, ChatGPT usage panel, warmup schedule, and backend auto-refresh settings, Grok usage panel toggle, SnFlow panel preferences such as `includeArchived` (compat key `workflow`; legacy `enabled` ignored), and Trellis panel settings, including Trellis install/update proxy options, workflow assistant primary/fallback model policy, and Trellis subagent model policy. |
| `lib/pi-runtime-resolver.ts` | Prepares a deterministic local Pi CLI shim for extension tools such as `pi-subagents` that spawn nested Pi processes from the WebUI server environment. |
| `lib/extension-web-ui.ts` | Web/RPC-style Pi extension UI adapter for SDK sessions; forwards simple extension UI requests and diagnostics to the browser SSE stream and resolves dialog responses. |
| `lib/extension-settings.ts` | Read/write `~/.pi/agent/settings-extensions.json`, discover registered extension setting definitions via a shared Pi event bus during package load, and build effective value rows (stored/default/orphan). |
| `lib/extension-command-web-support.ts` | Classify extension slash commands as full / partial / cli-only for Web autocomplete badges. |
| `lib/intercom-hub.ts` | Short-lived pi-intercom broker hub client for listing peers and sending one-shot messages from the Web UI. |
| `lib/allowed-roots.ts` | Shared authorized-workspace root discovery and path checks for file and Trellis APIs. |
| `lib/terminal-manager.ts` | Web Terminal PTY manager: setting-gated session creation, cwd authorization, platform-aware Unix/Windows shell and custom path resolution, env injection, SSE subscription fan-out, input/resize handling, and process cleanup. |
| `lib/trellis-manager.ts` | Trellis setup/status/update helper: prerequisite checks, CLI/version inspection, proxy-scoped child-process environment, and fixed Trellis/npm command execution. |
| `lib/trellis-reader.ts` | Read-only Trellis task discovery, artifact loading, manifest counting, hierarchy, optional `meta.lastCheck` quality-check state, and phase/progress derivation. |
| `lib/trellis-workflow-reader.ts` | Read-only `.trellis/workflow.md` reader/parser for Settings workflow visualization; extracts phases, steps, workflow-state blocks, source line ranges, and parser warnings without executing Trellis commands or mutating files. |
| `lib/trellis-workflow-types.ts` | Wire types for Trellis workflow visualization API responses and UI consumers. |
| `lib/trellis-session-link.ts` | Session-scoped Trellis task association resolver for the floating widget; uses high-confidence session transcript evidence and exact per-session runtime pointers without mutating Trellis task metadata. |
| `lib/trellis-chat-context.ts` | Pure helpers for converting Trellis task details into compact chat-composer context payloads and serializing those blocks into resume prompts recognized by session-task linking. |
| `lib/trellis-setup-types.ts` | Wire types for Trellis setup status and setup/update command API responses. |
| `lib/trellis-types.ts` | Wire types for Trellis task list/detail API responses and UI consumers. |
| `lib/workflow-types.ts` | Versioned SnFlow task/run/status/transition and browser projection types for the WebUI-owned development flow. |
| `lib/workflow-store.ts` | Project-local SnFlow task store under `.pi/snflows/tasks/` (archived tasks in sibling `.pi/snflows/archived/`): canonical cwd resolution, strict parsing with agent-hand-write leniency, atomic writes, revision checks, run records, complete/archive. Never reads/writes `.trellis/`. |
| `lib/snflow-assets.ts` | Bundled SnFlow project asset manifest (SemVer) and embedded file contents for the project extension, skill, agents, and CLI wrapper. |
| `lib/snflow-spec-templates.ts` | Project-owned specification skeleton, exact `AGENTS.md` managed section, and `00-bootstrap-spec` task documents. The bootstrap task fills specs first, then creates/appends/replaces only its bounded root `AGENTS.md` section. |
| `lib/workflow-setup.ts` | SnFlow project init/update/status: task directories, managed asset install from the bundled manifest, `.pi/snflows/.version`, optional `.gitignore` policy via `trackInGit`, and extension-presence checks used to avoid double guidance injection. |
| `lib/workflow-gitignore.ts` | Maintains a marked SnFlow block in the project `.gitignore` when `workflow.trackInGit` is false (default). |
| `lib/workflow-guidance.ts` | Legacy WebUI-side SnFlow system-prompt breadcrumbs for projects that are initialized but do not yet have the project extension installed. |
| `lib/workflow-session-link.ts` | Session-scoped SnFlow task resolver for the floating widget. Accepts an exact `current.json.sessionId` match or explicit task evidence from that session transcript; unbound cwd-global pointers do not associate blank/new sessions. |
| `lib/workflow-prompts.ts` | SnFlow dispatch marker, implement/check prompt builders, parser, and structured-output normalizers for builtin `worker` / `reviewer`. |
| `lib/workflow-chat-lifecycle.ts` | Current-chat SnFlow native-subagent boundary: prepares selected-task-bound dispatch instructions, validates marked `subagent` calls before execution, correlates session/tool-call progress and terminal results, and persists task/run projections without affecting ordinary subagents. |
| `lib/workflow-run-manager.ts` | Restart/reconnect reconciliation for SnFlow run records and native artifacts, including exact parent session/tool-call recovery, stale-run handling, and idempotent terminal task-projection repair. The hidden RPC host remains compatibility code, not the normal implement/check path. |
| `lib/workspace-title.ts` | Shared workspace title formatting from cwd and Git metadata. |
| `lib/i18n/` | Lightweight zh/en i18n core: locale types, browser/storage detection, nested message catalogs, and `translate()` with `{param}` interpolation. Consumed by `components/I18nProvider.tsx`. |

## Reuse Rules

- Do not duplicate JSONL parsing or tool-call normalization in UI code.
- If a route and a component need the same derived value, put it in `lib/` and import it from both sides.
- Keep wire types in `lib/types.ts` synchronized with route responses and hook consumers.
