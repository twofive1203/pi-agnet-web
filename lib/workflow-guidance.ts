/**
 * Trellis-like per-turn workflow breadcrumbs for the active WebUI Workflow task.
 * Injected into chat host system prompt when Workflow is enabled.
 */

import { getWorkflowCurrentTaskId } from "./workflow-current";
import { getWorkflowTaskDetail } from "./workflow-store";
import type { WorkflowTaskStatus } from "./workflow-types";

export type WorkflowPhaseLabel = "plan" | "execute" | "finish" | "idle";

export function workflowPhaseForStatus(status: WorkflowTaskStatus): WorkflowPhaseLabel {
  switch (status) {
    case "planning":
      return "plan";
    case "ready":
    case "implementing":
    case "review_ready":
    case "checking":
    case "changes_requested":
    case "failed":
      return "execute";
    case "ready_to_commit":
    case "completed":
    case "cancelled":
      return "finish";
    default:
      return "idle";
  }
}

export function buildWorkflowSystemGuidance(cwd: string): string | null {
  try {
    const taskId = getWorkflowCurrentTaskId(cwd);
    if (!taskId) {
      return [
        "<workflow-state:no_task>",
        "No active WebUI Workflow task for this project.",
        "This is Snail Pi Web native Workflow (.pi/workflows/tasks/), NOT Trellis (.trellis/).",
        "Task file contract:",
        "- task.json is mandatory and is the task source of truth.",
        "- task.md is legacy or scratch output only; do not rely on it for the panel.",
        "- A valid task directory should contain: task.json, requirements.md, design.md, and plan.md.",
        "Triage:",
        "- Simple chat: ask whether to create a Workflow task; if user says no, skip.",
        "- Real dev work: create a task yourself (do not ask the user to click panel +).",
        "Create (preferred):",
        '  npx tsx scripts/workflow-task.ts create "<title>" --seed "<user goal>"',
        "Manual fallback when the CLI fails because of Node/ESM/runtime issues:",
        "- Create .pi/workflows/tasks/<slug>/task.json plus requirements.md, design.md, and plan.md yourself.",
        "- task.json must include schemaVersion:1, id:<slug>, title, description, status:'planning', priority:'P2', createdAt, updatedAt, completedAt:null, revision:'manual', activeRunId:null, latestImplementRunId:null, latestCheckRunId:null, commit:null, archived:false.",
        "- Optionally set .pi/workflows/current.json to { taskId:'<slug>', updatedAt:'<ISO>', source:'agent' }.",
        "After create, verify the W panel can list the task; if CLI works, also verify with:",
        "  npx tsx scripts/workflow-task.ts show <taskId>",
        "Then stay in planning: edit requirements.md / design.md / plan.md before implement.",
        "User consent to create ≠ consent to implement.",
        "</workflow-state:no_task>",
      ].join("\n");
    }

    const task = getWorkflowTaskDetail(cwd, taskId);
    const base = `.pi/workflows/tasks/${task.id}`;
    const phase = workflowPhaseForStatus(task.status);

    const header = [
      `Active workflow task: ${base}`,
      `title: ${task.title}`,
      `status: ${task.status}`,
      `phase: ${phase}`,
      "Namespace: WebUI Workflow only — do not write .trellis/ or run trellis task.py for this task.",
      "Task file contract: task.json is mandatory source-of-truth metadata; requirements.md, design.md, and plan.md are the long-form docs; task.md is not a valid primary Workflow task record.",
    ];

    if (task.status === "planning") {
      return [
        "<workflow-state:planning>",
        ...header,
        "Stay in planning. Load skill workflow-dev if available.",
        `Read first: ${base}/task.json, ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
        `Edit docs only through the canonical files: ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
        "Do not create or update task.md as the task authority.",
        "If workflow-task.ts fails because of Node/ESM/runtime issues, update task.json manually instead of blocking on the CLI.",
        "When artifacts are ready and user approves implementation:",
        "  npx tsx scripts/workflow-task.ts start",
        "Manual fallback for start: change task.json status from planning to ready and update updatedAt.",
        "Do not start large implementation before start.",
        "</workflow-state:planning>",
      ].join("\n");
    }

    if (
      task.status === "ready" ||
      task.status === "implementing" ||
      task.status === "review_ready" ||
      task.status === "checking" ||
      task.status === "changes_requested" ||
      task.status === "failed"
    ) {
      return [
        "<workflow-state:in_progress>",
        ...header,
        "Main-session default flow (Trellis-like):",
        "  implement -> check -> ready_to_commit -> user commit -> complete/archive",
        "Dispatch from chat (preferred, no panel clicking):",
        "  npx tsx scripts/workflow-task.ts implement",
        "  npx tsx scripts/workflow-task.ts check",
        "  npx tsx scripts/workflow-task.ts wait",
        "Or use native subagent worker/reviewer with the same Active workflow task header,",
        "then record outcome with: npx tsx scripts/workflow-task.ts sync",
        "Recursion guard: if you are already the implement/check child, do not re-dispatch workflow agents.",
        "Never git commit/push/PR unless the user explicitly asks.",
        "Read task docs before editing code.",
        "</workflow-state:in_progress>",
      ].join("\n");
    }

    if (task.status === "ready_to_commit") {
      return [
        "<workflow-state:ready_to_commit>",
        ...header,
        "Check passed. Hand off commit to the user (do not commit unless asked).",
        "After commit: npx tsx scripts/workflow-task.ts complete --hash <git-sha>",
        "Then optional: npx tsx scripts/workflow-task.ts archive",
        "</workflow-state:ready_to_commit>",
      ].join("\n");
    }

    if (task.status === "completed" || task.status === "cancelled") {
      return [
        "<workflow-state:done>",
        ...header,
        "Task is terminal. Archive if needed:",
        "  npx tsx scripts/workflow-task.ts archive",
        "Or create a new task for new work.",
        "</workflow-state:done>",
      ].join("\n");
    }

    return null;
  } catch {
    return null;
  }
}
