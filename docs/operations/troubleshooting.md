# Operations and Troubleshooting

## Common Checks

- Confirm the server is on port `62666` unless `--port` or `PORT` overrides it.
- Confirm bind address: default is `127.0.0.1` (not LAN). Remote access needs `--server` or a non-loopback hostname.
- Confirm `PI_CODING_AGENT_DIR` when sessions or config appear missing.
- Check `~/.pi/agent/sessions/` for raw session JSONL files.
- For PM2 deployments, inspect process logs; ensure single-instance fork mode.

## Server access authentication

- **Cannot reach from another machine after upgrade:** intentional. Default bind is loopback. Use `spi --server` (or `PI_WEB_SERVER_MODE=1` / non-loopback `-H`).
- **Access key not printed on restart:** expected. The key is shown only on first server init or `--rotate-access-key`. It is never stored in plaintext in `server-access.json`.
- **Lost access key:** run `spi --server --rotate-access-key` (or with your usual non-loopback bind). A new key is printed once; all old sessions die immediately.
- **Corrupt `server-access.json`:** server mode fails closed (boot error or `503`). Recover with `--rotate-access-key` after fixing permissions; do not hand-edit the verifier.
- **Stuck on unlock page after login:** cookie blocked? Prefer same host you typed in the browser. Behind HTTPS proxy set `PI_WEB_TRUST_PROXY=1` only with loopback backend so `Secure` cookies work. Plain HTTP cookies intentionally omit `Secure`.
- **HTTP warning on unlock page:** expected for direct HTTP. Prefer Caddy/Nginx TLS termination. The warning is suppressed when trusted proxy reports `https`.
- **429 on login:** short in-process rate limit; wait and retry. Restart clears the counter (single-instance behavior).
- **Everyone logged out after ops change:** access key was rotated, or Agent data dir was not persisted (new empty `server-access.json`).
- **Container loses key every deploy:** mount a persistent volume for `PI_CODING_AGENT_DIR`.
- **Logged-in remote still cannot use Automation / native folder picker / browser bridge:** correct — those remain loopback-only and are not authorized by the global access key.

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
- If the popup remains on `Checking…`: reload the unpacked extension and restart Snail Pi so both sides use the current protocol implementation. The popup should report `Extension unavailable` instead of waiting indefinitely when its MV3 service worker does not respond.
- If tools return `BRIDGE_DISCONNECTED`: open the extension popup and click Reconnect; the MV3 service worker may have stopped.
- If tools return `BINDING_SUSPENDED`: the tab navigated cross-origin; re-confirm binding on the new page.
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
