/**
 * SnFlow project extension — injects Trellis-like task breadcrumbs into the
 * system prompt when the project has an active .pi/snflows task store.
 *
 * Self-contained: do not import Snail Pi Web lib modules from here.
 * Installed/updated by the WebUI SnFlow setup (manifest-managed).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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
  return isDirectory(candidate) ? candidate : null;
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

function taskStatus(cwd: string, taskId: string): { id: string; title: string; status: string } | null {
  const active = join(snflowsRoot(cwd), "tasks", taskId, "task.json");
  const archived = join(snflowsRoot(cwd), "archived", taskId, "task.json");
  const record = readJson(active) ?? readJson(archived);
  if (!record || !isValidTaskId(record.id)) return null;
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : taskId;
  const status = typeof record.status === "string" ? record.status : "planning";
  return { id: record.id, title, status };
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

  if (task.status === "planning") {
    return [
      "<workflow-state:planning>",
      ...header,
      "Stay in planning. Load skill snflow-dev if available.",
      `Read first: ${base}/task.json, ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
      `Edit docs only through the canonical files: ${base}/requirements.md, ${base}/design.md, ${base}/plan.md`,
      "Do not create or update task.md as the task authority.",
      "When the user approves implementation, do all of this in the same turn without asking again:",
      "  npx tsx scripts/snflow-task.ts start",
      "  npx tsx scripts/snflow-task.ts implement",
      "  npx tsx scripts/snflow-task.ts wait",
      "Approval to implement means dispatch the worker subagent — do NOT implement the code yourself in the main session.",
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
      "You are the orchestrator. Implementation MUST run in the worker subagent, not the main session:",
      "  npx tsx scripts/snflow-task.ts implement",
      "  npx tsx scripts/snflow-task.ts wait",
      "  npx tsx scripts/snflow-task.ts check",
      "  npx tsx scripts/snflow-task.ts wait",
      "Do NOT edit project source files yourself in the main session for this task.",
      "Sole inline exception: trivial fixes of roughly <=10 lines with no new files; still run check afterwards.",
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
