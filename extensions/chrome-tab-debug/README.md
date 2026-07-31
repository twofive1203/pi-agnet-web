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
- Element refs are document-context scoped. Detached, expired-document, wrong-binding, hidden, disabled, and covered targets fail with typed bounded diagnostics before execution.
- Successful actions return an 800 ms bounded post-action state summary. Cross-origin or still-loading navigation reports `stabilization: "pending"` rather than a false no-change result.
- Network tool results never include Cookie/Authorization headers or bodies.
- Raw CDP and arbitrary JavaScript evaluation are not exposed.
- Debug mode requires extension popup consent and optional `debugger` permission; contention maps to `CAPABILITY_UNAVAILABLE`.

## Protocol compatibility

The extension and server still use protocol envelope version 1. During authenticated WebSocket setup the extension advertises additive features (`element_diagnostics_v1`, `post_action_state_v1`). A newer server checks these before dispatching `page.act`; an older or capability-limited extension receives `UNSUPPORTED_EXTENSION_CAPABILITY` with upgrade guidance instead of an opaque unsupported-command response. Additive response fields are optional. Envelope or authorization breaking changes require a protocol-version increment.

## Bridge ports

- Web UI / REST: default `62666`
- Browser WebSocket bridge: default `62667` on `127.0.0.1` only

## Shared policy / redaction sources

Do **not** hand-edit these generated files:

- `action-policy.js` / `action-policy.inject.js` ← `lib/browser-action-policy.ts`
- `redaction.js` ← `lib/browser-redaction.ts`

Regenerate after changing the TypeScript sources:

```bash
npm run generate:browser-extension
```

`background.js` injects `action-policy.inject.js` before `content.js` so DOM actions use the same policy as the server. Wait cancels are delivered with `tabs.sendMessage` (MV3 content scripts do not receive `runtime.sendMessage` broadcasts). Multi-session pending bind requests are listed separately in the popup so the user picks the target session.

## Automated checks

`npm run test:browser` regenerates shared sources, then runs `scripts/smoke-browser-binding.ts` and `scripts/smoke-chrome-extension-artifacts.ts` (manifest, generated markers, production background/content/policy paths under mocked Chrome APIs). Headed Chrome E2E (real activeTab, service-worker restart, DevTools contention, live CDP) remains manual — see `docs/operations/troubleshooting.md`.
