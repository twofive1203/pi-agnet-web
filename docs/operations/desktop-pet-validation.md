# Desktop Pet Validation Matrix

- **Date:** 2026-08-12
- **Plan unit:** U8 (`docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md`)
- **Product:** Windows attach-only desktop pet (SnailPiPet / `snail-pi-pet`)
- **Service:** separate npm CLI `spi` (`@twofive/snail-pi-web`)

This document is the release/QA checklist for the desktop pet. Automated smokes cover domain and packaging **contracts**. Items marked **未执行** require a real Windows 10/11 host with an installer artifact.

## Hard product boundaries

| Rule | Expected |
| --- | --- |
| Attach-only | Pet never spawns/stops/restarts/signals/supervises `spi`. |
| Loopback only | Connects to `http://127.0.0.1:<port>` local mode only. |
| Privacy | Observer payload has no cwd, Prompt/firstMessage, tool args, paths, command/output/env, secrets, raw provider errors. |
| Deep links | Main validates allowlisted relative paths before `shell.openExternal`. |
| Data isolation | Uninstalling the pet must not delete `~/.pi/agent` or remove npm `spi`. |
| Package isolation | Pet installer must not embed Next/`.next`, pi SDK, Automation workers, node-pty, or `bin/pi-web.js`. |
| Signing | Broad distribution requires Authenticode signing; unsigned builds may hit SmartScreen. |

## Automated checks (run in CI / dev)

```bash
npm run lint
node_modules/.bin/tsc --noEmit
npm run test:desktop-observer
npm run test:desktop-package
npm run test:runtime
npm run test:server-auth
# Recommended focused service suites when touching shared lifecycle:
npm run test:agent-stream
npm run test:subagent-observability
npm run test:snflow
npm run test:automation
npm run test:quick-commands
```

| Suite | Covers |
| --- | --- |
| `test:task-observer` | Identity, presentation, privacy budgets (U1) |
| `test:desktop-observer-api` | Loopback/token/SSE hub gates (U4) |
| `test:desktop-deep-links` | Allowlist deep links + intent strip (U5) |
| `test:desktop-connection` | Connection state machine + no process control (U6) |
| `test:desktop-contract` | Tray/read/notification/window/renderer safety (U7) |
| `test:desktop-package` | Pet-only forge/npm separation + source contracts (U8) |
| `desktop:preview` | Dev-only visual state matrix under `desktop/.preview/` (U3); not packaged |

**Optional artifact scan:** after `electron-forge make`, set `DESKTOP_PACKAGE_OUT` to the output directory and re-run `npm run test:desktop-package` so forbidden runtime paths are scanned inside the package tree.

## Independent startup (either order)

### Dev (source tree)

```bash
# terminal A — service
npm run dev
# or: spi --no-open

# terminal B — pet window
npm run desktop:build   # once / after main|preload changes
npm run desktop:dev     # rebuilds when stale, then launches Electron
# npm run desktop:dev:rebuild
```

`desktop:dev` does **not** start `spi`. Default probe origin: `http://127.0.0.1:62666`.
Developer map: `desktop/README.md`.

UI: drag the pet/body grip to move; pet chrome **×** hides to tray; Activity tray **⌄** only collapses the list; **⚙** opens local pet/notification preferences; tray Quit ends pet only.

### Packaged / installed

1. Start service without auto-opening a browser:
   ```bash
   spi --no-open
   ```
   Default origin: `http://127.0.0.1:62666`.
2. Launch the desktop pet (installer shortcut or packaged exe).
3. Pet probes health → protocol → session token → single SSE snapshot stream.
4. If the service is down first, pet shows **蜗牛派服务未启动**, offers copy `spi --no-open`, help, and Retry. Starting `spi` independently then Retry attaches.

WebUI in the default browser is opened only from tray/activity/notification deep links — opening WebUI does not start the pet, and starting the pet does not start `spi`.

## Acceptance scenarios AE1–AE13

| ID | Scenario | Automated | Manual Windows | Status |
| --- | --- | --- | --- | --- |
| AE1 | Multi-project Agent/Automation/Quick Command visible with browsers closed | Partial (projection + tray grouping smokes) | Confirm live SSE with three sources | **Partial** — live multi-source UI **未执行** |
| AE2 | Ready transition notifies once; SSE replay does not re-notify | Yes (`test:desktop-contract` notification policy) | Confirm OS toast once | **Partial** — OS toast **未执行** |
| AE3 | (if present in requirements set) Subagent nested, not double-counted | Yes (task-observer / hub smokes) | Spot-check tray children | **Partial** |
| AE4 | (privacy) Snapshot omits forbidden fields | Yes (`test:task-observer`, API smokes) | Optional proxy inspect | **Automated OK** |
| AE5 | Close pet window → tray; click-through recoverable | Yes (window-manager pure state) | Real tray click | **Partial** — tray click **未执行** |
| AE6 | Notification/activity opens allowlisted WebUI; arbitrary URL rejected | Yes (deep-link opener smoke) | Default browser open | **Partial** — browser open **未执行** |
| AE7 | Port refused → 服务未启动 + copy command; no child process; Retry after `spi` | Yes (connection + contract + static no-spawn) | End-to-end | **Partial** — E2E **未执行** |
| AE8 | Unauthed observer rejected; payload privacy | Yes (`test:desktop-observer-api`) | — | **Automated OK** |
| AE9 | instanceId change → baseline, no flood of success toasts | Yes (connection + notification baseline) | Live restart | **Partial** — live restart **未执行** |
| AE10 | Quit pet leaves `spi`/tasks running; no “会中断任务” warning | Yes (static quit label + no service control) | Live quit while Agent runs | **Partial** — live quit **未执行** |
| AE11 | Priority Needs input > Blocked > Ready > Running; mark-read local only | Yes (`test:desktop-contract`) | UI click mark-read | **Partial** |
| AE12 | Reduced motion static frames; pet selection/position persist | Yes (pet-state + settings) | OS reduced-motion setting | **Partial** — OS preference **未执行** |
| AE13 | Unknown/incompatible/server-mode diagnostics + Retry, no process takeover | Yes (connection machine) | Point pet at wrong port owner | **Partial** |

