# Desktop Pet Bubble Chrome

- **Status:** Accepted
- **Date:** 2026-08-18
- **Scope:** Renderer-only presentation of the floating pet caption, hover intent chips, Activity tray, and settings/quick-session chrome
- **Related:** `desktop-pet-task-observer.md`, `desktop-pet-quick-session.md`

## Decision

Desktop-pet chrome uses a Q-version comic-bubble language: paper fill, ink outline, chunky radii, and a short tail on the status caption. Six switchable palettes live in settings as `bubbleTheme`:

| Token | Label | Read |
| --- | --- | --- |
| `cream` | 奶油白 | Warm parchment (default; missing v1 files migrate here) |
| `peach` | 蜜桃粉 | Rose-ink Q-version sticker |
| `night` | 星夜 | Indigo night-sky card, cream ink outlines, starlight-blue accent |
| `ember` | 余烬 | Warm charcoal card, copper/amber accent |
| `plum` | 暮紫 | Deep purple card, lilac accent |
| `moss` | 墨青 | Deep teal card, jade accent |

The whole tray/settings chrome follows the same tokens so the balloon and panel stay one sticker set. This follows the Codex pet speech/notification card, not a dark glass admin overlay.

The pet sprite stays transparent. Status still comes from the existing 8-state presentation and bubble reducer. Collapsed window size, attach-only networking, and privacy payload rules do not change.

## Why

Codex pets speak with a short light speech bubble and a rounded notification card. Snail Pi already had the same information architecture (caption + Activity tray + settings), but the chrome read as a tiny HUD and a developer console: 9px dark chips, hairline borders, uppercase tracked headings, nested glass panels.

Desktop pets are chibi companions. The chrome should look like stickers the snail is holding, not a second IDE.

## What changed

| Surface | Before | After |
| --- | --- | --- |
| Status caption | Dark 9px HUD in the top-left of the 112px stage | Cream comic balloon with ink outline, bold task title, muted action line, and tail |
| Hover intent | Dark rectangular menu | Separate paper pill chips |
| Activity tray / settings | Dark glass stack | Warm paper card, pill header, grouped `settings-card` stickers |
| Activity rows | Flat dark rows + glow glyphs | Outlined mini-bubbles with state-tinted sticker glyphs |

Native form controls follow `color-scheme: light` so checkboxes and selects match the paper card.

## Constraints that stay

- IDs, preload bridge, observer snapshot, DND/bubble reducer, and window metrics stay as they are.
- Caption remains inside `#pet-button` (no nested button). It is still `pointer-events: none`.
- Unscaled collapsed size is 148×196 (current small): a 24px left shift plus the 112px sprite, and a 40px band above the sprite so the balloon sits over the head instead of on the face. Medium/large multiply that layout (1.2 / 1.5).
- Hover chips sit in that top-left pocket (`top: 0` + `--pet-intent-gutter`) and may overlap the empty left of the stage, not a separate distant column.
- No new fonts (CSP `font-src 'self' data:`).
- Reduced-motion still collapses the pop animation through the existing global gate.
- Hover/focus on `.pet-stack` hides the caption and foot label so the intent chips are the only chrome.
- Running/Retrying keep the task caption visible in a Codex-style two-line card: explicit task/session title first, then a safe action/tool summary. While that card is visible, the compact top-right state label is hidden to avoid duplicate status; the label remains a fallback when the card is absent or suppressed by DND. Hover/focus still hides both so the intent chips remain unobstructed.
- The pet body does not use a native `title` tooltip. Transparent frameless windows clip it over the sprite. Shortcuts live in the settings 操作 hint and the button `aria-label`.

## Non-goals

- Do not copy Codex assets, copy, or conversational “personality” lines. Bubbles still show real presentation labels and safe titles only.
- Do not move settings into a second window or the main WebUI.
- Do not grow the overlay to host a full chat transcript.
