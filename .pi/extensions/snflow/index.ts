/**
 * SnFlow project extension — injects Trellis-like task breadcrumbs into the
 * system prompt when the project has an active .pi/snflows task store.
 *
 * Self-contained: do not import Snail Pi Web lib modules from here.
 * Installed/updated by the WebUI SnFlow setup (manifest-managed).
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface PiExtensionAPI {
  on?: (
    event: string,
    handler: (event: Record<string, unknown>, ctx: { cwd?: string }) => unknown,
  ) => void;
}

const ROOT_SEGMENTS = [".pi", "snflows"] as const;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

function readJson(filePath: string): JsonObject | null {
  try {
    if (!isFile(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isValidTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function resolveCwd(ctxCwd: string | undefined): string | null {
  const candidate = typeof ctxCwd === "string" && ctxCwd.trim() ? ctxCwd.trim() : "";
  if (!candidate) return null;
  if (!isDirectory(candidate)) return null;
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function snflowsRoot(cwd: string): string {
  return join(cwd, ...ROOT_SEGMENTS);
}

function isInitialized(cwd: string): boolean {
  return isDirectory(join(snflowsRoot(cwd), "tasks"));
}

function currentTaskId(cwd: string): string | null {
  const pointer = readJson(join(snflowsRoot(cwd), "current.json"));
  if (!pointer || !isValidTaskId(pointer.taskId)) return null;
  return pointer.taskId;
}

function taskStatus(cwd: string, taskId: string): { id: string; title: string; status: string; revision: string | null } | null {
  const active = join(snflowsRoot(cwd), "tasks", taskId, "task.json");
  const archived = join(snflowsRoot(cwd), "archived", taskId, "task.json");
  const record = readJson(active) ?? readJson(archived);
  if (!record || !isValidTaskId(record.id)) return null;
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : taskId;
  const status = typeof record.status === "string" ? record.status : "planning";
  const revision = typeof record.revision === "string" && /^[a-f0-9]{16}$/.test(record.revision)
    ? record.revision
    : null;
  return { id: record.id, title, status, revision };
}

function directDispatch(cwd: string, task: { id: string; title: string; revision: string | null }, phase: "implement" | "check"): string {
  if (!task.revision) {
    return "Task revision is missing or stale. Open/save the task in SnFlow before dispatch; fail closed instead of inventing a revision.";
  }
  const agent = phase === "implement" ? "snflow-implement" : "snflow-check";
  const marker = "SNFLOW_DISPATCH " + JSON.stringify({
    v: 1,
    taskId: task.id,
    phase,
    revision: task.revision,
    cwd,
  });
  return [
    "Call the current chat native subagent tool once (foreground, not CLI/RPC wait):",
    "- agent: " + agent,
    "- context: fresh",
    "- cwd: " + cwd,
    "- async: false",
    "- clarify: false",
    "- task first line must be exactly:",
    marker,
    "After the marker, provide the task id/title/revision, task document and spec paths, latest implement summary when checking, focused validation expectations, and the structured result contract.",
    "Do not run scripts/snflow-task.ts implement, check, or wait.",
  ].join("\n");
}

function phaseForStatus(status: string): "plan" | "execute" | "finish" | "idle" {
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

function buildGuidance(cwd: string): string | null {
  if (!isInitialized(cwd)) return null;

  const taskId = currentTaskId(cwd);
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
      '  npx tsx scripts/snflow-task.ts create "<title>" --seed "<user goal>"',
      "If the project CLI wrapper cannot resolve Snail Pi Web, use the panel Create action or write the task files manually under .pi/snflows/tasks/<slug>/.",
      "Manual fallback task.json must include schemaVersion:1, id:<slug>, title, description, status:'planning', priority:'P2', createdAt, updatedAt, completedAt:null, revision:'manual', activeRunId:null, latestImplementRunId:null, latestCheckRunId:null, commit:null, archived:false.",
      "Optionally set .pi/snflows/current.json to { taskId:'<slug>', updatedAt:'<ISO>', source:'agent' }.",
      "Then stay in planning: edit requirements.md / design.md / plan.md before implement.",
      "User consent to create does not imply consent to implement.",
      "</workflow-state:no_task>",
    ].join("\n");
  }

  const task = taskStatus(cwd, taskId);
  if (!task) {
    return [
      "<workflow-state:no_task>",
      `Current pointer taskId=${taskId} is missing or unreadable.`,
      "Fix .pi/snflows/current.json or recreate the task under .pi/snflows/tasks/.",
      "</workflow-state:no_task>",
    ].join("\n");
  }

  const base = `.pi/snflows/tasks/${task.id}`;
  const phase = phaseForStatus(task.status);
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
      "When the spec is complete, manually change " + base + "/task.json status to ready_to_commit and update updatedAt.",
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
      "Stay in planning. Load skill snflow-dev if available.",
      `Read first: ${base}/task.json, ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
      "Before development, read .pi/snflows/spec/index.md and relevant layer indexes when present.",
      "Also read the project-root AGENTS.md SnFlow managed section (between <!-- BEGIN SNFLOW SPEC --> and",
      "<!-- END SNFLOW SPEC -->) for spec-reading guidance specific to this project.",
      `Edit docs only through the canonical files: ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
      "Do not create or update task.md as the task authority.",
      "When the user approves implementation, mark the task ready, re-read task.json for its resulting revision, then dispatch the project agent snflow-implement.",
      "Use context:fresh, this canonical cwd, async:false and clarify:false. The task prompt must begin with the SNFLOW_DISPATCH v1 marker containing the resulting revision.",
      "Approval to implement means dispatch snflow-implement; the main session remains the orchestrator.",
      "The panel Mark Ready action or scripts/snflow-task.ts start may perform the planning-to-ready transition.",
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
    const dispatch = task.status === "review_ready"
      ? directDispatch(cwd, task, "check")
      : task.status === "implementing" || task.status === "checking"
        ? "A marked foreground native subagent call is already active. Do not dispatch a duplicate phase."
        : directDispatch(cwd, task, "implement");
    return [
      "<workflow-state:in_progress>",
      ...header,
      "Main-session default flow: implement -> check -> ready_to_commit -> user commit -> complete/archive.",
      "The current chat native subagent tool is the only implement/check path; its tool updates drive the top Subagents panel.",
      dispatch,
      "The main session coordinates lifecycle and spec maintenance; the dispatched phase agent owns product-source implementation or review.",
      "Read the task documents and applicable spec indexes before dispatch, and hand commit control back to the user after check passes.",
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
      "After commit: npx tsx scripts/snflow-task.ts complete --hash <git-sha>",
      "Then optional: npx tsx scripts/snflow-task.ts archive",
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
      "  npx tsx scripts/snflow-task.ts archive",
      "Manual fallback for archive: move .pi/snflows/tasks/<id>/ to .pi/snflows/archived/<id>/,",
      "set archived:true and activeRunId:null in task.json, and remove .pi/snflows/current.json if it points at this task.",
      "Or create a new task for new work.",
      "</workflow-state:done>",
    ].join("\n");
  }

  return null;
}

export default function snflowExtension(pi: PiExtensionAPI): void {
  pi.on?.("before_agent_start", (event, ctx) => {
    try {
      // Never force main-session SnFlow orchestration onto subagent children.
      if (process.env.PI_SUBAGENT_CHILD === "1") return;
      // WebUI host can disable SnFlow for a session without deleting project files.
      const webFlag = process.env.PI_WEB_SNFLOW_ENABLED;
      if (webFlag === "0" || webFlag === "false") return;
      const cwd = resolveCwd(ctx?.cwd);
      if (!cwd) return;
      // Only initialized projects opted into SnFlow (tasks/ exists).
      if (!isInitialized(cwd)) return;
      const guidance = buildGuidance(cwd);
      if (!guidance) return;
      const current = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      return {
        systemPrompt: current ? `${current}\n\n${guidance}` : guidance,
      };
    } catch {
      // Guidance is best-effort; never block the agent turn.
      return;
    }
  });
}
