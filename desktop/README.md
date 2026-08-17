# Windows Desktop Pet (SnailPiPet)

Attach-only Electron companion for Snail Pi Web. Observes local tasks and can start one first-message session from the Activity tray; never starts/stops `spi`. Older servers without the `quick_session` capability keep observation working and hide the composer.

## Prerequisites

- Windows 10/11 (primary target)
- Repo `npm install` completed (devDependencies: `electron`, `esbuild`, `@electron-forge/*`)
- A running local Snail Pi service on `127.0.0.1` (default port `62666`)

## Dev commands (repo root)

| Command | Purpose |
| --- | --- |
| `npm run desktop:build` | Bundle `desktop/main/main.ts` → `main.js` and `preload/pet-preload.ts` → `pet-preload.js` |
| `npm run desktop:dev` | Build if stale, then launch Electron |
| `npm run desktop:preview` | Generate the static visual-state matrix under `desktop/.preview/` |
| `npm run desktop:dev:rebuild` | Force rebuild, then launch |
| `npm run test:desktop-observer` | Domain + API + quick-session + connection + UI contract + package smokes |
| `npm run test:desktop-quick-session` | Control token, path-free catalog, idempotent start, main client, composer reducer |
| `npm run test:desktop-package` | Pet-only packaging contract |

```bash
# terminal A
npm run dev                 # or: spi --no-open

# terminal B
npm run desktop:dev
```

Generated main/preload bundles (`main.js`, `pet-preload.js`, maps, `.build-stamp.json`) are gitignored. `desktop:build` also regenerates the checked-in browser runtime `renderer/pet-app.js` from `pet-app.tsx` and validates both built-in manifest v2 documents plus any declared spritesheet file; always build before packaging and commit that renderer output when its source changes.

## UI cheatsheet

| Action | Result |
| --- | --- |
| Drag pet body | Move frameless window (body uses click-vs-drag threshold) |
| Click pet body | Toggle Activity tray (pet icon stays put; tray grows down/right, or up/left near edges) |
| Activity tray → **快速会话** | Open the in-tray composer (connected + capable servers only). Choose a known project, type the first message, Ctrl/Cmd+Enter to start. Full replies stay in WebUI. |
| Activity tray → **⚙** | Manage the server access key, choose a built-in snail (星海/经典 CSS, 像素 spritesheet) or size, restore default position and medium size, and adjust always-on-top, click-through, login launch, notifications, and sound cues |
| Activity tray → **⌄** | Collapse only the Activity tray; the pet stays visible |
| Pet chrome → **×** | Hide to system tray (process keeps observing) |
| Tray → 显示桌宠 | Show window again |
| Tray → 勿扰模式 | Toggle manual DND (silences notifications, task bubbles and sounds; tray unread/observation continue) |
| Tray → 声音提示 | Toggle the sound master switch (checked state mirrors settings) |
| Tray → 退出桌宠 | Quit pet only; `spi` / tasks continue |
| Tray / UI → 复制启动命令 | Clipboard `spi --no-open` (never executed) |

Default first-run position: primary work-area bottom-right. Saved `(0,0)` is treated as unset. Display add/remove/metrics changes clamp the window back into the nearest work area. During drag, the pet is constrained by the full virtual desktop rather than one display so mixed-resolution / mixed-DPI screens remain traversable in both directions.

Running activity durations refresh locally once per second only while the Activity tray is visible; this does not poll the service or rebuild the activity snapshot.

## Custom pets (folder drop-in, U6 slice 1)

Users can add their own desktop pets without rebuilding. Only script-free **spritesheet** packs (PNG/WebP) are supported in this slice; CSS-mode custom manifests are rejected because they would render as the built-in snail anatomy.

### Layout

```text
~/.pi/agent/desktop-pets/
  <pet-id>/
    manifest.json   # v2 document, renderMode "spritesheet"
    <sheet>.png     # or .webp (name comes from manifest sheet.src)
```

- `<pet-id>` must match `manifest.json#id` exactly and the pattern `[a-z0-9][a-z0-9_-]{0,63}`; built-in ids (`snail-default` etc.) are rejected.
- The manifest follows the same v2 contract as `desktop/assets/pets/snail-sprite/manifest.json`: 8 required states, single-row contiguous frame runs, ≤16×16 cells, ≤2048×2048 sheet, ≤256 KB bitmap, ≤16 KB manifest. Invalid packs are skipped and reported; they never crash the pet.
- The root resolves as `SNAIL_PET_CUSTOM_PETS_DIR`, then `<PI_CODING_AGENT_DIR>/desktop-pets`, then `~/.pi/agent/desktop-pets`.
- Settings panel → 角色 shows discovered pets under the built-ins; **打开目录** opens the folder, **刷新列表** rescans. The rescan payload is re-validated in the renderer; any failure falls back to the CSS snail.

## Sound cues (U4a)

Short synthesized cues for `needs_input` (attention) and `ready` (completion) only; blocked/running/retrying and connection states never sound. Main owns the policy (baseline/dedupe/settings/DND/10s per-kind cooldown); the renderer plays fixed Web Audio tones — no files, no network, no queue, gain-capped, silent on failure. Master default is **off** (upgrades never beep); per-event switches default on and stay preserved while master is off. DND silences playback without touching sound preferences, and the settings panel shows “声音已被勿扰模式静音” while DND is on. Windows audio playback needs real-machine validation (`docs/operations/desktop-pet-validation.md`).

## Layout

```text
desktop/
  main/           # Electron main (connection, SSE, tray, window, notifications, custom pets scan)
  preload/        # Narrow contextBridge (window.snailPet)
  renderer/       # index.html + pet-app + CSS (no Node)
  assets/pets/    # Builtin pet manifests (v2: two CSS snails + one spritesheet pet)
  package.json    # private snail-pi-pet; main → main/main.js
```

User-provided custom pets live outside the package under `~/.pi/agent/desktop-pets/` (see the Custom pets section); they are scanned by `desktop/main/custom-pets.ts` at startup and on rescan, never bundled.

Wire constants shared with the server live in `lib/desktop-observer-constants.ts` so the pet bundle does not import Automation/rpc graphs.

## Packaging notes

- Root `forge.config.ts` is pet-only; npm `package.json#files` must not include `desktop/`.
- After `npm run desktop:make`, scan the real root-relative output with `DESKTOP_PACKAGE_OUT=desktop/out npm run test:desktop-package` (PowerShell: `$env:DESKTOP_PACKAGE_OUT = "desktop/out"; npm run test:desktop-package`).
- Full matrix: `docs/operations/desktop-pet-validation.md`.

## Security reminders

- Token stays in main memory only.
- Renderer: no Node, no absolute URL open; deep links re-validated before `shell.openExternal`.
- No `child_process` / service PID / signal APIs in `desktop/`.
