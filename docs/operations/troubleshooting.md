# Operations and Troubleshooting

## Common Checks

- Confirm the server is on port `62666` unless `--port` or `PORT` overrides it.
- Confirm bind address: default is `127.0.0.1` (not LAN). Remote access needs `--server` or a non-loopback hostname.
- Confirm `PI_CODING_AGENT_DIR` when sessions or config appear missing.
- Check `~/.pi/agent/sessions/` for raw session JSONL files.
- For PM2 deployments, inspect process logs; ensure single-instance fork mode (`instances: 1`, `exec_mode: fork`).
- Hit `GET /api/health` for `pid`, `instanceId`, `mode`, `bind`, `liveSessions`, `sseListeners`, and Automation `scheduler.role`.
- Boot/Ready logs should include a `[spi] Runtime pid=… instanceId=… mode=… bind=…` line.

## Single-instance / multi-replica

- **Start refused with multi-instance / cluster message:** PM2 cluster (`NODE_APP_INSTANCE`), Node cluster workers, `WEB_CONCURRENCY>1`, or `instances>1` was detected. Use the official `ecosystem.config.cjs` single-process fork profile.
- **Sticky routing behind a load balancer still fails or splits sessions:** expected. Ordinary chat wrappers, SSE listeners, and access-auth rate limits are process-local. Sticky sessions are **not** a supported multi-replica mode.
- **Emergency override:** `PI_WEB_ALLOW_MULTI_INSTANCE=1` allows boot despite markers but remains unsupported and logs a strong warning.
- **Two independent `spi` processes on different ports:** not load-balanced multi-replica; each process owns its own live sessions. Prefer one process per host for production.

## Server access authentication

- **Cannot reach from another machine after upgrade:** intentional. Default bind is loopback. Use `spi --server` (or `PI_WEB_SERVER_MODE=1` / non-loopback `-H`).
- **Access key not printed on restart:** expected. The key is shown only on first server init or `--rotate-access-key`. It is never stored in plaintext in `server-access.json`.
- **Lost access key:** run `spi --server --rotate-access-key` (or with your usual non-loopback bind). A new key is printed once; all old sessions die immediately.
- **Corrupt `server-access.json`:** server mode fails closed (boot error or `503`). Recover with `--rotate-access-key` after fixing permissions; do not hand-edit the verifier.
- **Unlock page says HTTPS is required:** expected for server mode over plain HTTP. Terminate TLS at a trusted reverse proxy and set `PI_WEB_TRUST_PROXY=1` on a loopback backend. Only for a transport already encrypted by another trusted layer, restart with `--allow-insecure-http` or `PI_WEB_ALLOW_INSECURE_HTTP=1`.
- **Stuck on unlock page behind HTTPS:** confirm the proxy overwrites `X-Forwarded-Proto: https` and `X-Forwarded-Host`, then set `PI_WEB_TRUST_PROXY=1` only with a loopback backend so the transport gate passes and cookies are `Secure`.
- **HTTP warning on unlock page:** HTTP compatibility was explicitly enabled. The warning is suppressed when a trusted proxy reports `https`.
- **429 on login:** the socket client IP exhausted its short in-process attempt bucket; wait and retry. Restart clears counters (single-instance behavior). Multi-instance would split buckets and is unsupported.
- **Everyone logged out after ops change:** access key was rotated, or Agent data dir was not persisted (new empty `server-access.json`).
- **Container loses key every deploy:** mount a persistent volume for `PI_CODING_AGENT_DIR`.
- **Logged-in remote still cannot use Automation / browser bridge:** correct — those remain loopback-only and are not authorized by the global access key. Add Project uses the same web directory browser locally and remotely.
- **Want Tailscale phone access without typing the key:** start with `--server` and configure durable allowlist in `~/.pi/agent/server-access-policy.json`:
  ```json
  { "version": 1, "authBypassCidrs": ["100.64.0.0/10"] }
  ```
  Prefer the device's exact `/32`; use the full `100.64.0.0/10` only if every tailnet peer is trusted. The env override `PI_WEB_AUTH_BYPASS_CIDRS` uses socket `remoteAddress` only; forged `X-Forwarded-For` is ignored.
- **Bypass configured but still sees unlock:** loopback and world-open rules are intentionally rejected because loopback may be a reverse proxy carrying untrusted clients. Otherwise, the remote address may be unavailable/outside the list or an empty env override may be clearing the file. Check the boot log and `netstat`.

## Windows desktop pet

