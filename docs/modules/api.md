# API Module Map

API routes live under `app/api/`. When adding, removing, or changing routes, update this file and the short index in `AGENTS.md`.

| Route | Methods | Purpose |
| --- | --- | --- |
| `sessions/` | GET | List sessions grouped by cwd (includes `archivedCwds` and `archivedCounts`). |
| `sessions/[id]/` | GET/PATCH/DELETE | Read session detail, rename, delete. Returns `archived: true` for archived sessions. |
| `sessions/[id]/context/` | GET | Get context for a specific `leafId`. |
| `sessions/[id]/changes/` | GET | List files changed by tracked agent file tools in this session from non-Git sidecar data. |
| `sessions/[id]/changes/file/` | GET | Return the stored unified diff or metadata-only reason for one tracked session-changed file. |
| `sessions/[id]/trellis-task/` | GET | Resolve the high-confidence Trellis task associated with one pi session, using session-local transcript evidence or exact per-session Trellis runtime pointers only. |
| `sessions/[id]/export/` | GET | Export session as Markdown. |
| `sessions/new/` | 410 | Deprecated route kept for compatibility. |
| `agent/new/` | POST | Create a new session and send the first message. |
| `agent/[id]/` | GET/POST | Get agent state or send a command. |
| `agent/[id]/events/` | GET | SSE event stream. |
| `files/[...path]/` | GET/PUT | List/read/watch/preview workspace files for the file viewer and safely save existing editable text files. |
| `files/search/` | GET | Search files in the selected workspace. |
| `files/definitions/` | GET | Lightweight workspace text/code symbol definition search for editor drill-down actions. |
| `files/implementations/` | GET | Lightweight workspace search for Java symbol implementations/references used by the Monaco file editor. |
| `files/references/` | GET | Lightweight workspace text/code symbol reference search for editor “find usages” actions. |
| `files/upload/` | POST | Upload files for chat/file workflows. |
| `models/` | GET | List cwd-scoped available models and the project-aware default model. Complete metadata is cached briefly per canonical cwd with in-flight deduplication; `?refresh=1` rebuilds and replaces that cache entry after model/auth configuration changes. |
| `models-config/` | GET/PUT | Read/write `~/.pi/agent/models.json`. |
| `models-config/discover/` | POST | Fetch an OpenAI-compatible draft provider's remote `/models` list server-side and return selectable model candidates without mutating `models.json`. |
| `models-config/test/` | POST | Test a model config with a completion request. |
| `model-pricing/` | GET/POST | GET returns cache summary, cached model-id lookup (`?model=&provider=`), ambiguous provider/model/cost candidates for manual matching, or the normalized catalog (`?catalog=1`, including `contextWindow`); POST fetches `https://pi.dev/api/models`, validates, persists atomically, and returns sync result. GET never performs upstream network I/O. |
| `skills/` | GET | List installed skills for a cwd. |
| `skills/search/` | GET | Search skills.sh for available skills. |
| `skills/install/` | POST | Install a skill via `npx skills add`. |
| `commands/` | GET | List slash commands from extension commands, prompt templates, and skills for a cwd, with provenance metadata and diagnostics. |
| `pi/resources/` | GET | Inspect Pi SDK resource discovery for a cwd: configured packages, loaded extensions, tools, extension commands, skills, prompts, agent dir, and diagnostics. |
| `pi/extension-settings/` | GET/PUT | Discover registered `pi-extension-settings` definitions for a cwd, read current `settings-extensions.json` values (including orphan keys), and apply patch/replace writes. |
| `intercom/sessions/` | GET | List local pi-intercom broker sessions (best-effort hub registration). |
| `intercom/send/` | POST | Send a one-shot intercom message to a peer session id/name via temporary hub registration. |
| `cwd/validate/` | POST | Validate a candidate workspace path. |
| `git/worktrees/` | GET/POST/DELETE | Inspect, create, and remove Git worktrees from the selected cwd; removal also deletes sessions for that worktree cwd. |
| `sessions/archive/` | POST | Archive one or more sessions (moves to `sessions-archive/`). |
| `sessions/unarchive/` | POST | Unarchive one or more sessions (moves back to `sessions/`). |
| `sessions/archive-all/` | POST | Archive all sessions for a cwd. |
| `sessions/archived/` | GET | List archived sessions for a cwd. |
| `git/worktrees/archive/` | POST | Squash, push, merge, and remove a Git worktree after user risk confirmation; archive also deletes sessions for that worktree cwd. |
| `git/info/` | GET | Return best-effort Git branch/worktree metadata for a cwd. |
| `git/status/` | GET | Return detailed Git status (branch, commits, staged/unstaged changes, untracked files, stash) for a cwd. |
| `git/graph/` | GET | Return decorated commit graph data (commits, parents, refs, local branches) for the Git panel branch visualization; optional `branch` previews one validated local branch. |
| `git/commit/` | GET | Return read-only metadata and first-parent/root changed-file stats for a selected commit in the Git panel. |
| `git/diff/` | GET | Return a bounded read-only unified diff, or binary/too-large/unavailable fallback metadata, for one changed file in a selected commit. |
| `git/switch/` | POST | Switch the current workspace to a local branch. Validates cwd, branch existence, and working tree cleanliness before executing `git switch`. Returns `switchedTo` on success or an error message. |
| `subagents/config/` | GET/PUT | Read/write native `pi-subagents` model configuration in Pi `settings.json` for user-global or selected-project scope. GET returns managed fields, discovered agents, discovery diagnostics, and user-scope projection for project scope. PUT applies a managed-field patch with revision-based conflict detection, validates model ids against the Pi model registry, and returns the refreshed projection. |
| `web-config/` | GET/PUT | Read/write `~/.pi/agent/pi-web.json` for WorkTree defaults, Usage scan scope, Web Terminal settings, ChatGPT usage panel/warmup schedule settings, Editor implementation/shortcut settings, optional Workflow panel settings, optional Trellis panel settings, setup proxy, and Trellis subagent model policy; also lazily ensures the local ChatGPT warmup scheduler. |
| `terminal/env/assist/` | POST | Use the configured Terminal env assistant model to parse complex raw env text into normalized key-value env entries. |
| `terminal/sessions/` | POST | Create a local Web Terminal session for an authorized workspace cwd when the Terminal setting is enabled. |
| `terminal/sessions/[id]/` | DELETE | Close a Web Terminal session and terminate its process. |
| `terminal/sessions/[id]/events/` | GET | Stream Web Terminal output through SSE. |
| `terminal/sessions/[id]/input/` | POST | Write user input to a Web Terminal session. |
| `terminal/sessions/[id]/resize/` | POST | Resize a Web Terminal PTY. |
| `workflows/current/` | GET | Return the cwd current Workflow task pointer and detail (Trellis-like active task) when Workflow is enabled. |
| `workflows/tasks/` | GET/POST | List or create WebUI-owned Workflow tasks under `<cwd>/.pi/workflows/tasks/` when the Workflow panel setting is enabled. POST may seed from `sessionId` / `seedText`. |
| `workflows/tasks/[taskId]/` | GET/PUT | Read or revision-checked update one Workflow task metadata/documents. |
| `workflows/tasks/[taskId]/runs/` | POST | Start implement or check phase via native pi-subagents for one Workflow task. |
| `workflows/runs/[runId]/` | GET | Reconcile and return one Workflow run plus parent task projection. |
| `workflows/runs/[runId]/cancel/` | POST | Stop an active native Workflow run and reconcile. |
| `workflows/tasks/[taskId]/complete/` | POST | Record commit metadata and/or mark a Workflow task completed. |
| `workflows/tasks/[taskId]/archive/` | POST | Archive a completed/cancelled Workflow task under `.pi/workflows/tasks/archive/`. |
| `trellis/tasks/` | GET | List read-only Trellis task summaries for an authorized workspace cwd when the Trellis panel setting is enabled. |
| `trellis/tasks/[taskKey]/` | GET | Read one Trellis task detail, artifacts, manifest counts, hierarchy, and derived phase/progress. |
| `trellis/workflow/` | GET | Read and parse the selected workspace `.trellis/workflow.md` into a read-only workflow visualization projection with phases, steps, workflow-state blocks, source line ranges, and parser warnings. |
| `trellis/workflow/assist/` | POST | Use the configured Trellis workflow assistant model to translate and summarize one selected workflow node's guidance text without mutating `.trellis/workflow.md`. |
| `trellis/setup/status/` | GET | Inspect Trellis prerequisites, CLI availability, and selected-workspace initialization state without requiring the panel setting to be enabled. |
| `trellis/setup/init/` | POST | Install/ensure the Trellis CLI, run `trellis init -u <developer> --pi` for an authorized uninitialized workspace, and auto-enable the Trellis drawer setting on success. |
| `trellis/setup/update/` | POST | Upgrade/install the Trellis CLI and run `trellis update` for an authorized workspace that already has `.trellis`. |
| `default-cwd/` | POST | Create and return `~/pi-cwd-<YYYYMMDD>`. |
| `home/` | GET | Return `os.homedir()`. |
| `usage/` | GET | Aggregate token/cost usage across active-only or active-plus-archived sessions based on `pi-web.json` Usage settings. |
| `auth/providers/` | GET | List OAuth/subscription providers. `loggedIn` is true only when the active auth is OAuth (API-key-only credentials on dual-auth providers like `xai` do not count). |
| `auth/all-providers/` | GET | List API-key-capable built-in providers (excludes primary OAuth-only ids and `models.json` custom keys). `configured` is true only for non-OAuth auth so an xAI subscription login does not also surface a separate active "xAI" API-key row. |
| `auth/accounts/[provider]/` | GET/POST/PATCH/DELETE | List saved OAuth accounts, import one or more raw/CPA/SUB2API OAuth account JSON entries, update account remarks/extra info, return cached quota reset metadata, and soft-delete inactive saved accounts for supported providers (`openai-codex`). |
| `auth/accounts/[provider]/activate/` | POST | Activate a saved OAuth account and reload live RPC auth state. |
| `auth/login/[provider]/` | GET/POST | Initiate OAuth login for a provider; `openai-codex?accountMode=add` saves another account without replacing active auth. |
| `auth/logout/[provider]/` | POST | Clear OAuth tokens for a provider. |
| `auth/api-key/[provider]/` | GET/POST/DELETE | GET returns API-key auth status (never the key); OAuth credentials do not count as configured. POST sets a stored API key. DELETE clears the stored credential. |
| `auth/balance/[provider]/` | GET | Query DeepSeek account balance. |
| `auth/quota/[provider]/` | GET/POST | GET queries OpenAI Codex subscription quota and reset-credit availability for the active account, or for a saved account with `?accountId=...`; queries update the saved account's cached quota/reset-credit metadata and refresh expired saved-account OAuth tokens when possible. POST consumes one available Codex reset credit for the active account or JSON `{ accountId }`, then returns freshly queried quota. |
| `auth/usage/grok-cli/` | GET | Query Grok subscription structured billing usage. `?mode=cache` (default) returns last-known cache from `~/.pi/agent/grok-cli-usage-cache.json` without hitting billing; `?mode=refresh` live-fetches xAI `/billing` (+ optional weekly credits) using OAuth from `grok-cli` or built-in `xai` (plus the explicit env bypass), and overwrites the cache only on success. Returns browser-safe `GrokUsageResult` JSON (`monthly` used/limit/remaining/utilization/billingPeriodEnd, optional `weekly`, `source`, `queriedAt`, `envBypass`) with no tokens/credentials. No cwd required. Manual refresh only. |
| `auth/warmup/openai-codex/` | GET/POST | GET returns recent ChatGPT/Codex warmup history and lazily ensures the local scheduler. POST warms selected saved OAuth accounts by sending a tiny real Codex request without activating them; returns per-account results, records manual run history, and refreshes quota cache when possible. |
| `chatgpt/usage-refresh/status/` | GET | Ensure and inspect the backend ChatGPT usage auto-refresh scheduler, including lock diagnostics and last-run state. |
| `chatgpt/usage-refresh/ensure/` | POST | Start or re-arm the backend ChatGPT usage auto-refresh scheduler according to `pi-web.json`. |
| `chatgpt/usage-refresh/repair-lock/` | POST | Risk-gated stale lock repair for the ChatGPT usage auto-refresh scheduler. Requires `{ confirm: true }`. |
| `chatgpt/usage-refresh/run/` | POST | Trigger a best-effort immediate ChatGPT usage refresh cycle through the backend scheduler. |

## Implementation Pointers

- Agent command routes should go through `lib/rpc-manager.ts`.
- Session-file routes should use `lib/session-reader.ts` and shared types in `lib/types.ts`.
- Client-side command calls should use `lib/agent-client.ts`.
- Normalize streamed/file-loaded tool calls through `lib/normalize.ts`.
