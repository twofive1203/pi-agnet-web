# Auto-collapse chat input tabs on focus loss

## Goal

Improve the chat input auxiliary tab UX so `Branches`, `System`, `Subagent`, and `Git` panels do not remain open until the same tab is clicked again. Open panels should close naturally when the user shifts attention outside the input/tab/panel area.

## Requirements

- Preserve existing tab behavior for opening panels and switching between tabs.
- Preserve manual close by clicking the active tab again.
- Close the active auxiliary panel when focus/click moves outside the active tab/panel region, including when the chat input regains focus.
- Do not close when the user interacts inside the open panel or with its owning tab controls.
- Support keyboard escape as a close affordance if it fits existing component patterns.
- Avoid broad rewrites; keep the change localized to the chat input/UI state owner.

## Acceptance Criteria

- [x] Clicking `Branches`, `System`, `Subagent`, or `Git` opens the corresponding panel.
- [x] Clicking the same active tab closes its panel.
- [x] Clicking another tab switches panels without an intermediate close requirement.
- [x] Clicking outside the active tab/panel area closes the open panel.
- [x] Interacting within the open panel does not immediately close it.
- [x] Existing chat input submission and panel actions continue to work.
- [x] Lint and TypeScript checks pass or any skipped validation is documented.
