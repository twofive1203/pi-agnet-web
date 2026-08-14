/**
 * Pure task-observer identity, presentation, acknowledgement and snapshot
 * projection. SDK/React/Electron free so smoke fixtures can import directly.
 */

import {
  TASK_OBSERVER_BUDGETS,
  TASK_OBSERVER_FORBIDDEN_FIELDS,
  TASK_OBSERVER_GENERIC_TITLES,
  TASK_OBSERVER_PRESENTATION_PRIORITY,
  TASK_OBSERVER_PROTOCOL_VERSION,
  type TaskObserverActiveModel,
  type TaskObserverActivity,
  type TaskObserverActivityInput,
  type TaskObserverAggregate,
  type TaskObserverAttention,
  type TaskObserverChildSummary,
  type TaskObserverChildSummaryInput,
  type TaskObserverConnectionState,
  type TaskObserverDiagnostic,
  type TaskObserverDiagnosticInput,
  type TaskObserverExecutionState,
  type TaskObserverOutcome,
  type TaskObserverPresentationState,
  type TaskObserverProgress,
  type TaskObserverProject,
  type TaskObserverSessionResources,
  type TaskObserverSnapshot,
  type TaskObserverSource,
  type TaskObserverTransition,
  type TaskObserverTransitionInput,
  type TaskObserverTruncation,
} from "./task-observer-types";

// ---------------------------------------------------------------------------
// Identity builders (ADR entity / activity / transition)
// ---------------------------------------------------------------------------

function requireNonEmptyId(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`task-observer: ${label} must be non-empty`);
  }
  return trimmed;
}

export function buildAgentTaskKey(sessionId: string): string {
  return `agent:${requireNonEmptyId("sessionId", sessionId)}`;
}

export function buildSnflowTaskKey(projectKey: string, taskId: string): string {
  return `snflow:${requireNonEmptyId("projectKey", projectKey)}:${requireNonEmptyId("taskId", taskId)}`;
}

export function buildAutomationTaskKey(taskId: string): string {
  return `automation:${requireNonEmptyId("taskId", taskId)}`;
}

export function buildQuickCommandTaskKey(projectKey: string, commandId: string): string {
  return `quick:${requireNonEmptyId("projectKey", projectKey)}:${requireNonEmptyId("commandId", commandId)}`;
}

export function buildAgentActivityId(
  instanceId: string,
  sessionId: string,
  promptEpoch: number,
): string {
  if (!Number.isInteger(promptEpoch) || promptEpoch < 1) {
    throw new Error("task-observer: promptEpoch must be a positive integer");
  }
  return `${requireNonEmptyId("instanceId", instanceId)}:${requireNonEmptyId("sessionId", sessionId)}:${promptEpoch}`;
}

export function buildRunActivityId(runId: string): string {
  return requireNonEmptyId("runId", runId);
}

export function buildAgentTransitionId(
  instanceId: string,
  sessionId: string,
  promptEpoch: number,
  stateVersion: number,
): string {
  if (!Number.isInteger(stateVersion) || stateVersion < 1) {
    throw new Error("task-observer: stateVersion must be a positive integer");
  }
  return `agent:${requireNonEmptyId("instanceId", instanceId)}:${requireNonEmptyId("sessionId", sessionId)}:${promptEpoch}:${stateVersion}`;
}

export function buildSnflowTransitionId(
  runId: string,
  state: string,
  updatedOrEndedAt: string,
): string {
  return `snflow:${requireNonEmptyId("runId", runId)}:${requireNonEmptyId("state", state)}:${requireNonEmptyId("at", updatedOrEndedAt)}`;
}

export function buildAutomationTransitionId(
  runId: string,
  state: string,
  completedOrUpdatedAt: string,
): string {
  return `automation:${requireNonEmptyId("runId", runId)}:${requireNonEmptyId("state", state)}:${requireNonEmptyId("at", completedOrUpdatedAt)}`;
}