- **How to run from source:** `npm run dev` (or `spi --no-open`) in one terminal, `npm run desktop:dev` in another. Build only: `npm run desktop:build`. See `desktop/README.md`.
- **Pet stuck at top-left / cannot move:** drag the **grey grip bar above the pet** (frameless window has no title bar). First launch defaults to bottom-right; if an old settings file pinned `(0,0)`, delete Electron userData (`%APPDATA%\SnailPiPet` or `%APPDATA%\snail-pi-pet`) and relaunch.
- **No window close button / cannot dismiss:** use the **×** on the pet chrome or Activity tray header — it **hides to tray**, it does not quit. Restore via tray → 显示桌宠. Only tray 退出桌宠 ends the process.
- **0.1.0 EXE/Setup leaves processes but no visible pet:** 0.1.0 incorrectly inferred the packaged main entry from `process.argv[1]`, so Electron stayed alive without calling `main()`. Install/run 0.1.1 or newer. If stale 0.1.0 processes remain, end SnailPiPet from Task Manager before launching the repaired build.
- **Pet shows 蜗牛派服务未启动 / Service not running:** no compatible listener on `127.0.0.1:<port>` (default `62666`). Start the service separately with `spi --no-open`, then use Retry. The pet never auto-runs that command or spawns a service process.
- **Copy start command does nothing visible:** it only writes `spi --no-open` to the clipboard — paste into a terminal yourself.
- **Incompatible / protocol mismatch / legacy server mode:** the port owner is not a compatible Snail Pi observer. Fix/update the service or change the pet server profile; the pet will not kill or replace the process. Local attach stays `127.0.0.1`. Tauri remote profiles require server mode, HTTPS (or dual explicit HTTP), and an Access Key. Missing `remote_attach`, TLS failure, or insecure-HTTP mismatch show dedicated diagnostics — never skip certificate checks.
- **Pet connected but tasks missing after browser close:** confirm `spi` is still running (ordinary Agent wrappers live in the service process). Restarting the service drops in-memory ordinary/Quick Command work; SnFlow/Automation may reconcile from disk. Also confirm the pet SSE path is live (dev builds use `desktop/main/observer-client.ts` stream).
- **Duplicate notifications after reconnect:** should not happen for the same `transitionId`. If it does, file a bug with instanceId/reset details; baseline on first snapshot after connect/reset is intentional (no backfill).
- **Click-through cannot click the pet:** use tray → 取消鼠标穿透 / 显示桌宠.
- **Closed the window and pet “disappeared”:** close/× hides to tray; use tray → 显示桌宠. Only tray 退出桌宠 ends the pet process.
- **Quit pet while Agent is running:** expected that tasks keep running; there is no “will interrupt tasks” warning because the pet cannot stop them.
- **`desktop:dev` fails missing electron/esbuild:** run `npm install` at repo root (they are devDependencies). They are not part of the published npm `spi` package.
- **Bare `npx electron-forge` asks for `electron-prebuilt-compile`:** `npx` selected obsolete unscoped Forge 5. Use `npm run desktop:package` or `npm run desktop:make`; both invoke the pinned `@electron-forge/cli` and build desktop bundles first.
- **Forge says `packageJSON.main` is invalid / app has no devDependencies:** Forge was run from the repository root instead of the private desktop app root. Use the stable scripts rather than calling Forge directly.
- **Squirrel make reports `Unable to set icon`:** confirm `desktop/assets/icons/icon.ico` exists and use the checked-in Forge config. The setup/app receive the branded icon; legacy Update.exe icon patching is intentionally skipped for compatibility.
- **Unsigned Setup triggers SmartScreen:** expected for engineering-QA artifacts. Broad distribution requires Authenticode credentials supplied only through the packaging environment; never commit a certificate or password.
- **Uninstalled pet, sessions gone?** should not happen — agent data is under `~/.pi/agent` owned by `spi`. If data is missing, check `PI_CODING_AGENT_DIR` / accidental deletion, not pet uninstall.
- **npm `spi` install pulled Electron?** it must not; pet packaging is separate. Report if `npm pack` contents include `desktop/`.
- **Validation / packaging contracts:** `npm run test:desktop-observer`, `npm run test:desktop-package`, and `docs/operations/desktop-pet-validation.md`.

## Windows desktop pet — Tauri Preview

Tauri Preview is an isolated companion (`com.twofive.snail-pi-pet.tauri-preview`). It does not replace Electron and does not start `spi`.

