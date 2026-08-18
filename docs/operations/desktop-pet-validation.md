# Desktop Pet Validation Matrix

- **Date:** 2026-08-12
- **Plan unit:** U8 (`docs/plans/2026-08-12-001-feat-desktop-pet-task-observer-plan.md`)
- **Product:** Windows attach-only desktop pet (SnailPiPet / `snail-pi-pet`)
- **Service:** separate npm CLI `spi` (`@twofive/snail-pi-web`)

This document is the release/QA checklist for the desktop pet. Automated smokes cover domain and packaging **contracts**. Items marked **未执行** require a real Windows 10/11 host with an installer artifact.

Completed P0 engineering run, prepared artifacts, SHA-256 values, and residual validation checklist: [`desktop-pet-p0-validation-2026-08-13.md`](desktop-pet-p0-validation-2026-08-13.md). P0 closed on 2026-08-14 after the product owner confirmed the repaired installed app and explicitly accepted the remaining manual-validation risks.

## Hard product boundaries

| Rule | Expected |
| --- | --- |
| Attach-only | Pet never spawns/stops/restarts/signals/supervises `spi`. |
| Loopback only | Connects only through direct `http://127.0.0.1:<port>`. Ordinary local mode needs no auth; current server mode is attachable only on the same proven loopback boundary with an access key. Remote/multi-instance aggregation remains rejected. |
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
| `test:desktop-quick-session` | Control token isolation, path-free catalog, idempotent create, main client, composer reducer |
| `desktop:preview` | Dev-only visual state matrix under `desktop/.preview/` (U3); not packaged |

**Artifact scan:** `npm run desktop:make` writes `desktop/out`; set `DESKTOP_PACKAGE_OUT=desktop/out` and re-run `npm run test:desktop-package`. The smoke scans expanded resources, `app.asar` entries, and Squirrel `.nupkg` paths rather than only top-level filenames.

**2026-08-13 P0 engineering result:** lint, TypeScript, desktop observer, runtime, server-auth, Agent stream, Subagent observability, SnFlow, Automation, and Quick Command suites passed. `desktop:build`, the 51-cell `desktop:preview`, `desktop:package`, and `desktop:make` passed. The post-make scan reported `ARTIFACT_SCAN_OK dir=desktop/out files=84 asars=1`. Owner testing then found two delivery blockers: file preview CSP/frame bootstrap and packaged Electron auto-start. Both are fixed with regression coverage. The repaired 0.1.1 unpacked executable created a visible native window, and Setup updated the local engineering profile from 0.1.0 to 0.1.1 with exit code 0 and a visible installed app. Exact artifacts and hashes are recorded in the current P0 run document linked above. This does not mark clean-profile or subjective visual rows Pass.

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

UI: drag the pet/body grip to move; pet chrome **×** hides to tray; Activity tray **−** only collapses the list; **⚙** opens local pet/notification preferences; tray Quit ends pet only.

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
| AE13 | Unknown/incompatible/legacy-server diagnostics + Retry; current server mode requires a valid access key on loopback | Yes (connection/auth state machine) | Point pet at wrong port owner; test missing/invalid/valid access key | **Partial** |
| QS1 | Connected + capable server: open composer, start one session, Activity shows Running | Partial (`test:desktop-quick-session`) | Live local/server mode | **未执行** |
| QS2 | Timeout retry reuses requestId and does not create a second session | Yes (idempotency smoke) | Live timeout | **Partial** — live timeout **未执行** |
| QS3 | Renderer catalog/success/error have no cwd/Prompt/token | Yes (catalog + contract privacy) | DevTools inspect | **Automated OK** |
| QS4 | Deleted project after catalog load is rejected | Yes (resolver smoke) | Delete folder then submit | **Partial** — live delete **未执行** |
| QS5 | Old server hides composer; observer still works | Yes (capability fallback) | Mix old `spi` + new pet | **Partial** — live mix **未执行** |

