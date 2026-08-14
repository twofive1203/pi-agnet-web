# Desktop Pet P0 Validation Run — 2026-08-13

## Status

- **Agent engineering preparation:** Pass
- **Product-owner visual/Windows acceptance:** Accepted with documented residual risks on 2026-08-14
- **Overall P0:** Complete
- **Known visual finding:** Running currently uses the shared `pet-scoot` loop and has been reported as an unnatural repeated arching/thrusting motion. This accepted P0 residual is tracked for redesign as P1 in `docs/research/desktop-pet-improvements-2026-08-13.md`.

P0 was intentionally split: the Agent prepared validated code, preview fixtures, installer artifacts, hashes, and the checklist; the product owner confirmed the repaired installed app is visible and explicitly closed P0 on 2026-08-14. Unexecuted clean-profile, full visual-matrix, DPI/multi-monitor, notification, uninstall, signing, and SmartScreen checks remain documented residual risks; they are accepted for P0 rather than recorded as false Pass results.

## Engineering evidence

Run from `D:\workspace\aiwork\pi-agnet-web` on branch `self-run`.

| Command | Result | Notes |
| --- | --- | --- |
| `npm run lint` | Pass | ESLint completed without findings. |
| `node_modules/.bin/tsc --noEmit` | Pass | TypeScript completed without diagnostics. |
| `npm run test:desktop-observer` | Pass | Task observer, desktop observer API, deep links, connection, desktop contract, and source package contract passed. The package substep ran before artifacts existed and correctly reported `ARTIFACT_SCAN_SKIPPED`. |
| `npm run test:runtime` | Pass | Runtime packaging and worker/discovery artifacts passed. |
| `npm run test:server-auth` | Pass | Access-key domain and Proxy protection smokes passed. |
| `npm run test:agent-stream` | Pass | Stream throttling, retry, chat, and Pi lifecycle smokes passed. |
| `npm run test:subagent-observability` | Pass | Summary, progress, detail, run, and store smokes passed. |
| `npm run test:snflow` | Pass | Setup/store/session-link/chat/spec-review smokes passed. |
| `npm run test:automation` | Pass | All 15 Automation smoke groups passed. |
| `npm run test:quick-commands` | Pass | Quick Command smoke passed. |
| `npm run desktop:build` | Pass | Main, preload, renderer, and both CSS pet manifests built. |
| `npm run desktop:preview` | Pass after delivery fix | Generated 51 static visual cells. The initial file preview was blocked because the parent CSP denied frames and the child depended on inline/cross-frame bootstrap; the generator now allows its self frame and loads frame-local external fixture/bootstrap scripts. |
| `npm run desktop:package` | Pass after packaged-entry fix | Generated the unpacked Windows x64 pet. The first 0.1.0 artifact loaded Electron but skipped `main()` because packaged `argv[1]` did not contain `main.js`; 0.1.1 auto-starts in every Electron main runtime unless the explicit test disable flag is set. |
| `npm run desktop:make` | Pass | Generated the 0.1.1 Squirrel Setup and NUPKG. Squirrel install/update/uninstall lifecycle arguments now exit promptly; `--squirrel-firstrun` launches the pet normally. |
| `$env:DESKTOP_PACKAGE_OUT = "desktop/out"; npm run test:desktop-package` | Pass | `ARTIFACT_SCAN_OK dir=desktop/out files=84 asars=1`. |

Browser verification: Chrome headless opened the regenerated `file:///.../desktop/.preview/index.html` without `--allow-file-access-from-files` and rendered the selected snail frame successfully. `test:desktop-contract` now regenerates the preview and asserts the frame CSP/bootstrap contract so this failure cannot silently return.

Packaged launch verification: the repaired unpacked executable was launched without `SNAIL_PET_MAIN`; its root process remained alive and created a renderer plus a non-zero visible `MainWindowHandle`. The repaired Setup updated the local engineering profile from 0.1.0 to 0.1.1 with exit code 0, removed the old app directory, and auto-launched `C:\Users\lichong\AppData\Local\SnailPiPet\app-0.1.1\snail-pi-pet.exe` with a visible window. Clean-profile Windows 10/11 installation remains an owner-assisted release gate.

Non-blocking observation: the package smoke emits Node's `MODULE_TYPELESS_PACKAGE_JSON` warning while loading `forge.config.ts`; packaging and artifact isolation still pass.

## Prepared artifacts

Artifacts are unsigned engineering-QA builds and may trigger SmartScreen.

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `desktop/out/SnailPiPet-win32-x64/snail-pi-pet.exe` | 225,533,952 bytes | `0ed58bdfd1f74f2c7bc160e73e012d058742b3048c7a51f2c1c4ff2313ebe329` |
| `desktop/out/make/squirrel.windows/x64/SnailPiPetSetup.exe` | 140,334,080 bytes | `3ff2996e7536289647f2f4c0936c9b888ca8e1125ae4b0c8267910600f692fe7` |
| `desktop/out/make/squirrel.windows/x64/SnailPiPet-0.1.1-full.nupkg` | 139,195,638 bytes | `05607903cf77f5ec724472bfd37def80919dcec8859b8c0c3049411094815ff4` |

Visual preview:

- `desktop/.preview/index.html`
- Generated checklist: `desktop/.preview/review/checklist.md`
- Durable result sheet: `docs/operations/desktop-pet-visual-review.md`

## Product-owner test steps

Record every item as **Pass**, **Fail**, or **Blocked**, with a short note. A subjective concern is a valid Fail even when automated tests pass.

