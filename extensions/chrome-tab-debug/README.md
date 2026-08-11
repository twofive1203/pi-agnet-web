# Snail Pi Tab Debug (Chrome MV3)

Temporary, user-confirmed Chrome tab binding for local Snail Pi sessions.

## Install (development)

1. Start Snail Pi Web (`npm run dev` or `spi`) on `http://127.0.0.1:62666`.
2. In a Snail Pi chat with a real session id, open the Browser panel, click **Enable + pair extension**, and copy the pairing code.
3. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and select this directory:
   `extensions/chrome-tab-debug`
4. Switch to the normal webpage you want the chat to use, open the extension popup, enter the pairing code (and web port if not 62666), then click **Pair & connect current tab**. The pairing code carries a one-time intent for the issuing chat session, so this explicit popup click both pairs the installation and binds the active tab.
5. For later tabs or an already-paired extension, use **Connect browser tab** in the target chat and then **Bind this tab** in the extension popup.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Temporary access only after the user invokes the extension on the chosen tab |
| `scripting` | Inject DOM content script after confirmation |
| `storage` | Persist installation credential (`local`) and temporary bindings (`session`) |
| `debugger` | Chrome does not permit `debugger` in `optional_permissions`; the API remains inert until popup per-binding consent and a separate WebUI enable request attach it for read-only console/network diagnostics |
| `tabs` | Observe bound-tab navigation/close for suspend/revoke |
| `http://127.0.0.1/*` | Talk only to local Snail Pi HTTP + browser bridge |

No `<all_urls>`, no always-on content scripts, no remote code, incognito not allowed. Chrome requires `debugger` to be a manifest permission rather than an optional permission; DOM binding still never attaches the debugger, and debug attachment remains gated by explicit popup consent for that binding plus a separate WebUI enable action.

## Security notes

- Installation credentials alone are not tab authorization. During first-time setup, the pairing code may carry a one-time target-session intent, but the active tab is authorized only by the explicit **Pair & connect current tab** popup click.
- Binding acceptance is only accepted over the authenticated WebSocket channel (HTTP accept is rejected).
- Every command re-checks the extension-owned `chrome.storage.session` binding (session, binding, tab, document, origin, state, capability) before acting.
- Tab bindings are temporary and use `chrome.storage.session` only; bridge/Snail Pi restart reconciles and clears stale authorizations.
- Cross-origin navigation suspends the binding until the user confirms again.
- Session fork / Snail Pi restart / Chrome restart do not restore tab bindings.
- Console/exception/network outputs are redacted before leaving Chrome; typed text is never written to audit logs.
- Click/type/select block downloads, file inputs, password/payment-like fields, permission prompts, and destructive controls.
- Semantic `fill` / `clear` / `press` / `check` / `uncheck` / `hover` actions are capability-gated, policy-checked, and bounded. Press accepts only the documented allowlisted keys/modifiers; file upload and compound submit remain excluded.
- Element refs are document-context scoped. Detached, expired-document, wrong-binding, hidden, disabled, and covered targets fail with typed bounded diagnostics before execution.
- Successful actions return an 800 ms bounded post-action state summary. Cross-origin or still-loading navigation reports `stabilization: "pending"` rather than a false no-change result.
- Network tool results never include Cookie/Authorization headers or bodies.
- Raw CDP and arbitrary JavaScript evaluation are not exposed.
- Debug mode requires per-binding extension popup consent before the WebUI enable action may use the manifest-declared `debugger` permission. Contention maps to `CAPABILITY_UNAVAILABLE`.

## Protocol compatibility

The extension and server still use protocol envelope version 1. During authenticated WebSocket setup the extension advertises additive features (`element_diagnostics_v1`, `post_action_state_v1`, `semantic_actions_v1`, `bounded_snapshot_v1`, `wait_diagnostics_v1`). A newer server checks each requested feature before dispatch; an older or capability-limited extension receives `UNSUPPORTED_EXTENSION_CAPABILITY` with upgrade guidance instead of an opaque unsupported-command response. Additive response fields are optional. Envelope or authorization breaking changes require a protocol-version increment.

Enhanced snapshots support interactive-only mode, one bounded element/region scope, and truncation metadata. Enhanced waits support clickable state, URL glob, text change, and document idle; cancellation and timeout are distinct typed results. Network-idle waits remain out of scope until debug capability semantics are defined.

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
