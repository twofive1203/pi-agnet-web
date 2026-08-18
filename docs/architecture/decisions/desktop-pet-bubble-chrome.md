# Desktop Pet Bubble Chrome

- **Status:** Accepted
- **Date:** 2026-08-18
- **Scope:** Renderer-only presentation of the floating pet caption, hover intent chips, Activity tray, and settings/quick-session chrome
- **Related:** `desktop-pet-task-observer.md`, `desktop-pet-quick-session.md`

## Decision

Desktop-pet chrome uses a Q-version comic-bubble language: cream paper fill, dark ink outline, chunky radii, and a short tail on the status caption. This follows the Codex pet speech/notification card, not a dark glass admin overlay.

The pet sprite stays transparent. Status still comes from the existing 8-state presentation and bubble reducer. Collapsed window size, attach-only networking, and privacy payload rules do not change.

## Why

Codex pets speak with a short light speech bubble and a rounded notification card. Snail Pi already had the same information architecture (caption + Activity tray + settings), but the chrome read as a tiny HUD and a developer console: 9px dark chips, hairline borders, uppercase tracked headings, nested glass panels.

Desktop pets are chibi companions. The chrome should look like stickers the snail is holding, not a second IDE.

## What changed

| Surface | Before | After |
| --- | --- | --- |
| Status caption | Dark 9px HUD in the top-left of the 112px stage | Cream comic balloon with ink outline, state pill, and tail |
| Hover intent | Dark rectangular menu | Separate paper pill chips |
| Activity tray / settings | Dark glass stack | Warm paper card, pill header, grouped `settings-card` stickers |
| Activity rows | Flat dark rows + glow glyphs | Outlined mini-bubbles with state-tinted sticker glyphs |

Native form controls follow `color-scheme: light` so checkboxes and selects match the paper card.

## Constraints that stay

- IDs, preload bridge, observer snapshot, DND/bubble reducer, and window metrics stay as they are.
- Caption remains inside `#pet-button` (no nested button). It is still `pointer-events: none`.
- Collapsed bounds stay 140×160 at medium; the balloon must clamp inside the existing stage.
- No new fonts (CSP `font-src 'self' data:`).
- Reduced-motion still collapses the pop animation through the existing global gate.

## Non-goals

- Do not copy Codex assets, copy, or conversational “personality” lines. Bubbles still show real presentation labels and safe titles only.
- Do not move settings into a second window or the main WebUI.
- Do not grow the overlay to host a full chat transcript.
