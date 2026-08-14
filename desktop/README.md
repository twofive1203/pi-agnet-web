# Windows Desktop Pet (SnailPiPet)

Attach-only Electron companion for Snail Pi Web. Observes local tasks; never starts/stops `spi`.

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
| `npm run test:desktop-observer` | Domain + API + connection + UI contract + package smokes |
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
| Activity tray → **⚙** | Manage the server access key, choose the built-in snail or size, restore default position and medium size, and adjust always-on-top, click-through, login launch, and notifications |
| Activity tray → **⌄** | Collapse only the Activity tray; the pet stays visible |
| Pet chrome → **×** | Hide to system tray (process keeps observing) |
| Tray → 显示桌宠 | Show window again |
| Tray → 退出桌宠 | Quit pet only; `spi` / tasks continue |
| Tray / UI → 复制启动命令 | Clipboard `spi --no-open` (never executed) |

Default first-run position: primary work-area bottom-right. Saved `(0,0)` is treated as unset. Display add/remove/metrics changes clamp the window back into the nearest work area. During drag, the pet is constrained by the full virtual desktop rather than one display so mixed-resolution / mixed-DPI screens remain traversable in both directions.

Running activity durations refresh locally once per second only while the Activity tray is visible; this does not poll the service or rebuild the activity snapshot.

## Layout

```text
desktop/
  main/           # Electron main (connection, SSE, tray, window, notifications)
  preload/        # Narrow contextBridge (window.snailPet)
  renderer/       # index.html + pet-app + CSS (no Node)
  assets/pets/    # Builtin pet manifests (v2 CSS contract; spritesheet optional later)
  package.json    # private snail-pi-pet; main → main/main.js
```

Wire constants shared with the server live in `lib/desktop-observer-constants.ts` so the pet bundle does not import Automation/rpc graphs.

## Packaging notes

- Root `forge.config.ts` is pet-only; npm `package.json#files` must not include `desktop/`.
- After `npm run desktop:make`, scan the real root-relative output with `DESKTOP_PACKAGE_OUT=desktop/out npm run test:desktop-package` (PowerShell: `$env:DESKTOP_PACKAGE_OUT = "desktop/out"; npm run test:desktop-package`).
- Full matrix: `docs/operations/desktop-pet-validation.md`.

## Security reminders

- Token stays in main memory only.
- Renderer: no Node, no absolute URL open; deep links re-validated before `shell.openExternal`.
- No `child_process` / service PID / signal APIs in `desktop/`.
