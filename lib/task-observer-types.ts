/**
 * Desktop pet task-observer public domain contract.
 *
 * Privacy boundary: public types intentionally omit cwd, Prompt/firstMessage,
 * model/tool output, tool args, file paths/content, Quick Command command/env,
 * session paths, secrets, and raw provider errors. Adapters must project into
 * these shapes rather than spreading source records.
 */

/** Wire protocol version for /api/desktop-observer compatibility. */
export const TASK_OBSERVER_PROTOCOL_VERSION = 1 as const;

/** Hard size budgets for one service-level observer snapshot (R28 / ADR). */
export const TASK_OBSERVER_BUDGETS = {
  maxProjects: 50,
  maxActivities: 200,
  maxRecentTransitions: 20,
  maxChildrenPerActivity: 8,
  maxEncodedBytes: 256 * 1024,
  maxTitleChars: 120,
  maxProjectNameChars: 80,
  maxProjectKeyChars: 128,
  maxPhaseChars: 64,
  maxReasonCodeChars: 64,
  maxDeepLinkChars: 256,
  maxToolNameChars: 64,
  maxDiagnostics: 20,
  maxDiagnosticCodeChars: 64,
  maxDiagnosticMessageChars: 160,
  /** Desktop-local acknowledged/notified transition LRU capacity (presentation only). */
  maxLocalAckTransitions: 500,
} as const;

/** Fields that must never appear on the public observer wire payload. */
export const TASK_OBSERVER_FORBIDDEN_FIELDS = [
  "cwd",
  "prompt",
  "firstMessage",
  "messages",
  "output",
  "command",
  "env",
  "path",
  "filePath",
  "sessionPath",
  "sessionFile",
  "toolArgs",
  "arguments",
  "args",
  "rawError",
  "errorText",
  "stack",
  "apiKey",
  "token",
  "secret",
  "password",
] as const;

export type TaskObserverForbiddenField = (typeof TASK_OBSERVER_FORBIDDEN_FIELDS)[number];

export type TaskObserverSource = "agent" | "snflow" | "automation" | "quick_command";

/** Authoritative execution axis (R4). */
export type TaskObserverExecutionState = "queued" | "running" | "retrying" | "settled";

/** Authoritative terminal outcome; null while execution is non-terminal. */
export type TaskObserverOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "ambiguous"
  | null;

/** Authoritative attention axis; may change without ending execution. */
export type TaskObserverAttention = "none" | "needs_input" | "review_ready" | "blocked";

/**
 * Desktop presentation states (R3 / R11).
 * Connection overlays outrank task presentation.
 */
export type TaskObserverPresentationState =
  | "service_not_running"
  | "disconnected"
  | "needs_input"
  | "blocked"
  | "ready"
  | "retrying"
  | "running"
  | "idle";

/** Connection lifecycle overlay owned by the desktop client (never written into task state). */
export type TaskObserverConnectionState =
  | "probing"
  | "connected"
  | "reconnecting"
  | "service_not_running"
  | "incompatible";

export type TaskObserverProgressKind = "indeterminate" | "ratio" | "counters";

/**
 * Verifiable progress only (R8). Percentage is allowed only when current/total
 * are real server counters — never model-estimated.
 */
export type TaskObserverProgress =
  | { kind: "indeterminate" }
  | { kind: "ratio"; current: number; total: number }
  | {
      kind: "counters";
      toolCount?: number;
      turnCount?: number;
      activeSubagents?: number;
      completedSubagents?: number;
      currentToolName?: string;
    };

/** Nested Subagent summary — never a separate top-level activity (R2). */
export type TaskObserverChildSummary = {
  childId: string;
  title: string;
  executionState: TaskObserverExecutionState;
  outcome: TaskObserverOutcome;
  attention: TaskObserverAttention;
  phase?: string;
  updatedAt?: string;
};

