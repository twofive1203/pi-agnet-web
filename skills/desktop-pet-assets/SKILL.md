---
name: desktop-pet-assets
description: "Create or fix Snail Pi custom desktop pet packs (folder drop-in): lock a character card, generate a hero key plus per-state PNG strips, stitch the v2 spritesheet, and pass both the runtime contract and a visual review before the user drops the pack in. Use when the user asks to make/generate/design a custom desktop pet (桌宠/桌面宠物) or its assets."
---

# Custom desktop pet pack generator

Produce a **folder drop-in custom pet pack** for Snail Pi Web's desktop pet.
You only deliver resource files — never touch the pet runtime code.

This skill has two success bars. A pack that only passes `check` is unfinished.

1. **Contract** — the app can load it.
2. **Look** — a stranger can name the species and tell the 8 states apart at 108×92.

Do **not** start by asking an image model for a 4×8 grid. That path is why previous packs looked like the same thick-outline sticker with swapped colors.

Read `references/art-direction.md` before the first image prompt.

## Final layout (deliver this)

```text
~/.pi/agent/desktop-pets/<pet-id>/
  manifest.json     # v2 contract, renderMode "spritesheet"
  <sheet>.png       # filename must equal manifest sheet.src
```

Keep working files **outside** the drop-in folder (they are not loaded, but they clutter the scan):

```text
<work-dir>/<pet-id>-src/
  character-card.md
  hero.png
  idle.png
  running.png
  retrying.png
  needs_input.png
  ready.png
  blocked.png
  disconnected.png
  service_not_running.png
```

Root overrides: `SNAIL_PET_CUSTOM_PETS_DIR`, or `PI_CODING_AGENT_DIR/desktop-pets`.
Default on Windows: `C:\Users\<user>\.pi\agent\desktop-pets\`.
After the files land, the user clicks 桌宠设置 → 角色 → 「刷新列表」.

## Hard rules (contract)

- `<pet-id>` = folder name = `manifest.json#id`, pattern `[a-z0-9][a-z0-9_-]{0,63}`; must NOT be a builtin id (`snail-default`, `snail-classic`, `snail-sprite`).
- v2 manifest: only top-level keys `id/name/version/renderMode/states/sheet`; version must be `2`; `renderMode` must be `"spritesheet"`. No capability keys (`command/url/token/...`) anywhere.
- All 8 states are required: `idle, running, retrying, needs_input, ready, blocked, disconnected, service_not_running`.
- Each state needs: `frame`/`staticFrame` (CSS fallback keys; reuse `idle`, `running`, `running-static`, `retrying-static`, `needs-input`, `ready`, `blocked`, `disconnected`, `service-not-running`), `label` (≤16 chars, zh ok), `glyph` (≤4 chars), plus `firstFrame` (0-based cell), `frameCount` (1–16), `durationMs` (50–5000), `staticFrameIndex` (< frameCount).
- A state's frames must lie on ONE sheet row (no wrap). Proven layout: 4 cols × 8 rows of 108×92 cells, one state per row, first frame at column 0 — `idle` 0+3, `running` 4+3, `retrying` 8+2, `needs_input` 12+2, `ready` 16+2, `blocked` 20+2, `disconnected` 24+1, `service_not_running` 28+1.
- Sheet ≤ 2048×2048 px, ≤ 16×16 cells, ≤ 256 KB, transparent background, character faces right, no text/watermarks in the art (the app overlays glyph/label/badge).
- `name` ≤ 32 chars and must not contain `http://`/`https://`.

## Quality rules (blocking)

A pack is rejected — even if `check` prints PASS — when any of these fail:

- The hero is a generic blob / same “big head + thick outline + dot eyes” used for the last pet.
- Two standing states share the same silhouette. `idle` / `running` / `ready` / `blocked` must be readable as four different poses **without** the overlay glyph.
- Multi-frame states are copies of one drawing. Idle needs a real blink (eyes shut on one frame). Running needs a limb that leaves the ground.
- Size or feet jump between frames of the same state (jitter).
- Copyrighted mascots drawn as unofficial clones (Pikachu, 小火龙, …). Propose an **original** analog with a different silhouette, or a clearly distinct homage. Mushy unofficial Pokémon is the common failure mode.

