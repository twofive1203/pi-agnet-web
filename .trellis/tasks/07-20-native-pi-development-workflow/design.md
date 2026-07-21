# Technical Design

## Summary

Add a Snail Pi Web-owned development workflow alongside existing Trellis support. The new workflow stores task documents under `.pi/workflows/tasks/`, exposes a dedicated Workflow drawer, and dispatches implementation/review phases through native `pi-subagents` v1 RPC using a cwd-bound, server-owned Pi workflow host session.

Trellis remains a separate compatibility feature. No schema sharing, migration, import, or dual write is part of MVP.

## Architecture

```text
WorkflowPanel
  |
  | GET/POST/PUT /api/workflows/...
  v
workflow-store.ts  <---->  <cwd>/.pi/workflows/tasks/<task-id>/
  |
  | start/status/cancel
  v
workflow-run-manager.ts
  |
  | owns deterministic cwd-bound host
  v
Pi AgentSession + shared EventBus
  |
  | subagents:rpc:v1 spawn/status/stop
  v
native pi-subagents worker / reviewer
  |
  v
pi-subagents lifecycle artifacts + structured result
```

## Ownership Boundaries

### Workflow Store

New shared module, recommended `lib/workflow-store.ts`:

- Canonicalizes and validates cwd.
- Resolves only stable task ids under `.pi/workflows/tasks/`.
- Rejects symlink/realpath escapes.
- Strictly parses task metadata and run records.
- Creates task directories and Markdown documents.
- Applies revision-checked updates with same-directory atomic rename.
- Archives by moving task directories under `.pi/workflows/tasks/archive/<YYYY-MM>/`.
- Does not read or write `.trellis/`.

### Workflow Runtime

New shared module, recommended `lib/workflow-run-manager.ts`:

- Keeps a `globalThis` registry of workflow hosts and active runs.
- Creates one in-memory Pi AgentSession host per canonical cwd.
- Uses `preparePiRuntimeEnvironment()` before loading extensions.
- Creates a Pi `EventBus` and passes it to `DefaultResourceLoader`.
- Verifies native `pi-subagents` RPC availability with `ping`.
- Verifies `ping.session.cwd` equals the requested canonical cwd.
- Emits `spawn`, `status`, and `stop` RPC requests with bounded timeouts.
- Reconciles persisted run references with pi-subagents lifecycle artifacts.
- Enforces one active Workflow run per cwd for MVP.
- Never uses `process.cwd()` as a project fallback.

### UI

New `components/WorkflowPanel.tsx`, integrated as a distinct right-drawer mode in `components/AppShell.tsx`:

- Workspace-bound task list and task detail.
- Create task dialog with structured metadata.
- Requirements, Design, and Plan Markdown tabs with edit/preview modes.
- Explicit Save, Mark Ready, Run Implement, Run Check, Cancel Run, Record Commit, Complete, and Archive actions as state permits.
- Run history with agent, effective cwd, model, state, timestamps, summary, validation, errors, and artifact links/paths.
- User-visible empty, loading, conflict, extension-missing, invalid-context, failed, cancelled, and stale-run states.

The existing top-bar `SubagentPanel` remains chat-session activity. Workflow runs are authoritative in the Workflow panel and should not be forced into chat `SubagentRun` state. Shared formatting components may be extracted later if duplication is material.

## Project File Layout

```text
.pi/workflows/
  tasks/
    <task-id>/
      task.json
      requirements.md
      design.md
      plan.md
      runs/
        <workflow-run-id>.json
    archive/
      <YYYY-MM>/
        <task-id>/...
```

### `task.json`

Recommended versioned shape:

```json
{
  "schemaVersion": 1,
  "id": "fix-auth-refresh",
  "title": "Fix auth refresh",
  "description": "...",
  "status": "planning",
  "priority": "P1",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "completedAt": null,
  "revision": "content-hash",
  "activeRunId": null,
  "latestImplementRunId": null,
  "latestCheckRunId": null,
  "commit": null,
  "archived": false
}
```

Task status values for MVP:

- `planning`
- `ready`
- `implementing`
- `review_ready`
- `checking`
- `changes_requested`
- `ready_to_commit`
- `completed`
- `failed`
- `cancelled`

Runs are the source of execution outcome; task status is a workflow projection.

### Run Record

Each `runs/<id>.json` stores:

- `schemaVersion`, workflow run id, native pi-subagents run id.
- task id, phase (`implement` or `check`), agent name.
- requested/effective canonical cwd and deterministic workflow host session id.
- state (`starting`, `running`, `completed`, `failed`, `cancelled`, `stale`).
- timestamps and last reconciliation time.
- native `asyncDir`, session/output/artifact references when available.
- model/thinking and token/tool/turn metadata when available.
- structured result or browser-safe error.
- task revision used for dispatch, so stale reviews are detectable.

Do not copy full child transcripts into task files.

## Authoring Model

Structured fields belong in `task.json`: title, description, priority, status, commit.

Long-form content uses Markdown:

- `requirements.md`: goals, requirements, acceptance criteria, out of scope.
- `design.md`: technical design and decisions.
- `plan.md`: ordered implementation and validation plan.

The UI uses form controls for metadata and Markdown editor/preview tabs for documents. Creation writes all three documents with minimal headings so later saves only update existing task-owned files.

