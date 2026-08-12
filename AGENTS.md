# 蜗牛派 (Snail Pi Web) — Agent Guide

This file is the AI working entrypoint, documentation map, and project contract for the pi coding agent web UI. Keep detailed material in `docs/`; this file only says where to read, where to archive, and which rules must be followed.

## Quick Start

```bash
npm install
npm run dev     # http://localhost:62666
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server on port 62666. |
| `npm run lint` | Run ESLint. |
| `node_modules/.bin/tsc --noEmit` | Type-check without emitting. |
| `npm run test:browser` | Browser binding protocol/manager and Chrome extension artifact smoke suite. |
| `npm run test:agent-stream` | Agent token-stream coalescing, empty-completed retry, and main-chat lifecycle integration smoke suite. |
| `npm run test:chat-errors` | Chat/provider error classification and pre-send model readiness gate smoke suite. |
| `npm run test:model-primary-candidates` | models.json primary-candidate flag parsing and chat picker short-list projection smoke suite. |
| `npm run test:chat-draft` | Browser-local Composer draft parsing, persistence, and cleanup smoke suite. |
| `npm run test:session-changes` | Async session changed-file projection and serialization smoke suite. |
| `npm run test:session-index` | Rebuildable session/project index smoke suite (header reuse, cwd isolation, archive moves). |
| `npm run test:session-search` | Workspace session search smoke suite (indexed name/firstMessage, archived, limits, stale gate). |
| `npm run test:session-stats` | Parent-session lifetime token/cost aggregation smoke suite. |
| `npm run test:session-performance` | Durable session performance (weighted TPS/TTFT) domain, sidecar, and lifecycle smoke suite. |
| `npm run test:task-observer` | Desktop pet task-observer domain contract (identity/presentation/privacy/budgets) smoke suite. |
| `npm run test:desktop-observer-api` | Desktop observer access gate, hub revision/coalesce, and health boundary smoke suite. |
| `npm run test:desktop-deep-links` | Allowlisted WebUI deep-link builders/parse/intent/strip smoke suite. |
| `npm run test:desktop-connection` | Desktop attach-only connection state machine + probe client + settings smoke suite. |
| `npm run test:desktop-contract` | Desktop pet Activity tray/read/notification/deep-link/tray/window contract smoke suite. |
| `npm run test:desktop-package` | Pet-only packaging contract (forge/npm separation, no server runtime, validation doc gates). |
| `npm run test:desktop-observer` | Combined task-observer domain + desktop-observer API + deep-link + connection + contract + package smokes. |
| `npm run test:scale-baseline` | Usage/allowed-roots/session-index/long-JSONL scale baseline + accelerated-path correctness smoke. |
| `npm run test:usage` | Usage timeline projection + parent/subagent/archive accounting smoke suite. |
| `npm run test:session-tabs` | Same-session multi-tab write-lock coordination pure smoke. |
| `npm run test:git-diff` | Commit and staged/unstaged working-tree diff smoke suite. |
| `npm run test:file-search` | Bounded async workspace filename search smoke suite. |
| `npm run test:file-upload` | Chat upload path-boundary/sanitize/exclusive-write smoke suite. |
| `npm run test:quick-commands` | Project quick-command config/trust/runner/SSE/cancel/bounded-output smoke suite. |
| `npm run test:snflow` | SnFlow setup/store/session-link/spec-review smoke suite. |
| `npm run test:automation` | Automation store/schedule/policy/runner/API smoke suite. |
| `npm run test:mcp` | MCP configuration domain/API smoke suite (adapter-native files, secrets, revisions). |
| `npm run test:i18n` | zh/en catalog parity and i18n contract checks. |
| `npm run test:package-update-check` | npm latest version-check helpers (semver compare + in-process cache) smoke suite. |
| `npm run test:bundled-extensions` | Bundled Pi extension registry/loading smoke suite. |
| `npm run test:web-tools-config` | Web Search provider/secret configuration smoke suite. |
| `npm run test:vision` | Vision fallback configuration, routing, and evidence-boundary smoke suite. |
| `npm run test:ui-theme` | Theme registry, semantic Token, responsive, focus, and motion contract checks. |
| `npm run test:subagent-observability` | Subagent summaries, metrics, and observation projections. |
| `npm run test:runtime` | Runtime packaging and published launcher invariants. |
| `npm run test:server-auth` | Server access-key domain, launcher options, and Proxy policy smokes. |
| `npm run test:server-auth:e2e` | Post-build production E2E for access auth (first key, login, SSE/API gate, restart, rotation, trusted proxy). |
| `npm run test:open-folder` | Local project-folder opening policy and route checks. |
| `npm run test:cwd-browse` | Workspace directory browsing policy and route checks. |
| `npm run test:cwd-native-pick` | Native folder-picker policy and route checks. |
| `npm run test:api-protection` | Local API mutation protection smoke suite. |
| `npm run build` | Production/release build through `scripts/build-next.js`. Do not use for routine dev work. |
| `npm run start` | Start the production server on port 62666 via `bin/pi-web.js` (loopback default). |

> Never run `next build` directly during development. It pollutes `.next/` and can break `npm run dev`; use `npm run build` only for release/publish validation.

## Reading Order

| Task | Read first | Then inspect |
| --- | --- | --- |
| Understand the product | `README.md` | `docs/architecture/overview.md` |
| Locate code | This file's project structure | `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/modules/library.md` |
| Change API behavior | `docs/modules/api.md` | Relevant `app/api/**/route.ts`, then `lib/rpc-manager.ts` or `lib/session-reader.ts` |
| Change UI behavior | `docs/modules/frontend.md` | Relevant file in `components/` or `hooks/` |
| Change shared logic | `docs/modules/library.md` | Relevant file in `lib/` and all callers |
| Change session lifecycle, branching, JSONL, or SSE | `docs/architecture/overview.md` | `lib/rpc-manager.ts`, `lib/session-reader.ts`, `hooks/useAgentSession.ts` |
| Change Automation schedules/runs | `docs/architecture/decisions/automation-scheduler.md` | `lib/automation-*.ts`, `app/api/automations/**`, `components/AutomationPanel.tsx` |
| Operate or trial Automation | `docs/automation-user-guide.zh-CN.md` | Automation panel, task approval, run history, and troubleshooting |
| Pick up planned/backlog work | `docs/plans/README.md` | The linked active plan, then current code |
| Change code/comment/test conventions | `docs/standards/code-style.md` | Existing nearby code and `.pi/snflows/spec/` when SnFlow is active |
| Deploy, publish, or debug runtime | `docs/deployment/README.md` | `docs/operations/troubleshooting.md`, `ecosystem.config.cjs`, proxy scripts |
| Change dependencies or pi SDK integration | `docs/integrations/README.md` | `package.json`, installed pi docs under `node_modules/@earendil-works/pi-coding-agent/` |

## Project Structure

| Path | Purpose | Details |
| --- | --- | --- |
| `app/` | Next.js app routes, layout, global styles. | `README.md`, `docs/modules/api.md` |
| `app/api/` | API route handlers for sessions, agent RPC/SSE, files, models, skills, auth, usage, Git/worktrees, native subagent settings, and config. | `docs/modules/api.md` |
| `components/` | React UI components. | `docs/modules/frontend.md` |
| `hooks/` | Client hooks for session state, theme, drag/drop, audio. | `docs/modules/frontend.md` |
| `lib/` | Shared server/client utilities, parsing, lifecycle, config, provider helpers. | `docs/modules/library.md` |
| `bin/` | npm-published `spi` entrypoint. | `docs/deployment/README.md` |
| `scripts/` | Build and operational helpers. | `docs/deployment/README.md` |
| `public/` | Static assets. | Inspect files directly. |
| `docs/` | Project knowledge base and archive target. | This file's archive rules. |
| `.pi/` | Local workflow/runtime state (SnFlow tasks, extensions, skills); not project docs. | Read when the active SnFlow/skill workflow requires it. |
| `.trellis/` (removed) | Historical repository workflow assets are no longer present or supported. | Only serialized `trellis_subagent` records and unknown `pi-web.json.trellis` keys retain compatibility; no active code reads/writes `.trellis/`. |

## Module Entry Points

| Area | Source entry | Documentation |
| --- | --- | --- |
| Session browsing/parsing | `lib/session-reader.ts`, `app/api/sessions/**` | `docs/architecture/overview.md`, `docs/modules/api.md` |
| Workspace session search | `lib/session-search.ts`, `lib/session-index.ts`, `app/api/sessions/search/`, `hooks/useSessionBrowser.ts`, `components/sidebar/SessionSearchResults.tsx` | `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/modules/library.md` |
| Session changed-file overlay | `lib/session-file-changes.ts`, `components/SessionChangesFloatingPanel.tsx`, `app/api/sessions/[id]/changes/**` | `docs/architecture/overview.md`, `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/modules/library.md` |
| Session performance metrics | `lib/session-performance.ts`, `components/SessionResourcePanel.tsx`, `lib/rpc-manager.ts`, `app/api/sessions/[id]/route.ts` | `docs/architecture/overview.md`, `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/modules/library.md` |
| Agent command lifecycle | `lib/rpc-manager.ts`, `app/api/agent/**` | `docs/architecture/overview.md` |
| Chat/session UI state | `hooks/useAgentSession.ts`, `components/ChatWindow.tsx`, `components/ChatInput.tsx` | `docs/modules/frontend.md` |
| Tool-call normalization | `lib/normalize.ts` | `docs/architecture/overview.md`, `docs/modules/library.md` |
| Workspace files and Git context | `app/api/files/**`, `app/file/page.tsx`, `components/StandaloneFileViewer.tsx`, `app/api/git/**`, `lib/file-paths.ts`, `lib/file-viewer-url.ts`, `lib/git-worktree.ts`, `lib/workspace-title.ts` | `docs/modules/api.md`, `docs/modules/frontend.md`, `docs/modules/library.md` |
| Models, model pricing/catalog, bundled/native subagents, Web Search/MCP config, skills, extensions, auth, usage | `app/api/models*`, `app/api/model-pricing/`, `app/api/subagents/config/**`, `app/api/web-tools/config/**`, `app/api/mcp/config/**`, `app/api/skills/**`, `app/api/pi/**`, `app/api/auth/**`, `app/api/usage/route.ts`, `lib/usage-stats.ts`, `lib/usage-timeline.ts`, `components/UsageStatsModal.tsx`, `components/UsageTokenChart.tsx` | `docs/modules/api.md`, `docs/modules/library.md`, `docs/modules/frontend.md`, `docs/integrations/README.md` |
| WebUI-owned SnFlow tasks/runs | `lib/workflow-store.ts`, `lib/workflow-chat-lifecycle.ts`, `lib/workflow-run-manager.ts`, `app/api/workflows/**`, `components/WorkflowPanel.tsx` | `docs/modules/api.md`, `docs/modules/library.md`, `docs/modules/frontend.md` |
| Scheduled Agent Automation | `lib/automation-service.ts`, `lib/automation-scheduler.ts`, `lib/automation-runner.ts`, `app/api/automations/**`, `components/AutomationPanel.tsx`, `instrumentation.ts` | `docs/architecture/decisions/automation-scheduler.md`, `docs/modules/api.md`, `docs/modules/library.md`, `docs/modules/frontend.md` |
| Chrome tab debugging (local bridge + extension) | `lib/browser-*.ts`, `app/api/browser/**`, `components/BrowserBindingPanel.tsx`, `extensions/chrome-tab-debug/` | `docs/modules/api.md`, `docs/modules/library.md`, `docs/modules/frontend.md`, `docs/operations/troubleshooting.md`, `extensions/chrome-tab-debug/README.md` |
| Project quick commands (one-shot task runner + output dock) | `lib/quick-command-*.ts`, `app/api/quick-commands/**`, `hooks/useQuickCommands.ts`, `components/QuickCommand*.tsx` | `docs/modules/api.md`, `docs/modules/library.md`, `docs/modules/frontend.md`, `docs/brainstorms/2026-08-12-project-quick-commands-requirements.md` |

## Project Invariants

Keep this section short and operational; detailed rationale belongs in `docs/architecture/overview.md`.

- Keep one `AgentSessionWrapper` per session id in `globalThis.__piSessions`; use `globalThis.__piStartLocks` for concurrent starts.
- After a fork, capture the new session id and destroy the old wrapper immediately.
- Distinguish forked sessions (new JSONL file) from in-session branches (`navigate_tree` in the same file).
- Normalize pi tool calls through `lib/normalize.ts`; do not hand-roll tool-call field mapping in components/routes.
- Track session changed-file UI through non-Git sidecars in `lib/session-file-changes.ts`; do not derive it from Git status.
- Track session performance (weighted TPS/TTFT) through the non-JSONL sidecar in `lib/session-performance.ts`; measure on the raw AgentSession event boundary before SSE throttling; do not backfill from historical message timestamps or mix into billing/`sessionStats`/global Usage.
- Treat session header `parentSession` as display metadata only; content comes from JSONL entries.
- When changing event kinds, JSONL records, RPC payloads, config fields, or shared constants, search for all consumers first and update docs/tests/validation notes.
- Do not reset or overwrite unrelated user changes.
- Automation is independent of SnFlow and ordinary project sessions: data lives under `getAgentDir()/automations/`; Automation JSONL must not appear in default `/api/sessions` lists.
- Automation effective tools are snapshot ∩ live policy and never fall back to dynamic `all`; unapproved extensions must not be imported by the scheduled loader.
- `/api/automations/**` is local-only (direct loopback + control session); sensitive mutations require trusted UI confirmation (browser challenge or `ctx.ui.confirm`).
- Official launchers default to loopback bind without auth; `--server`, `PI_WEB_SERVER_MODE=1`, or any non-loopback listen enables global access-key auth via root `proxy.ts`. Server mode requires effective HTTPS unless `--allow-insecure-http` / `PI_WEB_ALLOW_INSECURE_HTTP=1` explicitly opts into compatibility, and state-changing requests require exact same-origin. Optional auth-bypass CIDRs live in `server-access-policy.json` or `PI_WEB_AUTH_BYPASS_CIDRS`; match socket client IPs only, reject loopback/world-open rules, and never trust `X-Forwarded-For`. Auth success never relaxes Automation/native-picker/browser-bridge loopback gates.

## Standards and Validation

| Topic | Entry point |
| --- | --- |
| Code style, comments, validation commands | `docs/standards/code-style.md` |
| TypeScript config | `tsconfig.json` |
| ESLint config | `eslint.config.mjs` |
| Package scripts and dependencies | `package.json` |
| SnFlow coding specs, when active | `.pi/snflows/spec/index.md`, `.pi/snflows/spec/frontend/index.md`, `.pi/snflows/spec/backend/index.md`, `.pi/snflows/spec/guides/index.md` |

Minimum validation for code changes:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

## Deployment and Dependencies

| Topic | Entry point |
| --- | --- |
| Local development, production build/start, PM2, proxy scripts, npm package | `docs/deployment/README.md` |
| Runtime troubleshooting | `docs/operations/troubleshooting.md` |
| Third-party packages and pi SDK docs | `docs/integrations/README.md` |
| Published binary | `bin/pi-web.js` exposed as `spi` |
| Build wrapper | `scripts/build-next.js` |
| PM2 config | `ecosystem.config.cjs` |

## Data and Configuration

| Item | Location |
| --- | --- |
| Default data dir | `~/.pi/agent/` |
| Data dir override | `PI_CODING_AGENT_DIR` |
| Session files | `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl` |
| Session performance sidecars | `~/.pi/agent/session-performance/<encoded-session-id>.json` (aggregate counters only) |
| Model config | `~/.pi/agent/models.json` |
| WebUI model favorites (built-in, subscription, extension, custom) | `~/.pi/agent/model-favorites.json` (legacy `models.json` flags seed the first write) |
| Settings/default model/native subagents | `~/.pi/agent/settings.json`, project override `<cwd>/.pi/settings.json` |
| Web UI settings (WorkTree, Usage, Vision fallback model, Web Terminal, ChatGPT panel, Grok panel, Editor, bundled core-extension toggles, SnFlow panel). Unknown legacy root keys such as `trellis` are ignored and left on disk | `~/.pi/agent/pi-web.json` |
| Server access auth state (scrypt verifier + session hashes; no plaintext key) | `~/.pi/agent/server-access.json` |
| Server access policy (optional auth-bypass CIDRs; env can override) | `~/.pi/agent/server-access-policy.json` |
| Bundled Web Search provider/API key/base URL config | XDG-aware `~/.config/rpiv-web-tools/config.json` (or `XDG_CONFIG_HOME`) |
| WebUI SnFlow tasks | `<cwd>/.pi/snflows/tasks/<task-id>/` (archived: `<cwd>/.pi/snflows/archived/<task-id>/`; version/assets: `.pi/snflows/.version`, `.pi/extensions/snflow/`, `.pi/skills/snflow-dev/`, `.pi/agents/snflow-*.md`) |
| Project quick commands | `<cwd>/.pi/quick-commands.json` (definitions); `~/.pi/agent/quick-command-trust.json` (executable digests only); runs are in-memory per process |
| Automation tasks/runs/sessions | `~/.pi/agent/automations/` (`tasks.json`, locks, claims, runs, promotions, audit, sessions); default cwd `~/pi-automation-cwd` (canonical path persisted once) |

## Archive Rules

All durable project knowledge belongs under `docs/`. Add or update docs first, then point to them from this file when the entry is important for future agents.

| Knowledge type | Archive location |
| --- | --- |
| Architecture, boundaries, data flow, invariants | `docs/architecture/` |
| API, component, hook, and library module behavior | `docs/modules/` |
| Code, comment, testing, and validation standards | `docs/standards/` |
| Deployment, environment, CI/CD, release notes | `docs/deployment/` |
| Third-party components, external services, SDK usage | `docs/integrations/` |
| Operations, logs, troubleshooting, runbooks | `docs/operations/` |
| Research, analysis, future improvements | `docs/research/` |
| Implementation plans and delivery status | `docs/plans/` |
| Requirement/brainstorm source records | `docs/brainstorms/` |
| Important technical decisions | `docs/architecture/decisions/` |
| Agent skill notes | `docs/` flat file with a descriptive name, unless a closer docs category fits |

Current docs index:

- `docs/architecture/overview.md` — runtime flow, invariants, session JSONL format.
- `docs/architecture/decisions/README.md` — archive location for durable technical decisions.
- `docs/modules/api.md` — API route map and route implementation pointers.
- `docs/modules/frontend.md` — component/hook/style map.
- `docs/modules/library.md` — shared `lib/` module map and reuse rules.
- `docs/standards/code-style.md` — code, comment, validation, and testing entry point.
- `docs/deployment/README.md` — local, production, PM2, proxy, npm package, and data config.
- `docs/integrations/README.md` — dependency and pi SDK integration entry point.
- `docs/operations/troubleshooting.md` — runtime and development troubleshooting.
- `docs/operations/ui-visual-validation.md` — representative-theme, viewport, keyboard, Portal, contrast, motion, and screenshot validation runbook.
- `docs/automation-user-guide.zh-CN.md` — Automation setup, approval, run, promotion, and troubleshooting guide.
- `docs/plans/README.md` — implementation-plan status index and delivery pointers.
- `docs/research/README.md` — implemented/superseded investigations and open-research index.
- `docs/plans/README.md` — active implementation, performance, and functional-polish backlog index.

## AI Working Conventions

- Start by following the reading order for the task type.

- Before modifying code, read the relevant module docs and source files.

- Keep `AGENTS.md` concise and navigational; move detailed explanations to `docs/`.

- When adding/removing API routes, update `docs/modules/api.md` and this file only if the top-level navigation changes.

- When adding/removing major components, hooks, or shared modules, update the relevant file under `docs/modules/`.

- When changing deployment, dependencies, or external integrations, update `docs/deployment/` or `docs/integrations/`.

- Preserve user-authored content unless it is stale, misleading, duplicated in docs, or conflicts with this contract.

- Upon project completion, unless the user explicitly requests that the project be launched for testing, the only requirement is to ensure that compilation and unit tests pass.
