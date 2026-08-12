/**
 * Automation → task-observer projection (desktop pet U3).
 *
 * Preserves blocked/ambiguous/timed_out meaning without exposing prompt, cwd
 * path strings, tool snapshots, session files, or raw error messages.
 */

import { listActiveRuns } from "./automation-run-registry";
import { getTaskRecord, listRunRecords, readRunRecord } from "./automation-store";
import {
  isTerminalRunStatus,
  type AutomationRunRecord,
  type AutomationRunStatus,
  type AutomationTaskRecord,
} from "./automation-types";
import { buildAutomationDeepLink } from "./desktop-deep-link";
import {
  buildProjectDisplayNameFromCwd,
  buildProjectKeyFromCwd,
} from "./task-observer-agent";
import { notifyTaskObserverSourceChange } from "./task-observer-invalidate";
import {
  buildAutomationTaskKey,
  buildAutomationTransitionId,
  buildRunActivityId,
  resolveSafeTitle,
} from "./task-observer-projection";
import type {
  TaskObserverActivityInput,
  TaskObserverAttention,
  TaskObserverExecutionState,
  TaskObserverOutcome,
} from "./task-observer-types";

const MAX_RECENT_TERMINAL = 20;
const MAX_ACTIVE_SCAN = 100;

export type AutomationObserverProjection = {
  activity: TaskObserverActivityInput;
  runId: string;
  taskId: string;
  status: AutomationRunStatus;
};

function mapExecution(status: AutomationRunStatus): TaskObserverExecutionState {
  if (status === "queued" || status === "claimed") return "queued";
  if (status === "running" || status === "cancel_requested") return "running";
  return "settled";
}

function mapOutcome(status: AutomationRunStatus): TaskObserverOutcome {
  if (!isTerminalRunStatus(status)) return null;
  switch (status) {
    case "succeeded":
    case "skipped":
      return "succeeded";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "failed";
    case "ambiguous":
      return "ambiguous";
    default:
      return null;
  }
}

function mapAttention(status: AutomationRunStatus): TaskObserverAttention {
  if (status === "blocked") return "blocked";
  if (status === "ambiguous") return "blocked";
  if (status === "cancel_requested") return "none";
  return "none";
}

function mapReason(status: AutomationRunStatus, blockedReason: string | null, errorCategory: string | null): string | undefined {
  if (status === "blocked") {
    return blockedReason?.trim() ? clampCode(`blocked_${blockedReason}`) : "blocked";
  }
  if (status === "ambiguous") return "ambiguous";
  if (status === "timed_out") return "timed_out";
  if (status === "failed") {
    return errorCategory?.trim() ? clampCode(errorCategory) : "automation_failed";
  }
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  return undefined;
}

function clampCode(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 64 ? trimmed : trimmed.slice(0, 64);
}

function projectGroup(run: AutomationRunRecord): { projectKey: string; projectName: string } {
  const cwd = typeof run.cwd === "string" ? run.cwd.trim() : "";
  if (cwd) {
    return {
      projectKey: buildProjectKeyFromCwd(cwd),
      projectName: buildProjectDisplayNameFromCwd(cwd),
    };
  }
  return { projectKey: "automation", projectName: "Automation" };
}

/**
 * Project one Automation run. Returns null when the record is unusable.
 */
export function projectAutomationRun(input: {
  run: AutomationRunRecord;
  taskName?: string | null;
}): AutomationObserverProjection | null {
  try {
    const run = input.run;
    if (!run || typeof run !== "object") return null;
    if (typeof run.id !== "string" || !run.id.trim()) return null;
    if (typeof run.taskId !== "string" || !run.taskId.trim()) return null;
    if (typeof run.status !== "string") return null;

    const status = run.status as AutomationRunStatus;
    const { projectKey, projectName } = projectGroup(run);
    const at =
      run.completedAt ||
      run.startedAt ||
      run.claimedAt ||
      run.createdAt ||
      new Date(0).toISOString();
    const transitionId = buildAutomationTransitionId(run.id, status, at);
    const title = resolveSafeTitle("automation", input.taskName);

    const activity: TaskObserverActivityInput = {
      taskKey: buildAutomationTaskKey(run.taskId),
      activityId: buildRunActivityId(run.id),
      source: "automation",
      projectKey,
      projectName,
      title,
      executionState: mapExecution(status),
      outcome: mapOutcome(status),
      attention: mapAttention(status),
      phase: status,
      reasonCode: mapReason(status, run.blockedReason ?? null, run.errorCategory ?? null),
      progress: { kind: "indeterminate" },
      startedAt: run.startedAt || run.claimedAt || run.createdAt || undefined,
      updatedAt: at,
      endedAt: run.completedAt || undefined,
      children: [],
      deepLink: buildAutomationDeepLink({ taskId: run.taskId, runId: run.id }),
      lastTransitionId: transitionId,
      stateVersion: 1,
    };

    return {
      activity,
      runId: run.id,
      taskId: run.taskId,
      status,
    };
  } catch {
    return null;
  }
}

function resolveTaskName(taskId: string, cache: Map<string, string | null>): string | null {
  if (cache.has(taskId)) return cache.get(taskId) ?? null;
  try {
    const task: AutomationTaskRecord | null = getTaskRecord(taskId);
    const name = task?.name?.trim() || null;
    cache.set(taskId, name);
    return name;
  } catch {
    cache.set(taskId, null);
    return null;
  }
}

/**
 * Active + bounded recent terminal Automation activities.
 * Malformed runs are skipped; active registry ids are preferred for liveness.
 */
export function listAutomationObserverProjections(options?: {
  maxRecentTerminal?: number;
  agentDir?: string;
}): AutomationObserverProjection[] {
  const maxTerminal = options?.maxRecentTerminal ?? MAX_RECENT_TERMINAL;
  const out: AutomationObserverProjection[] = [];
  const seen = new Set<string>();
  const nameCache = new Map<string, string | null>();

  // Live registry first (process-local running set).
  for (const active of listActiveRuns()) {
    try {
      const run = readRunRecord(active.runId, options?.agentDir);
      if (!run) continue;
      const projected = projectAutomationRun({
        run,
        taskName: resolveTaskName(run.taskId, nameCache),
      });
      if (projected) {
        out.push(projected);
        seen.add(projected.runId);
      }
    } catch {
      // isolate
    }
  }

  let terminalKept = 0;
  let scanned = 0;
  let records: AutomationRunRecord[] = [];
  try {
    records = listRunRecords({
      agentDir: options?.agentDir,
      limit: MAX_ACTIVE_SCAN,
    });
  } catch {
    return out;
  }

  for (const run of records) {
    scanned += 1;
    if (scanned > MAX_ACTIVE_SCAN) break;
    if (seen.has(run.id)) continue;
    try {
      const terminal = isTerminalRunStatus(run.status);
      if (terminal && terminalKept >= maxTerminal) continue;
      const projected = projectAutomationRun({
        run,
        taskName: resolveTaskName(run.taskId, nameCache),
      });
      if (!projected) continue;
      if (terminal) terminalKept += 1;
      out.push(projected);
      seen.add(projected.runId);
    } catch {
      // isolate
    }
  }

  return out;
}

export function listAutomationObserverActivities(options?: {
  maxRecentTerminal?: number;
  agentDir?: string;
}): TaskObserverActivityInput[] {
  return listAutomationObserverProjections(options).map((item) => item.activity);
}

export function notifyAutomationObserverSourceChange(): void {
  notifyTaskObserverSourceChange();
}
