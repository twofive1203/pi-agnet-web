# feat: Optimize Lightweight Browser Control

Created: 2026-03-10
Status: Part 1 complete; Parts 2-3 pending

## Problem Frame

The current browser control surface is intentionally small: it can list bound tabs, inspect bounded page state, find elements, perform one controlled DOM action, wait for common conditions, capture screenshots, and read redacted console/network summaries. Its primary product advantage is low token and context consumption.

The optimization goal is not to expose the full Playwright/CDP surface. The goal is to improve reliability and diagnosis while preserving bounded output, simple tool contracts, explicit actions, per-tab user authorization, and sensitive-operation protection.

## Current Baseline

- Browser tools are registered in `lib/browser-tools.ts` and routed through `lib/browser-binding-manager.ts`.
- DOM snapshot, find, action, and wait behavior executes in `extensions/chrome-tab-debug/content.js`.
- Extension command routing, screenshots, and debug console/network reads execute in `extensions/chrome-tab-debug/background.js`.
- Element references are already document-scoped and become stale when their element disconnects or the content-script document is replaced.
- A session can already own multiple explicitly bound tabs and select one primary binding through `browser_tabs`.
- Every tab remains independently user-authorized. A popup or newly opened tab must not inherit DOM authorization automatically.
- Protocol compatibility is currently based on one strict `BROWSER_PROTOCOL_VERSION`; new commands require an explicit compatibility strategy.

## Scope

### In scope

- More reliable element references and actionable failure messages.
- Real interactability checks for hidden, disabled, covered, detached, and wrong-context elements.
- Compact post-action state summaries with defined stabilization behavior.
- A small set of high-frequency semantic interactions.
- Better lifecycle handling for already bound tabs without expanding their default output.
- More useful bounded snapshots and wait conditions.
- Frame contexts only after the protocol and action lifecycle are stable and a focused workflow justifies them.
- Focused compatibility, security, response-size, telemetry, and documentation coverage.

### Out of scope for this cycle

- Full CDP or Playwright API exposure.
- Arbitrary JavaScript execution from the agent.
- Default access to cookies, credentials, authorization headers, or response bodies.
- Autonomous multi-step browsing plans.
- General-purpose browser test runner features.
- File upload, local-path transfer, or arbitrary binary transfer through the browser bridge.
- Automatic DOM access to popups or newly opened tabs without separate user binding.
- General cross-browser support; the current bridge target remains the Chrome MV3 extension.

## Success Criteria

- On the repository's fixed browser fixtures, representative click, fill, and wait workflows require fewer follow-up snapshots or retries than the U1 baseline.
- Default non-screenshot tool responses have explicit serialized-size budgets and remain materially smaller than full DOM dumps.
- Expired or invalid element references distinguish stale, hidden, disabled, covered, and wrong-context failures and identify the next recovery action.
- Actions report bounded final state containing URL, title, document/loading status, and a defined change indicator, or explicitly report that stabilization is still pending.
- New WebUI behavior degrades clearly when connected to an older extension that lacks a requested capability.
- Existing per-tab authorization, sensitive-action policy, audit behavior, and redaction remain unchanged or become stricter.
- `npm run test:browser`, lint, and TypeScript validation pass.

## Design Decisions

1. **Summary-first output:** normal calls return compact summaries; detailed DOM, console, or network data remains opt-in.
2. **Short-lived references:** references may expire after document replacement or DOM disconnection. Errors identify the reason and instruct the caller to re-run `browser_find` when that is the correct recovery.
3. **One semantic action per call:** keep actions predictable. Do not add compound submit actions in this cycle.
4. **Bound every response:** every new list, state, error, or snapshot field has a fixed default limit and truncation marker where applicable.
5. **Policy before execution:** all new actions and synthetic events go through the browser action policy before DOM execution and produce bounded audit metadata.
6. **No implicit tab authority:** bound-tab selection is explicit; frame selection is scoped to an authorized tab; popups and new tabs require separate user binding.
7. **Capability-gated evolution:** protocol or action additions must be advertised by the extension and checked by the server before dispatch. Unsupported capabilities return a typed recovery error instead of an opaque unsupported-command failure.
8. **Extension behavior is part of the contract:** changes to browser tools are incomplete until the Chrome extension implementation and artifact smoke suite agree with the server protocol.

