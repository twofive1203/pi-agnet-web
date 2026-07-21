# Integrations and Dependencies

## Primary Runtime Dependencies

See `package.json` for exact versions.

| Dependency | Purpose |
| --- | --- |
| `next`, `react`, `react-dom` | Web application framework/runtime. |
| `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` | In-process pi AgentSession and AI provider integration. **Pinned to exact `0.80.10`**. Auth/catalog access goes through `ModelRuntime` (`lib/pi-auth.ts`); multi-account helpers use `FileCredentialStore` for `auth.json` because public `AuthStorage` was removed. |
| `react-markdown`, `remark-gfm`, `remark-math`, `rehype-raw`, `rehype-sanitize`, `rehype-katex`, `katex` | Markdown, raw HTML sanitization, and math rendering. |
| `react-syntax-highlighter` | Code block highlighting. |
| `mermaid` | Diagram rendering. |
| `mammoth` | DOCX content handling. |
| `@lobehub/icons` | Provider/model icon assets. |
| `@xterm/xterm`, `@xterm/addon-fit` | Browser-side Web Terminal rendering and sizing. |
| `@lydell/node-pty` | Server-side local PTY process for interactive Web Terminal sessions; selected because the original `node-pty` failed under the local Node 26 runtime. |

## pi SDK Documentation

When changing pi SDK usage, read the installed package documentation first:

- `node_modules/@earendil-works/pi-coding-agent/README.md`
- `node_modules/@earendil-works/pi-coding-agent/docs/`
- `node_modules/@earendil-works/pi-coding-agent/examples/`

## Auth Providers

Auth-related API routes live under `app/api/auth/`. From pi `0.80.10`, login/logout/catalog/request-auth are owned by `ModelRuntime`:

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

**Usage/quota queries do not use the extension command bridge.** The Web UI owns billing fetch and display through `lib/grok-usage.ts` and `GET /api/auth/usage/grok-cli`, which directly calls the xAI billing endpoints. Token resolution order: `GROK_CLI_OAUTH_TOKEN` env bypass → OAuth credentials under either `grok-cli` (the extension provider) or `xai` (Pi's built-in xAI provider) in `auth.json` → the loaded extension registry as a compatibility fallback. Expired OAuth credentials are refreshed under their original provider key. The last-known successful result is cached at `~/.pi/agent/grok-cli-usage-cache.json` and is shown cache-first; only manual refresh hits live billing. This path does not require a workspace cwd and does not depend on a running Pi SDK session or `/grok-cli-usage`.

OAuth login, model catalog, streaming, and tools are still owned by `pi-grok-cli`. Usage query is the only path that was migrated from extension command to server-owned implementation.

## Skills, Commands, and Subagents

Skill search/install/list routes live under `app/api/skills/`; slash-command discovery lives under `app/api/commands/`. Use `lib/npx.ts` for cross-platform `npx` execution.

The WebUI uses the pi SDK in-process, and SDK resource discovery is the source of truth for installed Pi packages/extensions in `PI_CODING_AGENT_DIR` / `getAgentDir()`. Extension tools such as the official `pi-subagents` package may spawn nested Pi runtimes; `lib/pi-runtime-resolver.ts` prepares a local `pi` shim, package-resolution link, and Unix `PI_SUBAGENT_PI_BINARY` before SDK sessions start so those child processes use the project/package Pi CLI instead of relying on the server process `PATH`.

The local Trellis extension must resolve its project root from the active extension context (`ctx.cwd`) for every session-bound event and tool call. It must not use the WebUI server's `process.cwd()` as the authoritative workspace because one server can host sessions for multiple projects. The process cwd is only a fallback when the SDK context does not expose a workspace.

Web sessions call `AgentSession.bindExtensions()` with a Web/RPC UI adapter so extension commands, lifecycle events, simple dialogs/notifications, and diagnostics are available without shelling out to the local CLI. Use `/api/pi/resources?cwd=...` to inspect loaded extensions, tools, extension commands, skills, prompts, and load diagnostics.

## Native Pi Subagent Settings

The Web UI supports direct management of native pi-subagents model configuration
through a dedicated **Agents** section in Settings, independent of Trellis workflow
routing.

### Configuration Boundary

Two separate subagent configuration systems exist:

| System | File | Scope | Purpose |
|--------|------|-------|---------|
| Native pi-subagents | `settings.json → subagents` | User/Project | pi-subagents extension native model config (defaultModel, agentOverrides) |
| Trellis routing | `pi-web.json → trellis.subagents` | User | Web UI Trellis workflow routing policy only |

The WebUI-owned SnFlow panel (`pi-web.json → workflow` compatibility key) dispatches implement/check
through native pi-subagents RPC and uses the native `settings.json → subagents`
model source only. It does not read Trellis routing policy.

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