### A. Static visual and motion review

1. Open `D:\workspace\aiwork\pi-agnet-web\desktop\.preview\index.html` in a desktop browser.
2. Use **上一组/下一组** to inspect all 51 combinations.
3. For each state, verify the glyph and Chinese label remain understandable without relying only on color.
4. Inspect both pets at small/medium/large. Confirm the character, badge, caption, and hit area are not clipped.
5. Watch every Running combination continuously for 10–20 seconds. Specifically record whether it looks like natural focused work or repeated arching/thrusting. The current known report should remain Fail until a redesign is accepted.
6. Check Retrying is distinguishable from Running without appearing frantic; Needs input and Blocked are noticeable but not aggressively flashing; Ready celebration is pleasant and not excessive.
7. Open `tray-running` and `settings-ready`. Verify long titles truncate, project/task hierarchy is readable, controls fit, and the two pet choices look meaningfully different.
8. Open `reduced-motion-running`. Verify there is no looping movement and the state remains understandable.
9. Copy results into `docs/operations/desktop-pet-visual-review.md` or return the failed IDs and notes to the Agent.

### B. Unpacked executable smoke

1. Ensure no installed copy is running; exit it from the system tray if needed.
2. With `spi` stopped, launch:
   `D:\workspace\aiwork\pi-agnet-web\desktop\out\SnailPiPet-win32-x64\snail-pi-pet.exe`.
3. Verify the pet shows “蜗牛派服务未启动”, offers Retry/copy command, and does not open a terminal or start `spi` itself.
4. Start the service separately in a terminal with `spi --no-open` or `npm run dev`.
5. Select Retry and verify the pet attaches without restarting either process.
6. Click the pet, open settings, switch pet and size, collapse the Activity tray, hide with **×**, restore from the system tray, enable click-through, then recover with tray → 取消鼠标穿透.
7. Quit the pet from the tray and verify `spi` remains running.

### C. Live task flow

1. Start one Agent task that runs long enough to observe; close the WebUI tab while it runs.
2. Verify the desktop pet remains connected and shows the task as Running; elapsed time should update only while the Activity tray is open.
3. If available, run a task that invokes `ask_user` or another blocking extension UI request. Verify Needs input appears without leaking the request body, and “打开任务” returns to the allowlisted WebUI task.
4. Let a task complete. Verify Ready appears and the Windows notification is emitted once.
5. Click the notification and verify the default browser opens the corresponding local WebUI task without bringing the pet itself to the foreground.
6. Replay/reconnect the SSE by restarting `spi`; verify old completions do not produce a notification flood.
7. Mark a terminal task read. Confirm this changes only the desktop unread state and does not change the service-side task result. Record any misleading “空闲” outcome label as a Fail tracked by P1.
8. While an Agent or Automation is running, quit the pet and verify the task continues.

### D. Window, DPI, monitor, and focus checks

1. Test Windows display scaling at 100%, 150%, and 200% where available.
2. At each scale, test small/medium/large pet size and expand/collapse the Activity tray near all screen edges.
3. With two monitors, drag the pet in both directions between displays, including mixed resolution/scaling if available. It must not become permanently clipped or stop at the former monitor edge.
4. Move the pet to a secondary display, close it, disconnect that display, and relaunch. It should recover into a visible work area.
5. Put another application in the foreground on another virtual desktop. Trigger Running → Ready and an SSE reconnect. The pet must not switch virtual desktops, steal focus, or show itself if hidden.
6. Verify tray actions with the Windows taskbar at the positions available on the test machine.
7. Repeat a readability check in Windows light and dark modes.

### E. Access-key mode

Current builds allow server mode only through the same proven `127.0.0.1` observer boundary and require the access key for session minting.

1. Stop the ordinary local service.
2. For an isolated local compatibility test, start:
   `spi --server -H 127.0.0.1 --allow-insecure-http --no-open`.
3. Copy the one-time access key from the terminal.
4. Verify the pet opens the existing tray settings when auth is required, accepts the key without echoing it back, and connects.
5. Clear or enter an invalid key and verify the diagnostic is “访问密钥无效/需要访问密钥”, with no task payload exposed.
6. Stop this test service after the check. Do not use `--allow-insecure-http` for public exposure.

### F. Installer, update, and uninstall isolation

These steps modify the local Windows installation and should be run only on the intended QA machine/profile.

1. Record that `spi` works and that `~/.pi/agent` contains the expected existing data; do not delete or edit it for this test.
2. Run `desktop\out\make\squirrel.windows\x64\SnailPiPetSetup.exe`. Accept the expected unsigned-build warning only if the SHA-256 matches this record.
3. Verify the installed pet launches without a system Node dependency.
4. Enable launch-at-login, sign out/reboot when convenient, and verify the pet starts but `spi` is not auto-started.
5. Run the same or a newer Setup over the installation. Verify pet settings, position, selected role, and transition LRUs remain compatible.
6. Uninstall SnailPiPet from Windows Apps & Features.
7. Verify `spi` still runs/starts normally and `~/.pi/agent` sessions/configuration remain intact.

### G. Result handoff

Return:

- Windows version and display topology/scaling;
- visual checklist failures by ID;
- whether the unpacked and installed builds launched;
- notification/reconnect/focus results;
- update/uninstall isolation results;
- screenshots only with synthetic titles and no cwd, Prompt, token, key, or private task text.

P0 was closed on 2026-08-14 by explicit product-owner acceptance of the documented residual risks. Future validation should continue to update the durable matrix without reopening P0 unless a new release blocker is found.
