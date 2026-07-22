/**
 * Bundled SnFlow project assets (extension / skill / agents / script).
 * Embedded as string constants so Next.js production builds never depend on
 * reading an on-disk templates directory from a fragile package path.
 *
 * Bump SNFLOW_ASSETS_VERSION (SemVer) whenever any managed file content changes.
 */

export const SNFLOW_ASSETS_VERSION = "1.0.2";

export interface SnflowAssetFile {
  /** Project-relative path using forward slashes. */
  path: string;
  content: string;
}

const EXTENSION_INDEX = `/**
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

  if (task.status === "planning") {
    return [
      "<workflow-state:planning>",
      ...header,
      "Stay in planning. Load skill snflow-dev if available.",
      \`Read first: \${base}/task.json, \${base}/requirements.md, \${base}/design.md, \${base}/plan.md\`,
      \`Edit docs only through the canonical files: \${base}/requirements.md, \${base}/design.md, \${base}/plan.md\`,
      "Do not create or update task.md as the task authority.",
      "When the user approves implementation, do all of this in the same turn without asking again:",
      "  npx tsx scripts/snflow-task.ts start",
      "  npx tsx scripts/snflow-task.ts implement",
      "  npx tsx scripts/snflow-task.ts wait",
      "Approval to implement means dispatch the worker subagent — do NOT implement the code yourself in the main session.",
      "Manual fallback for start: change task.json status from planning to ready and update updatedAt.",
      "Do not start large implementation before start.",
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
    ].join("\\n");
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
    ].join("\\n");
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
    ].join("\\n");
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
description: "Use Snail Pi Web native SnFlow tasks under .pi/snflows/tasks/ for development work. Create tasks from chat (like Trellis task.py create), maintain requirements/design/plan, and guide implement/check via the SnFlow panel or project CLI. Prefer this over Trellis when the user wants WebUI-owned workflow or the project has no .trellis."
---

# SnFlow development workflow

This is **WebUI SnFlow** (\`.pi/snflows/tasks/\`), not Trellis (\`.trellis/\`).
Experience should feel like Trellis: chat-orchestrated create → plan → start → implement → check → commit handoff.

Panel (SF) is for visibility/emergency controls. **Do not make the user drive the lifecycle by clicking around.**

## Phase index

\`\`\`
Phase 1 Plan    → consent + create + requirements/design/plan
Phase 2 Execute → start + implement + check loops
Phase 3 Finish  → ready_to_commit + user commit + complete/archive
\`\`\`

## CLI (preferred agent interface)

Project-local wrapper (installed by SnFlow setup):

\`\`\`bash
npx tsx scripts/snflow-task.ts create "<title>" --seed "<user goal>"
npx tsx scripts/snflow-task.ts current
npx tsx scripts/snflow-task.ts show
npx tsx scripts/snflow-task.ts start
npx tsx scripts/snflow-task.ts implement
npx tsx scripts/snflow-task.ts wait
npx tsx scripts/snflow-task.ts check
npx tsx scripts/snflow-task.ts wait
npx tsx scripts/snflow-task.ts complete --hash <sha>
npx tsx scripts/snflow-task.ts archive
\`\`\`

If the CLI wrapper cannot resolve the Snail Pi Web package, use the SnFlow panel actions or the manual file fallback below.

Manual fallback layout:

\`\`\`text
.pi/snflows/tasks/<slug>/
  task.json
  requirements.md
  design.md
  plan.md
.pi/snflows/archived/<slug>/
.pi/snflows/current.json
\`\`\`

Minimum \`task.json\`:

\`\`\`json
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
\`\`\`

\`task.md\` is not a valid primary SnFlow record.

After create/start, acknowledge:

\`\`\`text
Active SnFlow task: .pi/snflows/tasks/<id>
\`\`\`

## Phase 1 — Plan

- Simple chat: ask if a SnFlow task is needed; skip if user says no.
- Real dev work: create the task yourself (never tell user to open SF and press +).
- Edit \`requirements.md\`, \`design.md\`, \`plan.md\`.
- Consent to create ≠ consent to implement.

When user approves implementation, run in the same turn:

\`\`\`bash
npx tsx scripts/snflow-task.ts start
npx tsx scripts/snflow-task.ts implement
npx tsx scripts/snflow-task.ts wait
\`\`\`

## Phase 2 — Execute

Main session is orchestrator only. Implementation runs in the worker subagent:

\`\`\`bash
npx tsx scripts/snflow-task.ts implement
npx tsx scripts/snflow-task.ts wait
npx tsx scripts/snflow-task.ts check
npx tsx scripts/snflow-task.ts wait
\`\`\`

### Recursion guards
- If you are already the implement/check child, do **not** re-dispatch SnFlow implement/check.
- Only the main session should run \`implement\` / \`check\`.

### Inline exception
Do **not** edit project source in the main session except a trivial fix of roughly ≤10 lines with no new files — still run \`check\` afterwards.

## Phase 3 — Finish

- Do **not** git commit/push/PR unless user explicitly asks.
- After user commits:

\`\`\`bash
npx tsx scripts/snflow-task.ts complete --hash <git-sha>
npx tsx scripts/snflow-task.ts archive
\`\`\`

## Hard rules

- Never write \`.trellis/\` for this workflow
- Never run \`python ./.trellis/scripts/task.py\` for SnFlow tasks
- Prefer CLI/panel over asking the user to click around
- Keep one writer on the working tree
- Fail closed on missing cwd/task context; print diagnostics
`;

