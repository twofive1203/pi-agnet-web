# Yolk native development workflow

## Goal

Build a yolk pi web native project development workflow that can eventually replace the current Trellis-based workflow integration. The feature should let a user enable the workflow for the currently selected workspace from Settings, provision only clearly namespaced project-local resources, and provide a minimum complete loop for task visibility, chat context, project-local agents/prompts/extensions, status inspection, and safe updates.

## Confirmed Product Decisions

- The new workflow should be yolk pi web's own system, not a wrapper around Trellis CLI or `.trellis` conventions.
- Trellis may be used as a reference implementation and as the current repository's planning process, but the new product feature should not depend on Trellis at runtime.
- Enabling the workflow may write project-local files.
- Writes must stay inside explicit namespaces such as `.yolk/` and yolk-prefixed `.pi/` resources.
- First version should be a minimum complete loop, not only a Settings toggle.
- First version should add an independent yolk Workflow panel instead of replacing the existing Trellis drawer immediately.
- Settings should expose yolk workflow controls in an independent `Yolk Workflow` section, not inside the existing Trellis settings section.
- Trellis should remain intact during the transition and can be removed later after the yolk workflow is complete enough to replace it.
- First version does not need to fully migrate existing `.trellis/tasks` into the new system unless later scoped in.
- First version should use a simplified yolk task model under `.yolk/tasks/<task-id>/` with `task.json` plus markdown artifacts such as `prd.md`, `design.md`, `implement.md`, and `check.md`.
- First version should include a minimal WebUI task creation path so users can create a yolk task without hand-writing `.yolk/tasks` files.
- Disabling the workflow in the first version should mark it disabled without deleting project-local `.yolk/` or yolk-prefixed `.pi/` resources.
- Enabling/updating should use conservative managed-file safety: create missing files, track managed template hashes, and report conflicts instead of overwriting user-authored or modified files.
- Active sessions do not need to auto-reload project-local Pi resources in the first version; enabling should make new sessions work and clearly tell users to refresh or start a new session for existing chats.
- First version should provision only this minimum resource set: `.yolk/manifest.json`, `.yolk/workflow.json`, `.yolk/tasks/`, `.pi/extensions/yolk-workflow/index.ts`, `.pi/prompts/yolk-continue.md`, `.pi/prompts/yolk-finish-work.md`, `.pi/agents/yolk-implement.md`, `.pi/agents/yolk-check.md`, and `.pi/agents/yolk-research.md`.

## Requirements

- Settings must expose workspace-aware enablement for the yolk native development workflow in a dedicated `Yolk Workflow` section.
- The backend must inspect the selected workspace and report whether the workflow is missing, ready, outdated, disabled, or blocked by conflicts.
- Enabling must provision project-local workflow files under clear namespaces only.
- Provisioning must avoid overwriting user-authored or modified files without explicit conflict handling.
- Provisioning must record enough managed-file metadata to distinguish unchanged managed templates from modified or user-authored files.
- Disabling must stop WebUI workflow display/context behavior for that workspace without removing project-local files in the first version.
- The workflow must include project-local Pi runtime resources needed for chat integration, including the `yolk-workflow` extension, `yolk-*` prompt templates, and `yolk-*` agent definitions.
- The workflow must include yolk-owned task/workflow state files that the WebUI can read without Trellis.
- Yolk task state must support task status, metadata, optional parent/children relationships, and markdown artifact documents for detail display and chat context.
- The main UI must expose an independent yolk Workflow panel that can show yolk workflow tasks/progress for the active workspace.
- The yolk Workflow panel must support creating a minimal task with `task.json` and `prd.md`, then selecting it for detail display and chat continuation.
- Task continuation should reuse the existing chat context-chip interaction style: a Workflow panel action inserts a structured yolk task context block into ChatInput, and the user sends it after review/editing.
- Chat sessions must be able to receive current yolk workflow context when the workflow is enabled for the workspace.
- After enabling or updating project-local Pi resources, the UI should guide users that existing sessions may need refresh/new session while new sessions use the workflow resources.
- The implementation must keep existing Trellis behavior intact during the first version; removing Trellis is a later follow-up after yolk workflow parity is reached.

## Acceptance Criteria

- [ ] A user can open the dedicated Settings `Yolk Workflow` section for a selected workspace and see the yolk workflow status.
- [ ] A user can enable the yolk workflow for that workspace from Settings.
- [ ] Enabling writes only `.yolk/` and yolk-prefixed `.pi/` resources, or reports conflicts without unsafe overwrite.
- [ ] Managed workflow files are hash/version tracked so unchanged templates can be recognized and modified/user-authored files are reported as conflicts.
- [ ] Disabling marks the workflow disabled for the selected workspace without deleting project-local workflow files.
- [ ] After enabling, Pi resource discovery shows the project-local `yolk-workflow` extension, `yolk-*` prompts, and `yolk-*` agents expected by the feature.
- [ ] The WebUI can read and display yolk workflow task state from the selected workspace without reading `.trellis/tasks`.
- [ ] The main UI provides an independent yolk Workflow panel while the existing Trellis drawer still works.
- [ ] A user can create a minimal yolk task from the Workflow panel and see it in the task list/detail view.
- [ ] A user can insert a structured yolk task continuation context chip into ChatInput from the Workflow panel and send it after review.
- [ ] A chat session in an enabled workspace receives relevant yolk workflow context.
- [ ] Enabling tells users that new sessions pick up workflow resources and existing sessions may need refresh/new session.
- [ ] Existing Trellis Settings, task panel, setup APIs, and runtime extension behavior are not broken by the new workflow.
- [ ] Minimum validation passes: `npm run lint` and `node_modules/.bin/tsc --noEmit`.

## Open Questions

- None currently blocking PRD-level scope.

## Out of Scope for Initial Planning Unless Reopened

- Project-local `.pi/skills/yolk-*`, complex dependency graph, manifest JSONL curation, migration tooling, or automatic full migration of existing `.trellis/tasks` history into `.yolk/tasks`.
- Removing current Trellis code paths in the same first implementation; this should happen later after yolk workflow parity is reached.
- Any dependency on `trellis init`, `trellis update`, or the Trellis CLI.
