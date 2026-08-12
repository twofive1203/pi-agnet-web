/**
 * SnFlow → task-observer projection and host-session dedupe (desktop pet U3).
 *
 * Public activities never include cwd, host session paths, tool call ids as
 * secrets, run summaries that embed model text, or document contents.
 */

import { buildSnflowDeepLink as buildSnflowDeepLinkHref } from "./desktop-deep-link";
import {
  buildProjectDisplayNameFromCwd,
  buildProjectKeyFromCwd,
} from "./task-observer-agent";
import {
  buildRunActivityId,
  buildSnflowTaskKey,
  buildSnflowTransitionId,
  resolveSafeTitle,
} from "./task-observer-projection";
import { notifyTaskObserverSourceChange } from "./task-observer-invalidate";
import type { TaskObserverActivityInput } from "./task-observer-types";
import {
  WORKFLOW_ACTIVE_RUN_STATES,
  WORKFLOW_TERMINAL_RUN_STATES,
  type WorkflowRunRecord,
  type WorkflowRunState,
  type WorkflowTaskSummary,
} from "./workflow-types";
import { listWorkflowTasks, readWorkflowRunRecord } from "./workflow-store";

export type SnflowObserverProjection = {
  activity: TaskObserverActivityInput;
  /** Parent ordinary chat session to suppress while this SnFlow run is active. */
  parentSessionId?: string;
  hostSessionId?: string;
  taskId: string;
  runId: string;
  runState: WorkflowRunState;
};

const MAX_RECENT_TERMINAL_PER_CWD = 8;

function mapSnflowExecution(state: WorkflowRunState): TaskObserverActivityInput["executionState"] {
  if (WORKFLOW_ACTIVE_RUN_STATES.has(state)) {
    return state === "starting" ? "queued" : "running";
  }
  return "settled";
}

function mapSnflowOutcome(state: WorkflowRunState): TaskObserverActivityInput["outcome"] {
  if (!WORKFLOW_TERMINAL_RUN_STATES.has(state)) return null;
  if (state === "completed") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "cancelled") return "cancelled";
  if (state === "stale") return "interrupted";
  return null;
}

function mapSnflowAttention(
  state: WorkflowRunState,
  taskStatus?: string | null,
): TaskObserverActivityInput["attention"] {
  // Unread Ready/Blocked for failed/succeeded is derived desktop-side from outcome.
  if (
    (taskStatus === "review_ready" || taskStatus === "changes_requested") &&
    state === "completed"
  ) {
    return "review_ready";
  }
  return "none";
}

function mapSnflowReason(state: WorkflowRunState, errorCode?: string | null): string | undefined {
  if (state === "stale") return "stale";
  if (state === "failed") return errorCode?.trim() ? clampCode(errorCode) : "snflow_failed";
  if (state === "cancelled") return "cancelled";
  return undefined;
}

function clampCode(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 64 ? trimmed : trimmed.slice(0, 64);
}

function phaseForRun(run: WorkflowRunRecord): string {
  if (WORKFLOW_ACTIVE_RUN_STATES.has(run.state)) {
    return run.phase === "check" ? "check" : "implement";
  }
  return run.state;
}

/**
 * Project one SnFlow run into a public observer activity.
 * Returns null for unusable/malformed inputs (isolated skip).
 */
export function projectSnflowRun(input: {
  run: WorkflowRunRecord;
  cwd: string;
  taskTitle?: string | null;
  taskStatus?: string | null;
}): SnflowObserverProjection | null {
  try {
    const run = input.run;
    if (!run || typeof run !== "object") return null;
    if (typeof run.id !== "string" || !run.id.trim()) return null;
    if (typeof run.taskId !== "string" || !run.taskId.trim()) return null;
    if (typeof run.state !== "string") return null;

    const projectKey = buildProjectKeyFromCwd(input.cwd);
    const projectName = buildProjectDisplayNameFromCwd(input.cwd);
    const state = run.state as WorkflowRunState;
    const executionState = mapSnflowExecution(state);
    const outcome = mapSnflowOutcome(state);
    const updatedOrEndedAt = run.endedAt || run.startedAt || run.createdAt || new Date(0).toISOString();
    const transitionId = buildSnflowTransitionId(run.id, state, updatedOrEndedAt);
    const titleBase = resolveSafeTitle("snflow", input.taskTitle);
    const title =
      run.phase === "check" ? `${titleBase} (check)` : `${titleBase} (implement)`;

    const activity: TaskObserverActivityInput = {
      taskKey: buildSnflowTaskKey(projectKey, run.taskId),
      activityId: buildRunActivityId(run.id),
      source: "snflow",
      projectKey,
      projectName,
      title,
      executionState,
      outcome,
      attention: mapSnflowAttention(state, input.taskStatus),
      phase: phaseForRun(run),
      reasonCode: mapSnflowReason(state, run.error?.code),
      progress:
        typeof run.toolCount === "number" || typeof run.turnCount === "number"
          ? {
              kind: "counters",
              toolCount: typeof run.toolCount === "number" ? run.toolCount : undefined,
              turnCount: typeof run.turnCount === "number" ? run.turnCount : undefined,
            }
          : { kind: "indeterminate" },
      startedAt: run.startedAt || run.createdAt,
      updatedAt: run.endedAt || run.startedAt || run.createdAt,
      endedAt: run.endedAt || undefined,
      children: [],
      deepLink: buildSnflowDeepLink(run),
      lastTransitionId: transitionId,
      stateVersion: 1,
    };

    return {
      activity,
      parentSessionId: run.parentSessionId?.trim() || undefined,
      hostSessionId: run.hostSessionId?.trim() || undefined,
      taskId: run.taskId,
      runId: run.id,
      runState: state,
    };
  } catch {
    return null;
  }
}

