# Isolated Tauri Desktop Pet Preview

- **Status:** Accepted for Preview / release-candidate qualification (U1–U8 implemented). Gate D remains **Extend** until same-machine installer, process-tree memory, clean-profile, and signing evidence are filled in.
- **Date:** 2026-09-17
- **Scope:** Parallel Windows Tauri 2 Preview beside the existing Electron pet
- **Plan:** `docs/plans/2026-09-17-001-refactor-tauri-desktop-pet-migration-plan.md`
- **Validation:** `docs/operations/desktop-pet-tauri-validation.md`

## Decision Summary

Keep Electron `SnailPiPet` as the default, ship-ready desktop pet. Build an isolated Tauri 2 Preview that reuses the existing observer/control protocol and `desktop/renderer/` UI through a narrow `window.snailPet` bridge. Rust owns tokens, secrets, filesystem, notifications, Tray, window control, and external opens. WebView only receives already-defined safe projections.

This plan does **not** delete Electron, switch the default download, reuse the Electron AppUserModelID, or import Electron settings automatically.

## Isolated identity

| Surface | Electron | Tauri Preview |
| --- | --- | --- |
| Identifier / single-instance | `com.twofive.snail-pi-pet` | `com.twofive.snail-pi-pet.tauri-preview` |
| Product | `SnailPiPet` | `SnailPiPet Tauri Preview` |
| Executable | `snail-pi-pet` | `snail-pi-pet-tauri-preview` |
| Settings | `desktop-pet-settings.json` | `tauri-preview-settings.json` |
| Access Key | `desktop-pet-access-key.json` | `tauri-preview-access-key.json` (DPAPI ciphertext) |
| Autostart | Electron login item | `SnailPiPetTauriPreview` |
| Installer | Squirrel `SnailPiPetSetup` | NSIS current-user Preview installer |
| Start menu | `SnailPiPet` | `SnailPiPet Tauri Preview` |

Writable state stays in the Preview app-data/config directory derived from the Preview identifier. Custom Snail/Codex pet folders are read-only shared user resources. Uninstalling Preview must not touch Electron settings, `~/.pi/agent`, or `spi`.

## Permission and process boundary

- Attach-only: Preview never starts, stops, restarts, signals, or stores a `spi` PID.
- Loopback only: Rust HTTP/SSE may use `http://127.0.0.1:<validated-port>`. WebView CSP is `connect-src 'none'`.
- Capability is deny-by-default and limited to the `pet` window plus `core:default`. No shell, process, fs, http, or opener plugin wildcards.
- Observer Token, Control Token, and Access Key stay in Rust memory. Access Key may persist only as OS-bound DPAPI ciphertext; if encryption is unavailable the key stays in memory and is never written as plaintext.
- Deep links are service-generated relative allowlist URLs, locally revalidated before `ShellExecuteW`.
- Renderer keeps one UI source tree. Host differences live in `desktop/preload/pet-preload.ts` and `desktop-tauri/src/tauri-bridge.ts`.

## WebView2 and packaging

Preview ships as NSIS, not MSI, and does not emit updater artifacts.

WebView2 candidates for size qualification:

| Mode | Allowed as size evidence | Why |
| --- | --- | --- |
| `downloadBootstrapper` | Yes | Evergreen; smallest installer; needs network if Runtime is missing |
| `embedBootstrapper` | Yes, current default | Evergreen plus ~1.8 MB bootstrapper for missing-Runtime machines |
| `offlineInstaller` | No | ~127 MB; destroys the installer-size target |
| `fixedRuntime` | No | ~180 MB; also forks the browser runtime |

Unsigned engineering QA is the default. Authenticode uses `bundle.windows.certificateThumbprint` / `digestAlgorithm` / `timestampUrl` placeholders and must not commit certificate material. SmartScreen warnings on unsigned Preview builds are expected.

Artifact scans must prove the bundle contains no `.next`, Next/pi SDK, Node, Electron, Forge, node-pty, Automation workers, `bin/pi-web.js`, test fixtures, Electron settings, or Access Key files. The UI build deletes and recreates `desktop-tauri/dist` and accepts only the fixed renderer/bridge allowlist. NSIS outer-file inspection is reported separately as `BUNDLE_OUTER_SCAN_OK`; only an unpacked or isolated temporary-install application tree may produce `ARTIFACT_SCAN_OK`.

## Runtime parity hardening

Rust keeps window focus/background state and per-sound-kind cooldown timestamps in process memory. Persisted settings continue to contain only transition LRUs, so focus changes and 10-second cooldown timestamps never become durable user data. `WindowEvent::Focused` updates policy state without showing the pet.

Tray mutations complete through the same host boundary that persists settings, emits the renderer view, and refreshes checked/enabled menu state. Left click is an explicit user reveal; right click remains the context menu. Restore-default resets to medium/collapsed and docks at the current work area bottom-right. A stoppable low-frequency monitor-topology watcher passively clamps the window to the nearest remaining work area without focus activation. Per-window scale-factor events are intentionally excluded from topology recovery: Windows emits them during ordinary mixed-DPI cross-screen dragging while the window straddles two work areas, where full-display clamping would detach the pet from the pointer. Tauri pet-body dragging delegates the gesture to the native OS window drag after the renderer's click/drag threshold; it does not integrate WebView `screenX`/`screenY` deltas with a changing per-window scale factor. This keeps the cursor anchor stable across mixed-DPI display boundaries while Electron retains its existing delta fallback. Actual display add/remove/metrics changes remain covered by the topology signature watcher.

Custom-pet scans validate the persisted selected key in Rust. If a selected Snail/Codex entry disappears or becomes invalid, Preview persists `snail:snail-default`; renderer fallback is no longer the source of truth.

## Settings migration

`map_electron_settings_preview` is a versioned, read-only mapper. U8 rehearses it against a synthetic Electron settings fixture and may optionally parse a real Electron file when `DESKTOP_TAURI_ELECTRON_SETTINGS` is set. The rehearsal writes only an anonymized temp report. Automatic import into Preview, and any write back to Electron, stay deferred to a later switch plan.

## Gate record

| Gate | Automatic contracts | Real Windows matrix | Decision |
| --- | --- | --- | --- |
| A Shell | Pass | **未执行** | Continue Preview; do not inherit Electron Pass |
| B Security / renderer | Pass | **未执行** | Continue Preview |
| C Feature parity | Pass | **未执行** | Continue Preview |
| D Release candidate | Package/isolation/rehearsal harness Pass | Installer size, process-tree memory, clean-profile, signing, AE/QS **未执行** | **Extend** |

**Extend** means the isolated architecture is in place and Electron remains the default product. A later switch plan still needs its own approval for the formal App ID, settings import, default download, and Electron retirement.

Proceed requires independent Tauri evidence for AE1–AE13 / QS1–QS5 with no P0/P1 gaps, installer ≤20 MB under Evergreen bootstrapper rules, app-specific install dir ≤30 MB, and connected-idle full process-tree private working set at least 30% below Electron on the same machine. Missing memory reduction with passing size may stay Extend if the process-tree data are published; it must not be reported from the Rust host process alone.

Stop if Preview cannot keep attach-only/privacy isolation, cannot recover click-through/focus, or cannot show a real resource win without Offline/Fixed WebView2 or a second privileged WebView network stack.
