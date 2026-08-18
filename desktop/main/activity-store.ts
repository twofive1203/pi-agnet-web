/**
 * Desktop activity projection, local read state, and tray grouping (U7).
 *
 * Pure module: no Electron, no observer token, no child_process.
 * Server task records are never mutated — ack is desktop-local only (R6 / R27).
 */

import {
  deriveActivityPresentation,
  deriveDesktopPresentation,
  type LocalAckState,
} from "../../lib/task-observer-projection";
import type {
  TaskObserverActivity,
  TaskObserverAggregate,
  TaskObserverChildSummary,
  TaskObserverConnectionState,
  TaskObserverDiagnostic,
  TaskObserverPresentationState,
  TaskObserverProgress,
  TaskObserverProject,
  TaskObserverSnapshot,
  TaskObserverSource,
  TaskObserverTransition,
} from "../../lib/task-observer-types";
import { TASK_OBSERVER_PRESENTATION_PRIORITY } from "../../lib/task-observer-types";
import {
  canCopyStartCommand,
  DESKTOP_START_COMMAND,
  type DesktopConnectionState,
  type DesktopConnectionStatus,
} from "./connection-state";
import { pushTransitionLru, type DesktopPetSettings } from "./settings-store";

/** Sanitized activity row for the renderer / tray (no token, cwd, absolute URL). */
export type DesktopActivityRow = {
  taskKey: string;
  activityId: string;
  source: TaskObserverSource;
  projectKey: string;
  projectName: string;
  title: string;
  presentation: TaskObserverPresentationState;
  executionState: TaskObserverActivity["executionState"];
  outcome: TaskObserverActivity["outcome"];
  attention: TaskObserverActivity["attention"];
  phase?: string;
  reasonCode?: string;
  progress: TaskObserverProgress;
  activeModel?: TaskObserverActivity["activeModel"];
  sessionResources?: TaskObserverActivity["sessionResources"];
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  /** Relative allowlisted deep link only. */
  deepLink: string;
  lastTransitionId: string;
  unread: boolean;
  /** Client-computed elapsed ms; null when timestamps unknown. */
  elapsedMs: number | null;
  children: DesktopChildRow[];
};

export type DesktopChildRow = {
  childId: string;
  title: string;
  executionState: TaskObserverChildSummary["executionState"];
  outcome: TaskObserverChildSummary["outcome"];
  attention: TaskObserverChildSummary["attention"];
  phase?: string;
  updatedAt?: string;
};

export type DesktopProjectGroup = {
  projectKey: string;
  displayName: string;
  counts: {
    active: number;
    needsInput: number;
    blocked: number;
    ready: number;
    unread: number;
  };
  activities: DesktopActivityRow[];
};

/**
 * Full sanitized view model pushed to the renderer over the narrow preload bridge.
 * Must never include observer tokens, absolute external URLs, cwd, or prompts.
 */
export type DesktopActivityView = {
  presentation: TaskObserverPresentationState;
  connectionStatus: DesktopConnectionStatus;
  connectionReasonCode: string | null;
  origin: string;
  port: number;
  /** Copyable only — never executed. */
  startCommand: string;
  canCopyStartCommand: boolean;
  /** True when main holds a server access key (value never included). */
  hasAccessKey: boolean;
  /** Show the access-key entry panel (server mode / invalid key). */
  needsAccessKey: boolean;
  /** True when last snapshot is retained under reconnect/disconnect. */
  stale: boolean;
  trayOpen: boolean;
  /**
   * Where the pet stack sits while trayOpen (mirrors window-manager trayAnchor).
   * Drives flex layout so the icon stays fixed while the tray grows outward.
   */
  trayAnchor: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  selectedActivityId: string | null;
  selectedPetId: string;
  selectedPetKey: string;
  petScale: DesktopPetSettings["petScale"];
  alwaysOnTop: boolean;
  clickThrough: boolean;
  launchAtLogin: boolean;
  showContextMeter: boolean;
  dndEnabled: boolean;
  notification: DesktopPetSettings["notification"];
  sound: DesktopPetSettings["sound"];
  reducedMotion: boolean;
  /** Reset/baseline snapshot marker for renderer-local transient presentation. */
  reset: boolean;
  revision: number | null;
  instanceId: string | null;
  generatedAt: string | null;
  aggregate: TaskObserverAggregate | null;
  projects: DesktopProjectGroup[];
  diagnostics: TaskObserverDiagnostic[];
  attentionCount: number;
  activeCount: number;
  /** Display-only custom pets root path (main-owned; never renderer-supplied). */
  customPetsRoot: string | null;
  /** Safe boolean only — never a token, cwd, or raw capability list. */
  quickSessionAvailable: boolean;
};

