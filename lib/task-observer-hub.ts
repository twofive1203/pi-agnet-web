/**
 * Global TaskObserverHub: one service-level bounded snapshot stream for the
 * desktop pet (U4). Observer subscribers never become chat SSE listeners.
 */

import { getProcessInstanceId } from "./process-runtime";
import { subscribeTaskObserverInvalidate } from "./task-observer-invalidate";
import type { SnflowObserverProjection } from "./task-observer-snflow";
import {
  buildTaskObserverSnapshot,
  createEmptyLocalAckState,
  deriveActivityPresentation,
  projectActivity,
  serializeTaskObserverSnapshot,
  snapshotContentFingerprint,
} from "./task-observer-projection";
import {
  TASK_OBSERVER_BUDGETS,
  TASK_OBSERVER_PROTOCOL_VERSION,
  type TaskObserverActivityInput,
  type TaskObserverSnapshot,
  type TaskObserverTransitionInput,
} from "./task-observer-types";

/** Lazy collectors keep hub import free of pi SDK for pure access smokes. */
export type TaskObserverCollectors = {
  listAgentActivities: () => TaskObserverActivityInput[];
  listAgentCwds: () => string[];
  listSnflowProjections: (cwd: string) => SnflowObserverProjection[];
  filterAgentForSnflow: (
    agents: TaskObserverActivityInput[],
    snflow: SnflowObserverProjection[],
  ) => TaskObserverActivityInput[];
  listAutomationActivities: () => TaskObserverActivityInput[];
  listQuickCommandActivities: () => TaskObserverActivityInput[];
};

function defaultCollectors(): TaskObserverCollectors {
  return {
    listAgentActivities: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listLiveAgentTaskObservations } = require("./rpc-manager") as typeof import("./rpc-manager");
      return listLiveAgentTaskObservations();
    },
    listAgentCwds: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listLiveAgentObserverCwds } = require("./rpc-manager") as typeof import("./rpc-manager");
      return listLiveAgentObserverCwds();
    },
    listSnflowProjections: (cwd: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listSnflowObserverProjections } = require("./task-observer-snflow") as typeof import("./task-observer-snflow");
      return listSnflowObserverProjections(cwd);
    },
    filterAgentForSnflow: (agents, snflow) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { filterAgentActivitiesForSnflowDedupe } = require("./task-observer-snflow") as typeof import("./task-observer-snflow");
      return filterAgentActivitiesForSnflowDedupe(agents, snflow);
    },
    listAutomationActivities: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listAutomationObserverActivities } = require("./task-observer-automation") as typeof import("./task-observer-automation");
      return listAutomationObserverActivities();
    },
    listQuickCommandActivities: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { listQuickCommandObserverActivities } = require("./task-observer-quick-command") as typeof import("./task-observer-quick-command");
      return listQuickCommandObserverActivities();
    },
  };
}

export const TASK_OBSERVER_PROGRESS_COALESCE_MS = 500;
export const TASK_OBSERVER_SSE_HEARTBEAT_MS = 25_000;

export type TaskObserverHubListener = (event: {
  type: "snapshot" | "reset";
  snapshot: TaskObserverSnapshot;
  json: string;
}) => void;

type HubState = {
  hub: TaskObserverHub | null;
  invalidateUnsub: (() => void) | null;
};

declare global {
  var __piTaskObserverHubState: HubState | undefined;
}

function hubState(): HubState {
  if (!globalThis.__piTaskObserverHubState) {
    globalThis.__piTaskObserverHubState = { hub: null, invalidateUnsub: null };
  }
  return globalThis.__piTaskObserverHubState;
}

function presentationForTransition(
  activity: TaskObserverActivityInput,
): TaskObserverTransitionInput["presentation"] | null {
  try {
    const presentation = deriveActivityPresentation(
      projectActivity(activity),
      createEmptyLocalAckState(),
    );
    if (
      presentation === "needs_input" ||
      presentation === "blocked" ||
      presentation === "ready" ||
      presentation === "retrying" ||
      presentation === "running"
    ) {
      return presentation;
    }
  } catch {
    return null;
  }
  return null;
}

function isUrgentActivity(activity: TaskObserverActivityInput): boolean {
  if (activity.attention === "needs_input" || activity.attention === "blocked") return true;
  if (activity.executionState === "retrying") return true;
  if (activity.executionState === "settled") return true;
  return false;
}

