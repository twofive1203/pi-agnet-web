# UI Visual Validation Runbook

Use this runbook after changing themes, semantic Tokens, workbench layout, Composer/Inspector interactions, Settings primitives, dialogs, popovers, drawers, or other shared frontend chrome.

## Validation gates

1. Run the static contract:

   ```bash
   npm run test:ui-theme
   ```

   It checks theme registry synchronization, boot-time theme mapping, required semantic/layer Tokens, stable shared classes, responsive breakpoints, safe-area/coarse-pointer/reduced-motion contracts, Inspector and Composer keyboard contracts, and shared dialog focus contracts.

2. Run repository checks:

   ```bash
   npm run lint
   node_modules/.bin/tsc --noEmit
   ```

3. Complete the representative browser matrix below. The static smoke does not prove geometry, contrast, focus order, Portal placement, browser zoom, or real content behavior.

## Browser matrix

### Representative themes

Capture the full matrix for these themes:

| Preference | Resolved mode | Purpose |
| --- | --- | --- |
| Light | light | Default light palette |
| Dark | dark | Default dark palette |
| Paper | light | Warm low-contrast material |
| Twilight | dark | Curated translucent/material effects |
| Dracula | dark | Daisy-derived high-chroma palette |

For `System`, `Graphite`, `Ocean`, `Forest`, `Night`, and `Daisy Dark`, run `test:ui-theme` and spot-check the active conversation, Inspector, Settings, and one blocking dialog.

### Fixed viewports

| ID | Viewport | Expected shell state |
| --- | --- | --- |
| desktop | 1440×900 | Sidebar + Chat + inline resizable Inspector |
| compact-desktop | 1024×768 | Three cards remain usable; low-priority context stats may hide |
| portrait-tablet | 768×1024 | Sidebar remains docked; Inspector is an inset overlay drawer |
| mobile | 390×844 | Sidebar and Inspector are full-height overlay drawers |

Also test exact CSS/TypeScript boundaries at widths `960`, `959`, `641`, and `640` px. Keep viewport height at least `768` px for boundary checks, then repeat the mobile flow at `390×844`.

### Zoom and platform preferences

- Repeat the compact-desktop flow at browser zoom `125%` and `150%`.
- Repeat one light and one dark representative theme with `prefers-reduced-motion: reduce`.
- If the device/browser exposes safe-area insets, check portrait and landscape placement.
- Use both a fine pointer and touch/coarse-pointer emulation when available.

## Stable test data

Prepare these states before comparing screenshots:

- no workspace selected;
- workspace selected with no active session;
- active session with long Chinese and English text;
- user image/file attachment;
- streaming assistant response with Thinking, successful tool call, failed tool call, and retry/error notice;
- long file paths and at least one tracked Changes diff;
- Git clean and dirty states;
- empty and populated SnFlow/Agents panels;
- Settings with a dirty field, warning/error notice, disabled control, and nested resource view;
- application confirm/prompt, extension select/input dialog, Composer dropdown, toast, Todo panel, and Terminal dock.

Use synthetic/local data only. Do not place secrets, account identifiers, private paths, or message content in screenshots.

## Critical user flow

Run this flow for every representative theme and fixed viewport:

1. Select a workspace.
2. Create a new session.
3. Focus the Composer, enter text, and open Model, Thinking, and Tools dropdowns.
4. Start a response and inspect streaming/tool/error states.
5. Open Changes, then a Diff.
6. Switch Inspector tabs through Changes → Preview → Git → SnFlow → Agents.
7. Open Settings, edit a field, open a shared confirm/prompt dialog, then cancel and save as appropriate.
8. Switch themes and confirm the active UI updates without stale skin classes or unreadable surfaces.
9. Open/close Sidebar, Inspector, and Terminal in the combinations below.

A flow fails if a key action is obscured, a drawer/dialog cannot be closed, page-level horizontal scrolling appears, content cannot be reached by scrolling, focus enters hidden content, or state is communicated only by color/hover.

## Keyboard and focus pass

Without using a pointer:

- reach the top context controls, open Theme Picker, change themes with arrow keys/Home/End, and close with Escape;
- toggle Sidebar and reach workspace, new-session, search, session actions, and Explorer controls;
- reach the Composer and operate Model/Thinking/Tools listboxes with arrows/Home/End, Enter/Space, Tab, and Escape;
- switch Inspector tabs with arrows/Home/End and confirm only the selected tab is in the tab sequence;
- open Settings and traverse fields, switches, tabs, and actions in visual order;
- open application and extension dialogs, verify initial focus, trapped Tab/Shift+Tab, Escape behavior, and focus restoration;
- close drawers/popovers and confirm focus does not remain in hidden content.