`node scripts/desktop-custom-pet.mjs review <petDir>` is the mechanical half of this bar. It cannot judge “is this a turtle”, so you still **open the sheet and look**.

## Workflow

### 1. Lock a character card

Ask only when the species, style, or homage-vs-original choice is missing. Otherwise fill the card yourself and show it in one short paragraph before drawing.

```md
id: <pet-id>
name: <Display Name>
style: chibi-cel | pixel-16 | soft-clay
species: <specific body plan, not "cute animal">
silhouette: <3 nouns, e.g. "low dome shell + beak + leaf sprout">
palette: outline #______ / fill #______ #______ / accent #______
accessory: <one signature item visible at 108px>
face: <eye shape + default mouth>
frozen: body mass, outline weight, eye placement, accessory — never change these
avoid: thick-sticker twins, extra text, sparkles, extra limbs
```

Default style is `chibi-cel`. Copy the matching recipe from `references/art-direction.md`.

### 2. Write manifest.json

Copy the template and fill in id/name. Do this before generating pixels so stitch/review have a contract.

```json
{
  "id": "<pet-id>",
  "name": "<Display Name>",
  "version": 2,
  "renderMode": "spritesheet",
  "states": {
    "idle": {
      "frame": "idle", "staticFrame": "idle", "label": "空闲", "glyph": "·",
      "firstFrame": 0, "frameCount": 3, "durationMs": 360, "staticFrameIndex": 1
    },
    "running": {
      "frame": "running", "staticFrame": "running-static", "label": "运行中", "glyph": "›",
      "firstFrame": 4, "frameCount": 3, "durationMs": 320, "staticFrameIndex": 0
    },
    "retrying": {
      "frame": "retrying", "staticFrame": "retrying-static", "label": "重试中", "glyph": "↻",
      "firstFrame": 8, "frameCount": 2, "durationMs": 220, "staticFrameIndex": 0
    },
    "needs_input": {
      "frame": "needs-input", "staticFrame": "needs-input", "label": "待输入", "glyph": "?",
      "firstFrame": 12, "frameCount": 2, "durationMs": 280, "staticFrameIndex": 0
    },
    "ready": {
      "frame": "ready", "staticFrame": "ready", "label": "已完成", "glyph": "✓",
      "firstFrame": 16, "frameCount": 2, "durationMs": 300, "staticFrameIndex": 0
    },
    "blocked": {
      "frame": "blocked", "staticFrame": "blocked", "label": "受阻", "glyph": "!",
      "firstFrame": 20, "frameCount": 2, "durationMs": 320, "staticFrameIndex": 0
    },
    "disconnected": {
      "frame": "disconnected", "staticFrame": "disconnected", "label": "未连接", "glyph": "⚠",
      "firstFrame": 24, "frameCount": 1, "durationMs": 1000, "staticFrameIndex": 0
    },
    "service_not_running": {
      "frame": "service-not-running", "staticFrame": "service-not-running", "label": "未启动", "glyph": "⏻",
      "firstFrame": 28, "frameCount": 1, "durationMs": 1000, "staticFrameIndex": 0
    }
  },
  "sheet": { "src": "<pet-id>.png", "frameWidth": 108, "frameHeight": 92, "columns": 4, "rows": 8 }
}
```

Write the manifest into the destination folder now. Leave the sheet for stitch.

### 3. Draw a hero key (mandatory)

Give an image-capable model the **hero prompt** in `references/art-direction.md` plus the locked card. Ask for **one** character, not a sheet.

Save as `hero.png`. Then **read the image** and reject it when:

- species / accessory / silhouette nouns are not obvious
- it faces left, or the camera is a close-up face
- outline weight or palette drifted from the card
- it looks like a recycled sticker from another pet

Redraw the hero up to 2 times. Do not continue on a weak hero — every later frame will copy it.

### 4. Draw 8 state strips from the hero

