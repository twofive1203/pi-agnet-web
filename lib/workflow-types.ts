/**
 * WebUI-owned development workflow types.
 * Task files live under <cwd>/.pi/snflows/tasks/ and never share storage with legacy .trellis/.
 */

export const WORKFLOW_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_TASK_STATUSES = [
  "planning",
  "ready",
  "implementing",
  "review_ready",
  "checking",
  "changes_requested",
  "ready_to_commit",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number];

export const WORKFLOW_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type WorkflowPriority = (typeof WORKFLOW_PRIORITIES)[number];

export const WORKFLOW_RUN_PHASES = ["implement", "check"] as const;
export type WorkflowRunPhase = (typeof WORKFLOW_RUN_PHASES)[number];

export const WORKFLOW_RUN_STATES = [
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

export const WORKFLOW_CHECK_VERDICTS = ["pass", "changes_requested"] as const;
export type WorkflowCheckVerdict = (typeof WORKFLOW_CHECK_VERDICTS)[number];

export const WORKFLOW_DOC_NAMES = ["requirements.md", "design.md", "plan.md"] as const;
export type WorkflowDocName = (typeof WORKFLOW_DOC_NAMES)[number];

/** Stable task id: lowercase slug, 1-80 chars, no path separators. */
export const WORKFLOW_TASK_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export const WORKFLOW_RUN_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

export interface WorkflowTaskCommitMeta {
  hash: string;
  recordedAt: string;
  note?: string;
}

export interface WorkflowTaskRecord {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  revision: string;
  activeRunId: string | null;
  latestImplementRunId: string | null;
  latestCheckRunId: string | null;
  commit: WorkflowTaskCommitMeta | null;
  archived: boolean;
  /** Optional immutable parent task reference; storage remains flat. */
  parentTaskId?: string;
}

export interface WorkflowDocuments {
  requirements: string;
  design: string;
  plan: string;
}

export interface WorkflowValidationResult {
  command?: string;
  ok: boolean;
  summary: string;
}

export interface WorkflowImplementResult {
  summary: string;
  changedFiles: string[];
  validation: WorkflowValidationResult[];
  residualRisks: string[];
}

export interface WorkflowCheckFinding {
  severity: "info" | "warning" | "error";
  summary: string;
  path?: string;
}

export interface WorkflowCheckResult {
  verdict: WorkflowCheckVerdict;
  summary: string;
  findings: WorkflowCheckFinding[];
  validation: WorkflowValidationResult[];
}

export interface WorkflowRunError {
  code: string;
  message: string;
}

export interface WorkflowRunRecord {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  taskId: string;
  phase: WorkflowRunPhase;
  agentName: string;
  state: WorkflowRunState;
  requestedCwd: string;
  effectiveCwd: string;
  hostSessionId: string;
  taskRevision: string;
  /** Parent chat correlation for direct foreground native subagent dispatch. */
  parentSessionId?: string;
  parentToolCallId?: string;
  nativeRunId: string | null;
  asyncDir: string | null;
  sessionFile: string | null;
  outputFile: string | null;
  model: string | null;
  thinking: string | null;
  summary: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastReconciledAt: string | null;
  error: WorkflowRunError | null;
  implementResult: WorkflowImplementResult | null;
  checkResult: WorkflowCheckResult | null;
  tokenUsage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  toolCount?: number;
  turnCount?: number;
}

export interface WorkflowTaskSummary {
  id: string;
  title: string;
  description: string;
  status: WorkflowTaskStatus;
  priority: WorkflowPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  revision: string;
  activeRunId: string | null;
  latestImplementRunId: string | null;
  latestCheckRunId: string | null;
  commit: WorkflowTaskCommitMeta | null;
  archived: boolean;
  parentTaskId?: string;
  childCount: number;
  completedChildCount: number;
  childTaskIds: string[];
  pathLabel: string;
  hasDocuments: {
    requirements: boolean;
    design: boolean;
    plan: boolean;
  };
  readError?: string;
}

export interface WorkflowTaskDetail extends WorkflowTaskSummary {
  documents: WorkflowDocuments;
  runs: WorkflowRunRecord[];
  parentTask?: WorkflowTaskSummary | null;
  children: WorkflowTaskSummary[];
  allowedActions: WorkflowAllowedActions;
}

export interface WorkflowAllowedActions {
  save: boolean;
  markReady: boolean;
  runImplement: boolean;
  runCheck: boolean;
  cancelRun: boolean;
  recordCommit: boolean;
  complete: boolean;
  archive: boolean;
  reasons: Partial<Record<keyof Omit<WorkflowAllowedActions, "reasons">, string>>;
}

export interface WorkflowTasksListResponse {
  cwd: string;
  exists: boolean;
  pathLabel: string;
  tasks: WorkflowTaskSummary[];
  statusCounts: Record<string, number>;
  archivedCount: number;
  activeCwdRunId: string | null;
  /** Per-cwd current SnFlow task pointer. */
  currentTaskId: string | null;
  errors: Array<{ id?: string; pathLabel?: string; message: string }>;
}

export interface WorkflowCreateTaskInput {
  title: string;
  description?: string;
  priority?: WorkflowPriority;
  id?: string;
  requirements?: string;
  design?: string;
  plan?: string;
  /** When true, leave status planning but mark ready immediately after create. */
  markReady?: boolean;
  /** Optional chat session id that seeded this task. */
  sessionId?: string;
  /** Optional parent task id. Parentage is immutable after creation. */
  parentTaskId?: string;
  /** Optional freeform user goal used only for seeding docs before create. */
  seedText?: string;
}

export interface WorkflowUpdateTaskInput {
  expectedRevision: string;
  title?: string;
  description?: string;
  priority?: WorkflowPriority;
  status?: WorkflowTaskStatus;
  requirements?: string;
  design?: string;
  plan?: string;
}

export interface WorkflowStartRunInput {
  phase: WorkflowRunPhase;
  expectedRevision: string;
}

export interface WorkflowCompleteTaskInput {
  expectedRevision: string;
  commitHash?: string;
  note?: string;
}

export interface WorkflowArchiveTaskInput {
  expectedRevision: string;
}

/** Statuses that mean a run is still in flight for lock purposes. */
export const WORKFLOW_ACTIVE_RUN_STATES: ReadonlySet<WorkflowRunState> = new Set([
  "starting",
  "running",
]);

/** Terminal run states. */
export const WORKFLOW_TERMINAL_RUN_STATES: ReadonlySet<WorkflowRunState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

export function isWorkflowTaskStatus(value: unknown): value is WorkflowTaskStatus {
  return typeof value === "string" && (WORKFLOW_TASK_STATUSES as readonly string[]).includes(value);
}

export function isWorkflowRunPhase(value: unknown): value is WorkflowRunPhase {
  return typeof value === "string" && (WORKFLOW_RUN_PHASES as readonly string[]).includes(value);
}

export function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  return typeof value === "string" && (WORKFLOW_RUN_STATES as readonly string[]).includes(value);
}