export class TaskObserverHub {
  private revision = 0;
  private lastFingerprint = "";
  private lastSnapshot: TaskObserverSnapshot | null = null;
  private lastJson = "";
  private listeners = new Set<TaskObserverHubListener>();
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUrgent = false;
  private knownCwds = new Set<string>();
  private transitionRing: TaskObserverTransitionInput[] = [];
  private seenTransitionIds = new Set<string>();
  private readonly clock: () => number;
  private readonly collectors: TaskObserverCollectors;

  constructor(options?: { clock?: () => number; collectors?: TaskObserverCollectors }) {
    this.clock = options?.clock ?? Date.now;
    this.collectors = options?.collectors ?? defaultCollectors();
  }

  /** Seed/extra project roots for SnFlow collection (tests and async index refresh). */
  rememberCwd(cwd: string): void {
    const trimmed = cwd.trim();
    if (trimmed) this.knownCwds.add(trimmed);
  }

  getListenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Subscribe to snapshot emissions. Does not count as a chat SSE listener and
   * does not extend Agent idle lifetime.
   */
  subscribe(listener: TaskObserverHubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Build current snapshot without emitting (and without forcing reset). */
  getSnapshot(options?: { reset?: boolean }): {
    snapshot: TaskObserverSnapshot;
    json: string;
  } {
    const built = this.rebuild(Boolean(options?.reset));
    return { snapshot: built.snapshot, json: built.json };
  }

  /** Invalidate from source adapters; coalesces progress, flushes urgent immediately. */
  invalidate(options?: { urgent?: boolean }): void {
    if (options?.urgent) this.pendingUrgent = true;
    if (this.pendingUrgent) {
      this.flush("snapshot");
      return;
    }
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.flush("snapshot");
    }, TASK_OBSERVER_PROGRESS_COALESCE_MS);
    // Don't keep the process alive solely for observer coalesce.
    this.coalesceTimer.unref?.();
  }

  /** Force a reset snapshot to all listeners (instance change / remint baseline). */
  emitReset(): void {
    this.flush("reset");
  }

  dispose(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.listeners.clear();
  }

  private flush(type: "snapshot" | "reset"): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const built = this.rebuild(type === "reset");
    this.pendingUrgent = false;
    if (type === "snapshot" && !built.changed && this.lastSnapshot) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener({ type, snapshot: built.snapshot, json: built.json });
      } catch {
        // listener isolation
      }
    }
  }

  private rebuild(resetFlag: boolean): {
    snapshot: TaskObserverSnapshot;
    json: string;
    changed: boolean;
  } {
    const diagnostics: { code: string; message: string }[] = [];
    const activities: TaskObserverActivityInput[] = [];
    const snflowProjections: SnflowObserverProjection[] = [];

    // --- Agent ---
    let agentActivities: TaskObserverActivityInput[] = [];
    try {
      agentActivities = this.collectors.listAgentActivities();
      for (const cwd of this.collectors.listAgentCwds()) this.knownCwds.add(cwd);
    } catch {
      diagnostics.push({
        code: "agent_collect_failed",
        message: "Failed to collect agent observations",
      });
    }

    // --- SnFlow per known cwd ---
    for (const cwd of this.knownCwds) {
      try {
        const projections = this.collectors.listSnflowProjections(cwd);
        for (const projection of projections) {
          snflowProjections.push(projection);
          activities.push(projection.activity);
        }
      } catch {
        diagnostics.push({
          code: "snflow_collect_failed",
          message: "Failed to collect SnFlow observations for one project",
        });
      }
    }

    // --- Agent after SnFlow host dedupe ---
    try {
      const deduped = this.collectors.filterAgentForSnflow(agentActivities, snflowProjections);
      activities.push(...deduped);
    } catch {
      activities.push(...agentActivities);
      diagnostics.push({
        code: "snflow_dedupe_failed",
        message: "SnFlow host dedupe failed; agent rows included without filter",
      });
    }

    // --- Automation ---
    try {
      activities.push(...this.collectors.listAutomationActivities());
    } catch {
      diagnostics.push({
        code: "automation_collect_failed",
        message: "Failed to collect Automation observations",
      });
    }

    // --- Quick Command ---
    try {
      activities.push(...this.collectors.listQuickCommandActivities());
    } catch {
      diagnostics.push({
        code: "quick_command_collect_failed",
        message: "Failed to collect Quick Command observations",
      });
    }

    // Transition ring: record new lastTransitionIds with meaningful presentation.
    for (const activity of activities) {
      const tid = activity.lastTransitionId;
      if (!tid || this.seenTransitionIds.has(tid)) continue;
      const presentation = presentationForTransition(activity);
      if (!presentation) continue;
      this.seenTransitionIds.add(tid);
      this.transitionRing.push({
        transitionId: tid,
        taskKey: activity.taskKey,
        activityId: activity.activityId,
        source: activity.source,
        projectKey: activity.projectKey,
        presentation,
        executionState: activity.executionState,
        outcome: activity.outcome ?? null,
        attention: activity.attention ?? "none",
        at: activity.updatedAt || activity.endedAt || new Date(this.clock()).toISOString(),
      });
      if (isUrgentActivity(activity)) {
        this.pendingUrgent = true;
      }
    }
    while (this.transitionRing.length > TASK_OBSERVER_BUDGETS.maxRecentTransitions) {
      const dropped = this.transitionRing.shift();
      if (dropped) this.seenTransitionIds.delete(dropped.transitionId);
    }
    // Bound seen set
    if (this.seenTransitionIds.size > TASK_OBSERVER_BUDGETS.maxRecentTransitions * 4) {
      this.seenTransitionIds = new Set(this.transitionRing.map((t) => t.transitionId));
    }

    const provisional = buildTaskObserverSnapshot({
      instanceId: getProcessInstanceId(),
      revision: this.revision,
      generatedAt: new Date(this.clock()).toISOString(),
      reset: resetFlag,
      activities,
      recentTransitions: this.transitionRing,
      diagnostics,
    });

    const serialized = serializeTaskObserverSnapshot(provisional);
    const fingerprint = snapshotContentFingerprint(serialized.snapshot);
    const changed = fingerprint !== this.lastFingerprint;
    if (changed) {
      this.revision += 1;
      serialized.snapshot.revision = this.revision;
      // Re-serialize after revision bump (revision is in fingerprint? - check)
      // snapshotContentFingerprint excludes revision? Looking at U1 - it includes... 
      // Actually fingerprint includes protocolVersion, instanceId, reset, truncation, aggregate, projects, transitions, diagnostics - NOT revision.
      // Good - revision bump doesn't need re-fingerprint for change detection.
      const again = serializeTaskObserverSnapshot(serialized.snapshot);
      this.lastSnapshot = again.snapshot;
      this.lastJson = again.json;
      this.lastFingerprint = fingerprint;
      return { snapshot: again.snapshot, json: again.json, changed: true };
    }

    // Unchanged content: refresh generatedAt only on the cached snapshot object copy for readers.
    if (!this.lastSnapshot) {
      this.revision = Math.max(1, this.revision);
      serialized.snapshot.revision = this.revision;
      const again = serializeTaskObserverSnapshot(serialized.snapshot);
      this.lastSnapshot = again.snapshot;
      this.lastJson = again.json;
      this.lastFingerprint = fingerprint;
      return { snapshot: again.snapshot, json: again.json, changed: true };
    }

    const withTime: TaskObserverSnapshot = {
      ...this.lastSnapshot,
      generatedAt: new Date(this.clock()).toISOString(),
      reset: resetFlag ? true : this.lastSnapshot.reset,
    };
    // Do not bump revision for time-only refresh.
    const timed = serializeTaskObserverSnapshot(withTime);
    return { snapshot: timed.snapshot, json: timed.json, changed: false };
  }
}

export function getTaskObserverHub(): TaskObserverHub {
  const state = hubState();
  if (!state.hub) {
    state.hub = new TaskObserverHub();
    state.invalidateUnsub = subscribeTaskObserverInvalidate(() => {
      try {
        state.hub?.invalidate();
      } catch {
        // never throw into source adapters
      }
    });
  }
  return state.hub;
}

/** Test helper: drop singleton hub. */
export function resetTaskObserverHubForTests(): void {
  const state = hubState();
  state.invalidateUnsub?.();
  state.invalidateUnsub = null;
  state.hub?.dispose();
  state.hub = null;
}

export function getTaskObserverProtocolVersion(): number {
  return TASK_OBSERVER_PROTOCOL_VERSION;
}
