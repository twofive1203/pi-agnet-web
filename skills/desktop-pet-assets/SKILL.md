---
name: desktop-pet-assets
description: "Create or fix Snail Pi custom desktop pet packs (folder drop-in): generate the v2 manifest.json and PNG/WebP spritesheet for a new character (turtle, cat, robot…), assemble per-state frame strips into the grid sheet, and validate packs against the real runtime contract before the user drops them in. Use when the user asks to make/generate/design a custom desktop pet (桌宠/桌面宠物) or its assets."
---

# Custom desktop pet pack generator

Produce a **folder drop-in custom pet pack** for Snail Pi Web's desktop pet (Electron companion).
You only deliver resource files — never touch the pet runtime code.

## Final layout (deliver this)

```text
~/.pi/agent/desktop-pets/<pet-id>/
  manifest.json     # v2 contract, renderMode "spritesheet"
  <sheet>.png       # or .webp; filename must equal manifest sheet.src
```

Root overrides: `SNAIL_PET_CUSTOM_PETS_DIR`, or `PI_CODING_AGENT_DIR/desktop-pets`.
Default on Windows: `C:\Users\<user>\.pi\agent\desktop-pets\`.
After the files land, the user clicks 桌宠设置 → 角色 → 「刷新列表」to see the pet.

## Hard rules

- `<pet-id>` = folder name = `manifest.json#id`, pattern `[a-z0-9][a-z0-9_-]{0,63}`; must NOT be a builtin id (`snail-default`, `snail-classic`, `snail-sprite`).
- v2 manifest: only top-level keys `id/name/version/renderMode/states/sheet`; version must be `2`; `renderMode` must be `"spritesheet"` (CSS custom packs are rejected by design). No capability keys (`command/url/token/...`) anywhere.
- All 8 states are required: `idle, running, retrying, needs_input, ready, blocked, disconnected, service_not_running`.
- Each state needs: `frame`/`staticFrame` (CSS fallback keys; reuse `idle`, `running`, `running-static`, `retrying-static`, `needs-input`, `ready`, `blocked`, `disconnected`, `service-not-running`), `label` (≤16 chars, zh ok), `glyph` (≤4 chars), plus `firstFrame` (0-based cell), `frameCount` (1–16), `durationMs` (50–5000), `staticFrameIndex` (< frameCount).
- A state's frames must lie on ONE sheet row (no wrap). The proven layout: 4 cols × 8 rows of 108×92 cells, one state per row, first frame at column 0 — `idle` 0+3, `running` 4+3, `retrying` 8+2, `needs_input` 12+2, `ready` 16+2, `blocked` 20+2, `disconnected` 24+1, `service_not_running` 28+1.
- Sheet ≤ 2048×2048 px, ≤ 16×16 cells, ≤ 256 KB, transparent background, character faces right, no text/watermarks in the art (the app overlays its own glyph/label/badge).
- `name` ≤ 32 chars and must not contain `http://`/`https://` (packs with absolute URLs are rejected).

## Workflow

### 1. Agree parameters (ask only when ambiguous)

`<pet-id>`, display `name`, art style (flat cel-shaded / pixel art), and any per-state pose tweaks. Otherwise default to the template below.

### 2. Write manifest.json

Copy the template and fill in id/name:

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

### 3. Produce the spritesheet (two routes)

**Route A — one-shot grid image** (give this prompt to an image-capable AI):

```
Create a sprite sheet PNG for a cute <CHARACTER> desktop pet, <STYLE> style with
clean dark outlines. Technical requirements — every one is mandatory:
- Exactly 432x736 pixels: a strict grid of 4 columns x 8 rows, each cell exactly 108x92 px.
- No gaps, gutters, borders, or padding between cells; the 4th cell of each row stays fully transparent.
- Transparent background. The character occupies ~80% of each cell, centered, feet near the bottom.
- Size and position IDENTICAL across all frames (no jitter/rescaling). Always faces RIGHT.
- No text, letters, numbers, icons, or watermarks anywhere (the app overlays its own badges).
Rows, top to bottom (one state per row, frames left to right):
Row 1 idle (3 frames): calm standing, gentle breathing bob, one blink (eyes briefly closed on one frame), slow head nod.
Row 2 running (3 frames): alert and energetic, head up, quick small steps, tail wag.
Row 3 retrying (2 frames): worried but active, leaning back slightly, one foot tapping.
Row 4 needs_input (2 frames): head stretched up, big round eyes, waving one front leg (asking).
Row 5 ready (2 frames): celebrating, happy closed curved eyes, front legs raised in a small cheer.
Row 6 blocked (2 frames): head and limbs slightly tucked, sad drooping eyes, small wavy mouth.
Row 7 disconnected (1 frame): desaturated/grayish colors, dull eyes looking up, blank "..." expression.
Row 8 service_not_running (1 frame): fully tucked into the shell/sleeping pose, muted colors.
Output checklist: 432x736 px, 4x8 cells of 108x92, transparent background, no cell
borders, consistent size, no text, PNG smaller than 256 KB.
```

**Route B — per-state strips + stitch** (use when the AI cannot draw an exact grid;
strips are usually reliable because each is one small image):

Ask the AI for 8 PNG strips named after the states, each exactly
`frameCount × 108` px wide × 92 px high (left-to-right animation frames, same pose
direction as Route A). Include one blink frame (closed eyes) in `idle` — bitmap
pets have no separate eye layer, so the eyes only move if the frames differ. Then:

```bash
node scripts/desktop-custom-pet.mjs stitch "<pet-dir>" --frames "<strips-dir>" [--force]
```

The script decodes the strips, places them at the manifest's `firstFrame` cells,
fills unused cells transparent, writes `<pet-dir>/<sheet src>`, and re-checks the pack.

### 4. Validate (always, before handing over)

```bash
node scripts/desktop-custom-pet.mjs check "<pet-dir>"
```

`check` uses the exact runtime contract (bundles `desktop/main/custom-pets.ts`):
manifest fields, frame ranges/row-wrap, sheet existence/size, and PNG dimensions
(432×736 for the template layout) + alpha. Any rejection prints a precise reason.
Also useful: `node scripts/desktop-custom-pet.mjs list [root]` shows what is
currently installed, and `selftest` exercises the stitcher/checker.

In the project root only; run from `D:/workspace/aiwork/pi-agnet-web` (or wherever
the repo lives). If the command is missing, first `npm install` so `esbuild` exists.

### 5. Place and hand off

Write the two files into `~/.pi/agent/desktop-pets/<pet-id>/`, then tell the user:
打开桌宠 → 设置 → 角色 → 点「刷新列表」，选择新宠物即可。Invalid packs are
skipped silently — if the pet doesn't appear after refresh, run `check` again and
read the failure reason.

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `check` prints `*_frame_wraps_row` | a state's frames cross two sheet rows | move the state to a fresh row (column 0) |
| `contract rejects ... sheet_size` | bitmap > 256 KB | reduce colors / shrink, or re-encode PNG |
| `sheet dimensions ... != expected` | AI drew the wrong grid or gutters | use Route B (strips + stitch) |
| pet never appears after 刷新 | any validation error | run `check` on the pack folder |
| `builtin_id_collision` | id equals a builtin snail id | pick a different id |

## Boundaries

- Only deliver `manifest.json` + sheet file. Do not edit `desktop/**`, `lib/**`, or
  the desktop pet runtime/settings.
- Do not promise unsupported formats: CSS-mode custom packs, GIF/APNG/SVG, ZIP
  import, and AI on-device generation are NOT in the supported slice.
- Never include command/URL/token-like fields in the manifest even if an AI suggests them.