- **How to run from source:** start `spi --no-open` or `npm run dev`, then `npm run desktop:tauri:dev`. UI build only: `npm run desktop:tauri:build-ui`. See `desktop-tauri/README.md`.
- **Preview and Electron both running:** expected. They use different App IDs, settings files, and single-instance locks. Closing one does not quit the other.
- **Settings did not come from Electron:** expected. Preview writes `tauri-preview-settings.json` only. The U8 rehearsal can parse Electron settings read-only; it never imports them automatically.
- **Access key not remembered:** Preview stores ciphertext with Windows DPAPI. If encryption is unavailable the key stays in memory and is not written as plaintext. Clear/re-enter after a failed decrypt.
- **WebView2 missing / install failed offline:** Preview uses Evergreen `embedBootstrapper` by default. Offline/Fixed Runtime is not the supported Preview path. Install Evergreen WebView2 or retry with network.
- **Unsigned Preview Setup triggers SmartScreen:** expected for engineering-QA artifacts. Signing uses `certificateThumbprint` in `desktop-tauri/src-tauri/tauri.conf.json`; do not commit certificates.
- **Uninstalled Preview and sessions disappeared?** should not happen. Agent data stays under `~/.pi/agent`. If Preview leftovers remain, remove only the Preview app-data directory, not `%APPDATA%\SnailPiPet`.
- **Need size/memory numbers:** `powershell -File scripts/benchmark-desktop-runtimes.ps1 -Scenario connected-idle`. Do not treat `src-tauri/target/debug` as a release result.
- **Validation / packaging contracts:** `npm run test:desktop-tauri-contract`, `npm run test:desktop-tauri-package`, and `docs/operations/desktop-pet-tauri-validation.md`.

## Development Safety

- Use `npm run dev` during development.
- Do not run `next build` directly; use `npm run build` only when validating release/publish behavior.
- If `.next/` appears polluted after an accidental build, clean it before continuing dev-server work.

## Session index smoke scripts

- Scripts that import `lib/session-reader` (and therefore `@earendil-works/pi-coding-agent`) may fail under the current `tsx` CJS loader with `ERR_PACKAGE_PATH_NOT_EXPORTED` for package subpath exports.
- For focused session-index validation, use the dependency-free `scripts/smoke-session-index.ts` (it exercises the index layer without pulling in the pi SDK).

## SnFlow task revisions

- SnFlow `task.json` `revision` values are 16-hex concurrency tokens, not Git commit objects. Do not `git show` / `git checkout` / otherwise resolve them as commits.
- Check agents must inspect the current unstaged working tree (and task documents) for the dispatched revision; treat a mismatch against `task.json` as stale dispatch, not a missing commit.

## Subagent observability diagnostics

- Server diagnostics are disabled by default. Start Snail Pi with `PI_WEB_SUBAGENT_OBSERVABILITY=1` to emit one bounded aggregate log every five seconds with raw/coalesced/delivered progress counts, projection/handler timing, SSE payload count/bytes, and event-loop delay. No tool arguments or output text are retained.
- Browser diagnostics are also disabled by default and are compiled into the client bundle. Set `NEXT_PUBLIC_PI_WEB_SUBAGENT_OBSERVABILITY=1` before starting/building, then inspect `[pi-web:subagent-observability:browser]` records in DevTools for SSE, handler, serialization, AppShell update/render, and open-panel render metrics.
- Use `npm run test:subagent-observability` for deterministic coalescing, terminal ordering, urgent-state bypass, teardown, bounded metrics/output/detail parsing, and selective external-store notifications. Use `npm run test:api-protection` for concurrent Grok billing behavior.
- The currently installed `pi-subagents` runtime reads TUI fleet settings only from `~/.pi/agent/extensions/subagent/config.json`; it has no safe WebUI-session override. For a manual attribution experiment, set both `fleetView: false` and `asyncWidget: false` (disabling only `fleetView` enables the legacy async widget by default), then restart/reload Pi. This is a user-global experiment, not an application-managed setting.

## Network / Proxy

Use `scripts/start-pi-web-proxy.sh` or `scripts/start-pi-web-proxy.ps1` when provider calls need the local proxy. They set common proxy env vars and `NODE_OPTIONS=--use-env-proxy` for modern Node fetch/undici behavior.

## Chrome Tab Debugging Extension

