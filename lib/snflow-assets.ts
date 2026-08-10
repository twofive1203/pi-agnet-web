/**
 * Bundled SnFlow project assets (extension / skill / agents / script).
 * Embedded as string constants so Next.js production builds never depend on
 * reading an on-disk templates directory from a fragile package path.
 *
 * Bump SNFLOW_ASSETS_VERSION (SemVer) whenever any managed file content changes.
 */

export const SNFLOW_ASSETS_VERSION = "1.9.0";

export interface SnflowAssetFile {
  /** Project-relative path using forward slashes. */
  path: string;
  content: string;
}

const EXTENSION_INDEX = `/**
 * SnFlow project extension — injects opt-in task breadcrumbs into the system
 * prompt when the project has an available .pi/snflows task store.
 *
 * Self-contained: do not import Snail Pi Web lib modules from here.
 * Installed/updated by the WebUI SnFlow setup (manifest-managed).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

type ExtensionCommandContext = {
  cwd?: string;
  isIdle?: () => boolean;
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
};

interface PiExtensionAPI {
  on?: (
    event: string,
    handler: (event: Record<string, unknown>, ctx: { cwd?: string }) => unknown,
  ) => void;
  registerCommand?: (
    name: string,
    command: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => unknown;
    },
  ) => void;
  sendUserMessage?: (content: string) => void;
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

function isPhysicalDirectory(target: string): boolean {
  try {
    return existsSync(target) && !lstatSync(target).isSymbolicLink() && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isPhysicalFile(target: string): boolean {
  try {
    return existsSync(target) && !lstatSync(target).isSymbolicLink() && statSync(target).isFile();
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

type SpecReviewTask = {
  id: string;
  title: string;
  status: string;
  revision: string;
};

type SpecReviewResolution =
  | { ok: true; task: SpecReviewTask }
  | { ok: false; message: string };

function resolveSpecReviewTask(cwd: string): SpecReviewResolution {
  const piDir = join(cwd, ".pi");
  const root = snflowsRoot(cwd);
  const tasksDir = join(root, "tasks");
  if (!isPhysicalDirectory(piDir) || !isPhysicalDirectory(root) || !isPhysicalDirectory(tasksDir)) {
    return { ok: false, message: "SnFlow is not initialized through physical project directories, or its task store is unsafe." };
  }
  const currentPath = join(root, "current.json");
  if (!existsSync(currentPath)) {
    return { ok: false, message: "No current SnFlow task. Create or select a task before running /snflow-spec-review." };
  }
  if (!isPhysicalFile(currentPath)) {
    return { ok: false, message: "SnFlow current.json must be a physical project file; linked or non-file pointers are rejected." };
  }
  const taskId = currentTaskId(cwd);
  if (!taskId) {
    return { ok: false, message: "The current SnFlow task pointer is malformed. Select the task again before running /snflow-spec-review." };
  }
  if (taskId === "00-bootstrap-spec") {
    return { ok: false, message: "The specification bootstrap task already owns initial Spec authoring; follow its plan instead of running /snflow-spec-review." };
  }

  const taskDir = join(snflowsRoot(cwd), "tasks", taskId);
  if (!isPhysicalDirectory(taskDir)) {
    return { ok: false, message: \`Current SnFlow task \${taskId} is missing from .pi/snflows/tasks/ or is not a physical directory.\` };
  }
  const taskJson = join(taskDir, "task.json");
  if (!isPhysicalFile(taskJson)) {
    return { ok: false, message: \`Current SnFlow task \${taskId} has no readable physical task.json.\` };
  }
  const record = readJson(taskJson);
  if (
    !record ||
    record.id !== taskId ||
    record.archived === true ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    typeof record.status !== "string" ||
    !record.status.trim() ||
    typeof record.revision !== "string" ||
    !record.revision.trim()
  ) {
    return { ok: false, message: \`Current SnFlow task \${taskId} has malformed or archived task metadata.\` };
  }
  for (const name of ["requirements.md", "design.md", "plan.md"]) {
    if (!isPhysicalFile(join(taskDir, name))) {
      return { ok: false, message: \`Current SnFlow task \${taskId} is missing physical \${name}.\` };
    }
  }
  const specDir = join(snflowsRoot(cwd), "spec");
  if (!isPhysicalDirectory(specDir) || !isPhysicalFile(join(specDir, "index.md"))) {
    return { ok: false, message: "SnFlow project Spec is missing .pi/snflows/spec/index.md. Initialize or repair the project Spec first." };
  }
  return {
    ok: true,
    task: {
      id: taskId,
      title: record.title.trim(),
      status: record.status.trim(),
      revision: record.revision.trim(),
    },
  };
}

function buildSpecReviewPrompt(cwd: string, task: SpecReviewTask): string {
  const base = \`.pi/snflows/tasks/\${task.id}\`;
  return [
    "SNFLOW_SPEC_REVIEW v1",
    "",
    \`Review reusable project lessons from the current SnFlow task \${task.id}: \${task.title}\`,
    \`Project cwd: \${cwd}\`,
    \`Task status: \${task.status}\`,
    \`Task revision: \${task.revision}\`,
    "",
    "This is a candidate-generation turn in the current main Agent. Do not dispatch subagents.",
    "This turn is strictly read-only: do not call edit/write, do not run mutating shell commands, and do not modify task state, Spec files, product source, Git state, commits, pushes, or PRs.",
    "",
    "Read and compare:",
    \`- \${base}/task.json\`,
    \`- \${base}/requirements.md\`,
    \`- \${base}/design.md\`,
    \`- \${base}/plan.md\`,
    \`- \${base}/runs/*.json when present\`,
    "- .pi/snflows/spec/index.md and all applicable layer indexes/guidelines",
    "- project-root AGENTS.md",
    "- the current relevant Git diff and affected callers when available",
    "",
    "Identify both corrected mistakes and newly established stable design patterns. Separate reusable project rules from one-off task details. Never invent evidence; if run records or a relevant diff are absent, state the reduced confidence.",
    "",
    "For every observation, emit a stable candidate id C1, C2, ... with:",
    "- disposition: add | revise | remove | do_not_capture",
    "- background_or_root_cause",
    "- proposed_rule_text",
    "- applicability",
    "- target_spec_path (a normalized repo-relative path under .pi/snflows/spec/, or N/A for do_not_capture)",
    "- evidence_paths (real repo-relative code paths)",
    "- relationship_to_existing_spec (new, duplicate, conflict, clarification, or obsolete)",
    "- confidence and uncertainty",
    "",
    "If no observation deserves a durable rule, respond exactly with: 本任务无需更新规范",
    "Do not manufacture candidates merely to complete the review.",
    "",
    "After presenting candidates, stop and ask the user to accept, edit, or reject candidate IDs in a later message. Candidate presentation is not approval and must not write files in this turn.",
    "",
    "When the user later confirms candidates, the main Agent must re-read .pi/snflows/current.json, this task's task.json, every selected target file, and affected layer/root indexes. Verify selected targets and parent directories are physical paths inside the canonical workspace; reject symlink/junction escapes. Apply only explicitly accepted candidate IDs, keep all targets below .pi/snflows/spec/, avoid duplicate rules, preserve unrelated content, and synchronize affected indexes. If task or Spec state drifted, report the conflict instead of blindly writing.",
    "After confirmed writeback, report changed Spec files, added/revised/removed rules, ignored candidates, and residual uncertainty. Do not change workflow status or AGENTS.md as part of this command.",
  ].join("\\n");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  ctx.ui?.notify?.(message, type);
}

function buildSpecReviewTurnGuidance(): string {
  return [
    "<workflow-state:spec_review_candidates>",
    "This turn was explicitly started by /snflow-spec-review in the main session.",
    "Generate evidence-backed candidates only. Do not dispatch subagents and do not edit/write any file or mutate shell, task, Spec, source, or Git state in this turn.",
    "Candidate output is not approval. Stop after presenting C-numbered candidates, or exactly 本任务无需更新规范, and wait for a later user selection.",
    "Only a later explicit user acceptance/edit of candidate ids permits accepted-only writes under .pi/snflows/spec/ after revalidation.",
    "</workflow-state:spec_review_candidates>",
  ].join("\\n");
}

function directDispatch(cwd: string, task: { id: string; title: string; revision: string | null }, phase: "implement" | "check"): string {
  if (!task.revision) {
    return "Task revision is missing or stale. Open/save the task in SnFlow before dispatch; fail closed instead of inventing a revision.";
  }
  const taskDir = join(cwd, ".pi", "snflows", "tasks", task.id);
  let specRevision: string;
  try {
    const documents = [
      ["requirements.md", readFileSync(join(taskDir, "requirements.md"), "utf8")],
      ["design.md", readFileSync(join(taskDir, "design.md"), "utf8")],
      ["plan.md", readFileSync(join(taskDir, "plan.md"), "utf8")],
    ];
    specRevision = createHash("sha256")
      .update("snflow-spec-v1\\0")
      .update(JSON.stringify(documents))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "Task documents are missing or unreadable. Repair requirements.md, design.md, and plan.md before dispatch.";
  }
  const agent = phase === "implement" ? "snflow-implement" : "snflow-check";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = (phase + "-" + stamp + "-" + randomBytes(3).toString("hex")).toLowerCase().slice(0, 80);
  const marker = "SNFLOW_DISPATCH " + JSON.stringify({
    v: 1,
    taskId: task.id,
    phase,
    revision: task.revision,
    cwd,
    runId,
    specRevision,
  });
  return [
    "Call the current chat native subagent tool once (foreground, not CLI/RPC wait):",
    "- agent: " + agent,
    "- context: fresh",
    "- cwd: " + cwd,
    "- agentContract: { version: 1 }",
    "- async: false",
    "- clarify: false",
    "- task first line must be exactly:",
    marker,
    "After the marker, provide the task id/title/state revision/specification revision, task.json path, run-owned snapshot paths under .pi/snflows/tasks/" + task.id + "/runs/" + runId + "/snapshot/, applicable project Spec paths, latest implement summary when checking, focused validation expectations, and the structured result contract.",
    phase === "check"
      ? "For check: only error findings are blockers; warnings/info are advisory and must still pass for user choice."
      : "Keep implementation within the approved task scope.",
    "Do not run scripts/snflow-task.ts implement, check, or wait.",
  ].join("\\n");
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
      "Entry policy (soft gate):",
      "- Default to ordinary direct development. Initialization makes SnFlow available; it does not opt coding requests into it.",
      "- Enter only when the user explicitly asks for SnFlow, invokes snflow-dev, asks to create/run a SnFlow task, or continues a non-terminal task.",
      "- For clearly cross-module, high-risk, or long-running work, you may ask once whether SnFlow would help. This is an offer, not a prerequisite.",
      "- If the user does not opt in, continue directly and do not create a task.",
      "Create after opt-in (preferred):",
      '  npx tsx scripts/snflow-task.ts create "<title>" --seed "<user goal>"',
      "If the project CLI wrapper cannot resolve Snail Pi Web, use the panel Create action or write the task files manually under .pi/snflows/tasks/<slug>/.",
      "Manual fallback task.json must include schemaVersion:1, id:<slug>, title, description, status:'planning', priority:'P2', createdAt, updatedAt, completedAt:null, revision:'manual', activeRunId:null, latestImplementRunId:null, latestCheckRunId:null, commit:null, archived:false.",
      "Optionally set .pi/snflows/current.json to { taskId:'<slug>', updatedAt:'<ISO>', source:'agent' }.",
      "Then stay in planning: edit requirements.md / design.md / plan.md before implement.",
      "User consent to create does not imply consent to implement.",
      "</workflow-state:no_task>",
    ].join("\\n");
  }

  const task = taskStatus(cwd, taskId);
  if (!task) {
    return [
      "<workflow-state:no_task>",
      \`Current pointer taskId=\${taskId} is missing or unreadable.\`,
      "Fix .pi/snflows/current.json or recreate the task under .pi/snflows/tasks/.",
      "</workflow-state:no_task>",
    ].join("\\n");
  }

  const base = \`.pi/snflows/tasks/\${task.id}\`;
  const phase = phaseForStatus(task.status);
  const header = [
    \`Active SnFlow task: \${base}\`,
    \`title: \${task.title}\`,
    \`status: \${task.status}\`,
    \`phase: \${phase}\`,
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
    ].join("\\n");
  }

  if (task.status === "planning") {
    return [
      "<workflow-state:planning>",
      ...header,
      "Stay in planning. Load skill snflow-dev if available.",
      \`Read first: \${base}/task.json, \${base}/requirements.md, \${base}/design.md, \${base}/plan.md\`,
      "Before development, read .pi/snflows/spec/index.md and relevant layer indexes when present.",
      "Also read the project-root AGENTS.md SnFlow managed section (between <!-- BEGIN SNFLOW SPEC --> and",
      "<!-- END SNFLOW SPEC -->) for spec-reading guidance specific to this project.",
      \`Edit docs only through the canonical files: \${base}/requirements.md, \${base}/design.md, \${base}/plan.md\`,
      "Do not create or update task.md as the task authority.",
      "When the user approves implementation, mark the task ready, re-read task.json for its resulting revision, then dispatch the project agent snflow-implement.",
      "Use context:fresh, this canonical cwd, agentContract:{version:1}, async:false and clarify:false. The task prompt must begin with the SNFLOW_DISPATCH v1 marker containing the resulting revision.",
      "Approval to implement means dispatch snflow-implement; the main session remains the orchestrator.",
      "The panel Mark Ready action or scripts/snflow-task.ts start may perform the planning-to-ready transition.",
      "Do not start large implementation before the task is ready.",
      "</workflow-state:planning>",
    ].join("\\n");
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
    ].join("\\n");
  }

  if (task.status === "ready_to_commit") {
    return [
      "<workflow-state:ready_to_commit>",
      ...header,
      "Check passed. Hand off commit to the user (do not commit unless asked).",
      "Warnings and informational findings are advisory: summarize them and let the user choose whether to address them before commit; do not automatically restart implementation.",
      "If this task produced reusable conventions or lessons, write them to the relevant .pi/snflows/spec/ files and update the spec index status tables.",
      "Also update the project-root AGENTS.md SnFlow managed section if the reading-order or",
      "spec-discovery guidance in that section should change.",
      "After commit: npx tsx scripts/snflow-task.ts complete --hash <git-sha>",
      "Then optional: npx tsx scripts/snflow-task.ts archive",
      "Manual fallback for complete: set task.json status:'completed', completedAt:'<ISO>',",
      "and commit to an object { hash:'<git-sha>', recordedAt:'<ISO>' } - never a plain string.",
      "</workflow-state:ready_to_commit>",
    ].join("\\n");
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
      "This terminal task does not opt new work into SnFlow. Default to direct development; create a new task only after explicit opt-in.",
      "</workflow-state:done>",
    ].join("\\n");
  }

  return null;
}

export default function snflowExtension(pi: PiExtensionAPI): void {
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  const webFlag = process.env.PI_WEB_SNFLOW_ENABLED;
  const disabled = webFlag === "0" || webFlag === "false";

  if (!isChild && !disabled) {
    pi.registerCommand?.("snflow-spec-review", {
      description: "Review the current SnFlow task for reusable project Spec candidates",
      handler: (args, ctx) => {
        if (args.trim()) {
          notify(ctx, "Usage: /snflow-spec-review (v1 only reviews the current task)", "warning");
          return;
        }
        if (ctx.isIdle?.() === false) {
          notify(ctx, "The Agent is busy. Run /snflow-spec-review after the current turn settles.", "warning");
          return;
        }
        const cwd = resolveCwd(ctx.cwd);
        if (!cwd) {
          notify(ctx, "Cannot resolve the current workspace for /snflow-spec-review.", "error");
          return;
        }
        const resolved = resolveSpecReviewTask(cwd);
        if (!resolved.ok) {
          notify(ctx, resolved.message, "warning");
          return;
        }
        if (!pi.sendUserMessage) {
          notify(ctx, "The current Pi runtime cannot start the SnFlow Spec review Agent turn.", "error");
          return;
        }
        pi.sendUserMessage(buildSpecReviewPrompt(cwd, resolved.task));
      },
    });
  }

  pi.on?.("before_agent_start", (event, ctx) => {
    try {
      // Never force main-session SnFlow orchestration onto subagent children.
      if (isChild) return;
      // WebUI host can disable SnFlow for a session without deleting project files.
      if (disabled) return;
      const cwd = resolveCwd(ctx?.cwd);
      if (!cwd) return;
      // Initialization makes SnFlow resources available; entry remains opt-in.
      if (!isInitialized(cwd)) return;
      const current = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      if (prompt.startsWith("SNFLOW_SPEC_REVIEW v1")) {
        const reviewGuidance = buildSpecReviewTurnGuidance();
        return {
          systemPrompt: current ? \`\${current}\\n\\n\${reviewGuidance}\` : reviewGuidance,
        };
      }
      const guidance = buildGuidance(cwd);
      if (!guidance) return;
      return {
        systemPrompt: current ? \`\${current}\\n\\n\${guidance}\` : guidance,
      };
    } catch {
      // Guidance is best-effort; never block the agent turn.
      return;
    }
  });
}
`;