## Implementation Units

- [x] U1. **Characterize Contracts and Define Compatibility**
  - **Goal:** Record current request/response shapes, limits, redaction rules, extension command mappings, protocol behavior, and retry counts before changing them.
  - **Files:** `lib/browser-tools.ts`, `lib/browser-protocol.ts`, `lib/browser-binding-manager.ts`, `lib/browser-action-policy.ts`, `lib/browser-redaction.ts`, `lib/browser-audit.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `extensions/chrome-tab-debug/shared.js`, `scripts/generate-browser-extension-shared.ts`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`, `docs/modules/library.md`
  - **Approach:** Inventory every model-facing operation and its extension bridge message. Add characterization assertions where behavior is not covered. Define extension-advertised capabilities and the protocol-version policy before adding commands or fields.
  - **Compatibility contract:** A new server must detect unsupported extension capabilities before dispatch. Additive response fields remain optional. A breaking envelope or authorization change requires a protocol-version increment and a clear upgrade error.
  - **Baseline measurements:** Record serialized response sizes and the number of tool round trips for fixed click, type/fill, navigation, stale-reference, and wait-timeout fixtures.
  - **Test scenarios:** Existing list/snapshot/find/action/wait/screenshot/console/network operations preserve their response contract; old or capability-limited extensions fail with a typed recovery message; sensitive fields remain redacted; unsupported or blocked actions remain rejected.
  - **Verification:** A contract table and baseline measurements exist in module documentation, and `npm run test:browser` passes before behavioral changes.

- [x] U2. **Harden Element References and Action Diagnostics**
  - **Goal:** Make element lookup and action failures recoverable without returning a large snapshot or executing against a non-interactable target.
  - **Dependencies:** U1
  - **Files:** `lib/browser-tools.ts`, `lib/browser-protocol.ts`, `lib/browser-binding-manager.ts`, `lib/browser-audit.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Approach:** Extend the existing document-scoped reference model with bounded generation/context metadata. Before execution, validate that the reference belongs to the selected binding/context and check attachment, visibility, enabled state, viewport geometry, and hit testing for covered controls. Standardize compact errors for stale, hidden, disabled, covered, and wrong-context cases.
  - **Diagnostics:** Include redacted current URL, bounded title, error reason, and one recovery suggestion. Do not include a DOM dump. Re-running `browser_find` is recommended only for stale or wrong-generation references; hidden/disabled/covered failures explain the relevant state.
  - **Test scenarios:** A valid ref executes; a disconnected or post-navigation ref is stale; refs from another binding/context are rejected; hidden, disabled, and covered controls never execute; unknown refs never execute; all diagnostics obey response limits.
  - **Verification:** No action bypasses policy or interactability checks, and each failure has a deterministic typed code and recovery path.

- [x] U3. **Add Compact Post-Action State**
  - **Goal:** Reduce follow-up snapshots after successful actions without claiming a page is stable when it is not.
  - **Dependencies:** U2
  - **Files:** `lib/browser-tools.ts`, `lib/browser-protocol.ts`, `lib/browser-binding-manager.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Approach:** Capture a bounded pre-action baseline, execute the action, then stabilize for a short fixed window. The extension background owns navigation-aware final-state collection so a replaced content script cannot return stale document state.
  - **State contract:** Return URL, title, document identifier or generation, loading/ready state, a safe focused-element summary, and change indicators such as `urlChanged`, `documentChanged`, and `focusChanged`. Return `stabilization: "pending"` when the final state cannot be confirmed within the bounded window; do not collapse that case into `changed: false`.
  - **Privacy:** Typing/fill responses never echo the input value. Focus summaries omit sensitive values and use bounded role/name metadata only.
  - **Test scenarios:** Click navigation reports the new URL/document; an SPA update reports a same-document change when observable; typing reports completion without its value; a verified no-op reports no change; tab closure and interrupted navigation are explicit; every field stays within its fixed size limit.
  - **Verification:** Fixed click/type/wait fixtures require fewer follow-up snapshots than the U1 baseline.