export function buildQuickCommandTransitionId(
  runId: string,
  state: string,
  endedOrUpdatedAt: string,
): string {
  return `quick:${requireNonEmptyId("runId", runId)}:${requireNonEmptyId("state", state)}:${requireNonEmptyId("at", endedOrUpdatedAt)}`;
}

// ---------------------------------------------------------------------------
// String / progress sanitization
// ---------------------------------------------------------------------------

function clampString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

function clampRequiredString(value: unknown, maxChars: number, fallback: string): string {
  return clampString(value, maxChars) ?? fallback.slice(0, maxChars);
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function resolveSafeTitle(
  source: TaskObserverSource,
  explicitTitle: string | null | undefined,
): string {
  const explicit = clampString(explicitTitle, TASK_OBSERVER_BUDGETS.maxTitleChars);
  if (explicit) return explicit;
  return TASK_OBSERVER_GENERIC_TITLES[source];
}

export function normalizeProgress(raw: TaskObserverProgress | null | undefined): TaskObserverProgress {
  if (!raw || typeof raw !== "object") {
    return { kind: "indeterminate" };
  }
  if (raw.kind === "ratio") {
    const current = nonNegativeInt(raw.current);
    const total = nonNegativeInt(raw.total);
    if (current === undefined || total === undefined || total <= 0 || current > total) {
      return { kind: "indeterminate" };
    }
    return { kind: "ratio", current, total };
  }
  if (raw.kind === "counters") {
    const currentToolName = clampString(raw.currentToolName, TASK_OBSERVER_BUDGETS.maxToolNameChars);
    const counters: TaskObserverProgress = { kind: "counters" };
    const toolCount = nonNegativeInt(raw.toolCount);
    const turnCount = nonNegativeInt(raw.turnCount);
    const activeSubagents = nonNegativeInt(raw.activeSubagents);
    const completedSubagents = nonNegativeInt(raw.completedSubagents);
    if (toolCount !== undefined) counters.toolCount = toolCount;
    if (turnCount !== undefined) counters.turnCount = turnCount;
    if (activeSubagents !== undefined) counters.activeSubagents = activeSubagents;
    if (completedSubagents !== undefined) counters.completedSubagents = completedSubagents;
    if (currentToolName) counters.currentToolName = currentToolName;
    return counters;
  }
  return { kind: "indeterminate" };
}

function normalizeActiveModel(
  raw: TaskObserverActiveModel | null | undefined,
): TaskObserverActiveModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const provider = clampString(raw.provider, TASK_OBSERVER_BUDGETS.maxModelProviderChars);
  const modelId = clampString(raw.modelId, TASK_OBSERVER_BUDGETS.maxModelIdChars);
  return provider && modelId ? { provider, modelId } : undefined;
}

function normalizeSessionResources(
  raw: TaskObserverSessionResources | null | undefined,
): TaskObserverSessionResources | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const normalized: TaskObserverSessionResources = {};

  const contextWindow = nonNegativeInt(raw.context?.contextWindow);
  if (contextWindow !== undefined && contextWindow > 0) {
    const rawPercent = raw.context?.percent;
    const percent = typeof rawPercent === "number" && Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : null;
    const usedTokens = raw.context?.usedTokens === null
      ? null
      : nonNegativeInt(raw.context?.usedTokens) ?? null;
    normalized.context = { percent, usedTokens, contextWindow };
  }

  const totalTokens = nonNegativeInt(raw.billing?.totalTokens);
  const costUsd = raw.billing?.costUsd;
  if (
    totalTokens !== undefined
    && typeof costUsd === "number"
    && Number.isFinite(costUsd)
    && costUsd >= 0
  ) {
    normalized.billing = { totalTokens, costUsd };
  }

  const avgTps = raw.performance?.avgTps;
  const sampleCount = nonNegativeInt(raw.performance?.sampleCount);
  if (
    typeof avgTps === "number"
    && Number.isFinite(avgTps)
    && avgTps > 0
    && sampleCount !== undefined
    && sampleCount > 0
  ) {
    normalized.performance = { avgTps, sampleCount };
  }

  return normalized.context || normalized.billing || normalized.performance
    ? normalized
    : undefined;
}

