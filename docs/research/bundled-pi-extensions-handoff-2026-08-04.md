# Handoff: Bundle Core Pi Extensions into Snail Pi Web

Date: 2026-08-04  
Branch: `theme/concept-b-workbench`  
Baseline commit: `3a25871` (`fix(session): align usage totals with CLI`)  
Status: implemented in the continuation session; focused and project validation passed

## Implementation outcome

Implemented through:

- `lib/bundled-pi-extension-registry.ts` and `lib/bundled-pi-extensions.ts` for exact-version registry, default enablement, interactive resource loading, bundled provenance, and bundled-wins duplicate filtering.
- `pi-web.json → bundledExtensions` plus Settings → Extensions toggles.
- Shared integration across interactive RPC sessions, resource/command/skill inspection, native subagent discovery, extension-settings discovery, and the legacy SnFlow host. Automation remains on its independent reviewed loader.
- `lib/web-tools-config.ts`, `/api/web-tools/config`, and `components/WebToolsConfig.tsx` for redacted provider/key/base-URL management with preserve/replace/clear operations, environment precedence, revision conflicts, XDG/legacy path behavior, unknown-field preservation, and atomic writes.
- `scripts/smoke-bundled-pi-extensions.ts` and `scripts/smoke-web-tools-config.ts` for focused acceptance coverage.

Validation completed: ESLint, TypeScript, bundled-extension/Web Search focused smokes, agent-stream, SnFlow, Automation, runtime packaging, MCP, and UI theme contract.

Known validation boundary: the no-global-PATH smoke verifies the project-local Pi CLI/shim and bundled native discovery, but does not make a paid provider call in a real foreground child process.

## Original implementation goal

Make Snail Pi Web fully functional for users who install/run only this project and do not have a separate global Pi Agent CLI/package setup.

Bundle these four curated Pi extensions with the WebUI and enable them by default:

1. `pi-subagents@0.40.0`
2. `@juicesharp/rpiv-web-tools@2.3.1`
3. `pi-ask-user@0.13.1`
4. `pi-manage-todo-list@0.4.0`

Also add first-class WebUI Settings management for the `rpiv-web-tools` search provider, API key, and self-hosted provider URL configuration.

## Confirmed product decision

The user explicitly selected:

> **Bundled default versions + individually disableable in WebUI**

Interpretation:

- The four packages are exact-version runtime dependencies of `@twofive/snail-pi-web`.
- New WebUI installations get the capabilities without running `pi install`.
- All four are enabled by default for ordinary interactive Web sessions.
- Settings exposes per-extension enable/disable controls.
- If the user also configured the same package in Pi's global/project `settings.json`, the WebUI must avoid duplicate extension/tool/command/lifecycle registration.
- WebUI bundling must not rewrite or remove the user's Pi `settings.json` package entries.
- External Pi CLI behavior remains independent and unchanged.
- Scheduled Automation must not inherit these bundled interactive extensions automatically; its reviewed allowlist/security model remains authoritative.

All four packages currently declare MIT licenses.

## Problem frame

Snail Pi Web already includes `@earendil-works/pi-coding-agent@0.83.0` and uses the SDK in-process. However, extension discovery currently relies on packages configured/installed under the user's Pi agent directory. A user who installs only Snail Pi Web can therefore lose:

- native subagents and SnFlow execution,
- `web_search` / `web_fetch`,
- structured `ask_user` interactions,
- `manage_todo_list` and the WebUI Todo panel.

The WebUI already has dedicated integration code for these capabilities, so requiring a second manual `pi install` step is an avoidable product gap.

## Current verified state

### Pi/Web runtime

- Project Pi SDK: `@earendil-works/pi-coding-agent@0.83.0`
- `lib/pi-runtime-resolver.ts` already prepares a project/package-local Pi CLI shim for extension tools such as `pi-subagents`.
- A global `pi` executable is therefore not inherently required, but the bundled `pi-subagents` path and child launch behavior must be validated end-to-end after integration.
- Interactive Web sessions bind extensions using the RPC/Web bridge in `lib/extension-web-ui.ts`.

### Current user installation inspected during this session

The local user had all four packages installed under `<getAgentDir()>/npm/node_modules`, but this is user-specific and must not be assumed by the product.

Observed tools:

| Package | Tools |
| --- | --- |
| `pi-subagents` | `subagent`, `subagent_wait`, `subagent_supervisor`, `intercom` |
| `@juicesharp/rpiv-web-tools` | `web_search`, `web_fetch` |
| `pi-ask-user` | `ask_user` |
| `pi-manage-todo-list` | `manage_todo_list` |

Observed supporting resources:

- `pi-subagents`: extension + skill + prompt templates
- `pi-ask-user`: extension + `ask-user` skill
- `pi-manage-todo-list`: extension and Todo widget
- `rpiv-web-tools`: extension and `/web-tools` command

### Existing WebUI support

- `pi-subagents` results/progress are projected into the Subagent panel.
- Settings → Agents reads/writes native `settings.json → subagents` configuration.
- SnFlow implement/check uses native `pi-subagents`.
- `ask_user` has an RPC/headless fallback using `select`/`input`; WebUI already supports those dialogs.
- `manage_todo_list`'s `todo-list` widget is materialized and shown in `ExtensionTodoPanel`.
- `web_search` and `web_fetch` work in ordinary sessions when the package and credentials are present.
- Browser tools and `automation_tasks` are WebUI-owned `customTools`; they are not part of this bundling request.

## Requirements

### Bundled extension registry

- R1. Add the four exact-version packages to production `dependencies`, not `devDependencies`.
- R2. Introduce one central WebUI-owned bundled-extension registry containing stable id, npm package identity, pinned version, entry point/resources, default-enabled state, and display metadata.
- R3. Ordinary interactive Web sessions load every enabled bundled extension even when Pi user/project settings contain no package entries.
- R4. Bundled skills and prompts must be discoverable where the package supplies them, especially `pi-subagents` and `pi-ask-user`.
- R5. Resource and command inspection endpoints must report the same effective bundled resources as real Web sessions and identify them as WebUI-bundled.

### Enable/disable and deduplication

- R6. Settings exposes an individual enabled toggle for each bundled extension; default is enabled.
- R7. Store WebUI-only enablement in `pi-web.json`, not Pi's `settings.json`, so CLI package configuration is not mutated.
- R8. A disabled bundled extension is absent from new/reloaded Web sessions, resource inspection, and command discovery.
- R9. If the same npm package is configured globally or per-project in Pi settings, WebUI loads only one effective copy. The chosen policy is that the pinned WebUI-bundled version wins inside WebUI sessions.
- R10. Deduplication must prevent duplicate lifecycle handlers, duplicate tool replacement, and suffixed duplicate slash commands such as `command:1`.
- R11. The UI/resource diagnostics should make the ignored duplicate understandable without exposing private paths unnecessarily.

### Runtime boundaries

- R12. Native subagent discovery in `lib/pi-subagent-discovery.ts` must work from the bundled package when no user-installed `pi-subagents` exists.
- R13. SnFlow's current-chat lifecycle and legacy hidden-host paths must continue to find `pi-subagents` when bundled.
- R14. Child subagent processes must use the project-local Pi runtime and required package assets without requiring global `pi` or a package under the Pi agent directory.
- R15. Scheduled Automation does not auto-load these four extensions. Its snapshot/intersection/reviewed-extension policy remains unchanged.
- R16. Existing global/project loose extensions, unrelated packages, skills, prompts, themes, and project trust behavior continue to work.

### Web Search settings

- R17. Add a Settings section for selecting the active `rpiv-web-tools` provider and managing its credential/configuration.
- R18. Read/write the adapter-native config file used by the bundled package: `~/.config/rpiv-web-tools/config.json` (platform-resolved by its config helper semantics).
- R19. Existing API keys must never be returned to the browser. Return only source/configured/masked-state metadata.
- R20. Secret edits use explicit `preserve`, `replace`, and `clear` semantics; leaving a masked field untouched must not erase the stored key.
- R21. Preserve unknown config fields, `guidance`, `interceptors`, and other package-owned data that the WebUI does not manage.
- R22. Handle malformed files and concurrent edits safely with parse diagnostics, revision comparison, and atomic same-directory writes.
- R23. Respect runtime precedence: per-provider environment variable → `apiKeys[provider]` → legacy Brave `apiKey`; `WEB_SEARCH_PROVIDER` overrides the persisted selected provider.
- R24. Show when an environment variable controls provider/key/base URL and explain that persisted changes may be shadowed.
- R25. Manage self-hosted base URLs where supported, currently SearXNG and Ollama, without treating a URL as a secret.
- R26. Configuration changes apply to subsequent `web_search`/`web_fetch` calls without destroying active sessions. The current package reads config on every execute; extension enable/disable changes may require `/reload` or a new session.

### Provider catalog for bundled `rpiv-web-tools@2.3.1`

The inspected package currently contains:

| Id | Label | Roles | Special config |
| --- | --- | --- | --- |
| `brave` | Brave | search | API key; legacy top-level `apiKey` compatibility |
| `tavily` | Tavily | search, fetch | API key |
| `serper` | Serper | search | API key |
| `exa` | Exa | search, fetch | API key |
| `youcom` | You.com | search, fetch | API key |
| `jina` | Jina | search, fetch | API key |
| `firecrawl` | Firecrawl | search, fetch | API key |
| `perplexity` | Perplexity | search | API key |
| `searxng` | SearXNG | search | base URL + optional bearer key |
| `ollama` | Ollama | search, fetch | base URL + optional key |

