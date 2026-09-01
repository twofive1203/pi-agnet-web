# Integrations and Dependencies

## Primary Runtime Dependencies

See `package.json` for exact versions.

| Dependency | Purpose |
| --- | --- |
| `next`, `react`, `react-dom` | Web application framework/runtime. |
| `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` | In-process pi AgentSession and AI provider integration. **Pinned to exact `0.84.1`**. Auth/catalog access goes through `ModelRuntime` (`lib/pi-auth.ts`); multi-account helpers use `FileCredentialStore` for `auth.json` because public `AuthStorage` was removed. Provider headers may include `null` deletion markers (`toStringHeaders` strips them for fetch). |
| `pi-subagents@0.40.0`, `@juicesharp/rpiv-web-tools@2.3.1`, `pi-ask-user@0.13.1`, `pi-manage-todo-list@0.4.0` | Exact-version WebUI-bundled Pi extensions for subagents, web tools, structured user questions, and Todo management. Enabled by default for ordinary interactive Web sessions and individually disableable through `pi-web.json`; Automation does not inherit them. `postinstall` runs `scripts/patch-pi-subagents-stale-ctx.mjs` so pi-subagents shutdown cleanup recognizes Pi 0.84+ stale-ctx error text. |
| `typebox` | Tool parameter schemas used directly by first-party extensions. Pinned to Pi's `1.3.7` runtime version to keep schema objects compatible. |
| `react-markdown`, `remark-gfm`, `remark-math`, `rehype-raw`, `rehype-sanitize`, `rehype-katex`, `katex` | Markdown, raw HTML sanitization, and math rendering. |
| `react-syntax-highlighter` | Code block highlighting. |
| `mermaid` | Diagram rendering. |
| `mammoth` | DOCX content handling. |
| `@lobehub/icons` | Provider/model icon assets. |
| `@xterm/xterm`, `@xterm/addon-fit` | Browser-side Web Terminal rendering and sizing. |
| `@lydell/node-pty` | Server-side local PTY process for interactive Web Terminal sessions; selected because the original `node-pty` failed under the local Node 26 runtime. |
| `ws` | Loopback browser-bridge WebSocket server used by the Chrome tab debugging extension. |
| `cron-parser` | Five-field cron parsing for Scheduled Agent Automation (`lib/automation-schedule.ts`). |
| `extensions/chrome-tab-debug` | First-party Chrome MV3 extension (unpacked) for temporary tab binding and restricted DOM/debug tools. |

## pi SDK Documentation

When changing pi SDK usage, read the installed package documentation first:

- `node_modules/@earendil-works/pi-coding-agent/README.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/`
- `node_modules/@earendil-works/pi-coding-agent/examples/`

## Auth Providers

Auth-related API routes live under `app/api/auth/`. From pi `0.80.10+`, login/logout/catalog/request-auth are owned by `ModelRuntime`:

- Shared helpers: `lib/pi-auth.ts`
- Direct `auth.json` read/write for multi-account Codex flows: `lib/file-credential-store.ts`
- Do not import removed public `AuthStorage` APIs from `@earendil-works/pi-coding-agent`

Provider-specific network calls remain isolated in `lib/` helpers.

### Model Pricing (pi.dev)

Model pricing synchronization fetches `https://pi.dev/api/models` on manual request (POST `/api/model-pricing`), validates the JSON response, and persists a normalized cache at `~/.pi/agent/model-pricing.json`. GET requests always read the local cache and never perform network I/O. The cache is written atomically (same-directory temp file + rename) so a failed refresh cannot corrupt the previous catalog.

Pricing lookup resolves by exact provider+model id first, then by unique model-id-only match when the model id appears exactly once across all providers. The UI auto-fills missing cost fields (`input`, `output`, `cacheRead`, `cacheWrite`) and `contextWindow` for custom providers and discovered model additions without overwriting user-entered values. Ambiguous model-id matches are not guessed: Models settings exposes the cached provider/model/cost candidates in a manual match dialog. The same cache is available in the searchable `ModelPricingCatalog` viewer; opening it performs local GET only.

