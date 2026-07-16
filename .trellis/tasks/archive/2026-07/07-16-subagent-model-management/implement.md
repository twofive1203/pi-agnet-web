# Implementation Plan

## 1. Native Settings Types and I/O

- [ ] Add `lib/pi-subagent-settings.ts` with browser-safe managed projections, strict parsing, scope path resolution, revision hashing, patch validation, managed-field merge/delete cleanup, and atomic write.
- [ ] Preserve every unrelated root setting, unmanaged `subagents` field, and unmanaged per-Agent override field.
- [ ] Refuse malformed/non-object settings and revision conflicts rather than overwriting them.
- [ ] Validate exact qualified model ids against a model set supplied by the API layer.

Checkpoint: inspect helper behavior with temporary user/project fixture files or a focused Node script without touching the real user settings file.

## 2. Agent Discovery

- [ ] Add `lib/pi-subagent-discovery.ts` that creates/disposes an in-memory Pi SDK session, invokes the registered `subagent` management `list` action, and projects executable Agent names/sources/descriptions.
- [ ] Return explicit extension-missing/parse diagnostics.
- [ ] Merge settings-only override names into the API projection so stale/hidden configured entries can still be managed.

Checkpoint: compare the helper's discovered names/sources with a direct `subagent({ action: "list" })` result for the repository.

## 3. API

- [ ] Add `app/api/subagents/config/route.ts` GET/PUT handlers.
- [ ] Require and authorize `cwd` for project scope; protect against `.pi`/settings symlink escape.
- [ ] Use Pi's available model registry to validate every changed default/primary/fallback model.
- [ ] Return selected config, inherited user config for project scope, target metadata, discovery data, and clear errors/status codes.
- [ ] Keep the route independent of Trellis enablement and `pi-web.json`.

Checkpoint: manually exercise GET for user/project scope and PUT against a temporary authorized workspace/config, including malformed JSON, unknown model, unrelated-field preservation, and revision conflict cases.

## 4. Frontend

- [ ] Add `components/AgentsConfig.tsx` with component-local load/save/dirty/error state.
- [ ] Add user/project scope selection, exact target path, precedence/help text, model registry loading, default model control, discovered Agent source badges, per-Agent model/thinking controls, and ordered fallback editing.
- [ ] Compute a minimal patch from saved vs. draft state; use `null` only for explicit field deletion.
- [ ] Preserve unavailable existing values until the user clears/replaces them, and prevent submitting newly invalid values.
- [ ] Handle no workspace, missing extension, no models, malformed settings, stale revision, and save success states.
- [ ] Add the independent `agents` tab to `SettingsConfig.tsx` before Trellis.
- [ ] Relabel existing Trellis subagent copy as Trellis-specific without changing its stored config or behavior.

Checkpoint: browser verification for both scopes, field clear/inheritance behavior, fallback ordering, Trellis independence, and responsive modal layout.

## 5. Default Port

- [ ] Change `npm run dev` and `npm run start` defaults to `62666`.
- [ ] Change the `spi` fallback port to `62666` while preserving `--port`, `-p`, and `PORT` precedence.
- [ ] Update all maintained tracked references to the old default port; do not touch task archives or `.pi-subagents` artifacts.

Checkpoint:

```bash
node -e "const p=require('./package.json'); console.log(p.scripts.dev, p.scripts.start)"
node bin/pi-web.js --port 0  # only if build artifacts/runtime make this safe; otherwise inspect argument precedence
```

## 6. Documentation

- [ ] Update `docs/modules/api.md`, `docs/modules/frontend.md`, and `docs/modules/library.md` for new code surfaces.
- [ ] Update `docs/integrations/README.md` and `docs/architecture/overview.md` for native-vs-Trellis settings boundaries and Pi settings precedence.
- [ ] Update `README.md`, `README.zh-CN.md`, `AGENTS.md`, `docs/deployment/README.md`, and `docs/operations/troubleshooting.md` for port `62666` and relevant configuration behavior.

## 7. Validation and Review

- [ ] Search all current non-archived consumers/references for `30141`, `subagents`, the new route, and the new settings types.
- [ ] Run:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

- [ ] Perform full-scope review against `prd.md`, `design.md`, project docs, `.trellis/spec/frontend/index.md`, and `.trellis/spec/frontend/quality-guidelines.md`.
- [ ] Confirm no unrelated user changes, historical task artifacts, bundled Agent files, or `.pi-subagents` outputs were modified.

## Risky Files and Rollback Points

- `lib/pi-subagent-settings.ts`: settings preservation and malformed-file safety are release blockers; rollback if fixture/manual checks cannot prove preservation.
- `app/api/subagents/config/route.ts`: project write authorization is a release blocker; rollback project scope rather than weakening allowed-root checks.
- `components/SettingsConfig.tsx`: keep native settings state isolated from the existing global `pi-web.json` Save button.
- Port changes are independently revertible if runtime override behavior regresses.