The implementation should avoid silently drifting from the pinned package's provider catalog. Prefer a typed adapter around package exports when practical; otherwise keep a version-bound WebUI catalog plus a smoke test that detects divergence.

## Acceptance examples

- AE1. With a fresh agent directory containing no `packages`, start Snail Pi Web and create a session: all four tools are available.
- AE2. Configure `npm:pi-subagents` in user `settings.json` while the bundled copy is enabled: only one `subagent` tool and one set of subagent commands/lifecycle handlers exist.
- AE3. Disable bundled Todo in Web settings, reload/new session: `manage_todo_list` and its widget are absent while the other three remain.
- AE4. With no global Pi executable on `PATH`, invoke bundled `subagent` and complete a foreground child run using the project-local Pi runtime.
- AE5. Store a Brave key, reload Settings, and inspect network responses: the browser never receives the existing key; a preserve save leaves it intact.
- AE6. Set `BRAVE_SEARCH_API_KEY` in the server environment and a different stored key: Settings reports environment precedence without revealing the environment value; runtime uses the environment key.
- AE7. Edit an unrelated `guidance` or interceptor field directly, then save provider/key through WebUI: unrelated fields remain byte-semantically preserved.
- AE8. Change the selected provider/key and call `web_search` again in the existing session: the next call uses the new persisted configuration without recreating the session.
- AE9. Run Automation catalog/policy smokes: bundled interactive extensions do not appear as automatically approved scheduled-run tools.

## Recommended architecture

### 1. Central bundled extension module

Create a shared module, likely under `lib/`, that owns:

- package metadata and pinned identities,
- enabled-state projection from `pi-web.json`,
- extension/skill/prompt path resolution from this project's `node_modules`,
- effective loader options,
- duplicate filtering for configured user/project copies,
- source metadata/diagnostics.

Do not duplicate loader assembly independently in each API/runtime path.

Potential SDK mechanisms already available in Pi 0.83.0:

- `DefaultResourceLoader.additionalExtensionPaths`
- `additionalSkillPaths`
- `additionalPromptTemplatePaths`
- named `extensionFactories`
- `extensionsOverride`, `skillsOverride`, `promptsOverride`

Path-based loading preserves package-relative behavior better than copying source into this repository. Named inline factories can provide clean source names but require separate handling for package skills/prompts and careful child-runtime behavior.

### 2. Apply the same effective loader to all relevant consumers

At minimum inspect/update:

| Concern | Current entry points |
| --- | --- |
| Interactive sessions | `lib/rpc-manager.ts` |
| Resource inventory | `app/api/pi/resources/route.ts` |
| Slash command discovery | `app/api/commands/route.ts` |
| Native agent discovery | `lib/pi-subagent-discovery.ts` |
| Extension settings discovery | `lib/extension-settings.ts` |
| SnFlow hidden compatibility host | `lib/workflow-run-manager.ts` |
| Shared session helpers | `lib/agent-session-services.ts` |
| Runtime shim/package resolution | `lib/pi-runtime-resolver.ts` |

Search all `createAgentSession(` and `new DefaultResourceLoader(` callers before implementation. Do not apply interactive defaults to Automation runners.

### 3. WebUI config

Extend `lib/pi-web-config.ts` with a supported section such as:

```json
{
  "bundledExtensions": {
    "pi-subagents": true,
    "rpiv-web-tools": true,
    "pi-ask-user": true,
    "pi-manage-todo-list": true
  }
}
```

Names are illustrative; choose stable ids once and use them across API/UI/tests. Unknown raw keys must continue to be preserved according to the existing `pi-web.json` contract.

### 4. Web Search config domain

Prefer a dedicated domain/API/UI boundary rather than putting secrets in `pi-web.json`:

- `lib/web-tools-config.ts` — native path resolution, safe read projection, revision, operations, atomic write, unknown-field preservation.
- `app/api/web-tools/config/route.ts` — local authorized GET/PUT.
- `components/WebToolsConfig.tsx` — provider selection, source badges, masked secret operations, SearXNG/Ollama URL fields.
- Embed in `components/SettingsConfig.tsx` with its own loading/dirty/save/conflict boundary, similar in spirit to `McpConfig` but scoped to this simpler config.

Do not expose raw file content or secrets. Do not store keys in client state after save.

## Important implementation risks

### Duplicate copies