### Grok CLI package

Grok subscription access is provided by the third-party `pi-grok-cli` Pi package, not by a copied provider implementation in pi-web:

```bash
pi install npm:pi-grok-cli
```

`pi-grok-cli` 0.5.0 or newer requires Pi 0.80.0 or newer. The package registers the `grok-cli` provider, OAuth flow, models, commands and tools through Pi's extension APIs. After installation, authenticate from the Models provider UI or Pi's `/login` flow.

**Usage/quota queries do not use the extension command bridge or initialize AgentSession.** The Web UI owns billing fetch and display through `lib/grok-usage.ts` and `GET /api/auth/usage/grok-cli`, which directly calls the xAI weekly billing endpoint (`/billing?format=credits`). Token resolution order is `GROK_CLI_OAUTH_TOKEN` env bypass, then OAuth credentials under either `grok-cli` (the extension provider) or `xai` (Pi's built-in xAI provider) in `auth.json`; there is no extension-registry fallback. Expired OAuth credentials are refreshed under their original provider key. Weekly billing uses a 15-second deadline; monthly billing is no longer queried or displayed. The last-known successful weekly result is cached at `~/.pi/agent/grok-cli-usage-cache.json` (v2 weekly-only schema) and shown cache-first; only manual refresh hits live billing. Per-account weekly progress can also be queried with `accountId` + `provider` against the OAuth account store without activating non-active accounts; weekly utilization is mirrored into each account's `quotaCache` for Models/top-bar account rows. This path requires no workspace cwd or running Pi SDK session.

OAuth login, model catalog, streaming, and tools are still owned by `pi-grok-cli`. Usage query is the only path that was migrated from extension command to server-owned implementation.

## MCP adapter configuration (`pi-mcp-adapter`)

`pi-mcp-adapter` is an optional Pi package, not a built-in WebUI transport:

```bash
pi install npm:pi-mcp-adapter
```

Settings → **MCP** edits adapter-native files only:

| Target | Path |
| --- | --- |
| User shared | `~/.config/mcp/mcp.json` |
| User Pi override | `<Pi agent dir>/mcp.json` |
| Project shared | `<cwd>/.mcp.json` |
| Project Pi override | `<cwd>/.pi/mcp.json` |

Read-only diagnostics also show `~/.agents/mcp.json` and `~/.agents/mcp/mcp.json`. Precedence matches the adapter: shared user → agents globals → Pi user override → project shared → project Pi override.

WebUI responsibilities:

- Browser-safe redacted projections (never return existing `env`/`headers`/`bearerToken`/`oauth.clientSecret` values).
- Field operations with preserve/replace/clear secret semantics, JSONC comment/unknown-field preservation, revision conflicts, and atomic writes.
- Package configured detection via Pi `settings.json` package metadata only (no adapter import, no resource loader reload, no connect/OAuth/`!command` execution).

Runtime ownership stays with the adapter loaded by the ordinary Pi `DefaultResourceLoader` path. Successful saves return `reloadRequired: true`; new sessions pick up changes automatically and the current session needs `/reload`. Settings never destroy/recreate `globalThis.__piSessions`.

Scheduled Automation does **not** automatically inherit this interactive MCP configuration or tools. Automation keeps its independent approved-extension allowlist and network policy.

## Skills, Commands, and Subagents

Skill search/install/list routes live under `app/api/skills/`; slash-command discovery lives under `app/api/commands/`. Use `lib/npx.ts` for cross-platform `npx` execution.

The WebUI uses the pi SDK in-process, and SDK resource discovery is the source of truth for installed Pi packages/extensions in `PI_CODING_AGENT_DIR` / `getAgentDir()`. Extension tools such as the official `pi-subagents` package may spawn nested Pi runtimes; `lib/pi-runtime-resolver.ts` prepares a local `pi` shim, package-resolution link, and Unix `PI_SUBAGENT_PI_BINARY` before SDK sessions start so those child processes use the project/package Pi CLI instead of relying on the server process `PATH`.

Session-bound extensions and tools must resolve their project root from the active
extension context (`ctx.cwd`) for every session-scoped event and tool call. They
must not use the WebUI server's `process.cwd()` as the authoritative workspace
because one server can host sessions for multiple projects. The process cwd is
only a fallback when the SDK context does not expose a workspace.

Web sessions call `AgentSession.bindExtensions()` with a Web/RPC UI adapter so extension commands, lifecycle events, simple dialogs/notifications, and diagnostics are available without shelling out to the local CLI. Use `/api/pi/resources?cwd=...` to inspect loaded extensions, tools, extension commands, skills, prompts, bundled source metadata, and duplicate suppression diagnostics.

### WebUI-bundled core extensions

`lib/bundled-pi-extension-registry.ts` owns the four pinned package definitions/defaults and `lib/bundled-pi-extensions.ts` is their single interactive loader adapter. It adds each enabled package root as a temporary resource source, preserving package-relative extension/skill/prompt behavior. Package resolution obtains `createRequire` through Node's runtime `process.getBuiltinModule("module")`; do not replace it with a static `node:module` import because Next/webpack can erase that call in production server chunks. Before factories bind, it removes another loaded copy with the same package manifest name, so the WebUI-pinned copy wins without duplicate tools, commands, or lifecycle handlers. The user's Pi `settings.json` is never rewritten; disabling a bundle only changes `pi-web.json → bundledExtensions` and applies to new sessions or `/reload`.

This helper is used by interactive chat, command/resource/skill inspection, native subagent discovery, extension-settings discovery, and the legacy SnFlow host. Automation deliberately keeps its reviewed resource loader and never calls it. After `npm run build`, `npm run test:bundled-extensions:production` starts the emitted production server with a fresh agent directory and verifies that all four bundles are available and their six extension tools reach the session schema.

### Web Search provider configuration

Settings → **Web Search** edits the adapter-native XDG-aware `rpiv-web-tools/config.json` through `lib/web-tools-config.ts` and `/api/web-tools/config`. The UI separates the persisted default search provider from the provider whose API key or self-hosted URL is being configured, so credential maintenance does not implicitly switch the default backend. The browser receives configured/source metadata only—never stored or environment API-key values. Writes use explicit preserve/replace/clear operations, exact-byte revision checks, same-directory atomic rename, and unknown-field-preserving object merges. Runtime precedence remains per-call provider override → `WEB_SEARCH_PROVIDER` → persisted provider → Brave default, while keys use provider env → `apiKeys[provider]` → legacy Brave `apiKey`; SearXNG/Ollama URL environment variables similarly shadow stored URLs. The package reads config on every tool execution, so saved provider/key/URL changes affect subsequent calls in an existing session.

## Native Pi Subagent Settings

The Web UI supports direct management of native pi-subagents model configuration
through a dedicated **Agents** section in Settings. SnFlow implement/check agents
use that same native model configuration.

### Configuration Boundary

| System | File | Scope | Purpose |
|--------|------|-------|---------|
| Native pi-subagents | `settings.json → subagents` | User/Project | pi-subagents extension native model config (defaultModel, agentOverrides) |
| SnFlow panel preferences | `pi-web.json → workflow` | User | Drawer preferences such as `includeArchived` and `trackInGit` (legacy `enabled` ignored) |

The WebUI-owned SnFlow panel prepares a selected-task-bound instruction for the
current chat, which calls the native `subagent` tool directly for implement/check.
The SnFlow chat lifecycle validator checks the marker before execution and
persists the native tool result; the existing Subagent panel owns live progress.
Models come only from native `settings.json → subagents`. Unknown legacy raw
`pi-web.json` keys such as `trellis` are ignored and preserved on disk. Project
initialization makes the managed resources available, while actual workflow entry
is soft-gated: ordinary work stays direct unless the user explicitly requests
SnFlow, invokes `snflow-dev`, or continues an active non-terminal task. Check
runs treat only `error` findings as blockers; warnings and informational findings
pass and are reported for user choice.

SnFlow project initialization installs managed assets from the bundled manifest in
`lib/snflow-assets.ts` into the selected workspace (extension, skill, agents, CLI
wrapper, and `.pi/snflows/.version`). Update rewrites only that whitelist. The
project-local `scripts/snflow-task.ts` wrapper records the validated absolute root
of the Snail Pi Web instance that installed it and imports that instance's
`scripts/workflow-task.ts` in the current `tsx` process; target projects do not
need to install `@twofive/snail-pi-web`. Moving or replacing the WebUI install
requires running SnFlow Update so the recorded root is refreshed. Published
packages include `lib/` because the CLI imports the workflow modules directly.
When `.pi/extensions/snflow/` is present it owns chat guidance via
`before_agent_start`; otherwise the WebUI keeps the legacy
`lib/workflow-guidance.ts` injection path.

Managed asset version `1.6.0` also registers the Web-supported
`/snflow-spec-review` extension command. It validates the current physical,
non-archived task and required task/Spec documents from command `ctx.cwd`, then
uses `pi.sendUserMessage()` to start a read-only review in the current main
Agent. The review produces evidence-backed `add` / `revise` / `remove` /
`do_not_capture` candidates and stops without writing. Pending candidates live
only in the conversation; after a later explicit user selection, the main Agent
revalidates task and Spec state and writes only accepted candidates under
`.pi/snflows/spec/`, synchronizing affected indexes. The command takes no task
id in v1, does not inspect archives, does not invoke a subagent or task CLI, and
does not add a workflow state transition. Existing initialized projects must run
SnFlow Update to receive the command; update preserves their project-owned Spec.

### Settings Precedence (Native)

Per `pi-subagents` resolver, effective model order (highest to lowest):

1. Runtime tool-call override (`model` in subagent() call)
2. Chain step / parallel task override
3. Agent frontmatter (`model:` in `.md`)
4. Settings `agentOverrides.<name>.model` (project scope)
5. Settings `agentOverrides.<name>.model` (user scope)
6. Settings `defaultModel` (project scope)
7. Settings `defaultModel` (user scope)
8. Parent session model

### Supported Managed Fields

The Web UI's Agents section manages these fields in `settings.json → subagents`:

- `defaultModel` — global fallback for agents without explicit model
- `agentOverrides.<name>.model` — per-agent primary model
- `agentOverrides.<name>.thinking` — per-agent thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `agentOverrides.<name>.fallbackModels` — ordered list of fallback models

Clearing a field removes the selected-scope key and restores normal inheritance.
The UI never writes placeholder model ids.

### API

| Route | Description |
|-------|-------------|
| `GET /api/subagents/config?scope=user|project&cwd=...` | Read managed settings, inherited user values, and discovered agents |
| `PUT /api/subagents/config?scope=user|project&cwd=...` | Apply managed-field patch with revision conflict detection |

### Discovery

Agent discovery uses the installed pi-subagents extension's public management
tool surface (not filesystem scanning). When the extension is unavailable or
its `list` output cannot be parsed, the API returns a browser-safe diagnostic
and still shows settings-only override names so stale entries can be cleared.

## Scheduled Agent Automation

- Domain libraries live under `lib/automation-*.ts` and are independent of SnFlow.
- Headless runs load the pi SDK (`@earendil-works/pi-coding-agent`) with an approved-extension allowlist and Automation-owned reviewed web tool adapters (`lib/automation-reviewed-web-tools.ts` + `lib/automation-network-policy.ts`).
- Interactive sessions may inject the `automation_tasks` tool; scheduled-origin sessions must never load it.
- Network egress for Automation uses DNS + connect-IP checks, redirect revalidation, and streaming size/time limits — not unrestricted `fetch`.