## Native Subagent Dispatch

### Host Session

Create a deterministic in-memory parent session per cwd, for example using a hash-derived id. It is not a visible chat session and does not write normal chat JSONL history.

The host loads normal user/project Pi settings and packages, so native subagent model overrides continue to work. It owns the event bus used by `pi-subagents` RPC.

### Implement Phase

Default agent: builtin `worker`.

Dispatch inputs:

- Explicit canonical `cwd`.
- `context: "fresh"` to avoid unrelated chat history.
- `async: true`, `clarify: false`.
- Project-relative reads for `requirements.md`, `design.md`, and `plan.md` when supported.
- Prompt names the task id/path and says this is the implementation child, not an orchestrator.
- Prompt forbids commit/push/merge.
- Prompt requires focused validation and a structured completion summary.
- Optional output schema for changed files, validation results, summary, and residual risks.

On success, task becomes `review_ready`; on failure/cancel it records the run outcome without pretending implementation completed.

### Check Phase

Default agent: builtin `reviewer`.

- Uses `context: "fresh"` for independent review.
- Receives the same task document paths and the implementation run summary.
- Prompt is review-only for MVP and explicitly forbids subagent dispatch.
- Requires structured output with `verdict: pass | changes_requested`, summary, findings, and validation.
- `pass` moves task to `ready_to_commit`.
- `changes_requested` moves task to `changes_requested`, allowing another implement run.

Builtin `worker` and `reviewer` avoid requiring Trellis-generated project Agent definitions. Agent selection can become configurable later through native discovery.

## Run State And Reconciliation

1. API validates cwd, task id, expected task revision, required documents, allowed transition, and absence of an active cwd run.
2. Store writes a `starting` run record and assigns `activeRunId` atomically.
3. Runtime verifies RPC ping and cwd.
4. Runtime spawns native async run and persists returned native run/artifact references.
5. Browser polls the run/task detail endpoint in MVP. A dedicated workflow SSE stream is a follow-up unless polling proves insufficient.
6. Status calls reconcile native state into the run record and task projection.
7. Cancel sends RPC `stop`, then reconciles until the native state is stopped/cancelled or a timeout produces a visible stale state.
8. On server restart, task reads reconcile non-terminal records from native lifecycle artifacts/status. Unknown fields are ignored.

## API Surface

Recommended routes:

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/workflows/tasks?cwd=...` | GET, POST | List/create tasks for one authorized cwd. |
| `/api/workflows/tasks/[taskId]?cwd=...` | GET, PUT | Read/update metadata and Markdown documents with revision checks. |
| `/api/workflows/tasks/[taskId]/runs?cwd=...` | POST | Start `implement` or `check`. |
| `/api/workflows/runs/[runId]?cwd=...` | GET | Reconcile and return one run. |
| `/api/workflows/runs/[runId]/cancel?cwd=...` | POST | Stop an active native run. |
| `/api/workflows/tasks/[taskId]/complete?cwd=...` | POST | Record explicit completion/commit metadata. |
| `/api/workflows/tasks/[taskId]/archive?cwd=...` | POST | Archive completed/cancelled task. |

Browser inputs use cwd plus stable ids, never raw task paths.

## Security And Failure Behavior

- Require authorized cwd through shared allowed-root checks.
- Canonicalize cwd once at every API boundary.
- Validate task ids with a narrow slug regex and reject traversal.
- Verify `.pi/workflows`, tasks, documents, and archive destinations stay inside workspace after realpath resolution.
- Bound Markdown and JSON sizes.
- Strictly parse malformed records and block writes until repaired; never normalize malformed task data to defaults.
- Use optimistic revisions for authoring and state transitions.
- Fail closed when project cwd, task, host session, pi-subagents RPC, agent, task revision, or lifecycle state is missing/mismatched.
- Never expose arbitrary native artifact paths for browser reads without an authorized, bounded projection route.

## Concurrency

MVP permits multiple historical runs per task but only one active Workflow run per canonical cwd. This prevents two writer/reviewer jobs from racing in the same working tree. Native `pi-subagents` may run unrelated general-purpose children outside Workflow; the panel should warn that those are not governed by the Workflow lock.

## Trellis Compatibility

- Keep existing Trellis settings, routes, readers, panel, and task widgets unchanged.
- Add Workflow as a new product surface and namespace.
- No `.trellis/tasks/` import, migration, adoption, or writeback in MVP.
- Do not reuse `pi-web.json -> trellis.subagents` for Workflow routing.
- Native `settings.json -> subagents` remains the model/config source.

## Commit And Archive Handoff

Delegated agents never commit. After check passes, Workflow enters `ready_to_commit` and shows changed-file/validation summary plus explicit commit handoff. MVP records a user-supplied or detected commit hash only after an explicit user action; it does not run Git commit/push/PR automatically. Archive is also explicit.

## Rollout And Rollback

- Gate the Workflow panel with a new `pi-web.json` setting, default off during initial rollout if needed.
- Projects without `.pi/workflows/` show an empty state and create it only after explicit task creation.
- Existing Trellis behavior is untouched and is the fallback.
- Rollback consists of disabling the Workflow panel/runtime; project task files remain inspectable and are not deleted.
