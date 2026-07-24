/**
 * Trellis-like per-turn SnFlow breadcrumbs for the active WebUI task.
 * Injected into chat host system prompt when SnFlow is enabled.
 */

import { getWorkflowCurrentTaskId } from "./workflow-current";
import { getWorkflowTaskDetail, getWorkflowTaskDocumentsPaths } from "./workflow-store";
import { buildDirectSubagentInstruction } from "./workflow-prompts";
import type { WorkflowRunPhase, WorkflowTaskDetail, WorkflowTaskStatus } from "./workflow-types";

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

function directDispatchInstruction(
  cwd: string,
  task: WorkflowTaskDetail,
  phase: WorkflowRunPhase,
): string {
  const paths = getWorkflowTaskDocumentsPaths(cwd, task.id);
  const implementSummary =
    phase === "check"
      ? task.runs.find((run) => run.id === task.latestImplementRunId)?.summary ?? null
      : null;
  return buildDirectSubagentInstruction({
    taskId: task.id,
    title: task.title,
    cwd,
    pathLabels: paths.pathLabels,
    phase,
    implementSummary,
    taskRevision: task.revision,
  });
}

export function buildWorkflowSystemGuidance(cwd: string): string | null {
  try {
    const taskId = getWorkflowCurrentTaskId(cwd);
    if (!taskId) {
      return [
        "<workflow-state:no_task>",
        "No active SnFlow task for this project.",
        "This is Snail Pi Web SnFlow (.pi/snflows/tasks/), NOT Trellis (.trellis/).",
        "Task file contract:",
        "- task.json is mandatory and is the task source of truth.",
        "- task.md is legacy or scratch output only; do not rely on it for the panel.",
        "- A valid task directory should contain: task.json, requirements.md, design.md, and plan.md.",
        "Triage:",
        "- Simple chat: ask whether to create a SnFlow task; if user says no, skip.",
        "- Real dev work: create a task yourself (do not ask the user to click panel +).",
        "Create (preferred):",
        '  npx tsx scripts/workflow-task.ts create "<title>" --seed "<user goal>"',
        "Manual fallback when the CLI fails because of Node/ESM/runtime issues:",
        "- Create .pi/snflows/tasks/<slug>/task.json plus requirements.md, design.md, and plan.md yourself.",
        "- task.json must include schemaVersion:1, id:<slug>, title, description, status:'planning', priority:'P2', createdAt, updatedAt, completedAt:null, revision:'manual', activeRunId:null, latestImplementRunId:null, latestCheckRunId:null, commit:null, archived:false.",
        "- Optionally set .pi/snflows/current.json to { taskId:'<slug>', updatedAt:'<ISO>', source:'agent' }.",
        "After create, verify the SnFlow panel can list the task; if CLI works, also verify with:",
        "  npx tsx scripts/workflow-task.ts show <taskId>",
        "Then stay in planning: edit requirements.md / design.md / plan.md before implement.",
        "User consent to create does not imply consent to implement.",
        "</workflow-state:no_task>",
      ].join("\n");
    }

    const task = getWorkflowTaskDetail(cwd, taskId);
    const base = `.pi/snflows/tasks/${task.id}`;
    const phase = workflowPhaseForStatus(task.status);

    const header = [
      `Active SnFlow task: ${base}`,
      `title: ${task.title}`,
      `status: ${task.status}`,
      `phase: ${phase}`,
      "Namespace: SnFlow only - do not write .trellis/ or run trellis task.py for this task.",
      "Task file contract: task.json is mandatory source-of-truth metadata; requirements.md, design.md, and plan.md are the long-form docs; task.md is not a valid primary SnFlow task record.",
    ];

    if (task.id === "00-bootstrap-spec" && task.status !== "completed" && task.status !== "cancelled") {
      return [
        "<workflow-state:spec_bootstrap>",
        ...header,
        "This special task initializes project specifications directly in the main session.",
        "Read project source and configuration without modifying product files, then edit files under .pi/snflows/spec/ and project-root AGENTS.md.",
        "Do not dispatch implement/check agents or any other subagents for this bootstrap task.",
        "Replace every (To be filled) placeholder with evidence-based conventions and keep all spec index status tables synchronized.",
        `When the spec is complete, manually change ${base}/task.json status to ready_to_commit and update updatedAt.`,
        "Commit remains a user handoff; after the user commits, complete and optionally archive the task.",
        "The task.json status handoff and project-root AGENTS.md are the only writes outside .pi/snflows/spec/ allowed by this branch.",
        "For AGENTS.md: create it if missing, replace only the inclusive SnFlow managed block when both markers exist, or append the block when neither exists.",
        "If only one marker exists or marker order is invalid, stop and report it. Preserve all bytes outside the managed block.",
        "Use the exact <!-- BEGIN SNFLOW SPEC --> / <!-- END SNFLOW SPEC --> block provided in the task plan.",
        "</workflow-state:spec_bootstrap>",
      ].join("\n");
    }

    if (task.status === "planning") {
      return [
        "<workflow-state:planning>",
        ...header,
        "Stay in planning. Load skill workflow-dev if available.",
        `Read first: ${base}/task.json, ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
        "Before development, read .pi/snflows/spec/index.md and relevant layer indexes when present.",
        "Also read the project-root AGENTS.md SnFlow managed section (between <!-- BEGIN SNFLOW SPEC --> and",
        "<!-- END SNFLOW SPEC -->) for spec-reading guidance specific to this project.",
        `Edit docs only through the canonical files: ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
        "Do not create or update task.md as the task authority.",
        "If workflow-task.ts fails because of Node/ESM/runtime issues, update task.json manually instead of blocking on the CLI.",
        "When the user approves implementation, mark the task ready, re-read task.json for its resulting revision, then call the current chat native subagent tool with builtin worker.",
        "The native call must use context:fresh, this canonical cwd, async:false, and clarify:false; its task prompt must begin with the SNFLOW_DISPATCH v1 marker containing the resulting revision.",
        "Do not run workflow-task.ts implement, check, or wait. Do not replace the native lifecycle with a bash wait.",
        "Approval to implement means dispatch the worker subagent — do NOT implement the code yourself in the main session.",
        "The panel Mark Ready action or workflow-task.ts start may perform the planning-to-ready transition.",
        "Do not start large implementation before the task is ready.",
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
      const dispatch =
        task.status === "review_ready"
          ? directDispatchInstruction(cwd, task, "check")
          : task.status === "implementing" || task.status === "checking"
            ? "A marked foreground native subagent call is already active. Do not dispatch a duplicate phase."
            : directDispatchInstruction(cwd, task, "implement");
      return [
        "<workflow-state:in_progress>",
        ...header,
        "Main-session default flow: implement -> check -> ready_to_commit -> user commit -> complete/archive.",
        "The current chat native subagent tool is the only implement/check execution path; its normal tool updates drive the top Subagents panel.",
        dispatch,
        "Before development, read .pi/snflows/spec/index.md and relevant layer indexes when present.",
        "Also read the project-root AGENTS.md SnFlow managed section for spec-reading guidance.",
        "Do NOT edit project source files yourself in the main session for this task; files under .pi/snflows/spec/ are explicitly allowed for specification maintenance.",
        "Recursion guard: if you are already the implement/check child, do not re-dispatch SnFlow agents.",
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
        "If this task produced reusable conventions or lessons, write them to the relevant .pi/snflows/spec/ files and update the spec index status tables.",
        "Also update the project-root AGENTS.md SnFlow managed section if the reading-order or",
        "spec-discovery guidance in that section should change.",
        "After commit: npx tsx scripts/workflow-task.ts complete --hash <git-sha>",
        "Then optional: npx tsx scripts/workflow-task.ts archive",
        "Manual fallback for complete: set task.json status:'completed', completedAt:'<ISO>',",
        "and commit to an object { hash:'<git-sha>', recordedAt:'<ISO>' } - never a plain string.",
        "</workflow-state:ready_to_commit>",
      ].join("\n");
    }

    if (task.status === "completed" || task.status === "cancelled") {
      return [
        "<workflow-state:done>",
        ...header,
        "If this task produced reusable conventions or lessons, write them to the relevant .pi/snflows/spec/ files and update the spec index status tables.",
        "Also update the project-root AGENTS.md SnFlow managed section if the reading-order or",
        "spec-discovery guidance should change for future agents.",
        "Task is terminal. Archive if needed:",
        "  npx tsx scripts/workflow-task.ts archive",
        "Manual fallback for archive: move .pi/snflows/tasks/<id>/ to .pi/snflows/archived/<id>/,",
        "set archived:true and activeRunId:null in task.json, and remove .pi/snflows/current.json if it points at this task.",
        "Or create a new task for new work.",
        "</workflow-state:done>",
      ].join("\n");
    }

    return null;
  } catch {
    return null;
  }
}
