# UI Visual Validation Result — 2026-08-10

## Run metadata

| Field | Value |
| --- | --- |
| Date | 2026-08-10 |
| Branch | `self-run` (working tree includes uncommitted pair/loopback fixes) |
| Base commit observed | `0819dfe` (single-instance/health) + local uncommitted server-access/browser-pair fixes |
| Browser / OS | Chrome (Snail Pi Tab Debug binding) / Windows |
| App URL | `http://127.0.0.1:62666/` |
| Zoom | 100% (tooling could not drive 125%/150%) |
| Viewport observed | ≈1047×898 (compact-desktop band; tool cannot force the full fixed matrix) |

## Static commands

| Command | Result |
| --- | --- |
| `npm run test:ui-theme` | PASS |
| `npm run lint` | PASS |
| `node_modules/.bin/tsc --noEmit` | PASS |
| `npm run test:server-auth` | PASS (after pair-path policy tests) |
| `npm run test:browser` | PASS |
| automation security smoke (loopback Host/URL rewrite) | PASS |

## Blocking failures fixed in this run

### 1. Chrome extension Pair blocked in server mode (403)

**Symptom:** Pair button appeared unresponsive / returned 403.

**Root causes (stacked):**

1. Server-mode Proxy required exact same-origin + access-key cookie for `/api/browser/pair`. The unpacked extension posts to `http://127.0.0.1` with a `chrome-extension://` Origin and no WebUI cookie.
2. After Proxy exemption, `assertDirectLoopbackConnection` rejected Next-rewritten Request URL hosts such as `0.0.0.0` even when the TCP peer and `Host` were loopback (`127.0.0.1` / `localhost`).

**Fix:**

- `proxy.ts` + `lib/server-access-policy.ts`: cookie/same-origin exemption only for extension-owned `exchange` / `connect_token` / `unpair`; `issue`/`configure` stay authenticated.
- `app/api/browser/pair|unpair`: extension actions still require proven loopback peer.
- `lib/automation-local-access.ts`: prefer client `Host` over rewritten URL hostname after remote is proven loopback (also unblocks Automation session on server bind `0.0.0.0`).
- Extension popup/background: clearer pairing progress/errors.

**Verify:**

```text
POST http://127.0.0.1:62666/api/browser/pair
Origin: chrome-extension://…
action=exchange
→ 400 PAIRING_INVALID "No pending pairing code"  (no longer 403 origin/URL-host)
```

## Browser matrix progress (this run)

### Completed on observed viewport

| Check | Result | Notes |
| --- | --- | --- |
| Workspace selected + session list | PASS | Sidebar shows project + sessions |
| Theme picker open | PASS | All representative themes listed (明亮/纸白/基础深色/暮光/Dracula/…) |
| Switch to Dracula | PASS | Selection checkmark; UI updates |
| Theme Escape restores trigger focus | PASS | Focus returned to “选择界面皮肤” |
| Settings dialog open/close | PASS | Dialog readable; close works |
| Open Inspector | PASS | Sidebar + Chat + Inspector coexist at ~1047px |
| Inspector tabs Changes → Preview → Git → SnFlow → Agents | PASS | Tabs focusable; Agents empty state shown |
| Composer model listbox (keyboard Space) | PASS | Body portal listbox with providers/options |
| Composer model Escape closes listbox | PASS | Panel dismissed |
| Pair HTTP path (extension simulation) | PASS | See blocking fix above |

### Not completed in this run (remain open for Iteration 8 gate)

| Check | Status |
| --- | --- |
| Fixed viewports 1440×900 / 1024×768 / 768×1024 / 390×844 | NOT RUN (binding tools cannot resize the host window) |
| Breakpoint edges 960 / 959 / 641 / 640 | NOT RUN |
| Full representative-theme visual pass (Light/Dark/Paper/Twilight/Dracula) with screenshots | PARTIAL (Dracula interactive only) |
| 125% / 150% zoom | NOT RUN |
| `prefers-reduced-motion` | NOT RUN |
| Full keyboard-only critical path | PARTIAL |
| Todo + toast / Terminal combinations | NOT RUN |
| Screenshot archive | NOT CAPTURED (`browser_screenshot` timed out once) |

## Non-blocking follow-ups

1. Complete remaining viewport/zoom/theme screenshot matrix manually per `docs/operations/ui-visual-validation.md` (or extend tooling to resize the bound tab).
2. Settings close restored focus to `body` rather than the Settings trigger in one observation — preference polish, not a blocker.
3. Composer model control is opened via `pointerdown`/`Space`/`Enter`; plain synthetic `click` from the tab-debug bridge may not toggle it — keep keyboard path covered in future matrix notes.
4. Screenshot automation platform remains out of scope (Iteration 8 plan).

## Gate decision (updated 2026-08-11)

- **Pairing/server-mode loopback regression:** closed.
- **Desktop + compact critical path + five representative themes:** accepted.
- **Mobile tooling observation** (drawer toggle covered by backdrop under synthetic clicks): **passed by product owner** — daily mobile use reported fine; no code change.
- **Iteration 8 / frontend visual system plans:** **completed**.
- Non-blocking residuals only: 125%/150% zoom, reduced-motion specialty pass, screenshot baseline automation, occasional Settings focus restore to `body`.