export function isWorkflowPriority(value: unknown): value is WorkflowPriority {
  return typeof value === "string" && (WORKFLOW_PRIORITIES as readonly string[]).includes(value);
}

export function isValidWorkflowTaskId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_TASK_ID_RE.test(value);
}

export function isValidWorkflowRunId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_RUN_ID_RE.test(value);
}

/** Manual authoring transitions (not run-manager projections). */
export const WORKFLOW_MANUAL_TRANSITIONS: Record<WorkflowTaskStatus, readonly WorkflowTaskStatus[]> = {
  planning: ["ready", "cancelled"],
  ready: ["planning", "cancelled"],
  implementing: ["cancelled"],
  review_ready: ["cancelled"],
  checking: ["cancelled"],
  changes_requested: ["cancelled"],
  ready_to_commit: ["completed", "cancelled"],
  completed: [],
  failed: ["ready", "planning", "cancelled"],
  cancelled: [],
};

export function canManuallyTransition(from: WorkflowTaskStatus, to: WorkflowTaskStatus): boolean {
  return WORKFLOW_MANUAL_TRANSITIONS[from].includes(to);
}

export function canStartImplement(status: WorkflowTaskStatus): boolean {
  return status === "ready" || status === "changes_requested" || status === "review_ready" || status === "failed";
}

export function canStartCheck(status: WorkflowTaskStatus): boolean {
  return status === "review_ready";
}

export function canMarkReady(status: WorkflowTaskStatus): boolean {
  return status === "planning" || status === "failed";
}

export function canRecordCommit(status: WorkflowTaskStatus): boolean {
  return status === "ready_to_commit";
}

export function canComplete(status: WorkflowTaskStatus): boolean {
  return status === "ready_to_commit";
}

export function canArchive(status: WorkflowTaskStatus, archived: boolean): boolean {
  if (archived) return false;
  return status === "completed" || status === "cancelled";
}

export function projectStatusAfterRun(
  phase: WorkflowRunPhase,
  runState: WorkflowRunState,
  checkVerdict?: WorkflowCheckVerdict | null,
): WorkflowTaskStatus | null {
  if (runState === "starting" || runState === "running") {
    return phase === "implement" ? "implementing" : "checking";
  }
  if (runState === "cancelled") return "cancelled";
  if (runState === "failed" || runState === "stale") return "failed";
  if (runState === "completed") {
    if (phase === "implement") return "review_ready";
    if (checkVerdict === "pass") return "ready_to_commit";
    if (checkVerdict === "changes_requested") return "changes_requested";
    return "failed";
  }
  return null;
}
