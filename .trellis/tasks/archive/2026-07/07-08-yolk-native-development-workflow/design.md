# Design: Yolk native development workflow

## Summary

Add a yolk pi web native workflow that is independent from Trellis runtime conventions. The first version keeps Trellis intact and adds a separate `Yolk Workflow` Settings section plus an independent Workflow panel. Enabling the workflow provisions a small, project-local resource set under `.yolk/` and yolk-prefixed `.pi/` paths, with managed hash tracking and conservative conflict handling.

## Boundaries

### In scope

- Workspace-aware workflow setup/status/enable/disable/update APIs.
- Project-local managed files under `.yolk/` and yolk-prefixed `.pi/` resources only.
- Dedicated Settings `Yolk Workflow` section.
- Independent main UI Workflow panel for yolk tasks.
- Minimal task creation from the Workflow panel.
- Structured yolk task context chip insertion into `ChatInput`.
- Project-local Pi runtime resources for new sessions: `yolk-workflow` extension, `yolk-*` prompts, and `yolk-*` agents.
- Resource discovery verification through existing `/api/pi/resources` and `/api/commands` behavior.

### Out of scope for v1

- Removing Trellis code paths.
- Calling `trellis init`, `trellis update`, or any Trellis CLI command.
- Automatic `.trellis/tasks` migration.
- Project-local `.pi/skills/yolk-*`.
- Complex dependency graph, JSONL manifest curation, or automatic session reload for already-open sessions.

## Project file layout

Provision only this minimum set:

```text
.yolk/
  manifest.json
  workflow.json
  tasks/

.pi/extensions/yolk-workflow/
  index.ts

.pi/prompts/
  yolk-continue.md
  yolk-finish-work.md

.pi/agents/
  yolk-implement.md
  yolk-check.md
  yolk-research.md
```

The backend must reject any template/provision target that resolves outside the selected workspace or outside this allowlist.

## Data contracts

### `.yolk/manifest.json`

The manifest is the source of workspace enablement and managed-file metadata. Suggested shape:

```json
{
  "schemaVersion": 1,
  "workflowVersion": "0.1.0",
  "enabled": true,
  "createdAt": "2026-07-08T00:00:00.000Z",
  "updatedAt": "2026-07-08T00:00:00.000Z",
  "managedFiles": {
    ".yolk/workflow.json": {
      "templateVersion": "0.1.0",
      "sha256": "..."
    }
  }
}
```

Rules:

- Missing manifest means workflow is `missing` unless conflicting yolk files already exist.
- `enabled: false` means workflow is installed but disabled.
- Managed file hashes are hashes of the last written managed content.
- Existing unmanaged same-path files are conflicts.
- Existing managed files with different current hash are conflicts unless the operation is an explicit future overwrite/merge action. v1 should report the conflict and stop.

### `.yolk/workflow.json`

The workflow definition is intentionally small and WebUI-readable:

```json
{
  "schemaVersion": 1,
  "name": "Yolk Workflow",
  "statuses": ["planning", "in_progress", "review", "completed"],
  "artifacts": ["prd.md", "design.md", "implement.md", "check.md"],
  "defaultStatus": "planning"
}
```

The extension can read this file to include current workflow guidance in system context. The WebUI can read it for labels and future visualization.

### `.yolk/tasks/<task-id>/task.json`

Suggested v1 task shape:

```json
{
  "schemaVersion": 1,
  "id": "07-08-some-task",
  "title": "Some task",
  "status": "planning",
  "priority": "P2",
  "assignee": "lichong",
  "parent": null,
  "children": [],
  "createdAt": "2026-07-08T00:00:00.000Z",
  "updatedAt": "2026-07-08T00:00:00.000Z",
  "notes": ""
}
```

Artifacts live next to `task.json`. v1 creates `prd.md` during task creation and reads optional `design.md`, `implement.md`, and `check.md` when present.

## Backend modules

### `lib/yolk-workflow-manager.ts`

New library module for setup/provisioning/status:

- canonicalize and validate cwd;
- inspect `.yolk/manifest.json` and target files;
- compute template hashes;
- produce status: `missing`, `ready`, `disabled`, `outdated`, `conflict`, `blocked`;
- enable by creating missing managed files and updating manifest;
- disable by setting `enabled: false` only;
- update by applying only unchanged managed templates and reporting conflicts;
- return output/conflict details for Settings UI.

This should mirror the safety posture of `lib/trellis-manager.ts` without invoking external commands.

### `lib/yolk-reader.ts`

New read/write helper for task state:

- list tasks from `.yolk/tasks`;
- read one task detail and markdown artifacts with byte limits;
- create a minimal task directory with safe task id generation;
- reject symlink/path escape issues using patterns from `lib/trellis-reader.ts`;
- expose wire types from `lib/yolk-types.ts`.

Task writes should be limited to explicit APIs and authorized cwd checks.

### `lib/yolk-chat-context.ts`

Pure helper matching the Trellis chat context pattern:

- convert a `YolkTaskDetail` into a compact chip payload;
- serialize chip payload into a continuation prompt;
- include task metadata, artifact content, and `.yolk/workflow.json` summary where available.

## API routes

Suggested routes:

```text
GET  /api/yolk/workflow/status?cwd=...
POST /api/yolk/workflow/enable
POST /api/yolk/workflow/disable
POST /api/yolk/workflow/update
GET  /api/yolk/tasks?cwd=...
POST /api/yolk/tasks
GET  /api/yolk/tasks/[taskKey]?cwd=...
```

All routes must use `getAllowedRoots()` and `isPathAllowed()` against both original and canonical cwd, following Trellis setup route patterns. Task keys should be strict path-safe ids.

## Frontend changes

### Settings

Extend `SettingsConfig.tsx` with:

- new `SettingsSection` value: `yolkWorkflow`;
- section button label `Yolk Workflow`;
- status loader for selected `cwd`;
- enable/disable/update actions;
- conflict list and managed-file status display;
- notice that new sessions pick up resources and existing sessions may need refresh/new session.

Do not store workspace enablement in global `pi-web.json`; `.yolk/manifest.json` is the per-workspace source of truth.

### Main shell / panel

Add an independent right-panel mode for yolk workflow, rather than replacing Trellis:

- keep existing `files` and `trellis` behavior intact;
- add `yolkWorkflow` mode and a separate floating/right-side toggle when workflow is enabled for the active workspace;
- pass active cwd to `YolkWorkflowPanel`;
- support focus/select after task creation.

If the workflow is missing or disabled, the panel should show an actionable empty state pointing to Settings.

### `YolkWorkflowPanel`

New component modeled on `TrellisPanel` but narrower in scope:

- list active `.yolk/tasks`;
- show task detail and artifacts;
- New task action with minimal title/priority/assignee input;
- refresh action;
- insert continuation context chip action;
- errors for read conflicts or disabled workflow.

### `ChatInput`

Extend the existing context-chip mechanism:

- add a new `yolk-task` chip type;
- render label such as `Yolk continue task`;
- serialize via `buildYolkTaskResumePrompt()`;
- keep Trellis chip behavior unchanged.

## Project-local Pi runtime resources

### `yolk-workflow` extension

The generated extension should be minimal in v1:

- on session start/before agent start, read `.yolk/manifest.json`, `.yolk/workflow.json`, and current task if discoverable;
- inject concise workflow context only when manifest exists and `enabled: true`;
- register no destructive tools in v1 unless required by follow-up design;
- degrade quietly if files are missing or invalid.

The extension should avoid Trellis names, env vars, and `.trellis` assumptions.

### Prompts and agents

Provision simple project-local resources:

- `yolk-continue.md`: instructs continuation using `.yolk/tasks` context.
- `yolk-finish-work.md`: finish/checklist prompt for current yolk task.
- `yolk-implement.md`, `yolk-check.md`, `yolk-research.md`: agent definitions with yolk task context expectations.

These resources are managed templates and participate in manifest hashes.

## Status model

Recommended status values:

- `missing`: `.yolk/manifest.json` absent and no managed targets present.
- `ready`: manifest enabled, required files exist, managed hashes match current version.
- `disabled`: manifest exists with `enabled: false`.
- `outdated`: managed files match old template hashes and can be updated safely.
- `conflict`: required paths exist but are unmanaged or modified from last managed hash.
- `blocked`: cwd invalid, access denied, path escapes workspace, or manifest malformed.

Settings should display a recommended action for each status.

## Safety and trust

- No external command execution is required for setup.
- All writes are explicit user actions from Settings or New task.
- Setup writes only allowlisted `.yolk/` and yolk-prefixed `.pi/` paths.
- Existing files are never overwritten unless recognized as unchanged managed templates.
- Project-local Pi extensions are executable code; Settings copy must say new sessions will load project-local resources after normal Pi trust/discovery behavior.
- Active sessions are not auto-reloaded in v1.

## Documentation updates

If implemented, update:

- `docs/modules/api.md` with new `/api/yolk/*` routes;
- `docs/modules/frontend.md` with `YolkWorkflowPanel` and Settings section;
- `docs/modules/library.md` with `yolk-workflow-manager`, `yolk-reader`, `yolk-chat-context`, and `yolk-types`;
- `docs/architecture/overview.md` with workflow invariants if event kinds/session context behavior changes.

## Validation

Minimum validation:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Manual checks:

- Settings status on workspace without `.yolk`.
- Enable workflow and verify file writes are only allowlisted.
- Re-run status after enable; verify `ready`.
- Introduce a managed-file edit and verify conflict reporting.
- Disable and verify no files are removed.
- Create a task from Workflow panel and verify detail display.
- Insert yolk task context chip and verify serialized prompt in chat submission.
- Verify `/api/pi/resources?cwd=...` and `/api/commands?cwd=...` see yolk resources in a newly started/discovered context.