Default path is **Route B** (strips + stitch). Attach `hero.png` as a reference on every call.

Each strip is exactly `frameCount × 108` wide × 92 high:

| file | size | must read as |
| --- | --- | --- |
| `idle.png` | 324×92 | standing rest; frame 2 = eyes fully closed |
| `running.png` | 324×92 | lean forward; at least one limb off the ground |
| `retrying.png` | 216×92 | 15–20° tilt + one tapping / recoiling limb |
| `needs_input.png` | 216×92 | head up, one limb waving above the head |
| `ready.png` | 216×92 | jump or both limbs in a V; happy closed eyes |
| `blocked.png` | 216×92 | hunched, smaller silhouette, frown |
| `disconnected.png` | 108×92 | same pose family, gray/vacant — do not redraw anatomy |
| `service_not_running.png` | 108×92 | unique sleep / tucked pose |

Use the strip prompts in `references/art-direction.md`. Generate **at most two states per image call**. After each strip, read it and redraw that strip when identity drifted or the pose is a still copy of idle.

**Route A** (one 432×736 grid) is last resort, only if the user forbids strips or the stitcher is unavailable. It still must pass `review` and the visual checklist. Do not use the old “cute … clean dark outlines … gentle breathing bob” prompt.

### 5. Stitch

From the project root:

```bash
node scripts/desktop-custom-pet.mjs stitch "<pet-dir>" --frames "<strips-dir>" [--force]
```

The script places each strip at the manifest `firstFrame` cells, leaves unused cells transparent, writes `<pet-dir>/<sheet src>`, and runs `check`.

### 6. Validate (both commands)

```bash
node scripts/desktop-custom-pet.mjs check "<pet-dir>"
node scripts/desktop-custom-pet.mjs review "<pet-dir>"
```

- `check` is the runtime contract (same code the app uses).
- `review` is a quality gate: empty/full cells, reserved-cell leaks, same-state jitter, frozen multi-frame states, and standing-state poses that barely differ.

If `review` FAILs, redraw only the named states and stitch again. Do not hand over a FAIL.

Then open the stitched sheet yourself and walk the checklist in `references/art-direction.md`. Mechanical PASS + “still looks like a sticker twin” = redraw the hero.

Also useful: `node scripts/desktop-custom-pet.mjs list [root]` and `selftest`.

Run these from `D:/workspace/aiwork/pi-agnet-web` (or the repo root). If the command is missing, `npm install` so `esbuild` exists.

### 7. Place and hand off

Only `manifest.json` + the sheet belong in `~/.pi/agent/desktop-pets/<pet-id>/`.
Tell the user: 打开桌宠 → 设置 → 角色 → 点「刷新列表」，选择新宠物即可。
Invalid packs are skipped silently — if it does not appear, run `check` and read the reason.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `check` prints `*_frame_wraps_row` | a state's frames cross two sheet rows | move the state to a fresh row (column 0) |
| `contract rejects ... sheet_size` | bitmap > 256 KB | flatten the palette / re-encode PNG |
| `sheet dimensions ... != expected` | AI drew gutters or the wrong grid | stay on Route B |
| `review` prints `frozen_frames` | strip is one drawing copied N times | redraw that state with a big limb / blink change |
| `review` prints `pose_too_similar` | running/ready/blocked are idle with new eyebrows | change the silhouette, not just the face |
| `review` prints `jitter` | character hops between frames | lock feet and body mass to the hero |
| pet never appears after 刷新 | any contract error | run `check` |
| `builtin_id_collision` | id equals a builtin snail id | pick a different id |
| every new pet looks the same | skipped the hero / used Route A first | restart from a new character card |

## Boundaries

- Only deliver `manifest.json` + sheet file. Do not edit `desktop/**`, `lib/**`, or the desktop pet runtime/settings.
- Do not promise unsupported formats: CSS-mode custom packs, GIF/APNG/SVG, ZIP import, and on-device generation are NOT in the supported slice.
- Never include command/URL/token-like fields in the manifest even if an AI suggests them.
- Do not ship unofficial clones of trademarked characters as if they were official art.
