---
name: snflow-dev
description: "Use Snail Pi Web native SnFlow tasks only when the user explicitly requests SnFlow, invokes snflow-dev, or continues an active non-terminal SnFlow task. Ordinary development stays outside the workflow by default."
---

# SnFlow development workflow

This is **WebUI SnFlow** (`.pi/snflows/tasks/`), not Trellis (`.trellis/`).
It is an opt-in workflow: chat-orchestrated create → plan → start → implement → check → commit handoff.

Panel (SF) is for visibility/emergency controls. **Do not make the user drive the lifecycle by clicking around.**

## Entry policy (soft gate)

- Default to ordinary direct development. Project initialization only makes SnFlow available; it does not opt every coding request into the workflow.
- Enter SnFlow when the user explicitly asks to use SnFlow, invokes `snflow-dev`, asks to create/run a SnFlow task, or continues an existing non-terminal task.
- For work that is clearly cross-module, high-risk, long-running, or benefits from independent acceptance checks, ask once whether the user wants SnFlow. This is an offer, not a prerequisite.
- Do not create a task from an ambiguous or routine development request. If the user declines or does not opt in, continue directly without SnFlow.
- A completed, cancelled, or archived task never opts subsequent work into SnFlow.

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

- Begin only after the entry policy opts this request into SnFlow.
- Create the task yourself (never tell the user to open SF and press +).
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

### Check decision policy

- `error` means a must-fix blocker: a violated acceptance criterion, incorrect behavior, security or data-loss risk, concrete regression, or required validation failure attributable to the implementation.
- `warning` and `info` are advisory. They may cover optional hardening, maintainability, style, extra tests, or improvements outside the approved scope.
- Return `changes_requested` only when at least one `error` finding exists. Advisory findings must not fail the check.
- Do not expand task scope during check or require unrelated files to be changed.
- After a passing check with advisory findings, report them to the user and let the user choose whether to address them. Do not automatically dispatch another implement loop.

## Optional Spec review command

`/snflow-spec-review` is an explicit, current-task-only learning review. It is optional and never runs automatically after implement/check or blocks `ready_to_commit`.

- Run it only in the main session; never dispatch implement/check or another subagent for this review.
- The managed extension validates the canonical cwd, current non-archived physical task, task documents, and `.pi/snflows/spec/index.md`, then sends a task-bound review prompt to the current Agent.
- The candidate-generation turn is read-only. Read task docs, available run records, applicable Spec files, project `AGENTS.md`, and the relevant diff/callers. Do not edit files, mutate Git/task state, or run mutating shell commands.
- Classify corrected mistakes and stable new designs as `add`, `revise`, `remove`, or `do_not_capture`. Every candidate uses a stable `C<number>` id and includes root cause/context, proposed rule text, applicability, target Spec path, real repo-relative evidence paths, relationship to existing rules, confidence, and uncertainty.
- If nothing is reusable, return exactly `本任务无需更新规范`; never manufacture a rule.
- Present candidates and stop. Candidate generation is not approval. Wait for the user to accept, edit, or reject candidate ids in a later message.
- After explicit confirmation, re-read `.pi/snflows/current.json`, task metadata, selected targets, and affected indexes. Verify selected targets and parent directories are physical paths inside the canonical workspace; reject symlink/junction escapes. Apply only accepted candidates under `.pi/snflows/spec/`, deduplicate, preserve unrelated content, and synchronize affected layer/root indexes.
- If task or Spec state drifted, report the conflict instead of writing stale conclusions. After writeback, report changed files, applied rules, ignored candidates, and residual uncertainty.
- V1 accepts no task id argument, does not review archived/history tasks, does not persist pending candidates outside the conversation, and does not update task status or `AGENTS.md`.

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
