# Operations and Troubleshooting

## Common Checks

- Confirm the server is on port `62666` unless `--port` or `PORT` overrides it.
- Confirm `PI_CODING_AGENT_DIR` when sessions or config appear missing.
- Check `~/.pi/agent/sessions/` for raw session JSONL files.
- For PM2 deployments, inspect `logs/pi-web-out.log` and `logs/pi-web-error.log`.

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