function normalizeOutcome(value: TaskObserverOutcome | undefined): TaskObserverOutcome {
  if (
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted" ||
    value === "ambiguous"
  ) {
    return value;
  }
  return null;
}

function normalizeAttention(value: TaskObserverAttention | undefined): TaskObserverAttention {
  if (value === "needs_input" || value === "review_ready" || value === "blocked") {
    return value;
  }
  return "none";
}

function normalizeExecutionState(value: TaskObserverExecutionState): TaskObserverExecutionState {
  if (value === "queued" || value === "running" || value === "retrying" || value === "settled") {
    return value;
  }
  return "running";
}

function normalizeChild(raw: TaskObserverChildSummaryInput): TaskObserverChildSummary | null {
  const childId = clampString(raw.childId, TASK_OBSERVER_BUDGETS.maxProjectKeyChars);
  if (!childId) return null;
  const explicit = clampString(raw.title, TASK_OBSERVER_BUDGETS.maxTitleChars);
  return {
    childId,
    title: explicit ?? TASK_OBSERVER_GENERIC_TITLES.child,
    executionState: normalizeExecutionState(raw.executionState),
    outcome: normalizeOutcome(raw.outcome),
    attention: normalizeAttention(raw.attention),
    phase: clampString(raw.phase, TASK_OBSERVER_BUDGETS.maxPhaseChars),
    updatedAt: clampString(raw.updatedAt, 40),
  };
}

export type ProjectedActivityResult = {
  activity: TaskObserverActivity;
  childrenOmitted: number;
};

/** Project one adapter activity into the public wire shape (no forbidden keys). */
export function projectActivityDetailed(input: TaskObserverActivityInput): ProjectedActivityResult {
  const source = input.source;
  const childrenIn = Array.isArray(input.children) ? input.children : [];
  const children: TaskObserverChildSummary[] = [];
  let childrenOmitted = 0;
  for (const child of childrenIn) {
    if (children.length >= TASK_OBSERVER_BUDGETS.maxChildrenPerActivity) {
      childrenOmitted += 1;
      continue;
    }
    const normalized = normalizeChild(child);
    if (normalized) children.push(normalized);
    else childrenOmitted += 1;
  }

  const executionState = normalizeExecutionState(input.executionState);
  // Non-terminal activities never carry a terminal outcome on the wire.
  const outcome = executionState === "settled" ? normalizeOutcome(input.outcome) : null;
  // Attention may remain while running (e.g. needs_input) or after settlement.
  const attention = normalizeAttention(input.attention);

  return {
    activity: {
      taskKey: clampRequiredString(input.taskKey, TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 2, "unknown"),
      activityId: clampRequiredString(input.activityId, TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 2, "unknown"),
      source,
      projectKey: clampRequiredString(input.projectKey, TASK_OBSERVER_BUDGETS.maxProjectKeyChars, "project"),
      projectName: clampRequiredString(
        input.projectName,
        TASK_OBSERVER_BUDGETS.maxProjectNameChars,
        "Project",
      ),
      title: resolveSafeTitle(source, input.title),
      executionState,
      outcome,
      attention,
      phase: clampString(input.phase, TASK_OBSERVER_BUDGETS.maxPhaseChars),
      reasonCode: clampString(input.reasonCode, TASK_OBSERVER_BUDGETS.maxReasonCodeChars),
      progress: normalizeProgress(input.progress),
      activeModel: source === "agent" ? normalizeActiveModel(input.activeModel) : undefined,
      sessionResources: source === "agent"
        ? normalizeSessionResources(input.sessionResources)
        : undefined,
      startedAt: clampString(input.startedAt, 40),
      updatedAt: clampString(input.updatedAt, 40),
      endedAt: clampString(input.endedAt, 40),
      children,
      deepLink: clampRequiredString(input.deepLink, TASK_OBSERVER_BUDGETS.maxDeepLinkChars, "/"),
      lastTransitionId: clampRequiredString(
        input.lastTransitionId,
        TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 3,
        "transition:unknown",
      ),
      stateVersion:
        Number.isInteger(input.stateVersion) && input.stateVersion >= 1 ? input.stateVersion : 1,
    },
    childrenOmitted,
  };
}