Adding dependencies alone is insufficient. The current user may already have the same packages configured under `~/.pi/agent/settings.json`; loading both filesystem copies can duplicate commands and lifecycle handlers even if a tool name appears to overwrite another. Deduplication is a correctness requirement.

### `pi-subagents` child runtime

The parent extension can be loaded from the WebUI package, but `pi-subagents` also spawns child Pi processes and discovers package skills/agents. Validate:

- project-local CLI shim resolution,
- extension paths passed to children,
- nested/fanout behavior,
- package root discovery when the package is in the WebUI's `node_modules` rather than `<agentDir>/npm/node_modules`,
- builtin/user/project agent discovery,
- SnFlow managed project agents.

Do not claim global-CLI independence until this passes an end-to-end child run.

### Third-party code trust

Bundling makes third-party extension code run by default with server permissions. Mitigations:

- exact version pins,
- lockfile review,
- MIT license notices as needed,
- release-time dependency/security review,
- explicit WebUI disable controls,
- no automatic unpinned updates.

### Secret handling

`rpiv-web-tools` currently supports unknown-field pass-through and a legacy Brave `apiKey`. A naive full-object PUT could leak or erase secrets. Use server-side field operations and browser-safe projections, following the project's existing MCP secret-handling principles where applicable.

### Automation boundary

Automation intentionally uses an approved-extension allowlist and reviewed web adapters. Do not reuse the interactive bundled registry as an Automation approval source.

## Explicit non-goals for the first implementation

- Copying/forking the four third-party codebases into this repository.
- Auto-writing the four packages into the user's Pi `settings.json`.
- Changing external Pi CLI package selection or versions.
- Automatically enabling bundled extensions in Scheduled Automation.
- Building a generic third-party extension marketplace/update system.
- Adding provider billing dashboards or account management.
- Storing Web Search API keys in `pi-web.json` or returning them to the browser.
- Live provider connectivity tests unless separately scoped; provider/key CRUD and runtime use are sufficient for v1.

## Validation expectations

Minimum project validation after implementation:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:agent-stream
npm run test:snflow
npm run test:automation
npm run test:runtime
```

Add focused smokes for:

1. fresh-agent-dir bundled discovery,
2. duplicate configured package filtering,
3. per-extension disabled state,
4. resource/command/session consistency,
5. no-global-CLI foreground subagent execution,
6. Web Search config redaction/preserve/replace/clear/revision/atomic-write behavior,
7. environment precedence projection,
8. provider catalog synchronization,
9. Automation exclusion.

Use `npm run build` only for release/packaging validation; never run bare `next build`.

## Suggested next-session procedure

1. Read this document plus:
   - `AGENTS.md`
   - `docs/integrations/README.md`
   - `docs/architecture/overview.md` (Models and tools / extension sections)
   - `docs/modules/api.md`
   - `docs/modules/frontend.md`
   - `docs/modules/library.md`
   - Pi SDK `docs/extensions.md`, `docs/packages.md`, and `docs/rpc.md`
2. Re-run `git status`; the baseline was clean before this handoff document was added.
3. Search every `DefaultResourceLoader` and `createAgentSession` caller.
4. Produce a concrete implementation plan that resolves the `pi-subagents` child-runtime path and dedupe mechanism before coding.
5. Implement in small stages:
   - dependency pins + central registry,
   - effective loading/deduplication across interactive/discovery paths,
   - enable/disable config/UI,
   - Web Search config domain/API/UI,
   - focused smokes/docs.
6. Update durable docs and `AGENTS.md` only if top-level navigation/reading guidance changes.

## Suggested first message for the new session

```text
继续“WebUI 内置核心 Pi 扩展 + Web Search 配置管理”开发。
先读 docs/research/bundled-pi-extensions-handoff-2026-08-04.md，并按 AGENTS.md 的依赖/Pi SDK 阅读顺序补齐上下文。
已确认产品决策：内置 pi-subagents、rpiv-web-tools、pi-ask-user、pi-manage-todo-list 的固定版本，WebUI 默认启用且可逐项关闭；Web 会话中内置版本优先并去重用户同名包，不修改用户 Pi CLI 配置；Automation 不自动继承。
另外实现 Settings 中 Web Search provider/API Key/base URL 管理，必须做到密钥不回传、preserve/replace/clear、环境变量优先级提示、revision 冲突和原生配置字段保留。
先做实现计划，重点验证 pi-subagents 在没有全局 Pi CLI/agent-dir 包安装时的子进程路径，再开始编码。
```

## Handoff state

- No product code was changed in the originating session.
- This handoff document is the only intended repository change from that session, plus its optional index link in `docs/research/README.md`.
- No SnFlow task was created; the user should explicitly opt in if the next session should run this work through SnFlow.
