# Design: Grok CLI subscription usage

## Summary

在 Models -> Grok CLI -> Subscription 中执行已安装扩展注册的 `/grok-cli-usage` 命令，并忠实展示命令通过 `ctx.ui.notify()` 返回的文本。蜗牛派只提供安全的执行与展示桥，不复制 `pi-grok-cli` 的 billing、OAuth 或 payload parser。

## Architecture

```text
ModelsConfig (current cwd)
  -> POST /api/auth/usage/grok-cli { cwd }
     -> validate allowed workspace + provider allowlist
     -> runExtensionCommand(cwd, "grok-cli-usage")
        -> createAgentSession(SessionManager.inMemory(cwd))
        -> bind Extensions in RPC mode with ExtensionWebUiBridge
        -> verify exact registered command exists
        -> command.handler("", extensionRunner.createCommandContext())
        -> collect ordered notify events and command errors
        -> finally session.dispose()
  <- { executed, notices, queriedAt } or browser-safe error
```

## Server Boundaries

### Extension command runner

Add a reusable server-only helper under `lib/` that:

- Creates a cwd-bound SDK session with the normal agent dir and resource loader behavior.
- Uses `SessionManager.inMemory(cwd)` so no JSONL file is created and the chat session registry is untouched.
- Binds extensions with `ExtensionWebUiBridge` in RPC mode and no-op/cancelled session replacement actions, matching the existing `/api/commands` and `/api/pi/resources` lifecycle.
- Checks `extensionRunner.getCommand(commandName)` before prompting. If duplicate registrations cause Pi to suffix command names, the unsuffixed command is treated as unavailable instead of invoking an ambiguous command.
- Resolves the exact registered command and invokes its public `ResolvedCommand.handler` with Pi's `extensionRunner.createCommandContext()`. This avoids running unrelated prompt/input handlers while still using the extension-owned command implementation and Pi command context.
- Gates capture to the exact command-running window, so lifecycle/bind notifications never enter success or failure responses. Command-owned `notify` events are retained in order as `{ level, message }` records. Other UI operations become browser-safe diagnostics or unsupported-command errors; no UI response loop is opened from the settings page.
- Races the handler against the HTTP request abort signal and a bounded server timeout. On completion, failure, disconnect or timeout it rejects pending bridge requests and disposes the temporary session in `finally`; the detached handler promise is rejection-safe if third-party network code ignores cancellation.

### Usage route

Add `POST /api/auth/usage/[provider]` with JSON `{ cwd: string }`.

The route keeps an explicit server-side allowlist:

```text
grok-cli -> grok-cli-usage
```

The browser cannot submit an arbitrary command name. The route validates that `cwd` is a current allowed workspace and directory before loading project packages. It returns no token, credential object, callback URL, command source path, or raw extension diagnostic payload.

Response contract:

```ts
interface ExtensionUsageNotice {
  level: "info" | "warning" | "error";
  message: string;
}

interface ExtensionUsageResponse {
  provider: string;
  command: string;
  executed: boolean;
  notices: ExtensionUsageNotice[];
  queriedAt: number;
  error?: string;
}
```

`executed: true` means the registered command completed. A warning notice from `pi-grok-cli` remains a warning and does not get rewritten as success. Command lookup/load/execution failures return `executed: false` with an actionable browser-safe error.

## UI Flow

- Pass the currently selected workspace cwd from `AppShell` into `ModelsConfig`, then into `OAuthDetail`.
- Enable the usage view only for `provider.id === "grok-cli"` and `provider.loggedIn`.
- Query once when the logged-in Grok detail becomes active, and expose a `Refresh usage` action for subsequent queries. This is view-scoped refresh, not a background scheduler.
- During refresh, retain the last successful text where practical and disable duplicate requests.
- Render notices in command order with preserved whitespace (`white-space: pre-wrap`) and monospace text. Use existing theme variables and warning/error colors; do not parse credit values or synthesize missing weekly usage.
- If no cwd is selected, show an actionable workspace-required state rather than falling back to an unrelated server cwd.
- Clear Grok usage state on provider change or disconnect.

## Error Matrix

| Condition | Behavior |
| --- | --- |
| Missing/invalid cwd | 400, usage view asks user to select a workspace. |
| Cwd outside allowed roots | 403, command is not loaded or executed. |
| Unsupported provider | 404/400 browser-safe unsupported usage message. |
| Package not installed or command missing | 404 with install/check-package guidance. |
| Extension load or command execution error | 502 with sanitized error; captured warning/error notices remain visible. |
| Client disconnects | Abort result path disposes the temporary session; no browser response is required. |
| Extension command exceeds the server timeout | 504 with retry guidance and temporary-session disposal. |
| Command emits warning but completes | 200, `executed: true`, warning rendered unchanged. |
| Command emits no notifications | Failed/empty-output state; do not invent usage. |
| Request in flight | Refresh disabled; loading state shown. |

## Security And Lifecycle

- Installed Pi packages already execute with local process permissions. This feature does not install packages or broaden the browser to arbitrary command execution.
- Credentials stay inside Pi's `AuthStorage`/`ModelRegistry` and the extension command. The response contains display notices only.
- Project package loading is restricted to an allowed cwd supplied by the active UI workspace.
- The temporary session never enters `globalThis.__piSessions`, uses no persistent `SessionManager`, and is disposed on every outcome.

## Compatibility

- Existing Grok OAuth, model registration, slash-command autocomplete, extension tools and normal chat sessions are unchanged.
- Existing OpenAI Codex structured quota and multi-account flows remain separate.
- Other OAuth providers keep the generic Subscription connection UI and do not call the new route.
- Usage text remains owned by `pi-grok-cli`; extension wording and optional weekly fields can evolve without a pi-web parser update.

## Documentation

Update:

- `docs/modules/api.md` with the usage route and lifecycle.
- `docs/modules/frontend.md` with the Grok Subscription usage behavior.
- `docs/integrations/README.md` with `pi-grok-cli` install/version requirements and the command-owned usage source.