- [ ] U4. **Add High-Value Semantic Actions**
  - **Goal:** Cover common workflows with small, predictable operations while preserving policy checks.
  - **Dependencies:** U2, U3
  - **Files:** `lib/browser-tools.ts`, `lib/browser-protocol.ts`, `lib/browser-action-policy.ts`, `lib/browser-redaction.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `scripts/generate-browser-extension-shared.ts`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Approach:** Add `fill`, `clear`, `press`, `check`, `uncheck`, and `hover` only when advertised by the extension. Prefer explicit action names over generic event parameters. Keep file upload and compound submit actions out of scope.
  - **Policy:** Enter, Space, checkbox/radio changes, and hover-triggered controls pass through action-specific policy because they may submit forms, grant consent, download content, or trigger destructive actions. Modifier keys use a small allowlist; arbitrary key sequences are rejected.
  - **Test scenarios:** Fill replaces existing text and emits expected input/change behavior; clear is idempotent; check/uncheck validate target type and are idempotent; press supports an allowlisted Enter and common modifiers without bypassing policy; hover exposes a menu; unsupported capabilities fail before dispatch; sensitive values never appear in output or audit logs.
  - **Verification:** Each action has a typed tool schema, capability check, protocol path, policy decision, audit entry, extension implementation, and artifact smoke coverage.

- [ ] U5. **Harden Already-Bound Tab Context Lifecycle**
  - **Goal:** Improve selection and diagnostics for tabs already authorized to the current session without widening tab authority.
  - **Dependencies:** U2, U3
  - **Files:** `lib/browser-binding-manager.ts`, `lib/browser-binding-state.ts`, `lib/browser-protocol.ts`, `lib/browser-tools.ts`, `app/api/browser/bindings/route.ts`, `hooks/useBrowserBridgeStatus.ts`, `components/BrowserBindingPanel.tsx`, `components/BrowserBindingTrigger.tsx`, `extensions/chrome-tab-debug/background.js`, `extensions/chrome-tab-debug/popup.js`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Approach:** Preserve the existing binding-per-tab and primary-binding model. Improve bounded tab listings, primary selection, closed/suspended diagnostics, and observable lifecycle changes. Do not introduce a second tab-context abstraction over `bindingId`.
  - **Popup/new-tab rule:** The extension may report that a bound page opened an unbound tab only if that can be done without exposing unauthorized page content. The new tab receives no DOM capability until the user separately binds it. Automatic popup inheritance is prohibited.
  - **Test scenarios:** Multiple existing bindings remain selectable; primary changes are explicit; closed and suspended tabs return typed recovery errors; a newly opened tab cannot be acted on before user binding; default output contains only model-safe binding projections.
  - **Verification:** Existing single-tab behavior remains compatible, and no context operation exposes raw Chrome tab ids or bypasses per-tab authorization.

- [ ] U6. **Improve Bounded Snapshots and Wait Diagnostics**
  - **Goal:** Make snapshots and waits more useful per token while retaining strict limits.
  - **Dependencies:** U3
  - **Files:** `lib/browser-tools.ts`, `lib/browser-protocol.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Approach:** Add an interactive-only snapshot mode, element/region scoping, explicit truncation metadata, and wait conditions for clickable state, URL pattern, text change, and document idle. Add network idle only when debug capability is active and its semantics are precisely defined.
  - **Validation:** Invalid conditions and selectors fail tool-schema or server validation before browser dispatch where possible. Timeout responses include the requested condition, elapsed time, compact current state, and a bounded recovery suggestion.
  - **Test scenarios:** Interactive-only snapshots omit non-actionable nodes; node/depth/text limits are enforced; scoped snapshots reject stale or wrong-context refs; successful waits resolve once; timeout and cancellation remain distinct; network-idle requests without debug capability are rejected clearly.
  - **Verification:** Snapshot byte budgets are asserted, and every timeout points to a concrete bounded recovery action.