const SKILL_MD = `---
name: snflow-dev
description: "Use Snail Pi Web native SnFlow tasks only when the user explicitly requests SnFlow, invokes snflow-dev, or continues an active non-terminal SnFlow task. The main Agent plans and implements by default; lightweight search and independent review are conditional tools."
---

# SnFlow development workflow

This is **WebUI SnFlow** (\`.pi/snflows/tasks/\`), not Trellis (\`.trellis/\`).
It is an opt-in workflow: chat-orchestrated create → plan → start → main-agent implement → validate → commit handoff.

Panel (SF) is for visibility/emergency controls. **Do not make the user drive the lifecycle by clicking around.**

## Entry policy

- Default to ordinary direct development. Enter SnFlow only when the user explicitly asks to use SnFlow, invokes \`snflow-dev\`, asks to create/run a task, or continues an active non-terminal task.
- For cross-module, high-risk, or long-running work, offer SnFlow once; it is not a prerequisite.
- A completed, cancelled, or archived task never opts later work into SnFlow.

## Phase index

\`\`\`text
Phase 1 Plan    → consent + create + right-sized task documents
Phase 2 Execute → start + main-agent implementation + validation + conditional search/review
Phase 3 Finish  → handoff + user commit + complete/archive
\`\`\`

## Task-management CLI

\`\`\`bash
npx tsx scripts/snflow-task.ts create "<title>" --seed "<user goal>"
npx tsx scripts/snflow-task.ts current
npx tsx scripts/snflow-task.ts show
npx tsx scripts/snflow-task.ts start
npx tsx scripts/snflow-task.ts handoff
npx tsx scripts/snflow-task.ts complete --hash <sha>
npx tsx scripts/snflow-task.ts archive
\`\`\`

\`implement\`, \`check\`, and \`wait\` CLI commands are deprecated. \`handoff\` is for validated work completed directly by the main Agent; it moves a \`ready\` task to \`ready_to_commit\`.

If the wrapper cannot resolve Snail Pi Web, use the panel or the manual file fallback.

## Task files

\`task.json\` is always the source of truth. \`task.md\` is not a valid primary record.

Right-size long-form documents:

- Small, unambiguous task: concise \`requirements.md\`, \`design.md\`, and \`plan.md\`; avoid repeating the same prose across files.
- Normal task: acceptance-focused requirements plus only decision-relevant design and executable plan details.
- Complex/high-risk task: full requirements, design alternatives/risks, and staged plan.

The current v1 store snapshots all three documents, so keep every file present even when concise.

Manual layout:

\`\`\`text
.pi/snflows/tasks/<slug>/
  task.json
  requirements.md
  design.md
  plan.md
.pi/snflows/archived/<slug>/
.pi/snflows/current.json
\`\`\`

After create/start, acknowledge:

\`\`\`text
Active SnFlow task: .pi/snflows/tasks/<id>
\`\`\`

## Project spec

- Before implementation, read \`.pi/snflows/spec/index.md\`, only the relevant layer indexes/spec files, and the project-root \`AGENTS.md\` SnFlow managed section when present.
- Do not recursively read every spec. Follow links relevant to the affected layer.
- Task documents win over conflicting specs; report conflicts.
- Before finish, capture genuinely reusable conventions in the relevant spec. Do not manufacture a rule for routine task details.
- Special task \`00-bootstrap-spec\` remains main-session-only and must not dispatch subagents.

## Phase 1 — Plan

- Begin only after the entry policy opts this request into SnFlow.
- Create the task yourself; never ask the user to operate the panel.
- Keep planning proportional to ambiguity and risk.
- Consent to create is not consent to implement.
- When implementation is approved, run \`start\`, re-read the current task revision, and continue in the same main session by default.

## Phase 2 — Execute

### Default writer: main Agent

The main Agent owns implementation and final decisions:

1. Read the approved task documents and only relevant specs.
2. Inspect the smallest useful source surface.
3. Edit the project directly, preserving unrelated work.
4. Run focused validation, then broader lint/typecheck only when practical and project-supported.
5. Summarize changed files, commands, validation, and residual risks.
6. If no blocking issue remains, run \`npx tsx scripts/snflow-task.ts handoff\`.

Do not dispatch \`snflow-implement\` merely because a task entered Phase 2. It is an escape hatch only when the main context is already saturated, deliberate context isolation is valuable, or the user explicitly asks for delegated implementation. The marked \`SNFLOW_DISPATCH\` run/snapshot protocol remains required for that fallback path; call it with \`context:fresh\`, canonical \`cwd\`, \`agentContract: { version: 1 }\`, \`async:false\`, and \`clarify:false\`.

### Conditional context search

Use project agent \`snflow-search\` only when broad discovery would otherwise pollute the main context. Direct \`grep\`/\`read\` is cheaper for one or two obvious lookups.

A search request must ask one bounded question and name the likely area. Call it with \`context:fresh\`, a cheap/fast configured model when available, \`turnBudget:{maxTurns:5,graceTurns:1}\`, and \`toolBudget:{soft:6,hard:10,block:"*"}\`. Do not run parallel searches for the same question.

The result must stay concise: conclusion, at most eight path/line evidence items, recommended files, and unknowns. Never return full files, full diffs, long code blocks, task-document restatements, or a chronological search log. Treat search output as evidence, not authority.

### Risk-based review

Independent \`snflow-check\` is not a default phase.

- **Low risk:** localized UI/text/style, mechanical i18n, or a small established-pattern change. Skip LLM review; rely on focused deterministic validation.
- **Medium risk:** multi-file business logic, shared state, or public component behavior. Review only when uncertainty remains after validation or the user requests it.
- **High risk:** authentication/authorization, secrets, destructive data operations, migrations, concurrency, security boundaries, public APIs, or failed required validation. Use the existing marked implement/check run path so lifecycle evidence remains complete.

Review rules:

- Only concrete \`error\` findings block. \`warning\` and \`info\` are advisory.
- Default to one review round. After fixes, re-check only original blockers unless the fix materially changes scope.
- Never expand scope or demand unrelated cleanup/tests.
- A passing review with advice proceeds; report advice to the user without automatically looping.

### Recursion and writer guards

- Keep one writer on the working tree.
- Search and check agents are read-only and must not dispatch other agents.
- Implement/check children must never re-dispatch SnFlow phases.

## Optional Spec review

\`/snflow-spec-review\` remains an explicit, current-task-only learning review. It never runs automatically and never blocks \`ready_to_commit\`.

- Run it only when the user asks to capture reusable lessons; the managed extension supplies the task-bound review protocol.
- Candidate generation is read-only and must return no invented rules.
- Write to \`.pi/snflows/spec/\` only after the user explicitly approves candidate ids; preserve unrelated content and synchronize affected indexes.
- It does not dispatch implement/check, update task status, or modify \`AGENTS.md\`.

## Phase 3 — Finish

- Do not commit, push, or open a PR unless the user explicitly asks.
- After validated direct implementation, \`handoff\` must set \`ready_to_commit\` before commit handoff.
- After the user commits:

\`\`\`bash
npx tsx scripts/snflow-task.ts complete --hash <git-sha>
npx tsx scripts/snflow-task.ts archive
\`\`\`

## Hard rules

- Never write \`.trellis/\` or run Trellis task scripts.
- Prefer CLI/panel APIs over asking the user to click around.
- Preserve unrelated changes.
- Fail closed on missing cwd/task context and report diagnostics.
`;