## Manual Windows matrix (release gate)

Run on clean Windows 10 and Windows 11 profiles when a signed or unsigned installer is available:

| Check | Steps | Pass criteria | Status |
| --- | --- | --- | --- |
| Clean install | Install pet only (no Node required for pet) | Pet launches; no Node dependency error | **未执行** |
| Service separate | Install/run `spi` via npm/npx separately | Service works without pet; pet attaches | **未执行** |
| No-service UX | Stop `spi`, launch pet | 服务未执行提示 + copy `spi --no-open` + Retry; no shell popup | **未执行** |
| Incompatible port | Bind non-Snail process on 62666 | Incompatible diagnostic; no kill/replace | **未执行** |
| Server-mode access key | Start server mode on `127.0.0.1`; test missing, invalid, then valid key | Pet requests the key, rejects invalid input, and attaches only after valid session mint; remote access never relaxes the loopback observer gate | **未执行** |
| Notification permission denied | Deny Windows notifications | Activity tray still works | **未执行** — U6 自动契约已覆盖通知 host 不支持/抛错时不影响 Activity tray，并验证本地化安全文案；Windows 权限拒绝实机未执行 |
| Launch at login | Enable option, reboot | Pet starts; does **not** auto-start `spi` | **未执行** |
| DPI / multi-monitor | 100%/150%/200%, move across displays in both directions | Pet position sane; crosses each display boundary; not off-screen permanently | **未执行** — 自动契约已覆盖 settings 迁移、三档 `petScale` 同比缩放、离屏位置拉回最近 workArea、恢复默认位置与中等尺寸，以及拖拽使用完整虚拟桌面边界而非锁定当前显示器；Windows 100/150/200% 与 1K↔2K 双向拖拽实机未执行 |
| Virtual desktop / focus | Hide pet; keep another app focused on another virtual desktop; let a task go Running → Ready, then drop/reconnect SSE | Current app keeps focus; virtual desktop does not switch; hidden pet stays hidden; OS toast (if allowed) does not raise the pet window | **未执行** — U1 自动契约已覆盖 show/focus 调用序列；Windows 虚拟桌面实机未执行 |
| User activation | Tray “显示桌宠”, tray icon click, or second-instance while hidden | Pet becomes visible, click-through is cleared, and the pet window focuses | **未执行** — U1 自动契约已覆盖 user-show / second-instance host 序列 |
| Taskbar positions | Bottom/left/top | Tray menu usable | **未执行** |
| Themes | Light/dark Windows | Glyph/label state still readable | **未执行** |
| Update-over-install | Install newer pet over older | Settings LRU retained when compatible | **Partial** — local engineering profile updated 0.1.0 → 0.1.1, old app directory was replaced, and installed app showed a native window; a profile with meaningful saved settings/LRUs still needs owner verification |
| Uninstall pet | Remove pet via Apps & Features | `spi` still runs; `~/.pi/agent` intact; sessions untouched | **未执行** |
| Quit isolation | Running Agent/Automation while Quit pet | Tasks continue; no service stop | **未执行** |
| Renderer isolation | DevTools (if enabled in debug builds) | No Node, no token in renderer | **未执行** (release builds should not expose unrestricted DevTools) |
| Quick session local/server | Connected composer start in local mode and server-mode access key | One session; observer Running; key never in renderer | **未执行** |
| Quick session IME | Chinese IME composition + Enter, then Ctrl+Enter | Composition Enter does not submit | **未执行** |
| Quick session DPI / anchors | 100/150/200% and four tray anchors | Composer not clipped | **未执行** |
| Quick session DND | Enable DND, open composer, submit | DND does not block explicit start; success toast still follows DND | **未执行** |
| Quick session old server | New pet + old `spi` | Observer works; composer hidden | **未执行** |
| Quick session quit isolation | Start session, quit pet | Session continues | **未执行** |