- Pairing and bridge traffic are loopback-only (`127.0.0.1`). Remote/LAN Snail Pi is not supported in v1.
- Default ports: Web UI `62666`, browser WebSocket bridge `62667`. Bridge state/pairing metadata lives in `~/.pi/agent/browser-bridge.json`; one-time, hashed handshake records briefly use `~/.pi/agent/browser-connect-tokens/` so REST and WebSocket handlers can authenticate across isolated Next.js module contexts.
- Load the unpacked extension from `extensions/chrome-tab-debug` (see that folder's README). After updating the source, click **Reload** for the unpacked extension in `chrome://extensions`.
- If the extension cannot pair: confirm browser control is enabled from the chat Browser panel, regenerate a pairing code, and verify nothing else is bound to the bridge port.
- **Server mode (`--server` / non-loopback bind) pair button “does nothing” or fails immediately:** the extension posts to `http://127.0.0.1:<port>/api/browser/pair` with `action=exchange` and a `chrome-extension://` Origin, so it cannot carry the WebUI access-key cookie or pass exact same-origin checks. Current builds exempt only extension-owned `exchange` / `connect_token` / `unpair` on those paths and still require a proven loopback TCP peer inside the route. Update/reload Snail Pi after that fix, reload the unpacked extension, then pair again. `issue` / `configure` stay fully authenticated (WebUI only). Pairing remains local-only — remote/LAN Snail Pi is not supported for the extension.
- **Pair or `/api/automations/session` still 403 after auth with message `Automation request URL host is not loopback`:** Next may rewrite `Request.url` to the listen address (`0.0.0.0`) while the client Host is `127.0.0.1`/`localhost`. Current builds prefer the client `Host` header once the TCP peer is proven loopback. Rebuild/restart if you still see the URL-host error.
- If the popup shows a clear HTTP 401/403 pairing error, read the message: outdated server builds without the loopback extension-pair bypass will block exchange even when the pairing code is valid.
- If the popup remains on `Checking…`: reload the unpacked extension and restart Snail Pi so both sides use the current protocol implementation. The popup should report `Extension unavailable` instead of waiting indefinitely when its MV3 service worker does not respond.
- If tools return `BRIDGE_DISCONNECTED`: open the extension popup and click Reconnect; the MV3 service worker may have stopped.
- If tools return `BINDING_SUSPENDED`: the tab navigated cross-origin; re-confirm binding on the new page.
- If **Allow debug** reports `Only permissions specified in the manifest may be requested`: reload extension version 0.1.4+ from `chrome://extensions` and approve/re-enable it if Chrome shows the required-permission warning. Chrome explicitly forbids `debugger` in `optional_permissions`; current builds declare it as required but still gate every attachment behind per-binding popup consent plus the separate WebUI **Enable debug** action.
- If debug tools return `CAPABILITY_UNAVAILABLE`: DevTools or another debugger may have detached `chrome.debugger`. DOM tools should still work; re-enable debug from Snail Pi after closing the conflicting debugger.
- Tab bindings are temporary (`chrome.storage.session` + in-memory manager). Chrome/Snail Pi restart and session fork do not restore them.
- Never expect raw CDP, arbitrary JS evaluation, cookies, or network bodies from v1 tools.
- Automated coverage: `npm run test:browser` regenerates extension policy/redaction from `lib/browser-*.ts`, then runs protocol/manager smoke checks plus an artifact harness that loads production `extensions/chrome-tab-debug` files under mocked Chrome/WebSocket/DOM (manifest permissions, local authorization rejections, action policy parity, console redaction, tabs.sendMessage cancel/wait, multi-session pending isolation, popup status). It does **not** replace headed Chrome validation.
- If multiple Snail Pi sessions request a tab at once, the extension popup lists each pending session — pick the intended one. A bare “global pending” is only used when exactly one request is open.
- `npm run test:runtime` protects production packaging invariants. In particular, `ws` must remain in Next's `serverExternalPackages`; bundling it replaces the optional `bufferutil` import with an empty module and crashes masked Chrome-extension frames with `TypeError: b.unmask is not a function`.
- Still headed-Chrome-only (not covered by the Node artifact harness): real `activeTab` user-gesture injection, live viewport screenshots/focus restore, MV3 service-worker kill/restart against a real browser process, DevTools debugger contention with a real `chrome.debugger` attach, cross-origin navigation suspension on a live tab, and end-to-end CDP event delivery from an actual page.

## Automation

- Scheduler unavailable: check `/api/automations/scheduler/status` after issuing a control session; corrupt `scheduler.lock` needs repair-lock with confirmation.
- Task blocked reauthorization_required: tool/extension digest or schema drifted — re-approve authority.
- Runs missing from sidebar: expected; open Automation drawer. Promote sealed runs to continue in a normal session.
- Non-loopback access denied: v1 is local-only.
