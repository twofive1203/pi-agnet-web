# Design: Extension Web UI P0

## Summary

Keep the server bridge (`lib/extension-web-ui.ts`) as the SSE/RPC boundary. Replace browser-side handlers in `useAgentSession` with React state + dedicated UI components mounted from `ChatWindow` near the composer.

## Data flow

```text
Extension (pi SDK)
  -> ExtensionWebUiBridge.createContext()
     -> SSE extension_ui_request
        -> useAgentSession.handleAgentEvent
           -> status/widget state  -> ExtensionChrome (chips + widgets)
           -> dialog state         -> ExtensionDialogHost (modal)
           -> toast state          -> ExtensionToastHost
           -> user action
              -> POST extension_ui_response
                 -> bridge.respond() resolves pending promise
```

## Client state

Owned by `useAgentSession` (session-scoped):

```ts
extensionStatuses: ExtensionStatusItem[]   // derived from Map key->text
extensionWidgets: ExtensionWidgetItem[]   // derived from Map key->item
extensionDialog: Extract<ExtensionUiRequest, interactive> | null
extensionToasts: { id, message, notifyType, createdAt }[]
```

Clear maps on session id change / new-session start.

## Components

| Component | Role |
| --- | --- |
| `components/ExtensionStatusBar.tsx` | Renders status chips row |
| `components/ExtensionWidgetStack.tsx` | Renders widgets for one placement |
| `components/ExtensionDialogHost.tsx` | Modal for confirm/select/input/editor |
| `components/ExtensionToastHost.tsx` | Fixed toast stack for notify |

Styling: CSS variables + inline styles (project convention). Portal modals/toasts to `document.body` so overflow parents cannot clip them.

### Dialog UX

- Overlay + centered panel, Escape cancels (confirm → false via cancelled or confirmed:false — match current bridge: confirm uses `confirmed`, others `cancelled`)
- Current bridge parse:
  - confirm: `confirmed ?? false` (cancelled → fallback false)
  - select/input/editor: cancelled → undefined
- Select: vertical list of buttons; highlight on keyboard ↑↓ + Enter
- Editor: textarea min-height ~160px, monospace optional
- Primary/secondary buttons consistent with Settings/Usage modals

### Widget UX

- Card with subtle border; key as small label; lines as pre-wrap text
- placement `aboveEditor` sits between message list and ChatInput
- placement `belowEditor` sits under ChatInput
- Status chips sit above the aboveEditor stack (single chrome strip)

## API / types

Reuse existing `ExtensionUiRequest` / `ExtensionUiResponse` / status/widget item types in `lib/types.ts`. No route changes required.

Optional: export a narrowed interactive dialog type for the host component.

## Docs

- `docs/modules/frontend.md` — new components + useAgentSession extension UI behavior
- `docs/architecture/overview.md` — one line: Web UI renders status/widget and modal dialogs for extension UI requests (no longer console/alert only)

## Risks

- High-frequency `setWidget` updates (todo list): React state per event is fine for MVP; batching not required.
- ask-user package uses `custom()` in TUI; Web still falls back if it does not use select/confirm — out of scope unless it already hits bridge dialogs.
