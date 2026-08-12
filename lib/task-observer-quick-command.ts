/**
 * Quick Command → task-observer projection (desktop pet U3).
 *
 * Safe summaries never include command text, resolved cwd, env, output chunks,
 * or exit reason strings — only name, status codes, and timestamps.
 */

import {
  buildProjectDisplayNameFromCwd,
  buildProjectKeyFromCwd,
} from "./task-observer-agent";
import { notifyTaskObserverSourceChange } from "./task-observer-invalidate";
import {
  buildQuickCommandTaskKey,
  buildQuickCommandTransitionId,
  buildRunActivityId,
  resolveSafeTitle,
} from "./task-observer-projection";
import type {
  TaskObserverActivityInput,
  TaskObserverExecutionState,
  TaskObserverOutcome,
} from "./task-observer-types";
import {
  isQuickCommandActiveStatus,
  isQuickCommandTerminalStatus,
  type QuickCommandRunStatus,
} from "./quick-command-types";
import {
  listQuickCommandObserverSources,
  type QuickCommandObserverSource,
} from "./quick-command-runner";

export type QuickCommandObserverProjection = {
  activity: TaskObserverActivityInput;
  runId: string;
  commandId: string;
  status: QuickCommandRunStatus;
};

function mapExecution(status: QuickCommandRunStatus): TaskObserverExecutionState {
  if (status === "starting") return "queued";
  if (status === "running") return "running";
  return "settled";
}

function mapOutcome(status: QuickCommandRunStatus): TaskObserverOutcome {
  if (!isQuickCommandTerminalStatus(status)) return null;
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function mapReason(status: QuickCommandRunStatus): string | undefined {
  if (status === "timed_out") return "timed_out";
  if (status === "failed") return "quick_command_failed";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  return undefined;
}

/**
 * Project a safe QC source row. Returns null when unusable.
 */
export function projectQuickCommandSource(
  source: QuickCommandObserverSource,
): QuickCommandObserverProjection | null {
  try {
    if (!source || typeof source !== "object") return null;
    if (!source.runId?.trim() || !source.commandId?.trim()) return null;
    if (!source.status) return null;

    const projectCwd = source.projectCwd?.trim() || "project";
    const projectKey = buildProjectKeyFromCwd(projectCwd);
    const projectName = buildProjectDisplayNameFromCwd(projectCwd);
    const at = source.endedAt || source.startedAt || new Date(0).toISOString();
    const transitionId = buildQuickCommandTransitionId(source.runId, source.status, at);

    const activity: TaskObserverActivityInput = {
      taskKey: buildQuickCommandTaskKey(projectKey, source.commandId),
      activityId: buildRunActivityId(source.runId),
      source: "quick_command",
      projectKey,
      projectName,
      title: resolveSafeTitle("quick_command", source.name),
      executionState: mapExecution(source.status),
      outcome: mapOutcome(source.status),
      attention: "none",
      phase: source.status,
      reasonCode: mapReason(source.status),
      progress: { kind: "indeterminate" },
      startedAt: source.startedAt,
      updatedAt: at,
      endedAt: source.endedAt || undefined,
      children: [],
      deepLink: `/?panel=quick-commands&run=${encodeURIComponent(source.runId)}`,
      lastTransitionId: transitionId,
      stateVersion: 1,
    };

    return {
      activity,
      runId: source.runId,
      commandId: source.commandId,
      status: source.status,
    };
  } catch {
    return null;
  }
}

/**
 * Active + recent in-memory Quick Command activities (process-local only).
 */
export function listQuickCommandObserverProjections(): QuickCommandObserverProjection[] {
  const out: QuickCommandObserverProjection[] = [];
  let sources: QuickCommandObserverSource[] = [];
  try {
    sources = listQuickCommandObserverSources();
  } catch {
    return out;
  }
  for (const source of sources) {
    const projected = projectQuickCommandSource(source);
    if (projected) out.push(projected);
  }
  // Prefer active first then recent terminal order already provided by runner.
  return out;
}

export function listQuickCommandObserverActivities(): TaskObserverActivityInput[] {
  return listQuickCommandObserverProjections().map((item) => item.activity);
}

export function isQuickCommandObserverActive(status: QuickCommandRunStatus): boolean {
  return isQuickCommandActiveStatus(status);
}

export function notifyQuickCommandObserverSourceChange(): void {
  notifyTaskObserverSourceChange();
}
