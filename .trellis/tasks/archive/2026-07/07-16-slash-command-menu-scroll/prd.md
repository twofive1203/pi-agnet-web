# Fix slash command menu scrolling

## Goal

Make the chat input slash-command autocomplete usable when many commands are available.

## Requirements

- Show all matching slash commands instead of truncating the result set.
- Keep the menu at a bounded height of roughly five visible command rows.
- Allow mouse/touch scrolling through the remaining commands.
- Keep the keyboard-selected command visible while using Arrow Up/Down.
- Preserve filtering, Enter/Tab selection, Escape dismissal, and the existing above-input placement.
- Keep the menu header visible while the command list scrolls.

## Acceptance Criteria

- [ ] Entering `/` does not make the menu grow with the total command count.
- [ ] Commands beyond the previous first eight results can be reached by scrolling.
- [ ] Arrow-key navigation scrolls the selected command into view.
- [ ] Clicking or pressing Enter/Tab inserts the selected command.
- [ ] Lint and TypeScript checks pass.
