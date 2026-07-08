# Implementation Plan: Yolk native development workflow

## Preconditions

- User has approved moving from planning to implementation.
- Before editing code, load relevant Trellis specs with `trellis-before-dev` because this repository currently uses Trellis workflow conventions for coding tasks.
- Keep existing Trellis behavior intact during v1.
- Do not run `next build` directly.

## Phase 1: Shared contracts and manager

1. Add `lib/yolk-types.ts`.
   - Define workflow setup status/response types.
   - Define manifest, managed file, task summary/detail, task document, and task creation payload types.
   - Keep route wire types explicit and reusable by UI.

2. Add `lib/yolk-workflow-templates.ts`.
   - Centralize v1 template version and allowlisted managed file paths.
   - Include templates for `.yolk/workflow.json`, `.pi/extensions/yolk-workflow/index.ts`, prompts, and agents.
   - Keep generated text ASCII unless a template requires user-facing Chinese later.

3. Add `lib/yolk-workflow-manager.ts`.
   - Validate/canonicalize cwd.
   - Inspect `.yolk/manifest.json`.
   - Compute SHA-256 for template content and current file content.
   - Detect `missing`, `ready`, `disabled`, `outdated`, `conflict`, and `blocked`.
   - Implement `enableYolkWorkflow`, `disableYolkWorkflow`, and `updateYolkWorkflow`.
   - Create directories and missing files only within the allowlist.
   - Stop on conflicts without overwriting user-authored or modified files.

4. Add focused unit-like self-check helpers where practical.
   - There is no test framework, but keep pure functions small enough for type-check and manual route validation.

## Phase 2: Backend APIs

1. Add setup routes:
   - `app/api/yolk/workflow/status/route.ts`
   - `app/api/yolk/workflow/enable/route.ts`
   - `app/api/yolk/workflow/disable/route.ts`
   - `app/api/yolk/workflow/update/route.ts`

2. Apply existing route safety pattern.
   - Use `getAllowedRoots()` and `isPathAllowed()`.
   - Check original cwd and canonical cwd.
   - Return clear 400/403/500 errors.

3. Add task reader/writer:
   - `lib/yolk-reader.ts`
   - `lib/yolk-chat-context.ts`

4. Add task APIs:
   - `GET /api/yolk/tasks?cwd=...`
   - `POST /api/yolk/tasks`
   - `GET /api/yolk/tasks/[taskKey]?cwd=...`

5. Task API details.
   - `GET` list returns disabled/missing state cleanly.
   - `POST` creates `.yolk/tasks/<generated-id>/task.json` and `prd.md`.
   - Task id must be path-safe and collision-resistant.
   - Read markdown artifacts with byte limits, following `trellis-reader` patterns.

## Phase 3: Settings UI

1. Extend `components/SettingsConfig.tsx`.
   - Add `yolkWorkflow` section id.
   - Add `Yolk Workflow` section button.
   - Add status load effect for selected cwd.
   - Add enable/disable/update actions.
   - Show status, conflicts, managed files, and resource paths.
   - Show enable/update note: new sessions pick up resources; existing sessions may need refresh/new session.

2. Keep Trellis Settings untouched except for layout coexistence if needed.

3. Avoid storing yolk enablement in `pi-web.json`.
   - The project-local `.yolk/manifest.json` is the source of truth.

## Phase 4: Workflow panel

1. Add `components/YolkWorkflowPanel.tsx`.
   - List tasks from `/api/yolk/tasks`.
   - Show empty states for missing/disabled/no tasks.
   - Add refresh.
   - Add minimal New task UI.
   - Show task details and markdown artifacts.
   - Add continue/join chat action.

2. Extend `components/AppShell.tsx`.
   - Add right panel mode `yolkWorkflow` without replacing `trellis`.
   - Add a separate toggle/entry for Yolk Workflow when enabled/available for active cwd.
   - Pass `onJoinYolkTaskChat` into the panel.
   - Preserve existing file and Trellis panel behavior.

3. Consider a lightweight status fetch in `AppShell`.
   - Only show the Yolk Workflow toggle when selected workspace is enabled/ready.
   - If status fetch fails, hide or show a disabled entry rather than breaking layout.

## Phase 5: Chat context chip

1. Extend `components/ChatInput.tsx`.
   - Add `YolkTaskChatContext` support.
   - Render a `data-chip="yolk-task"` block.
   - Serialize through `buildYolkTaskResumePrompt()`.
   - Add imperative ref method `addYolkTaskContext` mirroring Trellis behavior.

2. Add `lib/yolk-chat-context.ts` if not already added.
   - Convert task detail to context payload.
   - Produce compact continuation prompt.
   - Keep Trellis prompt serialization unchanged.

3. Update `AppShell` pending-context flow.
   - Add state for pending yolk task context.
   - If needed, open/start a chat for the relevant cwd before insertion.

## Phase 6: Project-local Pi resources

1. Finalize `yolk-workflow` extension template.
   - No Trellis env vars or `.trellis` references.
   - Read `.yolk/manifest.json`, `.yolk/workflow.json`, and task context opportunistically.
   - Inject concise context only when enabled.
   - Degrade on missing/malformed files.

2. Finalize prompts.
   - `yolk-continue.md`
   - `yolk-finish-work.md`

3. Finalize agents.
   - `yolk-implement.md`
   - `yolk-check.md`
   - `yolk-research.md`

4. Verify resource discovery.
   - Use `/api/pi/resources?cwd=...` and `/api/commands?cwd=...` manually after enabling.

## Phase 7: Documentation

Update project docs after code changes:

- `docs/modules/api.md`: add `/api/yolk/*` routes.
- `docs/modules/frontend.md`: add Settings `Yolk Workflow`, `YolkWorkflowPanel`, and ChatInput yolk chip behavior.
- `docs/modules/library.md`: add new `lib/yolk-*` modules.
- `docs/architecture/overview.md`: add workflow invariants if runtime context behavior or session association is formalized.

## Validation

Run:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Manual validation matrix:

1. Workspace without `.yolk`:
   - Settings status is `missing`.
   - Enable writes only allowlisted paths.
   - Status becomes `ready`.

2. Existing unmanaged file conflict:
   - Pre-create one target path.
   - Enable reports conflict and does not overwrite.

3. Managed modified file conflict:
   - Enable once.
   - Modify a managed file.
   - Update reports conflict.

4. Disable:
   - Disable sets manifest enabled false.
   - Files remain on disk.
   - Workflow panel/context injection stops or shows disabled state.

5. Task loop:
   - Create New task.
   - Task list updates.
   - Detail reads `task.json` and `prd.md`.
   - Continue action inserts a yolk context chip into ChatInput.
   - Sending serializes the expected prompt text.

6. Runtime resources:
   - Newly discovered commands/resources include yolk extension/prompts/agents.
   - Existing sessions show guidance that refresh/new session may be needed.

## Risk points

- `SettingsConfig.tsx`, `AppShell.tsx`, and `ChatInput.tsx` are already large. Keep edits scoped and avoid broad refactors.
- File provisioning must be path-safe and conservative. Do not rely on ad hoc string checks alone.
- Project-local extensions are executable code. Keep v1 extension minimal and read-only.
- Do not accidentally couple new yolk modules to Trellis names, env vars, or `.trellis` paths.
- Do not overwrite unrelated user changes or existing project-local resources.

## Suggested implementation order

1. Backend types/templates/manager.
2. Setup APIs and manual API status/enable checks.
3. Yolk task reader/create APIs.
4. Settings section.
5. Workflow panel.
6. ChatInput context chip.
7. Runtime templates polish and discovery checks.
8. Docs and final validation.