export function projectActivity(input: TaskObserverActivityInput): TaskObserverActivity {
  return projectActivityDetailed(input).activity;
}

// ---------------------------------------------------------------------------
// Presentation derivation + local acknowledgement
// ---------------------------------------------------------------------------

export type LocalAckState = {
  /** Oldest → newest transition ids acknowledged on this desktop install. */
  acknowledgedTransitionIds: string[];
};

export function createEmptyLocalAckState(): LocalAckState {
  return { acknowledgedTransitionIds: [] };
}

export function isTransitionAcknowledged(state: LocalAckState, transitionId: string): boolean {
  if (!transitionId) return false;
  return state.acknowledgedTransitionIds.includes(transitionId);
}

/**
 * Mark a transition read locally. Does not mutate server task state (R6 / R27).
 * Bounded LRU: newer acks push out the oldest when over capacity.
 */
export function acknowledgeTransition(state: LocalAckState, transitionId: string): LocalAckState {
  const id = transitionId.trim();
  if (!id) return state;
  const next = state.acknowledgedTransitionIds.filter((existing) => existing !== id);
  next.push(id);
  const max = TASK_OBSERVER_BUDGETS.maxLocalAckTransitions;
  return {
    acknowledgedTransitionIds:
      next.length <= max ? next : next.slice(next.length - max),
  };
}

export function acknowledgeTransitions(state: LocalAckState, transitionIds: string[]): LocalAckState {
  let current = state;
  for (const id of transitionIds) {
    current = acknowledgeTransition(current, id);
  }
  return current;
}

function isFailureOutcome(outcome: TaskObserverOutcome): boolean {
  return outcome === "failed" || outcome === "interrupted" || outcome === "ambiguous";
}

function isReadyOutcome(outcome: TaskObserverOutcome): boolean {
  return outcome === "succeeded" || outcome === "cancelled";
}

/**
 * Per-activity desktop presentation, applying local unread semantics.
 * Connection overlays are applied separately at the aggregate level.
 */
export function deriveActivityPresentation(
  activity: TaskObserverActivity,
  ack: LocalAckState,
): TaskObserverPresentationState {
  if (activity.attention === "needs_input") {
    return "needs_input";
  }
  if (activity.attention === "blocked") {
    return "blocked";
  }

  const unread = !isTransitionAcknowledged(ack, activity.lastTransitionId);

  if (activity.executionState === "settled") {
    if (isFailureOutcome(activity.outcome)) {
      return unread ? "blocked" : "idle";
    }
    if (isReadyOutcome(activity.outcome) || activity.attention === "review_ready") {
      return unread ? "ready" : "idle";
    }
    return "idle";
  }

  if (activity.executionState === "retrying") {
    return "retrying";
  }
  if (activity.executionState === "queued" || activity.executionState === "running") {
    return "running";
  }
  return "idle";
}

function presentationRank(state: TaskObserverPresentationState): number {
  const idx = TASK_OBSERVER_PRESENTATION_PRIORITY.indexOf(state);
  return idx === -1 ? TASK_OBSERVER_PRESENTATION_PRIORITY.length : idx;
}

export function maxPresentation(
  states: readonly TaskObserverPresentationState[],
): TaskObserverPresentationState {
  let best: TaskObserverPresentationState = "idle";
  for (const state of states) {
    if (presentationRank(state) < presentationRank(best)) {
      best = state;
    }
  }
  return best;
}