- [ ] U7. **Add Explicit Frame Contexts When Justified**
  - **Goal:** Support a focused iframe workflow without conflating frames with bound tabs or weakening origin authorization.
  - **Dependencies:** U2, U3, U5, U6
  - **Files:** `lib/browser-protocol.ts`, `lib/browser-tools.ts`, `lib/browser-binding-manager.ts`, `extensions/chrome-tab-debug/content.js`, `extensions/chrome-tab-debug/background.js`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`
  - **Entry gate:** Start only after a concrete same-origin or cross-origin frame workflow and its Chrome MV3 permission behavior are documented. If no qualifying workflow exists, defer U7 without blocking U8 or the rest of the release.
  - **Approach:** Add bounded frame listings and opaque frame context ids scoped to one authorized binding. Require explicit frame selection for frame-local find/snapshot/action calls. Context ids carry binding/document generation and expire deterministically.
  - **Security:** Same-origin and cross-origin behavior are tested separately. A frame context never grants access beyond what the authorized extension content script and Chrome permissions already allow.
  - **Test scenarios:** Top-frame behavior is unchanged; same-origin frame selection is explicit; stale frame contexts are rejected; unsupported cross-origin access fails clearly; refs cannot cross frame contexts; frame listings remain bounded.
  - **Verification:** Frame support is capability-gated, binding-scoped, auditable, and does not change default single-tab/top-frame output.

- [ ] U8. **Add Focused Observability and Security Regression Coverage**
  - **Goal:** Preserve the lightweight and safe product identity as capabilities grow.
  - **Dependencies:** U4, U5, U6; U7 only if frame support ships
  - **Files:** `lib/browser-redaction.ts`, `lib/browser-action-policy.ts`, `lib/browser-audit.ts`, `extensions/chrome-tab-debug/action-policy.js`, `extensions/chrome-tab-debug/action-policy.inject.js`, `extensions/chrome-tab-debug/redaction.js`, `scripts/generate-browser-extension-shared.ts`, `scripts/smoke-browser-binding.ts`, `scripts/smoke-chrome-extension-artifacts.ts`, `docs/modules/api.md`, `docs/modules/library.md`, `extensions/chrome-tab-debug/README.md`, `docs/operations/troubleshooting.md`
  - **Approach:** Add response-size assertions, fixed workflow round-trip measurements, redaction fixtures, capability/version compatibility cases, policy matrix coverage, and audit event checks. Regenerate extension policy/redaction artifacts from their TypeScript sources.
  - **Test scenarios:** Cookie/token/password-like values are redacted from every new output; blocked destructive, submission-like, permission, download, and sensitive actions remain blocked; every mutating action emits an audit event; oversized text and node collections are truncated; old/capability-limited extensions degrade clearly; optional U7 frame contexts cannot cross binding boundaries.
  - **Verification:** Documentation, generated extension artifacts, policy tests, audit tests, and both browser smoke suites agree on the same action and output surface.

## Development Parts

### Part 1: Protocol and Reliability Foundation

**Units:** U1, U2, U3

This part establishes the contracts that every later capability depends on:

1. U1 records the current contract, response-size/round-trip baseline, and extension capability/version strategy.
2. U2 hardens element references, interactability checks, and typed recovery diagnostics.
3. U3 adds navigation-aware compact post-action state on top of the U2 reference model.

**Delivery boundary:** Existing browser actions keep their current functional surface but become more diagnosable and require fewer follow-up snapshots. No new semantic actions or frame contexts ship in this part.

**Part gate:** `npm run lint`, `node_modules/.bin/tsc --noEmit`, and `npm run test:browser` pass; old/capability-limited extension behavior is covered; U1 baseline comparisons show U3 does not increase default response budgets unexpectedly.

**Part 1 delivery note (2026-03-10):** U1-U3 are implemented. Protocol v1 remains additive and advertises `element_diagnostics_v1` plus `post_action_state_v1`; legacy extensions receive a typed pre-dispatch upgrade error for `browser_act`. Element refs carry a bounded document context, interaction checks reject detached/hidden/disabled/covered targets, and action responses include an 800 ms bounded navigation-aware `postAction` state. Fixed-fixture sizes and round-trip comparisons are recorded in `docs/modules/library.md`.

### Part 2: Common Workflow Efficiency

**Units:** U4, U5, U6

This part adds the capabilities used by ordinary browser workflows:

1. U4 and U6 may be developed in parallel after Part 1 because both consume the stabilized action/reference contracts.
2. U4 adds semantic actions: `fill`, `clear`, `press`, `check`, `uncheck`, and `hover`.
3. U6 improves interactive/scoped snapshots and wait diagnostics.
4. U5 then closes the already-bound tab lifecycle and UI behavior against the same capability and compact-state contracts. U5 may start earlier when it does not overlap U4/U6 protocol edits, but it finishes after their shared protocol shape is stable.

**Delivery boundary:** Common top-frame workflows across one or more explicitly bound tabs are feature-complete. File upload, implicit popup authority, and iframe contexts remain excluded.

**Part gate:** Every new action has policy, audit, extension artifact, and smoke coverage; snapshot/response byte budgets pass; fixed workflows improve on the U1 round-trip baseline; existing single-tab behavior remains compatible.

### Part 3: Advanced Contexts and Release Hardening

**Units:** U7 when its entry gate passes, then U8

1. Evaluate U7 using a documented concrete frame workflow and Chrome MV3 permission findings.
2. If the entry gate passes, implement explicit binding-scoped frame contexts. If it does not, record the deferral and continue without frame support.
3. Complete U8 across all capabilities shipped in Parts 1 and 2, plus U7 only when included.

**Delivery boundary:** The release receives final compatibility, redaction, policy, audit, response-size, generated-artifact, documentation, and troubleshooting coverage. U7 remains optional and must not delay the release unless frame support is explicitly promoted to required scope.

**Part gate:** Full browser validation passes, documentation matches the shipped surface, and release criteria are met with no unresolved security or protocol-compatibility blocker.

## Sequencing

The default development and review order is:

1. **Part 1:** U1 -> U2 -> U3.
2. **Part 2:** U4 and U6 in parallel where ownership permits -> U5 integration and lifecycle closure.
3. **Part 3:** U7 entry-gate decision -> optional U7 -> U8 release hardening.

Use one branch or pull request per part unless a part becomes too large. Within Part 2, U4 and U6 may use separate pull requests because they share Part 1 as a prerequisite but do not depend on each other. Do not postpone unit-specific tests until U8; each unit lands with its own protocol, policy, extension, and smoke coverage, while U8 adds cross-unit regression coverage.

Run the repository's standard validation at every part boundary:

- `npm run lint`
- `node_modules/.bin/tsc --noEmit`
- `npm run test:browser`

Run other domain suites only if their code is actually touched. Browser work does not require `npm run test:mcp` by default.

## Risks

- More action types can increase tool-description and response token cost. Keep names and parameters concise and enforce serialized-size budgets.
- Post-action stabilization can add latency or report old-document state during navigation. Keep the window bounded and represent uncertainty explicitly.
- Context ids can become another source of stale references. Scope them to binding/document generation and return typed recovery messages.
- Synthetic key and checkbox actions can submit forms or grant consent. Apply action-specific policy before dispatching events.
- Popup discovery can leak unauthorized titles or URLs. Preserve per-tab user binding and return no unbound page content by default.
- Frame behavior varies by origin and Chrome injection permissions. Ship only a tested, capability-gated workflow.
- Capability negotiation increases protocol complexity. Keep one canonical capability registry and test new-server/old-extension behavior.

## Release Criteria

The release is ready when existing browser workflows remain compatible, fixed manual and automated fixtures show fewer retry/snapshot round trips than the U1 baseline, default response byte budgets pass, unsupported extension capabilities degrade clearly, security regression cases pass, and documentation accurately states what the lightweight browser surface does and does not support. U7 frame support is optional and does not block release unless explicitly promoted into the required scope after its entry-gate review.