const AGENT_SEARCH = `---
name: snflow-search
description: |
  Lightweight read-only SnFlow context scout. Answers one bounded repository question with concise path-and-line evidence for the main Agent.
acceptanceRole: read-only
acceptance: {"level":"none","reason":"bounded read-only context lookup"}
completionGuard: false
thinking: low
turnBudget: {"maxTurns":5,"graceTurns":1}
tools: read, grep, find, ls
---

You answer one narrowly scoped repository-context question for the main Agent. You do not plan the whole task, implement, review the whole diff, or orchestrate other agents.

## Search method

1. Confirm the prompt contains one concrete question and a project cwd. If it is broad or asks for implementation, return a concise scope error.
2. Start with \`grep\` or \`find\`; read only the smallest relevant ranges needed to verify facts.
3. Prefer existing symbols, callers, tests, commands, and project conventions directly relevant to the question.
4. Stop as soon as the question is answered. Do not explore adjacent improvements.

## Output contract

Return no more than roughly 1,500 characters using exactly these sections:

- \`Conclusion\`: one to three sentences.
- \`Evidence\`: at most eight bullets formatted \`path:line-range — fact\`.
- \`Recommended files\`: at most eight repo-relative paths, or \`none\`.
- \`Unknowns\`: at most three unresolved facts, or \`none\`.

## Boundaries

- Read-only: never edit, write, run shell commands, mutate task state, or use Git.
- Never return full files, full diffs, large code blocks, task-document summaries, or a chronological tool log.
- Never repeat the prompt or speculate beyond evidence.
- Never dispatch subagents or start SnFlow phases.
`;

