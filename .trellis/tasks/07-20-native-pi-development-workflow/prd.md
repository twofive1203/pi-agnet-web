# Build Native Pi Development Workflow

## Goal

Give Snail Pi Web a project-owned development workflow that preserves the useful parts of Trellis task-driven development while using native `pi-subagents` for implement/check delegation. The workflow must be reliable across multiple workspaces because the WebUI owns the active session cwd and task context.

## User Intent

The user wants to avoid depending on Trellis-generated `.pi/extensions/trellis/index.ts` behavior for core development work. Instead, Snail Pi Web should provide its own first-class workflow for:

1. Creating and tracking a development task.
2. Capturing requirements, design, and implementation order.
3. Dispatching `trellis-implement`-equivalent implementation work through native `pi-subagents`.
4. Dispatching review/check work through native `pi-subagents`.
5. Keeping task context, project cwd, progress, validation, commit, and archive state connected in the WebUI.

## Confirmed Facts

- The WebUI already manages sessions with an explicit cwd through `lib/rpc-manager.ts` and `hooks/useAgentSession.ts`.
- Native `pi-subagents` receives the parent `ctx.cwd` and uses it as the child runtime cwd unless an explicit child cwd is supplied.
- The current project has Trellis task files under `.trellis/tasks/`, but Trellis-generated Pi extensions are project-local and may be stale or inconsistent across projects.
- The current WebUI already exposes native subagent settings and Trellis model-routing settings separately.
- The current WebUI has Trellis task readers/panels and subagent progress projections that may be reusable as UI patterns, but no WebUI-owned implementation/check task lifecycle has been confirmed yet.

## Requirements

- The workflow must be owned by Snail Pi Web and must not require Trellis CLI initialization in the target project for its core path.
- Every workflow run must bind to an explicit project cwd and task identity; it must never silently use the WebUI server process cwd or another selected workspace.
- Task context must be persisted in project-local, inspectable files under a WebUI-owned namespace (recommended MVP path: `.pi/workflows/tasks/`) and include at least requirements, design/plan state, implementation/check status, and validation results.
- Native `pi-subagents` must be the dispatch mechanism for implementation and checking agents. The MVP uses its stable in-process RPC and defaults to bundled `worker` and `reviewer`, so target projects do not need Trellis-generated Agent files.
- The workflow must support an implementation agent and an independent check/review agent, with clear recursion guards so delegated agents do not recursively dispatch the same workflow agents.
- The primary MVP entry point is a dedicated Workflow drawer/panel where users create tasks, edit requirements/plans, launch implement/check phases, and inspect run state. Chat integration is supplementary rather than the workflow authority.
- The parent WebUI must display run status, output, failures, cancellation, and the effective project/task context.
- Existing native pi-subagents model configuration must remain compatible; workflow routing must not conflate native settings with unrelated Trellis policy.
- The MVP must support projects with no `.trellis/` directory.
- Existing Trellis support must remain available as a strictly separate compatibility feature. The new Workflow panel manages only `.pi/workflows/tasks/`; it does not auto-import, migrate, or write `.trellis/tasks/` in MVP.
- The workflow must provide an explicit handoff path for commit and cleanup/archive; agents must not commit unless that behavior is separately and explicitly designed.

## Acceptance Criteria

- [ ] A user can create/select a WebUI-owned development task for the currently selected project cwd.
- [ ] A task can hold requirements and an implementation plan that native subagents can read.
- [ ] An implementation dispatch always receives the selected project cwd and task context, even when another project was previously selected or the server started elsewhere.
- [ ] A check dispatch can review the implementation against the same task context without recursively spawning implementation/check agents.
- [ ] The UI exposes active, completed, failed, and cancelled workflow states with enough context to distinguish project and task.
- [ ] Missing/invalid project or task context fails closed with a user-visible diagnostic.
- [ ] Native model settings and existing general-purpose subagent behavior continue to work.
- [ ] The workflow works in a project without Trellis initialization.
- [ ] Focused tests or deterministic smoke checks cover cwd isolation, task context loading, dispatch lifecycle, and failure/cancellation behavior.
- [ ] Lint and TypeScript validation pass.

## Out Of Scope For MVP

- Replacing every Trellis command, skill, or platform integration.
- A general project-management system, issue tracker, or cloud synchronization service.
- Automatic Git commit/push/PR creation by delegated agents.
- Cross-machine collaboration, remote workers, or distributed task queues.
- Rewriting existing `.trellis/` task history or silently migrating Trellis metadata.
- Supporting arbitrary third-party agent runtimes beyond native `pi-subagents`.

## Open Decisions

- **Decided:** MVP task records are project-local files under a WebUI-owned namespace; the design recommends `.pi/workflows/tasks/`.
- **Decided:** task authoring uses structured controls for metadata and Markdown editor/preview tabs for Requirements, Design, and Plan.
- **Decided:** the first-class MVP entry point is a dedicated Workflow panel; chat integration is secondary.
- **Decided for MVP:** use native builtin `worker` and `reviewer` as execution roles; Workflow labels may present them as Implement and Check without requiring project Agent files.
- **Decided:** Trellis and the native Workflow coexist but remain strictly separated in MVP; there is no task adoption, migration, or dual write.
- **Design recommendation:** retain multiple sequential run records for implementation/review loops, but allow only one active Workflow run per canonical cwd in MVP.