## Packaging commands (when Electron Forge is installed)

> Electron/Forge are **not** required for ordinary WebUI/`spi` development and are **not** part of the npm publish `files` list. Use the stable scripts below; bare `npx electron-forge` may download obsolete Forge 5 instead of the pinned scoped CLI.

```powershell
# Windows packaging workstation; each command runs desktop:build first.
npm run desktop:package
npm run desktop:make

# Scan the real package + Squirrel output:
$env:DESKTOP_PACKAGE_OUT = "desktop/out"
npm run test:desktop-package
```

**2026-08-13 U7 engineering result:** `desktop:package`, `desktop:make`, and the real artifact scan passed on Windows x64. Outputs included `desktop/out/SnailPiPet-win32-x64/snail-pi-pet.exe`, `desktop/out/make/squirrel.windows/x64/SnailPiPetSetup.exe`, and the full NUPKG. They are unsigned engineering-QA artifacts; install/notification/update/uninstall evidence remains **未执行** under the manual matrix.

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
| Current server mode on loopback | 访问密钥 required/invalid diagnostic; settings accepts the key and retries session mint |
| Legacy server-mode observer | Server mode unsupported + Retry |
| Unknown HTTP on port | Unknown service on port + Retry |
| SSE drop | Disconnected/reconnecting overlay; last snapshot stale; no false success |
| Token expiry | Silent remint + baseline reset (no historical toast flood) |

## Codex resource compatibility (2026-08-18)

Automated coverage lives in `scripts/smoke-desktop-contract.ts` (parser, catalog, lazy read, settings key migration, CSP `blob:`, IPC allowlist). Local sample binaries under `codex-ui-resouce/` stay untracked and must not be packaged.

| Case | Expected | Status |
| --- | --- | --- |
| Snail + Codex packs in the picker | Both formats listed, source badge visible, distinct keys | Automated catalog smoke |
| Select Codex v2 | Running/Needs input/Ready/Blocked map to running/waiting/waving/failed; Snail labels/glyphs unchanged. Ready does not loop `jumping` (that clip is a hop/attack cycle and reads as in-place jumping). | Automated profile mapping; visual playback 未执行 |
| v2 look + reduced-motion | 16-dir quantization; reduced-motion stays on a static business frame | Automated; desktop size readability 未执行 |
| Multiple 2–3 MB atlases | Catalog has no base64; only the selected bitmap is read | Automated |
| Bad path / size / decode / deleted file | Reject or CSS-snail fallback, pet stays up | Automated hard errors; Electron decode 未执行 |
| Upgrade `selectedPetId` | Becomes `snail:<id>`; same-id Codex does not steal it | Automated |
| License boundary | Samples not in repo/package; local load ≠ redistribute | Documented + gitignore/forge ignore |

Manual visual matrix (local v2 samples + synthetic v1, small/medium/large, look, drag, delete/rescan): **未执行**.

## Residual risks

1. Forge package/make is wired locally, but signed installer CI is not; signing still depends on environment-provided certificate secrets.
2. Live AE multi-monitor/DPI/notification/SmartScreen matrix is manual.
3. Install, notification-click activation, update-over-install, and uninstall data isolation still require U8 clean-profile evidence.
4. Auto-update is out of v1 scope.

## Sign-off

| Role | Result | Date |
| --- | --- | --- |
| Agent engineering preparation | **Pass** — automated suites, preview, package/make, real artifact scan, unpacked native-window smoke, and local 0.1.0 → 0.1.1 installed-window update | 2026-08-13 |
| Product-owner P0 acceptance | **Accepted with documented residual risks** — repaired 0.1.1 installed app confirmed visible; Running redesign remains P1 | 2026-08-14 |
| Windows clean-profile installer | **未执行，P0 residual accepted** | 2026-08-14 |
| Code signing / SmartScreen | **未执行，P0 residual accepted** | 2026-08-14 |
