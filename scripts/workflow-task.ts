#!/usr/bin/env npx tsx
/**
 * SnFlow CLI for chat agents.
 *
 * Lifecycle:
 *   create → (edit docs) → start → main-agent implementation → handoff → complete → archive
 *
 * The main chat is the default writer. Native implement/check subagents remain
 * available for exceptional high-risk or context-isolation cases.
 */

import {
  archiveWorkflowTask,
  completeWorkflowTask,
  createWorkflowTask,
  getWorkflowTaskDetail,
  listWorkflowTasks,
  markWorkflowTaskReady,
  markWorkflowTaskReadyToCommit,
  recordWorkflowCommit,
  WorkflowNotFoundError,
} from "../lib/workflow-store";
import {
  clearWorkflowCurrentTask,
  getWorkflowCurrentTaskId,
  setWorkflowCurrentTask,
} from "../lib/workflow-current";
/** Lazy import for workflow-run-manager (requires pi SDK, which is ESM-only). */
function lazyRunManager(): Promise<typeof import("../lib/workflow-run-manager")> {
  return import("../lib/workflow-run-manager");
}

function usage(): never {
  console.log(`Usage:
  workflow-task create <title> [--cwd <path>] [--seed <text>] [--id <slug>] [--ready]
  workflow-task start [--cwd <path>] [taskId]
  workflow-task handoff [--cwd <path>] [taskId]   # validated main-agent work → ready_to_commit
  workflow-task current [--cwd <path>]
  workflow-task use <taskId> [--cwd <path>]
  workflow-task show [taskId] [--cwd <path>]
  workflow-task list [--cwd <path>]
  workflow-task implement   # deprecated: use current-chat native subagent
  workflow-task check       # deprecated: use current-chat native subagent
  workflow-task wait        # deprecated: native tool lifecycle is foreground
  workflow-task cancel [--cwd <path>] [runId|taskId]
  workflow-task complete [--cwd <path>] [--hash <sha>] [--note <text>] [taskId]
  workflow-task commit --hash <sha> [--cwd <path>] [--note <text>] [taskId]
  workflow-task archive [--cwd <path>] [taskId]
  workflow-task finish [--cwd <path>]   # clear current pointer only
`);
  process.exit(1);
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function taskDetailForRunReference(cwd: string, value?: string) {
  if (!value) return getWorkflowTaskDetail(cwd, resolveTaskId(cwd));
  try {
    return getWorkflowTaskDetail(cwd, value);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
}

function positionalAfterCommand(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (
        a === "--cwd" ||
        a === "--seed" ||
        a === "--id" ||
        a === "--hash" ||
        a === "--note"
      ) {
        i += 1;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

// pi injects the chat session id into tool subprocess env; binding it into the
// pointer keeps the session widget session-scoped.
function sessionIdFromEnv(): string | undefined {
  const raw = process.env.PI_SESSION_ID ?? process.env.PI_SESSIONID;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveTaskId(cwd: string, maybeId?: string): string {
  if (maybeId) return maybeId;
  const current = getWorkflowCurrentTaskId(cwd);
  if (!current) {
    throw new Error("No task id and no current SnFlow task. Run: workflow-task create ...");
  }
  return current;
}

function printActive(taskId: string) {
  console.log(`Active SnFlow task: .pi/snflows/tasks/${taskId}`);
}

function deprecatedDispatchCommand(command: "implement" | "check" | "wait"): never {
  throw new Error(
    `workflow-task ${command} is deprecated. Use the current chat foreground native subagent tool with the SnFlow dispatch marker; do not use a CLI wait.`,
  );
}

export async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd) usage();
  const cwd = argValue(args, "--cwd") || process.cwd();
  const pos = positionalAfterCommand(args);

  if (cmd === "create") {
    const title = pos.join(" ").trim();
    if (!title) usage();
    const task = createWorkflowTask(cwd, {
      title,
      seedText: argValue(args, "--seed"),
      id: argValue(args, "--id"),
      markReady: hasFlag(args, "--ready"),
      sessionId: sessionIdFromEnv(),
    });
    console.log(task.pathLabel);
    console.log(`id=${task.id}`);
    console.log(`status=${task.status}`);
    printActive(task.id);
    return;
  }

  if (cmd === "start") {
    const taskId = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, taskId);
    const next =
      detail.status === "planning" || detail.status === "failed"
        ? markWorkflowTaskReady(cwd, taskId, detail.revision)
        : detail;
    setWorkflowCurrentTask(cwd, taskId, { source: "cli", sessionId: sessionIdFromEnv() });
    console.log(`status=${next.status}`);
    printActive(taskId);
    return;
  }

  if (cmd === "handoff") {
    const taskId = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, taskId);
    const next = markWorkflowTaskReadyToCommit(cwd, taskId, detail.revision);
    console.log(`status=${next.status}`);
    printActive(taskId);
    return;
  }

  if (cmd === "current") {
    const id = getWorkflowCurrentTaskId(cwd);
    if (!id) {
      console.log("(no current SnFlow task)");
      return;
    }
    printActive(id);
    return;
  }

  if (cmd === "use") {
    const id = pos[0];
    if (!id) usage();
    getWorkflowTaskDetail(cwd, id); // validate exists
    setWorkflowCurrentTask(cwd, id, { source: "cli", sessionId: sessionIdFromEnv() });
    printActive(id);
    return;
  }

  if (cmd === "show") {
    const id = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, id);
    console.log(
      JSON.stringify(
        {
          id: detail.id,
          title: detail.title,
          status: detail.status,
          pathLabel: detail.pathLabel,
          revision: detail.revision,
          activeRunId: detail.activeRunId,
          latestImplementRunId: detail.latestImplementRunId,
          latestCheckRunId: detail.latestCheckRunId,
          commit: detail.commit,
          allowedActions: detail.allowedActions,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (cmd === "list") {
    const listed = listWorkflowTasks(cwd, false);
    for (const task of listed.tasks) {
      const marker = task.id === listed.currentTaskId ? "*" : " ";
      console.log(`${marker} ${task.status.padEnd(18)} ${task.id}  ${task.title}`);
    }
    if (listed.currentTaskId) console.log(`current=${listed.currentTaskId}`);
    if (listed.activeCwdRunId) console.log(`activeRun=${listed.activeCwdRunId}`);
    return;
  }

  if (cmd === "implement" || cmd === "check" || cmd === "wait") {
    deprecatedDispatchCommand(cmd);
  }

  if (cmd === "cancel") {
    const maybe = pos[0];
    const detail = taskDetailForRunReference(cwd, maybe);
    const runId = detail?.activeRunId ?? maybe;
    if (!runId || (detail && !detail.activeRunId)) throw new Error("No active run to cancel");
    const rm = await lazyRunManager();
    const result = await rm.cancelWorkflowRun(cwd, runId);
    console.log(`state=${result.run.state}`);
    console.log(`taskStatus=${result.task.status}`);
    return;
  }

  if (cmd === "commit") {
    const hash = argValue(args, "--hash");
    if (!hash) usage();
    const taskId = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, taskId);
    const next = recordWorkflowCommit(cwd, taskId, {
      expectedRevision: detail.revision,
      commitHash: hash,
      note: argValue(args, "--note"),
    });
    console.log(`status=${next.status}`);
    console.log(`commit=${next.commit?.hash ?? ""}`);
    printActive(taskId);
    return;
  }

  if (cmd === "complete") {
    const taskId = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, taskId);
    const next = completeWorkflowTask(cwd, taskId, {
      expectedRevision: detail.revision,
      commitHash: argValue(args, "--hash"),
      note: argValue(args, "--note"),
    });
    console.log(`status=${next.status}`);
    printActive(taskId);
    return;
  }

  if (cmd === "archive") {
    const taskId = resolveTaskId(cwd, pos[0]);
    const detail = getWorkflowTaskDetail(cwd, taskId);
    const next = archiveWorkflowTask(cwd, taskId, detail.revision);
    console.log(`status=${next.status}`);
    console.log(`archived=${next.archived}`);
    return;
  }

  if (cmd === "finish") {
    clearWorkflowCurrentTask(cwd);
    console.log("(current SnFlow task cleared)");
    return;
  }

  usage();
}

// Auto-run when executed directly (not imported by the wrapper).
const entryArg = process.argv[1]?.replace(/\\/g, "/");
const isDirectRun = Boolean(
  entryArg &&
  (entryArg.endsWith("/workflow-task.ts") || entryArg.endsWith("/workflow-task")),
);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
