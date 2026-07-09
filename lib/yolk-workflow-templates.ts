import type { YolkTaskDocumentName, YolkWorkflowDefinition } from "./yolk-types";

export const YOLK_WORKFLOW_VERSION = "0.1.3";
export const YOLK_MANIFEST_PATH = ".yolk/manifest.json";
export const YOLK_TASKS_PATH = ".yolk/tasks";

export interface YolkManagedTemplate {
  path: string;
  templateVersion: string;
  content: string;
}

export const YOLK_ARTIFACTS: YolkTaskDocumentName[] = ["prd.md", "design.md", "implement.md", "check.md"];

export const DEFAULT_YOLK_WORKFLOW: YolkWorkflowDefinition = {
  schemaVersion: 1,
  name: "Yolk Workflow",
  statuses: ["planning", "in_progress", "review", "completed"],
  artifacts: YOLK_ARTIFACTS,
  defaultStatus: "planning",
};

const WORKFLOW_EXTENSION = String.raw`import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";

type JsonObject = Record<string, unknown>;

type ToolText = { type: "text"; text: string };
interface ToolResult {
  content: ToolText[];
  details?: unknown;
}

interface ExtensionContext {
  cwd?: string;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
}

interface YolkTaskInput {
  action?: "create" | "list" | "read" | "update_status";
  title?: string;
  taskId?: string;
  status?: "planning" | "in_progress" | "review" | "completed";
  priority?: "P0" | "P1" | "P2" | "P3";
  assignee?: string;
  prd?: string;
  notes?: string;
}

interface ExtensionApi {
  registerTool?: (tool: JsonObject) => void;
  registerCommand?: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionContext) => unknown }) => void;
  on?: (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => void;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson(path: string): JsonObject | null {
  try {
    const parsed = JSON.parse(readText(path)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function enabled(root: string): boolean {
  const manifest = readJson(join(root, ".yolk", "manifest.json"));
  return manifest?.enabled === true;
}

function safeTitle(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 180) : "";
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
  return slug || "task";
}

function datePrefix(): string {
  const now = new Date();
  return String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

function taskIdForTitle(title: string): string {
  return datePrefix() + "-" + slugify(title) + "-" + randomBytes(3).toString("hex");
}

function taskPath(root: string, taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error("Invalid yolk task id");
  return join(root, ".yolk", "tasks", taskId);
}

function readTask(root: string, taskId: string): JsonObject | null {
  return readJson(join(taskPath(root, taskId), "task.json"));
}

function listTasks(root: string): JsonObject[] {
  const tasksDir = join(root, ".yolk", "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTask(root, entry.name))
    .filter((task): task is JsonObject => !!task)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function createTask(root: string, input: YolkTaskInput): JsonObject {
  const title = safeTitle(input.title);
  if (!title) throw new Error("title is required");
  const tasksDir = join(root, ".yolk", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  let id = taskIdForTitle(title);
  let dir = join(tasksDir, id);
  for (let attempt = 0; existsSync(dir) && attempt < 5; attempt += 1) {
    id = taskIdForTitle(title);
    dir = join(tasksDir, id);
  }
  if (existsSync(dir)) throw new Error("Could not create a unique yolk task id");
  const now = new Date().toISOString();
  const task = {
    schemaVersion: 1,
    id,
    title,
    status: "planning",
    priority: input.priority || "P2",
    assignee: typeof input.assignee === "string" && input.assignee.trim() ? input.assignee.trim() : undefined,
    parent: null,
    children: [],
    createdAt: now,
    updatedAt: now,
    notes: typeof input.notes === "string" ? input.notes : "",
  };
  mkdirSync(dir, { recursive: false });
  writeJson(join(dir, "task.json"), task);
  const prd = typeof input.prd === "string" && input.prd.trim()
    ? input.prd.trim() + "\n"
    : "# " + title + "\n\n## Goal\n\nTBD.\n";
  writeFileSync(join(dir, "prd.md"), prd, "utf8");
  return task;
}

function updateTaskStatus(root: string, input: YolkTaskInput): JsonObject {
  if (!input.taskId) throw new Error("taskId is required");
  if (!input.status) throw new Error("status is required");
  const dir = taskPath(root, input.taskId);
  const task = readTask(root, input.taskId);
  if (!task) throw new Error("Yolk task not found: " + input.taskId);
  task.status = input.status;
  task.updatedAt = new Date().toISOString();
  if (typeof input.notes === "string") task.notes = input.notes;
  writeJson(join(dir, "task.json"), task);
  return task;
}

function toolText(text: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function workspaceRoot(ctx?: ExtensionContext): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
}

function buildContext(root: string): string {
  if (!enabled(root)) return "";
  const workflow = readJson(join(root, ".yolk", "workflow.json"));
  const tasksDir = join(root, ".yolk", "tasks");
  const parts = [
    "## Yolk Workflow Context",
    "This workspace uses the project-local yolk native development workflow.",
    "Workflow state lives under .yolk/ and project-local Pi resources use yolk-* names.",
  ];
  if (workflow) {
    const statuses = Array.isArray(workflow.statuses) ? workflow.statuses.filter((item) => typeof item === "string").join(", ") : "";
    if (typeof workflow.name === "string") parts.push("Workflow: " + workflow.name);
    if (statuses) parts.push("Statuses: " + statuses);
  }
  if (existsSync(tasksDir)) parts.push("Tasks path: .yolk/tasks");
  parts.push("Use yolk_task to create/list/read/update .yolk tasks from chat when the user describes a new feature, bug, or work item.");
  parts.push("Use /yolk-new-task <title> prompt template for explicit user-driven task creation from chat.");
  parts.push("Use /yolk-continue or the WebUI Workflow panel when continuing a specific yolk task.");
  return parts.join("\n");
}

const YOLK_TASK_PARAMS = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("read"), Type.Literal("update_status")], { description: "Task operation." })),
  title: Type.Optional(Type.String({ description: "Task title for create." })),
  taskId: Type.Optional(Type.String({ description: "Yolk task id for read or update_status." })),
  status: Type.Optional(Type.Union([Type.Literal("planning"), Type.Literal("in_progress"), Type.Literal("review"), Type.Literal("completed")], { description: "New status for update_status." })),
  priority: Type.Optional(Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2"), Type.Literal("P3")], { description: "Priority for create." })),
  assignee: Type.Optional(Type.String({ description: "Optional assignee for create." })),
  prd: Type.Optional(Type.String({ description: "Optional initial prd.md content for create." })),
  notes: Type.Optional(Type.String({ description: "Optional task notes." })),
});

export default function yolkWorkflowExtension(pi: ExtensionApi): void {
  pi.registerTool?.({
    name: "yolk_task",
    label: "Yolk Task",
    description: "Create, list, read, or update project-local Yolk workflow tasks under .yolk/tasks.",
    promptSnippet: "Manage project-local Yolk workflow tasks under .yolk/tasks.",
    promptGuidelines: [
      "Use yolk_task with action=create when the user describes a new feature, bug, or work item and no suitable active Yolk task exists.",
      "Use yolk_task instead of direct file writes for creating or updating .yolk task metadata.",
      "Do not use Trellis CLI or .trellis task state for Yolk workflow tasks."
    ],
    parameters: YOLK_TASK_PARAMS,
    execute: async (_id: string, input: YolkTaskInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      const root = workspaceRoot(ctx);
      if (!enabled(root)) return toolText("Yolk workflow is not enabled for this workspace.", { enabled: false, cwd: root });
      const action = input.action || "list";
      if (action === "create") {
        const task = createTask(root, input);
        const text = [
          "Created Yolk task: " + task.title,
          "Task id: " + task.id,
          "Task directory: .yolk/tasks/" + task.id,
          "Next: inspect .yolk/tasks/" + task.id + "/prd.md and continue planning."
        ].join("\n");
        return toolText(text, { task });
      }
      if (action === "read") {
        if (!input.taskId) throw new Error("taskId is required");
        const task = readTask(root, input.taskId);
        if (!task) throw new Error("Yolk task not found: " + input.taskId);
        return toolText(JSON.stringify(task, null, 2), { task });
      }
      if (action === "update_status") {
        const task = updateTaskStatus(root, input);
        return toolText("Updated Yolk task " + task.id + " status to " + task.status + ".", { task });
      }
      const tasks = listTasks(root);
      const text = tasks.length
        ? tasks.map((task) => String(task.id) + " · " + String(task.status) + " · " + String(task.title)).join("\n")
        : "No Yolk tasks found.";
      return toolText(text, { tasks });
    }
  });

  pi.registerCommand?.("yolk-status", {
    description: "Show project-local Yolk workflow status",
    handler: async (_args, ctx) => {
      const root = workspaceRoot(ctx);
      const active = enabled(root);
      const message = active
        ? "Yolk workflow is enabled for this workspace."
        : "Yolk workflow is not enabled for this workspace.";
      ctx.ui?.notify?.(message, active ? "info" : "warning");
      return message;
    },
  });

  pi.on?.("session_start", (_event, ctx) => {
    const root = workspaceRoot(ctx);
    if (enabled(root)) ctx?.ui?.notify?.("Yolk workflow context is available. Use /yolk-new-task <title> or let the agent call yolk_task for new work.", "info");
  });

  pi.on?.("before_agent_start", (event, ctx) => {
    const root = workspaceRoot(ctx);
    const context = buildContext(root);
    if (!context) return undefined;
    const current = (event as { systemPrompt?: string }).systemPrompt ?? "";
    return { systemPrompt: [current, context].filter(Boolean).join("\n\n") };
  });
}
`;