export type ActivityStoreSnapshotInput = {
  snapshot: TaskObserverSnapshot | null;
  connection: DesktopConnectionState;
  settings: DesktopPetSettings;
  /** Wall clock for elapsed computation. */
  now?: number;
  /** OS reduced-motion preference (main injects). */
  reducedMotion?: boolean;
  /** Renderer-only selection cursor. */
  selectedActivityId?: string | null;
  /** When true, keep last projects but mark stale (SSE lost). */
  stale?: boolean;
  /** Whether main currently holds an access key (never the key itself). */
  hasAccessKey?: boolean;
  /** Layout anchor while tray is open (from window-manager). */
  trayAnchor?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Explicit observer baseline/reset marker from the connection envelope. */
  reset?: boolean;
  /** Display-only custom pets root path (main-owned; never renderer-supplied). */
  customPetsRoot?: string | null;
};

const PRESENTATION_RANK = new Map(
  TASK_OBSERVER_PRESENTATION_PRIORITY.map((state, index) => [state, index]),
);

export function mapConnectionToObserver(
  status: DesktopConnectionStatus,
): TaskObserverConnectionState {
  switch (status) {
    case "probing":
      return "probing";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting";
    case "service-not-running":
      return "service_not_running";
    case "incompatible":
      return "incompatible";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function ackStateFromSettings(settings: DesktopPetSettings): LocalAckState {
  return { acknowledgedTransitionIds: settings.acknowledgedTransitionIds };
}

export function computeElapsedMs(
  startedAt: string | undefined,
  endedAt: string | undefined,
  now: number,
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.floor(end - start));
}

function presentationRank(state: TaskObserverPresentationState): number {
  return PRESENTATION_RANK.get(state) ?? TASK_OBSERVER_PRESENTATION_PRIORITY.length;
}

/** Sort: Needs input → Blocked → Ready → Retrying → Running → Idle, then updatedAt desc. */
export function compareActivityRows(a: DesktopActivityRow, b: DesktopActivityRow): number {
  const rankDiff = presentationRank(a.presentation) - presentationRank(b.presentation);
  if (rankDiff !== 0) return rankDiff;
  const aTime = Date.parse(a.updatedAt ?? a.startedAt ?? "") || 0;
  const bTime = Date.parse(b.updatedAt ?? b.startedAt ?? "") || 0;
  return bTime - aTime;
}

export function projectActivityRow(
  activity: TaskObserverActivity,
  ack: LocalAckState,
  now: number,
): DesktopActivityRow {
  const presentation = deriveActivityPresentation(activity, ack);
  const unread =
    presentation === "needs_input" ||
    presentation === "blocked" ||
    presentation === "ready";
  return {
    taskKey: activity.taskKey,
    activityId: activity.activityId,
    source: activity.source,
    projectKey: activity.projectKey,
    projectName: activity.projectName,
    title: activity.title,
    presentation,
    executionState: activity.executionState,
    outcome: activity.outcome,
    attention: activity.attention,
    phase: activity.phase,
    reasonCode: activity.reasonCode,
    progress: activity.progress,
    activeModel: activity.activeModel ? { ...activity.activeModel } : undefined,
    sessionResources: activity.sessionResources
      ? {
          context: activity.sessionResources.context
            ? { ...activity.sessionResources.context }
            : undefined,
          billing: activity.sessionResources.billing
            ? { ...activity.sessionResources.billing }
            : undefined,
          performance: activity.sessionResources.performance
            ? { ...activity.sessionResources.performance }
            : undefined,
        }
      : undefined,
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
    endedAt: activity.endedAt,
    deepLink: activity.deepLink,
    lastTransitionId: activity.lastTransitionId,
    unread,
    elapsedMs: computeElapsedMs(activity.startedAt, activity.endedAt, now),
    children: activity.children.map((child) => ({
      childId: child.childId,
      title: child.title,
      executionState: child.executionState,
      outcome: child.outcome,
      attention: child.attention,
      phase: child.phase,
      updatedAt: child.updatedAt,
    })),
  };
}

export function projectProjectGroup(
  project: TaskObserverProject,
  ack: LocalAckState,
  now: number,
): DesktopProjectGroup {
  const activities = project.activities
    .map((activity) => projectActivityRow(activity, ack, now))
    .sort(compareActivityRows);
  let unread = 0;
  for (const row of activities) {
    if (row.unread) unread += 1;
  }
  return {
    projectKey: project.projectKey,
    displayName: project.displayName,
    counts: {
      active: project.counts.active,
      needsInput: project.counts.needsInput,
      blocked: project.counts.blocked,
      ready: project.counts.ready,
      unread,
    },
    activities,
  };
}

/** Group + sort projects by highest activity priority, then display name. */
export function sortProjectGroups(groups: DesktopProjectGroup[]): DesktopProjectGroup[] {
  return [...groups].sort((a, b) => {
    const aBest = a.activities[0]?.presentation ?? "idle";
    const bBest = b.activities[0]?.presentation ?? "idle";
    const rankDiff = presentationRank(aBest) - presentationRank(bBest);
    if (rankDiff !== 0) return rankDiff;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function flattenActivities(groups: readonly DesktopProjectGroup[]): DesktopActivityRow[] {
  const rows: DesktopActivityRow[] = [];
  for (const group of groups) {
    for (const activity of group.activities) {
      rows.push(activity);
    }
  }
  return rows;
}

export function findActivityById(
  groups: readonly DesktopProjectGroup[],
  activityId: string,
): DesktopActivityRow | null {
  for (const group of groups) {
    for (const activity of group.activities) {
      if (activity.activityId === activityId) return activity;
    }
  }
  return null;
}

/**
 * Build the sanitized Activity tray + pet view model.
 * Connection overlays outrank task presentation (service not running / disconnected).
 */
export function buildActivityView(input: ActivityStoreSnapshotInput): DesktopActivityView {
  const now = input.now ?? Date.now();
  const ack = ackStateFromSettings(input.settings);
  const connectionMapped = mapConnectionToObserver(input.connection.status);
  const stale =
    input.stale === true ||
    input.connection.status === "reconnecting" ||
    (input.connection.status !== "connected" && input.snapshot != null);

  const emptyAggregate: TaskObserverAggregate = {
    activeProjects: 0,
    activeActivities: 0,
    needsInput: 0,
    blocked: 0,
    ready: 0,
    running: 0,
  };

  let projects: DesktopProjectGroup[] = [];
  let aggregate: TaskObserverAggregate | null = null;
  let diagnostics: TaskObserverDiagnostic[] = [];
  let allActivities: TaskObserverActivity[] = [];

  if (input.snapshot) {
    projects = sortProjectGroups(
      input.snapshot.projects.map((project) => projectProjectGroup(project, ack, now)),
    );
    aggregate = input.snapshot.aggregate;
    diagnostics = input.snapshot.diagnostics.slice();
    allActivities = input.snapshot.projects.flatMap((project) => project.activities);
  }

  const presentation = deriveDesktopPresentation({
    connection: connectionMapped,
    activities: allActivities,
    ack,
  });

  const rows = flattenActivities(projects);
  let attentionCount = 0;
  let activeCount = 0;
  for (const row of rows) {
    if (row.presentation === "needs_input" || row.presentation === "blocked") {
      attentionCount += 1;
    }
    if (
      row.presentation === "running" ||
      row.presentation === "retrying" ||
      row.presentation === "needs_input"
    ) {
      activeCount += 1;
    }
  }

  const selectedActivityId = input.selectedActivityId ?? null;
  const selectedExists =
    selectedActivityId != null && findActivityById(projects, selectedActivityId) != null;

  const reason = input.connection.reasonCode;
  const needsAccessKey =
    reason === "auth_required" || reason === "auth_invalid";

  return {
    presentation,
    connectionStatus: input.connection.status,
    connectionReasonCode: input.connection.reasonCode,
    origin: input.connection.origin,
    port: input.connection.port,
    startCommand: DESKTOP_START_COMMAND,
    canCopyStartCommand: canCopyStartCommand(input.connection),
    hasAccessKey: input.hasAccessKey === true,
    needsAccessKey,
    stale,
    trayOpen: input.settings.activityTrayOpen,
    trayAnchor: input.trayAnchor ?? "top-left",
    selectedActivityId: selectedExists ? selectedActivityId : null,
    selectedPetId: input.settings.selectedPetId,
    selectedPetKey: input.settings.selectedPetKey,
    petScale: input.settings.petScale,
    alwaysOnTop: input.settings.alwaysOnTop,
    clickThrough: input.settings.clickThrough,
    launchAtLogin: input.settings.launchAtLogin,
    showContextMeter: input.settings.showContextMeter,
    dndEnabled: input.settings.dndEnabled,
    notification: { ...input.settings.notification },
    sound: { ...input.settings.sound },
    reducedMotion: input.reducedMotion === true,
    reset: input.reset === true || input.snapshot?.reset === true,
    revision: input.snapshot?.revision ?? null,
    instanceId: input.snapshot?.instanceId ?? input.connection.instanceId,
    generatedAt: input.snapshot?.generatedAt ?? null,
    aggregate: aggregate ?? (input.snapshot ? emptyAggregate : null),
    projects,
    diagnostics,
    attentionCount,
    activeCount,
    customPetsRoot: input.customPetsRoot ?? null,
    quickSessionAvailable:
      input.connection.status === "connected" && input.connection.quickSessionAvailable === true,
  };
}

/** Mark one activity's last transition read locally. */
export function markActivityRead(
  settings: DesktopPetSettings,
  activity: Pick<DesktopActivityRow, "lastTransitionId">,
): DesktopPetSettings {
  const id = activity.lastTransitionId.trim();
  if (!id) return settings;
  return {
    ...settings,
    acknowledgedTransitionIds: pushTransitionLru(settings.acknowledgedTransitionIds, id),
  };
}

/** Mark all terminal unread (ready/blocked-from-outcome) activities read. Needs input stays. */
export function markAllTerminalRead(
  settings: DesktopPetSettings,
  view: DesktopActivityView,
): DesktopPetSettings {
  let next = settings.acknowledgedTransitionIds;
  for (const row of flattenActivities(view.projects)) {
    if (row.presentation === "ready" || row.presentation === "blocked") {
      // Keep needs_input: only terminal ready/blocked outcomes are bulk-acked.
      if (row.attention === "needs_input") continue;
      next = pushTransitionLru(next, row.lastTransitionId);
    }
  }
  return { ...settings, acknowledgedTransitionIds: next };
}

export function listUnreadTransitionIds(view: DesktopActivityView): string[] {
  const ids: string[] = [];
  for (const row of flattenActivities(view.projects)) {
    if (row.unread) ids.push(row.lastTransitionId);
  }
  return ids;
}

/**
 * Ensure a renderer-bound payload cannot smuggle tokens or absolute navigations.
 * Throws if forbidden keys appear at the top level or nested JSON.
 */
export function assertRendererViewSafe(view: unknown): void {
  const json = JSON.stringify(view);
  const forbidden = [
    "token",
    "observerToken",
    "accessKey",
    "password",
    "pid",
    "servicePid",
    "cwd",
    "firstMessage",
    "prompt",
    "command",
    "output",
    "child_process",
  ];
  for (const key of forbidden) {
    if (new RegExp(`"${key}"\\s*:`).test(json)) {
      throw new Error(`renderer view leaked key: ${key}`);
    }
  }
  // Absolute URLs must stay relative except the verified loopback origin display field.
  const absoluteUrls = json.match(/https?:\/\/[^"\s]+/gi) ?? [];
  for (const url of absoluteUrls) {
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?\/?$/i.test(url)) {
      throw new Error(`renderer view must not contain non-loopback absolute URL: ${url}`);
    }
  }
}

/** Index activities by activityId for notification fan-out. */
export function indexActivitiesById(
  snapshot: TaskObserverSnapshot | null,
): Map<string, TaskObserverActivity> {
  const map = new Map<string, TaskObserverActivity>();
  if (!snapshot) return map;
  for (const project of snapshot.projects) {
    for (const activity of project.activities) {
      map.set(activity.activityId, activity);
    }
  }
  return map;
}

/** Index by transition id via recentTransitions + activity lastTransitionId. */
export function indexActivitiesByTransitionId(
  snapshot: TaskObserverSnapshot | null,
): Map<string, TaskObserverActivity> {
  const byActivity = indexActivitiesById(snapshot);
  const map = new Map<string, TaskObserverActivity>();
  if (!snapshot) return map;
  for (const activity of byActivity.values()) {
    map.set(activity.lastTransitionId, activity);
  }
  for (const transition of snapshot.recentTransitions) {
    const match =
      byActivity.get(transition.activityId) ??
      [...byActivity.values()].find((item) => item.taskKey === transition.taskKey);
    if (match) map.set(transition.transitionId, match);
  }
  return map;
}

export type { TaskObserverTransition, TaskObserverSnapshot };
