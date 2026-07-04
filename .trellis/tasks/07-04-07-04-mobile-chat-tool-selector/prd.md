# Fix mobile chat tool selector

## Goal

Analyze the chat tool configuration and make the chat-input bottom controls usable on mobile, especially the tool preset selector that currently shows `default` but does not reveal other choices when tapped.

## User Value

Mobile users can change tool presets and related chat input controls without switching to desktop.

## Confirmed Facts

- Tool presets are defined in `components/ToolPanel.tsx` as `none`, `default`, `full`, and `subagent`.
- The inline chat-input tool selector maps labels `off`, `default`, `full`, and `subagent` to those presets in `components/ChatInput.tsx`.
- The session hook initializes `toolPreset` to `default`, loads active tools through `get_tools`, and infers the preset via `getPresetFromTools()` in `hooks/useAgentSession.ts`.
- On mobile (`max-width: 640px`), `.chat-input-controls` uses horizontal scrolling (`overflow-x: auto`) in `app/globals.css`.
- The model dropdown already uses a fixed-position floating panel. Thinking and tool preset dropdowns are still absolutely positioned inside the horizontally scrolling controls row, which can clip the menu on mobile.

## Requirements

- Preserve the existing tool preset semantics:
  - `off` -> `none`: no tools.
  - `default`: `read`, `bash`, `edit`, `write`.
  - `full`: built-in full set (`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`).
  - `subagent`: full set plus `subagent` and `trellis_subagent`.
- Fix mobile visibility/interaction for the tool preset dropdown.
- Apply the same mobile-safe dropdown behavior to adjacent bottom controls with the same layout risk, especially thinking level.
- Keep desktop visual behavior equivalent unless needed for consistency.
- Do not change API contracts, tool preset names, or session lifecycle behavior.

## Acceptance Criteria

- [ ] On a narrow/mobile viewport, tapping the chat input tool preset button opens a visible menu with `off`, `default`, `full`, and `subagent`.
- [ ] Selecting a tool preset closes the menu and calls the existing preset change path.
- [ ] On a narrow/mobile viewport, tapping the thinking-level selector opens a visible menu that is not clipped by the controls row.
- [ ] Outside click/tap still closes model, thinking, and tool dropdowns.
- [ ] Desktop dropdown behavior remains usable.
- [ ] `npm run lint` and `node_modules/.bin/tsc --noEmit` pass, or any failures are documented if unrelated.

## Out of Scope

- Redesigning the chat input toolbar.
- Changing the underlying pi agent tool registry or backend tool activation behavior.
- Adding new tool presets.