const YOLK_CONTINUE_PROMPT = `# Continue Yolk Task

Continue work using the project-local yolk workflow.

1. Inspect .yolk/manifest.json and .yolk/workflow.json.
2. Inspect the relevant .yolk/tasks/<task-id>/task.json and markdown artifacts.
3. Restore the current task status and summarize the next concrete step.
4. If the user is describing a new work item instead of continuing an existing one, create a task with yolk_task or /yolk-new-task.
5. Do not use Trellis CLI or .trellis conventions for yolk workflow state.
`;

const YOLK_FINISH_WORK_PROMPT = `# Finish Yolk Work

Wrap up the current yolk workflow task.

1. Review the active .yolk task metadata and artifacts.
2. Check whether implementation and validation notes are captured.
3. Use yolk_task action=update_status when status should move to review or completed.
4. Summarize remaining risks and recommended follow-up.
5. Do not delete .yolk or yolk-prefixed .pi resources.
`;

const YOLK_NEW_TASK_PROMPT = `---
description: Create a new Yolk workflow task from chat
argumentHint: <title>
---

Create a new Yolk workflow task for this work item.

Requested title or description:
$ARGUMENTS

Instructions:
1. If the requested title/description is empty, ask me for the task title and do not call tools yet.
2. Use the yolk_task tool with action=create. Set title from the request, priority P2 unless the request clearly implies another priority, and write a concise prd.md seed from the request.
3. After creating the task, report the task id and path .yolk/tasks/<task-id>.
4. Do not start implementation unless I explicitly ask you to continue.
5. Do not use Trellis CLI or .trellis task state.
`;

