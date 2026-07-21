# Implementation Plan

## Preconditions

- User reviews and approves `prd.md` and `design.md` in a new session.
- Run `trellis-before-dev` before code changes.
- Keep task status `planning`; do not run `task.py start` until design review is complete.
- Confirm installed Pi SDK and `pi-subagents` versions still expose the APIs documented in `research/native-pi-subagents-rpc.md`.

## Phase 1: Store And Types

1. Add `lib/workflow-types.ts` with versioned task, document, run, status, transition, and API projection types.
2. Add `lib/workflow-store.ts` with:
   - canonical cwd and allowed-root integration;
   - `.pi/workflows/tasks/` resolution;
   - stable task id validation;
   - strict JSON/document parsing and size limits;
   - symlink/realpath escape protection;
   - task creation and document templates;
   - optimistic revision updates;
   - atomic JSON/Markdown writes;
   - run-record persistence;
   - explicit complete/archive operations.
3. Add focused deterministic tests or a repository-local smoke harness for:
   - project A/project B isolation;
   - traversal and symlink rejection;
   - malformed record behavior;
   - revision conflicts;
   - archive collision behavior;
   - allowed state transitions.

Checkpoint: CRUD works without Pi, Trellis, or a running chat session.

## Phase 2: Native Subagent Runtime

1. Extend the SDK session construction path carefully:
   - create a Pi `EventBus`;
   - create/reuse `DefaultResourceLoader` with cwd, agentDir, settings manager, and event bus;
   - preserve all existing extension/package/resource discovery behavior.
2. Add `lib/workflow-run-manager.ts`:
   - `globalThis` host/run registries and locks;
   - deterministic in-memory workflow host session per canonical cwd;
   - `preparePiRuntimeEnvironment()` integration;
   - versioned RPC request/reply helper with timeout and unsubscribe cleanup;
   - `ping`, `spawn`, `status`, and `stop` wrappers;
   - one-active-run-per-cwd lock;
   - lifecycle artifact projection and restart reconciliation.
3. Add `lib/workflow-prompts.ts`:
   - implement prompt using builtin `worker`;
   - check prompt using builtin `reviewer`;
   - explicit task id/path/cwd;
   - fresh context, no commit, no recursive delegation;
   - structured output schemas and output normalization.
4. Validate unavailable extension, wrong RPC version, cwd mismatch, unknown agent, failed spawn, cancellation, server restart/stale run, and malformed structured output.

Checkpoint: a server-side smoke call can run `worker` in a temporary project and reports the exact effective cwd and task revision.

## Phase 3: API

1. Add task list/create and task detail/update routes under `app/api/workflows/`.
2. Add implement/check start route with expected revision and transition validation.
3. Add run status and cancel routes.
4. Add complete and archive routes.
5. Return browser-safe typed projections only; do not expose arbitrary native artifact files.
6. Update `docs/modules/api.md` and `AGENTS.md` route navigation when routes are added.

Checkpoint: API smoke tests cover cwd isolation, create/edit conflicts, implement/check transition order, active-run collision, failure, and cancellation.

## Phase 4: Workflow Panel

1. Add `components/WorkflowPanel.tsx` using existing panel conventions:
   - task list/status filters;
   - create task dialog;
   - metadata form;
   - Requirements/Design/Plan tabs;
   - edit/preview mode using existing Monaco/Markdown patterns;
   - revision conflict preservation;
   - phase actions and clear disabled reasons;
   - run history/status/output/error/artifact summaries;
   - explicit complete/archive actions.
2. Integrate a distinct `workflow` drawer mode in `components/AppShell.tsx`; keep `trellis` intact.
3. Add polling with abort/cleanup while a run is active; stop polling on terminal states and workspace/task switches.
4. Add compact workflow activity indication without conflating runs with chat `SubagentPanel` state.
5. Add zh/en strings in `lib/i18n/messages/`.
6. Add responsive behavior, keyboard access, empty/error/loading/conflict/cancelled states, and icon tooltips.
7. Update `docs/modules/frontend.md`.

Checkpoint: user can complete create -> author -> mark ready -> implement -> check -> ready to commit from the panel in a project without `.trellis/`.

## Phase 5: Configuration And Compatibility

1. Add a distinct Workflow enablement/settings section in `lib/pi-web-config.ts` and Settings UI.
2. Keep native `settings.json -> subagents` as the only Workflow agent model source.
3. Do not read `pi-web.json -> trellis.subagents` from Workflow code.
4. Verify Trellis panel/setup/task association behavior remains unchanged.
5. Update `docs/architecture/overview.md`, `docs/integrations/README.md`, `docs/modules/library.md`, and deployment/troubleshooting docs if runtime behavior warrants it.

## Validation

Minimum commands:

```bash
npm run lint
node_modules/.bin/tsc --noEmit
```

Focused deterministic coverage must additionally prove:

- canonical cwd A never reads/writes/dispatches cwd B;
- server `process.cwd()` is irrelevant to Workflow context;
- projects without `.trellis/` work;
- missing `.pi/workflows/` is a normal empty state;
- malformed task files fail closed;
- RPC ping cwd mismatch blocks spawn;
- worker receives requirements/design/plan and cannot commit through the phase contract;
- reviewer uses fresh context and returns pass/changes-requested projection;
- one active run per cwd is enforced;
- cancellation and stale/restart reconciliation are visible and deterministic;
- existing chat, native Agents settings, general-purpose subagent runs, and Trellis UI still work.

For UI changes, run browser verification on desktop and mobile widths and inspect screenshots for drawer layout, Markdown editing/preview, long paths/titles, run progress, and error states.

## Risky Files And Rollback Points

- `lib/rpc-manager.ts`: avoid changing existing chat session lifecycle unless necessary; prefer a separate workflow host factory/manager.
- Pi `DefaultResourceLoader` construction: preserve extension/package/settings discovery exactly.
- `components/AppShell.tsx`: add a distinct drawer mode without destabilizing files/Trellis state.
- `lib/pi-web-config.ts`: keep Workflow config separate from Trellis and native subagent settings.
- Native RPC constants: define local protocol types/constants from the documented v1 contract; do not import package internals.

Rollback by disabling Workflow configuration and removing its routes/panel/runtime registration. Do not delete project `.pi/workflows/tasks/` files during rollback.

## Suggested Commit Batches

1. Workflow types/store/tests.
2. Native RPC host/run manager/tests.
3. Workflow API routes/tests/docs.
4. Workflow panel/i18n/browser validation/docs.
5. Compatibility hardening and final validation.
