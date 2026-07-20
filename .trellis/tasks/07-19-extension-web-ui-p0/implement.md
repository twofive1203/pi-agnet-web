# Implement: Extension Web UI P0

## Checklist

1. **Hook state + handlers** in `hooks/useAgentSession.ts`
   - Track statuses, widgets, dialog, toasts
   - Replace alert/confirm/prompt handlers
   - Export state + dismiss/respond helpers to ChatWindow
   - Clear on session change

2. **UI components**
   - `ExtensionStatusBar.tsx`
   - `ExtensionWidgetStack.tsx`
   - `ExtensionTodoPanel.tsx` for Trellis-style `todo-list` floating task UI
   - `ExtensionDialogHost.tsx`
   - `ExtensionToastHost.tsx`

3. **Mount in `ChatWindow.tsx`**
   - above/below editor placements
   - portal hosts for dialog/toast

4. **Docs**
   - `docs/modules/frontend.md`
   - `docs/architecture/overview.md` (brief)

5. **Validate**
   - `npm run lint`
   - `node_modules/.bin/tsc --noEmit`

## File touch list

- `hooks/useAgentSession.ts`
- `components/ChatWindow.tsx`
- `components/ExtensionStatusBar.tsx` (new)
- `components/ExtensionWidgetStack.tsx` (new)
- `components/ExtensionTodoPanel.tsx` (new)
- `components/ExtensionDialogHost.tsx` (new)
- `components/ExtensionToastHost.tsx` (new)
- `docs/modules/frontend.md`
- `docs/architecture/overview.md`
- possibly `lib/types.ts` if small type helpers needed
