---
name: workflow-dev
description: "Use Snail Pi Web native Workflow tasks under .pi/workflows/tasks/ for development work. Create tasks from chat (like Trellis task.py create), maintain requirements/design/plan, and guide implement/check via the Workflow panel or CLI. Prefer this over Trellis when the user wants WebUI-owned workflow or the project has no .trellis."
---

# Native WebUI Workflow — Trellis-like flow

This is **WebUI Workflow** (`.pi/workflows/tasks/`), not Trellis (`.trellis/`).
The **user experience should feel like Trellis**: chat-orchestrated create → plan → start → implement → check → commit handoff.

Panel (W) is for visibility/emergency controls. **Do not make the user drive the lifecycle by clicking around.**

## Phase index (mirror Trellis)

```
Phase 1 Plan    → consent + create + requirements/design/plan
Phase 2 Execute → start + implement + check loops
Phase 3 Finish  → ready_to_commit + user commit + complete/archive
```

## CLI (preferred agent interface)

```bash
npx tsx scripts/workflow-task.ts create "<title>" --seed "<user goal>"
npx tsx scripts/workflow-task.ts current
npx tsx scripts/workflow-task.ts show
npx tsx scripts/workflow-task.ts start
npx tsx scripts/workflow-task.ts implement
npx tsx scripts/workflow-task.ts wait
npx tsx scripts/workflow-task.ts check
npx tsx scripts/workflow-task.ts wait
npx tsx scripts/workflow-task.ts complete --hash <sha>   # after user commits
npx tsx scripts/workflow-task.ts archive
```

If the CLI fails because of Node/ESM/runtime compatibility, use the manual file fallback instead of producing an incomplete markdown-only task.

Manual fallback task layout:

```text
.pi/workflows/tasks/<slug>/
  task.json
  requirements.md
  design.md
  plan.md
.pi/workflows/current.json   # optional current pointer
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

`task.md` is not a valid primary Workflow record. It can exist as scratch text, but the W panel reads `task.json`.

After create/start, always acknowledge:

```text
Active workflow task: .pi/workflows/tasks/<id>
```

## Phase 1 — Plan

### 1.0 Create task
- Simple chat: ask if a Workflow task is needed; skip if user says no.
- Real dev work: create the task yourself (never tell user to open W and press +).
- Preferred command: `create "<title>" --seed "..."`
- If the command fails, manually create `task.json`, `requirements.md`, `design.md`, and `plan.md` using the fallback schema above.
- Status becomes `planning`. Current pointer is set automatically by CLI, or manually through `.pi/workflows/current.json` when using fallback.

### 1.1 Artifacts
Edit:
- `requirements.md` (goals, requirements, acceptance, out of scope)
- `design.md` (for complex work)
- `plan.md` (ordered implementation + validation)

Consent to create ≠ consent to implement. Stay in planning until review.

### 1.2 Activate
When user approves implementation:

```bash
npx tsx scripts/workflow-task.ts start
```

Status → `ready`.

## Phase 2 — Execute

Main session orchestrates (like Trellis main session):

```bash
npx tsx scripts/workflow-task.ts implement
npx tsx scripts/workflow-task.ts wait
npx tsx scripts/workflow-task.ts check
npx tsx scripts/workflow-task.ts wait
```

- `implement` dispatches builtin `worker` via native pi-subagents (cwd-bound).
- `check` dispatches builtin `reviewer`.
- On check pass → `ready_to_commit`.
- On changes requested → `changes_requested` → another implement loop.

### Recursion guards
- If you are already the implement/check child, do **not** re-dispatch workflow implement/check.
- Only the main session should run `implement` / `check` commands.

### Alternative
You may implement small fixes inline in the main session after `start`, then still run `check`.

## Phase 3 — Finish

- Do **not** git commit/push/PR unless user explicitly asks.
- After user commits:

```bash
npx tsx scripts/workflow-task.ts complete --hash <git-sha>
npx tsx scripts/workflow-task.ts archive
```

## Hard rules

- Never write `.trellis/` for this workflow
- Never run `python ./.trellis/scripts/task.py` for Workflow tasks
- Prefer CLI over asking the user to click panel buttons, but use the manual file fallback when CLI/runtime compatibility breaks
- Keep one writer on the working tree
- Fail closed on missing cwd/task context; print diagnostics