/**
 * Desktop-level presentation including connection overlay (R3 / R16 / R23).
 * Stale/disconnected overlays never mutate underlying task records.
 */
export function deriveDesktopPresentation(input: {
  connection: TaskObserverConnectionState;
  activities: readonly TaskObserverActivity[];
  ack: LocalAckState;
}): TaskObserverPresentationState {
  if (input.connection === "service_not_running") {
    return "service_not_running";
  }
  if (
    input.connection === "reconnecting" ||
    input.connection === "probing" ||
    input.connection === "incompatible"
  ) {
    // Connection-loss overlays outrank tasks; incompatible is still a connection failure.
    return "disconnected";
  }

  const activityStates = input.activities.map((activity) =>
    deriveActivityPresentation(activity, input.ack),
  );
  return maxPresentation(activityStates);
}

// ---------------------------------------------------------------------------
// Snapshot build, budgets, serialization, revision
// ---------------------------------------------------------------------------

export type BuildSnapshotInput = {
  instanceId: string;
  revision: number;
  generatedAt?: string;
  reset?: boolean;
  activities: readonly TaskObserverActivityInput[];
  recentTransitions?: readonly TaskObserverTransitionInput[];
  diagnostics?: readonly TaskObserverDiagnosticInput[];
};

function emptyTruncation(): TaskObserverTruncation {
  return {
    projectsOmitted: 0,
    activitiesOmitted: 0,
    transitionsOmitted: 0,
    childrenOmitted: 0,
    encodedBytesLimited: false,
  };
}

function emptyAggregate(): TaskObserverAggregate {
  return {
    activeProjects: 0,
    activeActivities: 0,
    needsInput: 0,
    blocked: 0,
    ready: 0,
    running: 0,
  };
}

function projectTransition(input: TaskObserverTransitionInput): TaskObserverTransition {
  return {
    transitionId: clampRequiredString(
      input.transitionId,
      TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 3,
      "transition:unknown",
    ),
    taskKey: clampRequiredString(input.taskKey, TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 2, "unknown"),
    activityId: clampRequiredString(
      input.activityId,
      TASK_OBSERVER_BUDGETS.maxProjectKeyChars * 2,
      "unknown",
    ),
    source: input.source,
    projectKey: clampRequiredString(input.projectKey, TASK_OBSERVER_BUDGETS.maxProjectKeyChars, "project"),
    presentation: input.presentation,
    executionState: normalizeExecutionState(input.executionState),
    outcome: normalizeOutcome(input.outcome),
    attention: normalizeAttention(input.attention),
    at: clampRequiredString(input.at, 40, new Date(0).toISOString()),
  };
}

function projectDiagnostic(input: TaskObserverDiagnosticInput): TaskObserverDiagnostic | null {
  const code = clampString(input.code, TASK_OBSERVER_BUDGETS.maxDiagnosticCodeChars);
  const message = clampString(input.message, TASK_OBSERVER_BUDGETS.maxDiagnosticMessageChars);
  if (!code || !message) return null;
  return {
    code,
    message,
    at: clampString(input.at, 40),
  };
}

function countPresentation(
  activity: TaskObserverActivity,
  ack: LocalAckState,
  aggregate: TaskObserverAggregate,
  projectCounts: TaskObserverProject["counts"],
): void {
  const presentation = deriveActivityPresentation(activity, ack);
  const isActive =
    presentation === "needs_input" ||
    presentation === "blocked" ||
    presentation === "ready" ||
    presentation === "retrying" ||
    presentation === "running";

  if (isActive) {
    aggregate.activeActivities += 1;
    projectCounts.active += 1;
  }
  if (presentation === "needs_input") {
    aggregate.needsInput += 1;
    projectCounts.needsInput += 1;
  } else if (presentation === "blocked") {
    aggregate.blocked += 1;
    projectCounts.blocked += 1;
  } else if (presentation === "ready") {
    aggregate.ready += 1;
    projectCounts.ready += 1;
  } else if (presentation === "running" || presentation === "retrying") {
    aggregate.running += 1;
  }
}

