---
name: snflow-dev
description: "Use Snail Pi Web native SnFlow tasks under .pi/snflows/tasks/ for development work. Create and plan tasks in chat, then dispatch the managed snflow-implement and snflow-check project agents. Prefer this over Trellis for WebUI-owned workflow."
---

# SnFlow development workflow

This is **WebUI SnFlow** (`.pi/snflows/tasks/`), not Trellis (`.trellis/`).
Experience should feel like Trellis: chat-orchestrated create → plan → start → implement → check → commit handoff.

Panel (SF) is for visibility/emergency controls. **Do not make the user drive the lifecycle by clicking around.**

## Phase index

```
Phase 1 Plan    → consent + create + requirements/design/plan
Phase 2 Execute → start + implement + check loops
Phase 3 Finish  → ready_to_commit + user commit + complete/archive
```

## Task-management CLI

The project-local wrapper manages task state only. Implement/check run through the current chat native `subagent` tool:

```bash
npx tsx scripts/snflow-task.ts create "<title>" --seed "<user goal>"
npx tsx scripts/snflow-task.ts current
npx tsx scripts/snflow-task.ts show
npx tsx scripts/snflow-task.ts start
npx tsx scripts/snflow-task.ts complete --hash <sha>
npx tsx scripts/snflow-task.ts archive
```

`implement`, `check`, and `wait` are deprecated and must not be used for execution.

If the CLI wrapper cannot resolve the Snail Pi Web package, use the SnFlow panel actions or the manual file fallback below.

Manual fallback layout:

```text
.pi/snflows/tasks/<slug>/
  task.json
  requirements.md
  design.md
  plan.md
.pi/snflows/archived/<slug>/
.pi/snflows/current.json
```

Minimum `task.json`:

```json
{
  "schemaVersion": 1,
  "id": "<slug>",
  "title": "<title>",
  "description": "<short description>",
  "status": "planning",
  "priority": "P2",
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "completedAt": null,
  "revision": "manual",
  "activeRunId": null,
  "latestImplementRunId": null,
  "latestCheckRunId": null,
  "commit": null,
  "archived": false
}
```

`task.md` is not a valid primary SnFlow record.

After create/start, acknowledge:

```text
Active SnFlow task: .pi/snflows/tasks/<id>
```

## Project spec (`.pi/snflows/spec/`)

- Before development, read `.pi/snflows/spec/index.md` and the relevant layer indexes when present.
- Also read the project-root `AGENTS.md` SnFlow managed section (bounded by `<!-- BEGIN SNFLOW SPEC -->` / `<!-- END SNFLOW SPEC -->` markers) which directs agents to the spec index and requirements.
- Implementation follows applicable specs; active task documents win on conflicts, and the conflict must be reported.
- Check compares the diff against applicable specs and reports violations as findings.
- Before finish, capture reusable conventions or lessons in the relevant spec file and update its index status table.
- Specification maintenance under `.pi/snflows/spec/` is allowed in the main session even though product source remains phase-agent-owned.
- Special task `00-bootstrap-spec`: scan source read-only, fill the spec, then create or idempotently update the project-root `AGENTS.md` with the exact managed block from the task plan. Preserve all content outside the markers. Do not dispatch implement/check or other subagents. When complete, manually set its `task.json` status to `ready_to_commit` for user commit handoff.

## Phase 1 — Plan

- Simple chat: ask if a SnFlow task is needed; skip if user says no.
- Real dev work: create the task yourself (never tell user to open SF and press +).
- Edit `requirements.md`, `design.md`, `plan.md`.
- Consent to create ≠ consent to implement.

When the user approves implementation, mark the task ready, re-read its revision, and call the current chat native `subagent` tool with project agent `snflow-implement`, `context:fresh`, canonical `cwd`, `async:false`, and `clarify:false`. The task prompt must begin with the exact `SNFLOW_DISPATCH` v1 marker.

## Phase 2 — Execute

Main session is orchestrator only. It calls project agent `snflow-implement` for implement and `snflow-check` for check using a marked foreground native `subagent` call. The agent definitions own the stable phase responsibilities and safety boundaries; the marked task prompt supplies dynamic task context and the result contract. Native tool updates, cancellation, and the final result remain in the current chat; do not substitute a CLI/RPC wait.

### Recursion guards
- If you are already the implement/check child, do **not** re-dispatch SnFlow implement/check.
- Only the main session should issue the marked native implement/check tool call.

### Inline exception
Do **not** edit project source in the main session except a trivial fix of roughly ≤10 lines with no new files — still run `check` afterwards.

## Phase 3 — Finish

- Do **not** git commit/push/PR unless user explicitly asks.
- After user commits:

```bash
npx tsx scripts/snflow-task.ts complete --hash <git-sha>
npx tsx scripts/snflow-task.ts archive
```

## Hard rules

- Never write `.trellis/` for this workflow
- Never run `python ./.trellis/scripts/task.py` for SnFlow tasks
- Prefer CLI/panel over asking the user to click around
- Keep one writer on the working tree
- Fail closed on missing cwd/task context; print diagnostics