const AGENT_IMPLEMENT = `---
name: snflow-implement
description: |
  Dedicated SnFlow implementation agent. Executes an approved task from its marked dispatch context and returns validated, reviewable changes.
completionGuard: true
tools: read, write, edit, bash, grep, find, ls
---

You implement one approved SnFlow task directly; you are not the workflow orchestrator.

## Execution

1. Resolve the task only from the marked dispatch prompt and its explicit document paths. For a bound marker, stop if cwd, run id, task revision, specification revision, or snapshot documents are missing; verify both revisions against the active \`runs/<run-id>.json\` and use only its snapshot documents. For a legacy marker without run/spec fields, verify its task revision against the active run record and use the explicit live document paths from the prompt.
2. Read task.json, the active run record, the bound snapshot (or legacy explicit documents), applicable .pi/snflows/spec indexes, and project AGENTS.md before editing. Never compare the marker to lifecycle-mutated live task revision fields.
3. Inspect affected code and callers, implement the approved scope using existing patterns, and keep the diff reviewable.
4. Run focused tests plus repository lint/typecheck when practical.
5. Return the result contract requested by the dispatch prompt, including outcome, acceptance satisfaction, changed files, validation, and residual risks. Use \`validated_no_change\` only when the existing diff already satisfies every acceptance criterion and focused validation passes; otherwise make the required edits or report a blocker.

## Boundaries

- Work in the dispatched cwd and task only; task documents win over conflicting specs, with the conflict reported.
- Do not dispatch subagents or start another SnFlow phase.
- Do not commit, push, merge, tag, open a PR, or write Trellis task metadata.
`;