/**
 * Build a bounded public snapshot from adapter inputs.
 * Uses an empty ack set for server-side aggregates (unread is desktop-local).
 * Server counts treat terminal failure/success as active until the desktop acks —
 * aggregate fields therefore represent attention-worthy terminal + live work
 * under a neutral (all-unread) ack baseline so the desktop can re-derive locally.
 */
export function buildTaskObserverSnapshot(input: BuildSnapshotInput): TaskObserverSnapshot {
  const ack = createEmptyLocalAckState();
  const truncation = emptyTruncation();
  const aggregate = emptyAggregate();

  // Deterministic project order: first-seen projectKey order, activities keep input order within project.
  const projectOrder: string[] = [];
  const projectMap = new Map<
    string,
    { displayName: string; activities: TaskObserverActivity[] }
  >();

  for (const raw of input.activities) {
    const { activity, childrenOmitted } = projectActivityDetailed(raw);
    truncation.childrenOmitted += childrenOmitted;

    let bucket = projectMap.get(activity.projectKey);
    if (!bucket) {
      projectOrder.push(activity.projectKey);
      bucket = { displayName: activity.projectName, activities: [] };
      projectMap.set(activity.projectKey, bucket);
    }
    if (activity.projectName) bucket.displayName = activity.projectName;
    bucket.activities.push(activity);
  }

  const projects: TaskObserverProject[] = [];
  let activitiesAccepted = 0;

  for (const projectKey of projectOrder) {
    if (projects.length >= TASK_OBSERVER_BUDGETS.maxProjects) {
      const omittedBucket = projectMap.get(projectKey);
      if (omittedBucket) {
        truncation.projectsOmitted += 1;
        truncation.activitiesOmitted += omittedBucket.activities.length;
      }
      continue;
    }

    const bucket = projectMap.get(projectKey);
    if (!bucket) continue;

    const counts: TaskObserverProject["counts"] = {
      active: 0,
      needsInput: 0,
      blocked: 0,
      ready: 0,
    };
    const keptActivities: TaskObserverActivity[] = [];

    for (const activity of bucket.activities) {
      if (activitiesAccepted >= TASK_OBSERVER_BUDGETS.maxActivities) {
        truncation.activitiesOmitted += 1;
        continue;
      }
      keptActivities.push(activity);
      activitiesAccepted += 1;
      countPresentation(activity, ack, aggregate, counts);
    }

    if (keptActivities.length === 0 && bucket.activities.length > 0) {
      // Project had only overflow activities — still count as omitted project if empty.
      truncation.projectsOmitted += 1;
      continue;
    }

    projects.push({
      projectKey,
      displayName: bucket.displayName,
      counts,
      activities: keptActivities,
    });
  }

  aggregate.activeProjects = projects.filter((project) => project.counts.active > 0).length;

  const transitionInputs = Array.isArray(input.recentTransitions) ? input.recentTransitions : [];
  const recentTransitions: TaskObserverTransition[] = [];
  for (const transition of transitionInputs) {
    if (recentTransitions.length >= TASK_OBSERVER_BUDGETS.maxRecentTransitions) {
      truncation.transitionsOmitted += 1;
      continue;
    }
    recentTransitions.push(projectTransition(transition));
  }
  // Keep overflow accounting accurate when input already exceeds the cap mid-loop.
  if (transitionInputs.length > TASK_OBSERVER_BUDGETS.maxRecentTransitions) {
    truncation.transitionsOmitted = transitionInputs.length - TASK_OBSERVER_BUDGETS.maxRecentTransitions;
  }

  const diagnosticInputs = Array.isArray(input.diagnostics) ? input.diagnostics : [];
  const diagnostics: TaskObserverDiagnostic[] = [];
  for (const diagnostic of diagnosticInputs) {
    if (diagnostics.length >= TASK_OBSERVER_BUDGETS.maxDiagnostics) break;
    const projected = projectDiagnostic(diagnostic);
    if (projected) diagnostics.push(projected);
  }

  return {
    protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
    instanceId: clampRequiredString(input.instanceId, TASK_OBSERVER_BUDGETS.maxProjectKeyChars, "instance"),
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    generatedAt: clampRequiredString(
      input.generatedAt ?? new Date().toISOString(),
      40,
      new Date(0).toISOString(),
    ),
    reset: Boolean(input.reset),
    truncation,
    aggregate,
    projects,
    recentTransitions,
    diagnostics,
  };
}

