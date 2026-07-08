# Design: Local Pi extensions in WebUI

## Diagnosis

The WebUI already uses the Pi SDK's `DefaultResourceLoader` with `getAgentDir()`, so global packages installed by `pi install` in the same agent dir are discoverable without calling the CLI. A local SDK probe confirmed that package extensions/tools/skills/prompts from `C:\Users\lichong\.pi\agent\settings.json` load in this repository.

The remaining incompatibility is the host layer around the SDK:

1. `createAgentSession()` is used directly, not `runRpcMode()` or `InteractiveMode()`.
2. Direct SDK sessions default extension mode to `print` with no-op UI until the host calls `session.bindExtensions(...)`.
3. WebUI currently does not bind a browser/RPC-style extension UI context.
4. WebUI slash-command discovery lists skills and prompts, but not `pi.registerCommand()` extension commands.
5. Extension load diagnostics are not surfaced prominently to the browser.

## Recommended Architecture

Keep the in-process SDK architecture and add a Web extension-host compatibility layer.

### Layer 1: Discovery and Version Diagnostics

- Continue using `getAgentDir()` / `PI_CODING_AGENT_DIR` as the single source of truth.
- Expose diagnostics from `DefaultResourceLoader.getExtensions()`, `getSkills()`, and `getPrompts()` through relevant API responses.
- Optionally add a dedicated `/api/pi/resources` or `/api/extensions` endpoint showing:
  - loaded extensions
  - package sourceInfo
  - registered tools
  - registered extension commands
  - load errors
  - WebUI SDK version vs local package expectations when detectable

### Layer 2: Extension Commands in WebUI

- For live sessions, use `session.inner.getCommands()` if available instead of only reading skills/prompts from `DefaultResourceLoader`.
- For pre-session command autocomplete, either:
  - create a lightweight SDK session/loader to collect extension commands, or
  - extend `app/api/commands/route.ts` to load extension factories and read registered commands similarly to `AgentSession`.
- Return `source: "extension" | "prompt" | "skill"` and `sourceInfo` so the UI can show provenance.

### Layer 3: Bind Extensions for Web Mode

In `startRpcSession()` after `createAgentSession(...)`, call `inner.bindExtensions(...)` with a Web-compatible context:

- `mode: "rpc"` or a Web-specific equivalent if SDK allows only known modes.
- `uiContext` mapping extension UI calls to browser-visible events:
  - `notify` -> SSE event / toast
  - `select`, `confirm`, `input`, `editor` -> request/response dialog protocol
  - `setStatus`, `setWidget`, `setTitle` -> optional SSE state events
  - unsupported TUI-only `custom()` -> return `undefined` or emit unsupported diagnostic
- `commandContextActions` for safe operations:
  - `waitForIdle` -> `inner.agent.waitForIdle()`
  - `navigateTree` -> existing WebUI navigation path where feasible
  - `reload` -> `inner.reload()` plus WebUI state refresh
  - `newSession`, `fork`, `switchSession` -> either wire through existing session replacement logic or initially return `{ cancelled: true }` with a clear unsupported diagnostic
- `onError` -> forward extension errors to WebUI logs/SSE diagnostics.

This is the closest equivalent to what `runRpcMode()` does, without moving the WebUI to a subprocess model.

### Layer 4: Fallback Process-Isolation Mode

Keep `pi --mode rpc` as a fallback for hard incompatibilities:

- Pros: maximum CLI parity; Pi owns extension UI protocol and lifecycle.
- Cons: higher complexity for session registry, SSE bridging, auth/config reload, process cleanup, Windows spawning, and existing WebUI state assumptions.

Use only if SDK binding proves insufficient for specific extensions.

## Trade-offs

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Keep current state | Already loads tools/skills/prompts in many cases | Commands/UI/lifecycle gaps remain invisible | Not enough |
| Add Web extension-host layer | Preserves SDK architecture, minimal disruption, good parity | Need dialog protocol and partial TUI degradation | Preferred |
| Shell out to `pi --mode rpc` | Highest CLI parity/process isolation | Large rewrite, harder session lifecycle and Windows handling | Fallback only |
| Duplicate CLI package scanning manually | Could avoid SDK internals | Easy to drift from Pi semantics/security | Avoid |

## MVP Recommendation

1. Surface diagnostics and extension commands.
2. Bind extensions in Web/RPC mode with notifications and simple dialogs.
3. Explicitly mark TUI-only APIs unsupported in WebUI.
4. Add reload support so installed/updated packages can be picked up without restarting the WebUI server.
