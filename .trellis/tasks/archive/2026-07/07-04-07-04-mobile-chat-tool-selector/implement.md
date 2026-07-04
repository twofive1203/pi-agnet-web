# Implementation Plan

## Checklist

1. Read frontend/Trellis specs and relevant module docs.
2. Update `components/ChatInput.tsx`:
   - Add rect state and panel refs for thinking/tool dropdowns.
   - Capture button rects on click.
   - Render thinking/tool panels as fixed-position `.chat-input-dropdown-panel` menus with bounded height.
   - Update outside-click handling to include fixed panels.
3. Run validation:
   - `npm run lint`
   - `node_modules/.bin/tsc --noEmit`
4. Manually review the diff for unchanged tool preset semantics.
5. Summarize tool configuration and the mobile fix.

## Review Gates

- Before implementation: confirm this plan is acceptable.
- Before completion: verify lint/type-check results or document unrelated failures.

## Files Expected to Change

- `components/ChatInput.tsx`
- Trellis task artifacts under `.trellis/tasks/07-04-07-04-mobile-chat-tool-selector/`

## Rollback Point

Revert `components/ChatInput.tsx` changes to restore previous behavior.

## Validation Results

- `npm run lint` — passed after the model-dropdown portal follow-up.
- `node_modules/.bin/tsc --noEmit` — passed after the model-dropdown portal follow-up.
- `git diff --check -- components/ChatInput.tsx` — passed.