export type TaskObserverActivity = {
  taskKey: string;
  activityId: string;
  source: TaskObserverSource;
  projectKey: string;
  projectName: string;
  /** Explicit user/task/command name or generic fallback — never firstMessage (R21). */
  title: string;
  executionState: TaskObserverExecutionState;
  outcome: TaskObserverOutcome;
  attention: TaskObserverAttention;
  /** Bounded safe phase code, not free-form model text. */
  phase?: string;
  /** Bounded stable reason code for failures/attention. */
  reasonCode?: string;
  progress: TaskObserverProgress;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  children: TaskObserverChildSummary[];
  /** Relative allowlisted WebUI path (validated again in Electron main). */
  deepLink: string;
  lastTransitionId: string;
  /** Monotonic per-activity state version used to rebuild stable transition ids. */
  stateVersion: number;
};

export type TaskObserverProjectCounts = {
  active: number;
  needsInput: number;
  blocked: number;
  ready: number;
};

export type TaskObserverProject = {
  projectKey: string;
  displayName: string;
  counts: TaskObserverProjectCounts;
  activities: TaskObserverActivity[];
};

export type TaskObserverTransition = {
  transitionId: string;
  taskKey: string;
  activityId: string;
  source: TaskObserverSource;
  projectKey: string;
  /** Presentation-relevant state after this transition. */
  presentation: Exclude<
    TaskObserverPresentationState,
    "service_not_running" | "disconnected" | "idle"
  >;
  executionState: TaskObserverExecutionState;
  outcome: TaskObserverOutcome;
  attention: TaskObserverAttention;
  at: string;
};

export type TaskObserverAggregate = {
  activeProjects: number;
  activeActivities: number;
  needsInput: number;
  blocked: number;
  ready: number;
  running: number;
};

export type TaskObserverTruncation = {
  projectsOmitted: number;
  activitiesOmitted: number;
  transitionsOmitted: number;
  childrenOmitted: number;
  encodedBytesLimited: boolean;
};

export type TaskObserverDiagnostic = {
  code: string;
  message: string;
  at?: string;
};

export type TaskObserverSnapshot = {
  protocolVersion: typeof TASK_OBSERVER_PROTOCOL_VERSION;
  instanceId: string;
  /** Content revision; must not change for wall-clock/elapsed-only updates (R28). */
  revision: number;
  generatedAt: string;
  reset: boolean;
  truncation: TaskObserverTruncation;
  aggregate: TaskObserverAggregate;
  projects: TaskObserverProject[];
  recentTransitions: TaskObserverTransition[];
  diagnostics: TaskObserverDiagnostic[];
};

/** Input used by adapters before public sanitization/budgets. */
export type TaskObserverActivityInput = {
  taskKey: string;
  activityId: string;
  source: TaskObserverSource;
  projectKey: string;
  projectName: string;
  /** Prefer explicit user naming; null/empty → generic fallback. */
  title: string | null | undefined;
  executionState: TaskObserverExecutionState;
  outcome?: TaskObserverOutcome;
  attention?: TaskObserverAttention;
  phase?: string | null;
  reasonCode?: string | null;
  progress?: TaskObserverProgress | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  endedAt?: string | null;
  children?: TaskObserverChildSummaryInput[] | null;
  deepLink: string;
  lastTransitionId: string;
  stateVersion: number;
};

export type TaskObserverChildSummaryInput = {
  childId: string;
  title?: string | null;
  executionState: TaskObserverExecutionState;
  outcome?: TaskObserverOutcome;
  attention?: TaskObserverAttention;
  phase?: string | null;
  updatedAt?: string | null;
};

export type TaskObserverTransitionInput = {
  transitionId: string;
  taskKey: string;
  activityId: string;
  source: TaskObserverSource;
  projectKey: string;
  presentation: TaskObserverTransition["presentation"];
  executionState: TaskObserverExecutionState;
  outcome?: TaskObserverOutcome;
  attention?: TaskObserverAttention;
  at: string;
};

export type TaskObserverDiagnosticInput = {
  code: string;
  message: string;
  at?: string | null;
};

/** Generic localized-safe title tokens used when no explicit name exists (R21). */
export const TASK_OBSERVER_GENERIC_TITLES = {
  agent: "Agent session",
  snflow: "SnFlow task",
  automation: "Automation run",
  quick_command: "Quick command",
  child: "Subagent",
} as const;

export const TASK_OBSERVER_PRESENTATION_PRIORITY: readonly TaskObserverPresentationState[] = [
  "service_not_running",
  "disconnected",
  "needs_input",
  "blocked",
  "ready",
  "retrying",
  "running",
  "idle",
] as const;