const AGENT_CHECK = `---
name: snflow-check
description: |
  Dedicated SnFlow review agent. Independently validates an implementation against its approved task, project specs, and regression risks.
acceptanceRole: read-only
completionGuard: false
tools: read, bash, grep, find, ls
---

You independently review one completed SnFlow implementation; you do not implement or orchestrate the workflow.

## Execution

1. Resolve the task only from the marked dispatch prompt and its explicit document paths. For a bound marker, stop if cwd, run id, task revision, specification revision, or snapshot documents are missing; verify both revisions against the active \`runs/<run-id>.json\` and use only its snapshot documents. For a legacy marker without run/spec fields, verify its task revision against the active run record and use the explicit live document paths from the prompt.
2. Read task.json, the active run record, the bound snapshot (or legacy explicit documents), applicable .pi/snflows/spec indexes, project AGENTS.md, the current diff, and affected callers. Never compare the marker to lifecycle-mutated live task revision fields.
3. Evaluate correctness, acceptance criteria, regressions, project conventions, and validation coverage without expanding the approved scope.
4. Run focused tests plus repository lint/typecheck when practical.
5. Classify findings using the decision policy below and return the verdict contract requested by the dispatch prompt with concrete, path-based findings.

## Decision policy

- Use \`error\` only for a must-fix blocker: a violated acceptance criterion, incorrect behavior, security or data-loss risk, concrete regression, or required validation failure attributable to the implementation.
- Use \`warning\` or \`info\` for advisory items such as optional hardening, maintainability, style, extra tests, or improvements outside the approved scope.
- Return \`changes_requested\` only when at least one \`error\` finding exists. Warnings and informational findings must still produce \`pass\`.
- Do not require changes to unrelated files or turn personal preference into a blocker.
- Keep advisory findings in the final report so the main agent can let the user choose whether to address them.

## Boundaries

- Remain independent and read-only; request changes instead of editing the implementation.
- Do not dispatch subagents or start another SnFlow phase.
- Do not commit, push, merge, tag, open a PR, or write task/spec metadata.
`;