function buildSnflowDeepLink(run: WorkflowRunRecord): string {
  const sessionId = (run.parentSessionId || run.hostSessionId || "").trim();
  return buildSnflowDeepLinkHref({
    taskId: run.taskId,
    sessionId: sessionId || null,
  });
}

/**
 * Collect active (+ bounded recent terminal) SnFlow activities for one project cwd.
 * Malformed tasks/runs are skipped individually.
 */
export function listSnflowObserverProjections(
  cwd: string,
  options?: { maxRecentTerminal?: number },
): SnflowObserverProjection[] {
  const maxTerminal = options?.maxRecentTerminal ?? MAX_RECENT_TERMINAL_PER_CWD;
  const out: SnflowObserverProjection[] = [];
  let list: ReturnType<typeof listWorkflowTasks>;
  try {
    list = listWorkflowTasks(cwd, false);
  } catch {
    return out;
  }

  const terminalCandidates: { task: WorkflowTaskSummary; runId: string }[] = [];

  for (const task of list.tasks) {
    try {
      if (task.activeRunId) {
        const run = readWorkflowRunRecord(cwd, task.id, task.activeRunId);
        const projected = projectSnflowRun({
          run,
          cwd,
          taskTitle: task.title,
          taskStatus: task.status,
        });
        if (projected) out.push(projected);
        continue;
      }
      // Prefer latest implement/check for recent terminal window.
      const recentId = task.latestCheckRunId || task.latestImplementRunId;
      if (recentId) terminalCandidates.push({ task, runId: recentId });
    } catch {
      // isolate malformed task
    }
  }

  let terminalKept = 0;
  for (const candidate of terminalCandidates) {
    if (terminalKept >= maxTerminal) break;
    try {
      const run = readWorkflowRunRecord(cwd, candidate.task.id, candidate.runId);
      if (!WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) continue;
      const projected = projectSnflowRun({
        run,
        cwd,
        taskTitle: candidate.task.title,
        taskStatus: candidate.task.status,
      });
      if (projected) {
        out.push(projected);
        terminalKept += 1;
      }
    } catch {
      // isolate
    }
  }

  return out;
}

export function listSnflowObserverActivities(
  cwd: string,
  options?: { maxRecentTerminal?: number },
): TaskObserverActivityInput[] {
  return listSnflowObserverProjections(cwd, options).map((item) => item.activity);
}

/**
 * Session ids whose ordinary Agent host row should be suppressed because an
 * active SnFlow run is already the top-level activity (R7 / AE4).
 */
export function collectSnflowSuppressedHostSessionIds(
  projections: readonly SnflowObserverProjection[],
): Set<string> {
  const suppressed = new Set<string>();
  for (const item of projections) {
    if (!WORKFLOW_ACTIVE_RUN_STATES.has(item.runState)) continue;
    const parent = item.parentSessionId?.trim();
    const host = item.hostSessionId?.trim();
    if (parent) suppressed.add(parent);
    // Prefer parent correlation; host session is the native runner session and
    // is usually not the ordinary chat wrapper, but suppress if it coincides.
    if (host && host === parent) suppressed.add(host);
  }
  return suppressed;
}

/**
 * Drop ordinary agent activities whose session is the live SnFlow host parent.
 * Agent taskKey format: `agent:<sessionId>`.
 */
export function filterAgentActivitiesForSnflowDedupe(
  agentActivities: readonly TaskObserverActivityInput[],
  snflowProjections: readonly SnflowObserverProjection[],
): TaskObserverActivityInput[] {
  const suppressed = collectSnflowSuppressedHostSessionIds(snflowProjections);
  if (suppressed.size === 0) return [...agentActivities];
  return agentActivities.filter((activity) => {
    if (activity.source !== "agent") return true;
    if (!activity.taskKey.startsWith("agent:")) return true;
    const sessionId = activity.taskKey.slice("agent:".length);
    return !suppressed.has(sessionId);
  });
}

/** Best-effort hub ping after SnFlow source writes. */
export function notifySnflowObserverSourceChange(): void {
  notifyTaskObserverSourceChange();
}
