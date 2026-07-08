# Implementation Plan: Local Pi extensions in WebUI

## Phase 1: Verify and expose current discovery

- Add or update diagnostics endpoint/response to show loaded extensions, extension errors, package sources, and registered tools.
- Confirm `PI_CODING_AGENT_DIR` override works in server process and document it if needed.
- Validation: run SDK probe or integration-style script with local packages installed.

## Phase 2: Extension commands

- Update command discovery to include `source: "extension"` commands registered by loaded extensions.
- Preserve existing skill and prompt command behavior.
- Update frontend command autocomplete types/rendering if it assumes only `skill | prompt`.
- Validation: installed package command appears in autocomplete and can be sent through `session.prompt()`.

## Phase 3: Web extension UI binding

- Add a small `lib/extension-web-ui.ts` or similar adapter for Pi extension UI methods.
- Bind it from `startRpcSession()` using `inner.bindExtensions(...)`.
- Forward `notify`, `setStatus`, and diagnostics through the existing SSE stream.
- Decide and implement dialog request/response protocol for `select`, `confirm`, `input`, and `editor` if MVP includes interactive UI.
- Degrade `custom()` and TUI component APIs explicitly.

## Phase 4: Lifecycle and reload

- Wire `ctx.reload()` or a WebUI command/button to `inner.reload()` and refresh resource-dependent UI state.
- Decide whether `newSession`, `fork`, and `switchSession` extension command actions should be supported in MVP or cancelled with diagnostics.

## Validation Commands

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

## Risk Points

- Extension APIs are powerful and run arbitrary code; avoid broadening trust beyond Pi's own resource loader behavior.
- Browser dialog handling must not deadlock an agent turn if the tab disconnects.
- Avoid multiple SDK sessions solely for autocomplete if that would run extension factories too often or start resources unexpectedly.
- Existing sessions and SSE event consumers may need type updates for new extension UI/diagnostic events.