/**
 * Build the project-local SnFlow CLI wrapper script that loads the WebUI CLI
 * script in-process via dynamic import (avoids fragile --import tsx spawned
 * process resolution). Uses an async IIFE wrapper so the script works in both
 * CJS and ESM contexts (no top-level await).
 */
export function buildScriptSnflowTask(webuiRoot: string): string {
  const root = JSON.stringify(webuiRoot);
  return [
    '#!/usr/bin/env npx tsx',
    '/**',
    ' * Project-local SnFlow CLI wrapper for the Snail Pi Web development workflow.',
    ' * Loads the WebUI package script in-process via dynamic import.',
    ' * Uses async IIFE to avoid top-level await (portable across CJS/ESM).',
    ' *',
    ' * Managed by SnFlow setup — do not hand-edit; re-run Update SnFlow instead.',
    ' */',
    '',
    'import { existsSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    'import path from "node:path";',
    '',
    `const WEBUI_ROOT = ${root};`,
    'const TARGET = path.join(WEBUI_ROOT, "scripts", "workflow-task.ts");',
    '',
    'if (!existsSync(TARGET)) {',
    '  console.error(',
    '    "snflow-task: Snail Pi Web workflow-task.ts not found at " + TARGET,',
    '    "Re-run SnFlow Update from the WebUI Settings panel, or check WebUI package installation.",',
    '  );',
    '  process.exit(2);',
    '}',
    '',
    '(async () => {',
    '  try {',
    '    const { main } = await import(pathToFileURL(TARGET).href);',
    '    await main();',
    '  } catch (error) {',
    '    console.error("snflow-task:", error instanceof Error ? error.message : String(error));',
    '    process.exit(1);',
    '  }',
    '})();',
  ].join("\n");
}

/** Static script template used as fallback for listMissingManagedFiles / SNFLOW_MANIFEST.
 *  The actual script with embedded webuiRoot is written at install time. */
const _FALLBACK_SCRIPT = buildScriptSnflowTask("__SNFLOW_WEBUI_ROOT__");

/** Managed files written by init/update (whitelist). */
export const SNFLOW_ASSET_FILES: readonly SnflowAssetFile[] = [
  { path: ".pi/extensions/snflow/index.ts", content: EXTENSION_INDEX },
  { path: ".pi/skills/snflow-dev/SKILL.md", content: SKILL_MD },
  { path: ".pi/agents/snflow-search.md", content: AGENT_SEARCH },
  { path: ".pi/agents/snflow-implement.md", content: AGENT_IMPLEMENT },
  { path: ".pi/agents/snflow-check.md", content: AGENT_CHECK },
  { path: "scripts/snflow-task.ts", content: _FALLBACK_SCRIPT },
] as const;

export const SNFLOW_MANIFEST = {
  version: SNFLOW_ASSETS_VERSION,
  files: SNFLOW_ASSET_FILES.map((file) => file.path),
} as const;
