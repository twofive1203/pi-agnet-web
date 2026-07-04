# Design: Mobile chat tool selector fix

## Root Cause

Mobile CSS makes `.chat-input-controls` horizontally scrollable so the dense bottom toolbar can fit small screens. Absolute-positioned dropdowns rendered inside that row are clipped by the scroll container. The model selector already avoids this by capturing the button rectangle and rendering its panel as `position: fixed`; the thinking-level and tool-preset selectors need the same pattern.

## Boundaries

- UI-only change in `components/ChatInput.tsx`, with possible CSS cleanup only if needed.
- Reuse existing preset constants and callbacks.
- No backend/API changes.

## Proposed Approach

1. Add floating-panel positioning state for thinking and tool dropdowns, matching the model dropdown's `{ top, left, width }` shape.
2. On selector button click, capture `getBoundingClientRect()` and toggle open state.
3. Render thinking/tool menus as fixed-position panels above the button, using viewport height (`visualViewport?.height ?? innerHeight`) to calculate `bottom` and `maxHeight`.
4. Assign `chat-input-dropdown-panel` class to these panels so existing mobile CSS constrains them to the viewport.
5. Extend outside-click detection to treat these fixed panels as part of the dropdown, so tapping inside does not immediately close before selection.

## Compatibility

- Desktop keeps the same anchored-above-button behavior, now using viewport coordinates instead of ancestor-relative coordinates.
- Mobile avoids clipping from the horizontal toolbar scroll container.
- The displayed labels and preset callbacks are unchanged.

## Risks

- Fixed panels can become stale if viewport changes while open. This is acceptable for a short-lived dropdown; outside tap/selection closes it. If necessary, a future enhancement can close on resize/scroll.
- Existing mobile CSS for `.chat-input-dropdown-panel` forces left/right in small screens, which is compatible with full-width mobile dropdowns.

## Rollback

Revert the `ChatInput.tsx` dropdown positioning changes; no data migration or persisted setting changes are involved.