const YOLK_IMPLEMENT_AGENT = `---
name: yolk-implement
description: Implement code changes using project-local yolk workflow context. No git commit allowed.
---

You are a yolk workflow implementation agent.

- Read the active .yolk task context before changing code.
- If no active task exists for the user's work item, ask the parent to create one with yolk_task first.
- Follow project documentation and local coding standards.
- Keep changes scoped to the task.
- Do not call Trellis CLI or depend on .trellis runtime files.
- Report changed files and validation results.
`;

const YOLK_CHECK_AGENT = `---
name: yolk-check
description: Review and verify code changes using project-local yolk workflow context.
---

You are a yolk workflow check agent.

- Review changes against the active .yolk task artifacts and project standards.
- Prioritize regressions, missing requirements, unsafe writes, and validation gaps.
- Fix in-scope issues when safe.
- Do not call Trellis CLI or depend on .trellis runtime files.
- Report findings, fixes, and validation results.
`;

const YOLK_RESEARCH_AGENT = `---
name: yolk-research
description: Gather focused codebase or technical research for a yolk workflow task.
---

You are a yolk workflow research agent.

- Inspect relevant local code and docs before making claims.
- Save durable findings into the active .yolk task artifacts when asked.
- Keep output concise and implementation-oriented.
- Do not call Trellis CLI or depend on .trellis runtime files.
`;

export const YOLK_MANAGED_TEMPLATES: YolkManagedTemplate[] = [
  {
    path: ".yolk/workflow.json",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: `${JSON.stringify(DEFAULT_YOLK_WORKFLOW, null, 2)}\n`,
  },
  {
    path: ".pi/extensions/yolk-workflow/index.ts",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: `${WORKFLOW_EXTENSION}\n`,
  },
  {
    path: ".pi/prompts/yolk-continue.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_CONTINUE_PROMPT,
  },
  {
    path: ".pi/prompts/yolk-finish-work.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_FINISH_WORK_PROMPT,
  },
  {
    path: ".pi/prompts/yolk-new-task.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_NEW_TASK_PROMPT,
  },
  {
    path: ".pi/agents/yolk-implement.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_IMPLEMENT_AGENT,
  },
  {
    path: ".pi/agents/yolk-check.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_CHECK_AGENT,
  },
  {
    path: ".pi/agents/yolk-research.md",
    templateVersion: YOLK_WORKFLOW_VERSION,
    content: YOLK_RESEARCH_AGENT,
  },
];

export const YOLK_ALLOWED_MANAGED_PATHS = new Set<string>([
  YOLK_MANIFEST_PATH,
  YOLK_TASKS_PATH,
  ...YOLK_MANAGED_TEMPLATES.map((template) => template.path),
]);