## Manual Windows matrix (release gate)

Run on clean Windows 10 and Windows 11 profiles when a signed or unsigned installer is available:

| Check | Steps | Pass criteria | Status |
| --- | --- | --- | --- |
| Clean install | Install pet only (no Node required for pet) | Pet launches; no Node dependency error | **未执行** |
| Service separate | Install/run `spi` via npm/npx separately | Service works without pet; pet attaches | **未执行** |
| No-service UX | Stop `spi`, launch pet | 服务未执行提示 + copy `spi --no-open` + Retry; no shell popup | **未执行** |
| Incompatible port | Bind non-Snail process on 62666 | Incompatible diagnostic; no kill/replace | **未执行** |
| Server mode refusal | `spi --server` on loopback/non-loopback | Pet shows server-mode unsupported; does not attach | **未执行** |
| Notification permission denied | Deny Windows notifications | Activity tray still works | **未执行** |
| Launch at login | Enable option, reboot | Pet starts; does **not** auto-start `spi` | **未执行** |
| DPI / multi-monitor | 100%/150%/200%, move across displays | Pet position sane; not off-screen permanently | **未执行** — U2 自动契约已覆盖 settings 迁移、三档 `petScale` 同比缩放、离屏位置拉回最近 workArea、恢复默认位置；Windows 100/150/200% 与主副屏实机未执行 |
| Virtual desktop / focus | Hide pet; keep another app focused on another virtual desktop; let a task go Running → Ready, then drop/reconnect SSE | Current app keeps focus; virtual desktop does not switch; hidden pet stays hidden; OS toast (if allowed) does not raise the pet window | **未执行** — U1 自动契约已覆盖 show/focus 调用序列；Windows 虚拟桌面实机未执行 |
| User activation | Tray “显示桌宠”, tray icon click, or second-instance while hidden | Pet becomes visible, click-through is cleared, and the pet window focuses | **未执行** — U1 自动契约已覆盖 user-show / second-instance host 序列 |
| Taskbar positions | Bottom/left/top | Tray menu usable | **未执行** |
| Themes | Light/dark Windows | Glyph/label state still readable | **未执行** |
| Update-over-install | Install newer pet over older | Settings LRU retained when compatible | **未执行** |
| Uninstall pet | Remove pet via Apps & Features | `spi` still runs; `~/.pi/agent` intact; sessions untouched | **未执行** |
| Quit isolation | Running Agent/Automation while Quit pet | Tasks continue; no service stop | **未执行** |
| Renderer isolation | DevTools (if enabled in debug builds) | No Node, no token in renderer | **未执行** (release builds should not expose unrestricted DevTools) |

## Packaging commands (when Electron Forge is installed)

> Electron/Forge are **not** required for ordinary WebUI/`spi` development and are **not** part of the npm publish `files` list.

```bash
# From a packaging workstation with electron + electron-forge devDependencies installed:
npx electron-forge package
npx electron-forge make

# Then scan artifacts:
set DESKTOP_PACKAGE_OUT=out
npm run test:desktop-package
```

Signing (broad distribution):

| Variable | Purpose |
| --- | --- |
| `WINDOWS_CERTIFICATE_FILE` | Path to Authenticode cert (Squirrel maker) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Cert password |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Alternate electron-builder-style placeholders |

Unsigned local builds are fine for engineering QA; SmartScreen may warn until signed.

## Diagnostics users should see

| Condition | UI |
| --- | --- |
| Connection refused | 蜗牛派服务未启动 + copy `spi --no-open` + Retry |
| Protocol mismatch | 不兼容 / protocol mismatch + Retry |
| Server mode | Server mode unsupported + Retry |
| Unknown HTTP on port | Unknown service on port + Retry |
| SSE drop | Disconnected/reconnecting overlay; last snapshot stale; no false success |
| Token expiry | Silent remint + baseline reset (no historical toast flood) |

## Residual risks

1. Full installer make/sign CI is not wired in this repository slice; packaging depends on optional Electron Forge install.
2. Live AE multi-monitor/DPI/SmartScreen matrix is manual.
3. Preload/main TypeScript still needs a packaging compile step to `.js` before production `loadFile`/`require` paths are bulletproof in packaged form.
4. Auto-update is out of v1 scope.

## Sign-off

| Role | Result | Date |
| --- | --- | --- |
| Automated contract smokes | Pass when commands above succeed | 2026-08-12 |
| Windows clean-profile installer | **未执行** | — |
| Code signing / SmartScreen | **未执行** | — |