/**
 * Content fingerprint fields that participate in revision identity.
 * Excludes generatedAt so wall-clock / elapsed-only refresh does not bump revision.
 */
export function snapshotContentFingerprint(snapshot: TaskObserverSnapshot): string {
  // Exclude delivery/meta fields: generatedAt, revision, and reset flags must not
  // drive content identity (R28 / reconnect baseline).
  const payload = {
    protocolVersion: snapshot.protocolVersion,
    instanceId: snapshot.instanceId,
    truncation: snapshot.truncation,
    aggregate: snapshot.aggregate,
    projects: snapshot.projects,
    recentTransitions: snapshot.recentTransitions,
    diagnostics: snapshot.diagnostics.map(({ code, message }) => ({ code, message })),
  };
  return JSON.stringify(payload);
}

/**
 * Whether two snapshots represent the same observable content for revision purposes.
 * generatedAt differences alone must return true (same content).
 */
export function snapshotsShareContentRevision(
  a: TaskObserverSnapshot,
  b: TaskObserverSnapshot,
): boolean {
  return snapshotContentFingerprint(a) === snapshotContentFingerprint(b);
}

/** Public JSON object keys allowed on a serialized snapshot root and nested records. */
const SNAPSHOT_ROOT_KEYS = new Set([
  "protocolVersion",
  "instanceId",
  "revision",
  "generatedAt",
  "reset",
  "truncation",
  "aggregate",
  "projects",
  "recentTransitions",
  "diagnostics",
]);

const ACTIVITY_KEYS = new Set([
  "taskKey",
  "activityId",
  "source",
  "projectKey",
  "projectName",
  "title",
  "executionState",
  "outcome",
  "attention",
  "phase",
  "reasonCode",
  "progress",
  "activeModel",
  "sessionResources",
  "startedAt",
  "updatedAt",
  "endedAt",
  "children",
  "deepLink",
  "lastTransitionId",
  "stateVersion",
]);

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) continue;
      out[key] = stripUndefinedDeep(nested);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a snapshot to JSON text, enforcing the encoded-byte budget by
 * deterministically dropping lowest-priority trailing projects/activities first.
 */