const AGENT_IMPLEMENT = `---
name: snflow-implement
description: |
  SnFlow implementation agent. Reads the active .pi/snflows task docs and implements the requested change. No git commit allowed.
tools: read, write, edit, bash, grep, find, ls
---

## Required: Load SnFlow context first

1. Look at the dispatch prompt for \`Active SnFlow task: .pi/snflows/tasks/<id>\` or \`Active task:\`.
2. Otherwise read \`.pi/snflows/current.json\` for \`taskId\`.
3. If still unknown, stop and report that no SnFlow task is selected.

Then read:

- \`.pi/snflows/tasks/<id>/task.json\`
- \`.pi/snflows/tasks/<id>/requirements.md\`
- \`.pi/snflows/tasks/<id>/design.md\`
- \`.pi/snflows/tasks/<id>/plan.md\`

## Recursion guard

You are already the implementation child.

- Do NOT spawn another snflow-implement / snflow-check / worker / reviewer for this workflow.
- Do NOT run \`scripts/snflow-task.ts implement|check\`.
- Do the implementation work directly.

## Responsibilities

1. Implement only what the task docs require.
2. Follow existing project patterns.
3. Run focused validation available in the repo (lint/typecheck/tests as applicable).
4. Return a structured summary: changed files, validation, residual risks.

## Forbidden

- \`git commit\` / \`git push\` / \`git merge\`
- Writing \`.trellis/\`
- Expanding scope beyond the task
`;

const AGENT_CHECK = `---
name: snflow-check
description: |
  SnFlow review agent. Reviews implementation against the active .pi/snflows task docs and reports pass or changes_requested. No recursive dispatch.
tools: read, write, edit, bash, grep, find, ls
---

## Required: Load SnFlow context first

1. Look at the dispatch prompt for \`Active SnFlow task: .pi/snflows/tasks/<id>\` or the latest implement summary.
2. Otherwise read \`.pi/snflows/current.json\` for \`taskId\`.
3. If still unknown, stop and report that no SnFlow task is selected.

Then read:

- \`.pi/snflows/tasks/<id>/task.json\`
- \`.pi/snflows/tasks/<id>/requirements.md\`
- \`.pi/snflows/tasks/<id>/design.md\`
- \`.pi/snflows/tasks/<id>/plan.md\`
- current git diff / changed files

## Recursion guard

You are already the check/review child.

- Do NOT spawn snflow-implement / snflow-check / worker / reviewer.
- Do NOT run \`scripts/snflow-task.ts implement|check\`.
- Review (and fix only clearly in-scope issues) directly.

## Responsibilities

1. Compare the diff to acceptance criteria and plan.
2. Flag regressions, missing validation, and contract violations.
3. Run focused validation available in the repo.
4. Return a structured verdict: \`pass\` or \`changes_requested\`, with findings and summary.

## Forbidden

- \`git commit\` / \`git push\` / \`git merge\`
- Writing \`.trellis/\`
- Expanding into unrelated refactors
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
  { path: ".pi/agents/snflow-implement.md", content: AGENT_IMPLEMENT },
  { path: ".pi/agents/snflow-check.md", content: AGENT_CHECK },
  { path: "scripts/snflow-task.ts", content: _FALLBACK_SCRIPT },
] as const;

export const SNFLOW_MANIFEST = {
  version: SNFLOW_ASSETS_VERSION,
  files: SNFLOW_ASSET_FILES.map((file) => file.path),
} as const;
