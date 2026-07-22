#!/usr/bin/env npx tsx
/**
 * Trellis-like SnFlow CLI for chat agents.
 *
 * Lifecycle:
 *   create → (edit docs) → start → implement → check → complete → archive
 *
 * implement/check dispatch through the same server-side native pi-subagents host
 * as the SnFlow panel (cwd-bound). No panel clicking required.
 */

import {
  archiveWorkflowTask,
  completeWorkflowTask,
  createWorkflowTask,
  getWorkflowTaskDetail,
  listWorkflowTasks,
  markWorkflowTaskReady,
  recordWorkflowCommit,
} from "../lib/workflow-store";
import {
  clearWorkflowCurrentTask,
  getWorkflowCurrentTaskId,
  setWorkflowCurrentTask,
} from "../lib/workflow-current";
import { WORKFLOW_TERMINAL_RUN_STATES } from "../lib/workflow-types";

/** Lazy import for workflow-run-manager (requires pi SDK, which is ESM-only). */
function lazyRunManager(): Promise<typeof import("../lib/workflow-run-manager")> {
  return import("../lib/workflow-run-manager");
}

function usage(): never {
  console.log(`Usage:
  workflow-task create <title> [--cwd <path>] [--seed <text>] [--id <slug>] [--ready]
  workflow-task start [--cwd <path>] [taskId]
  workflow-task current [--cwd <path>]
  workflow-task use <taskId> [--cwd <path>]
  workflow-task show [taskId] [--cwd <path>]
  workflow-task list [--cwd <path>]
  workflow-task implement [--cwd <path>] [taskId]
  workflow-task check [--cwd <path>] [taskId]
  workflow-task wait [--cwd <path>] [runId|taskId]
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

// pi injects the chat session id into tool subprocess env (same source Trellis
// uses); binding it into the pointer keeps the session widget session-scoped.
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

async function dispatchPhase(cwd: string, taskId: string, phase: "implement" | "check") {
  const rm = await lazyRunManager();
  const detail = getWorkflowTaskDetail(cwd, taskId);
  setWorkflowCurrentTask(cwd, taskId, { source: "cli", sessionId: sessionIdFromEnv() });
  const result = await rm.startWorkflowRun({
    cwd,
    taskId,
    phase,
    expectedRevision: detail.revision,
  });
  console.log(`phase=${phase}`);
  console.log(`runId=${result.run.id}`);
  console.log(`state=${result.run.state}`);
  console.log(`taskStatus=${result.task.status}`);
  printActive(taskId);
  if (result.run.error) {
    console.error(`error=${result.run.error.code}: ${result.run.error.message}`);
    process.exitCode = 1;
  }
}

async function waitForRun(cwd: string, runId: string, timeoutMs = 30 * 60_000) {
  const rm = await lazyRunManager();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { run, task } = await rm.getWorkflowRunStatus(cwd, runId);
    console.log(`state=${run.state} taskStatus=${task.status}`);
    if (WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) {
      if (run.summary) console.log(`summary=${run.summary.slice(0, 2000)}`);
      if (run.error) {
        console.error(`error=${run.error.code}: ${run.error.message}`);
        process.exitCode = 1;
      }
      printActive(task.id);
      return;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
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

  if (cmd === "implement") {
    const taskId = resolveTaskId(cwd, pos[0]);
    await dispatchPhase(cwd, taskId, "implement");
    return;
  }

  if (cmd === "check") {
    const taskId = resolveTaskId(cwd, pos[0]);
    await dispatchPhase(cwd, taskId, "check");
    return;
  }

  if (cmd === "wait") {
    const maybe = pos[0];
    let runId: string | undefined = maybe;
    if (!runId || !runId.includes("-")) {
      const taskId = resolveTaskId(cwd, maybe);
      const detail = getWorkflowTaskDetail(cwd, taskId);
      runId = detail.activeRunId ?? detail.latestCheckRunId ?? detail.latestImplementRunId ?? undefined;
      if (!runId) throw new Error(`No run to wait on for task ${taskId}`);
    }
    await waitForRun(cwd, runId);
    return;
  }

  if (cmd === "cancel") {
    const maybe = pos[0];
    let runId: string | undefined = maybe;
    if (!runId || (!runId.includes("implement-") && !runId.includes("check-"))) {
      const taskId = resolveTaskId(cwd, maybe);
      const detail = getWorkflowTaskDetail(cwd, taskId);
      if (!detail.activeRunId) throw new Error("No active run to cancel");
      runId = detail.activeRunId;
    }
    if (!runId) throw new Error("No run id to cancel");
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