export function serializeTaskObserverSnapshot(snapshot: TaskObserverSnapshot): {
  json: string;
  snapshot: TaskObserverSnapshot;
  bytes: number;
} {
  const current: TaskObserverSnapshot = {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      activities: project.activities.map((activity) => ({
        ...activity,
        children: [...activity.children],
      })),
      counts: { ...project.counts },
    })),
    recentTransitions: [...snapshot.recentTransitions],
    diagnostics: [...snapshot.diagnostics],
    truncation: { ...snapshot.truncation },
    aggregate: { ...snapshot.aggregate },
  };

  const encode = (value: TaskObserverSnapshot): string =>
    JSON.stringify(stripUndefinedDeep(value));

  let json = encode(current);
  let bytes = Buffer.byteLength(json, "utf8");

  const dropOneActivity = (): boolean => {
    for (let projectIndex = current.projects.length - 1; projectIndex >= 0; projectIndex -= 1) {
      const project = current.projects[projectIndex];
      if (project.activities.length > 0) {
        project.activities.pop();
        current.truncation.activitiesOmitted += 1;
        current.truncation.encodedBytesLimited = true;
        if (project.activities.length === 0) {
          current.projects.splice(projectIndex, 1);
          current.truncation.projectsOmitted += 1;
        }
        return true;
      }
    }
    return false;
  };

  while (bytes > TASK_OBSERVER_BUDGETS.maxEncodedBytes) {
    if (current.recentTransitions.length > 0) {
      current.recentTransitions.pop();
      current.truncation.transitionsOmitted += 1;
      current.truncation.encodedBytesLimited = true;
    } else if (current.diagnostics.length > 0) {
      current.diagnostics.pop();
      current.truncation.encodedBytesLimited = true;
    } else if (!dropOneActivity()) {
      // Nothing left to drop; break to avoid infinite loop on pathological headers.
      break;
    }
    json = encode(current);
    bytes = Buffer.byteLength(json, "utf8");
  }

  // Recompute aggregate after possible drops so wire payload stays self-consistent.
  if (current.truncation.encodedBytesLimited) {
    const ack = createEmptyLocalAckState();
    const aggregate = emptyAggregate();
    for (const project of current.projects) {
      const counts = { active: 0, needsInput: 0, blocked: 0, ready: 0 };
      for (const activity of project.activities) {
        countPresentation(activity, ack, aggregate, counts);
      }
      project.counts = counts;
    }
    aggregate.activeProjects = current.projects.filter((project) => project.counts.active > 0).length;
    current.aggregate = aggregate;
    json = encode(current);
    bytes = Buffer.byteLength(json, "utf8");
  }

  return { json, snapshot: current, bytes };
}

/**
 * Parse serialized JSON and assert the public surface has no forbidden keys.
 * Returns the parsed value for further assertions in smokes.
 */
export function parseAndAssertPublicSnapshot(json: string): TaskObserverSnapshot {
  const parsed = JSON.parse(json) as unknown;
  assertNoForbiddenFields(parsed, "$");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("task-observer: snapshot root must be an object");
  }
  for (const key of Object.keys(parsed as object)) {
    if (!SNAPSHOT_ROOT_KEYS.has(key)) {
      throw new Error(`task-observer: unexpected snapshot root key ${key}`);
    }
  }
  return parsed as TaskObserverSnapshot;
}

export function assertNoForbiddenFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    for (const forbidden of TASK_OBSERVER_FORBIDDEN_FIELDS) {
      if (lower === forbidden.toLowerCase()) {
        throw new Error(`task-observer: forbidden field ${key} at ${path}`);
      }
    }
    // Nested objects under known containers are still scanned.
    assertNoForbiddenFields(nested, `${path}.${key}`);
  }
}

/** Guard used by adapters: ensure a projected activity only exposes public keys. */
export function assertPublicActivityShape(activity: TaskObserverActivity): void {
  for (const key of Object.keys(activity)) {
    if (!ACTIVITY_KEYS.has(key)) {
      throw new Error(`task-observer: unexpected activity key ${key}`);
    }
  }
  assertNoForbiddenFields(activity, "activity");
}

/**
 * Stale connection overlay helper: presentation becomes disconnected while the
 * last snapshot body is retained unchanged (R23).
 */
export function applyStaleConnectionOverlay(input: {
  snapshot: TaskObserverSnapshot;
  connection: TaskObserverConnectionState;
  ack: LocalAckState;
}): {
  presentation: TaskObserverPresentationState;
  snapshot: TaskObserverSnapshot;
} {
  const activities = input.snapshot.projects.flatMap((project) => project.activities);
  return {
    presentation: deriveDesktopPresentation({
      connection: input.connection,
      activities,
      ack: input.ack,
    }),
    snapshot: input.snapshot,
  };
}