Focus must be visibly distinguishable in Light, Dark, Paper, Twilight, and Dracula. Selected, dirty, running, warning, danger, disabled, and completed states must include text, icon/shape, border, or semantic markup in addition to color.

## Portal and stacking combinations

Check each combination at desktop, portrait-tablet, and mobile widths:

| Combination | Pass condition |
| --- | --- |
| Sidebar + Inspector + Terminal | Chat remains reachable; close controls stay above content |
| Composer listbox + shared dialog | Dialog wins stacking; closing restores a usable Composer focus target |
| Todo sheet + toast | Both remain readable above safe area and Composer |
| Theme/Usage popover + drawer | Popover stays viewport-bounded and does not become trapped behind drawer chrome |
| Usage Token structure chart modal | Full-width stacked chart readable at desktop / 641–959 / ≤640 and 200% zoom; absolute/share modes; keyboard Arrow/Home/End + Escape unpin; touch pin/clear; no page-level horizontal overflow; reduced-motion has no chart geometry animation |
| Changes/Git + Diff | Diff wins stacking and remains closable at minimum Inspector width |
| Settings + nested dialog/popover | One clear modal layer; no background focus or double page scrolling |

The canonical layer order is declared by `--z-*` Tokens in `app/globals.css`: workbench card, drawer backdrop, Sidebar/Inspector drawers, Automation drawer, top portals, terminal fullscreen, context menu, and dialogs.

## Standalone Git workbench matrix

Use a disposable fixture repository and open it from Inspector Git → **Open Git Workbench**. Never run destructive rows against a developer repository.

| View | Required checks |
| --- | --- |
| Desktop ≥960 | Three panes remain independently scrollable; Local/Remote/Tags start collapsed; All is selected; right-side changed-file tree and details keep their vertical split. |
| 641–959 | Branches button opens/closes the refs drawer; Log and commit inspector remain usable without page-level horizontal scroll. |
| ≤640 | Branches/Log/Changes/Details tabs expose every function without hover; dialogs fill the viewport and honor safe-area insets. |
| 200% zoom | Search/Branch/User filters wrap or remain reachable; long refs/paths truncate without hiding menu/Diff actions. |

For keyboard and Portal behavior, select a commit with Up/Down, open its menu by `Shift+F10`, traverse enabled actions, inspect visible disabled reasons, close with Escape, and verify trigger focus restoration. Repeat from a branch More button and through coarse-pointer emulation. Open a destructive Reset/Drop dialog from the context menu, then open a file Diff after canceling; context menu must use `--z-context-menu`, while operation and Diff dialogs win through `--z-dialog`.

Use Light, Dark, Paper, Twilight, and Dracula with clean, dirty, detached, published, unpublished-linear, merge, and empty-repository fixtures. Check non-color cues for current/tracking/remote/tag, capability-disabled rows, stale/busy/conflict-aborted/recovery-required notices, push rejection, and unknown push outcome. With reduced motion, the middle-width refs drawer must change state without animation while focus and content remain correct.

Record this matrix as executed or not executed in the delivery summary; `test:git-workbench` and `test:ui-theme` do not replace it.

## Contrast and motion review

- Inspect primary, secondary, and tertiary text on app/panel/raised/subtle surfaces.
- Inspect selected tabs/rows, notices, status badges, destructive buttons, and focus rings.
- Prefer semantic Token corrections over component- or skin-specific color patches.
- With reduced motion enabled, drawers, popovers, notices, progress, loading pulses, and theme switching must remain functional without decorative movement.
- Loading states must retain visible text/shape after animation is suppressed.

## Screenshot convention

Store local review artifacts outside tracked source unless a dedicated baseline change is approved. Use:

```text
YYYY-MM-DD_<theme>_<viewport-id>_<state>_<sequence>.png
```

Examples:

```text
2026-08-01_light_desktop_active-chat_01.png
2026-08-01_twilight_portrait-tablet_inspector-git_03.png
2026-08-01_dracula_mobile_settings-dialog_05.png
```

Keep theme IDs and viewport IDs lowercase. Use stable state names such as `empty-workspace`, `active-chat`, `streaming-tool`, `inspector-changes`, `settings-dirty`, `dialog-confirm`, and `mobile-drawers`.

## Result record

For each validation run, record:

- commit/branch and date;
- browser/OS and zoom;
- themes and viewports completed;
- static command results;
- blocking failures fixed in the current iteration;
- non-blocking follow-ups with an owner/plan link;
- screenshot directory, if captured.

Do not mark the visual iteration complete when the browser matrix is incomplete. Screenshot automation, full-repository inline-style cleanup, and preference-only visual tweaks remain separate follow-up work.
