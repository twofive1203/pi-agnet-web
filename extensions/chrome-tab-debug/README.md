# Snail Pi Tab Debug (Chrome MV3)

Temporary, user-confirmed Chrome tab binding for local Snail Pi sessions.

## Install (development)

1. Start Snail Pi Web (`npm run dev` or `spi`) on `http://127.0.0.1:62666`.
2. In the chat Browser panel, click **Enable + pair extension** and copy the pairing code.
3. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and select this directory:
   `extensions/chrome-tab-debug`
4. Open the extension popup, enter the pairing code (and web port if not 62666), then **Pair**.
5. In a Snail Pi session with a real session id, click **Connect browser tab**.
6. Switch to the target normal webpage, open the extension popup, and click **Bind this tab**.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access only after the user invokes the extension on the chosen tab |
| `scripting` | Inject DOM content script after confirmation |
| `storage` | Persist installation credential (`local`) and temporary bindings (`session`) |
| `debugger` (optional) | Read-only console/network diagnostics only after popup consent + runtime permission |
| `tabs` | Observe bound-tab navigation/close for suspend/revoke |
| `http://127.0.0.1/*` | Talk only to local Snail Pi HTTP + browser bridge |

No `<all_urls>`, no always-on content scripts, no remote code, incognito not allowed. `debugger` is an **optional_permission** — DOM binding never attaches the debugger.

## Security notes

- Installation pairing is not tab authorization.
- Binding acceptance is only accepted over the authenticated WebSocket channel (HTTP accept is rejected).
- Every command re-checks the extension-owned `chrome.storage.session` binding (session, binding, tab, document, origin, state, capability) before acting.
- Tab bindings are temporary and use `chrome.storage.session` only; bridge/Snail Pi restart reconciles and clears stale authorizations.
- Cross-origin navigation suspends the binding until the user confirms again.
- Session fork / Snail Pi restart / Chrome restart do not restore tab bindings.
- Console/exception/network outputs are redacted before leaving Chrome; typed text is never written to audit logs.
- Click/type/select block downloads, file inputs, password/payment-like fields, permission prompts, and destructive controls.
- Network tool results never include Cookie/Authorization headers or bodies.
- Raw CDP and arbitrary JavaScript evaluation are not exposed.
- Debug mode requires extension popup consent and optional `debugger` permission; contention maps to `CAPABILITY_UNAVAILABLE`.

## Bridge ports

- Web UI / REST: default `62666`
- Browser WebSocket bridge: default `62667` on `127.0.0.1` only

## Automated checks

`npm run test:browser` includes `scripts/smoke-chrome-extension-artifacts.ts`, which parses this package's `manifest.json`, syntax-checks extension scripts, and executes production `background.js` / `content.js` / `action-policy.js` paths under mocked Chrome APIs. Headed Chrome E2E (real activeTab, service-worker restart, DevTools contention, live CDP) remains manual — see `docs/operations/troubleshooting.md`.
