/**
 * Automation domain contracts (independent of SnFlow).
 * Schema versions are fixed for first-release identity; do not reinterpret
 * existing tasks when defaults change — bump policy versions instead.
 */

export const AUTOMATION_SCHEMA_VERSION = 1 as const;
export const AUTOMATION_SCHEDULE_POLICY_VERSION = 1 as const;
export const AUTOMATION_AUTHORITY_POLICY_VERSION = 1 as const;

export const AUTOMATION_MIN_CRON_INTERVAL_MS = 5 * 60 * 1000;
export const AUTOMATION_MISFIRE_WINDOW_MS = 5 * 60 * 1000;
export const AUTOMATION_DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;
export const AUTOMATION_MIN_MAX_RUNTIME_MS = 1 * 60 * 1000;
export const AUTOMATION_MAX_MAX_RUNTIME_MS = 120 * 60 * 1000;
export const AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY = 1;
export const AUTOMATION_DEFAULT_APPROVAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const AUTOMATION_APPROVAL_REMIND_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOMATION_DEFAULT_FAILURE_THRESHOLD = 3;
export const AUTOMATION_TRANSCRIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUTOMATION_METADATA_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES = 512 * 1024 * 1024;

export const AUTOMATION_TASK_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const AUTOMATION_RUN_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;

export const AUTOMATION_TASK_STATUSES = [
  "draft",
  "active",
  "paused",
  "blocked",
  "archived",
] as const;
export type AutomationTaskStatus = (typeof AUTOMATION_TASK_STATUSES)[number];

export const AUTOMATION_BLOCKED_REASONS = [
  "reauthorization_required",
  "interaction_required",
  "capacity",
  "approval_expired",
  "cwd_unavailable",
  "cwd_drift",
  "cwd_invalid",
  "model_unavailable",
  "credential_unavailable",
  "tool_unavailable",
  "scheduler_unavailable",
  "policy_violation",
] as const;
export type AutomationBlockedReason = (typeof AUTOMATION_BLOCKED_REASONS)[number];

export const AUTOMATION_RUN_STATUSES = [
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancel_requested",
  "cancelled",
  "skipped",
  "blocked",
  "ambiguous",
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const AUTOMATION_TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
  "blocked",
  "ambiguous",
] as const satisfies readonly AutomationRunStatus[];

export type AutomationRunTerminalStatus = (typeof AUTOMATION_TERMINAL_RUN_STATUSES)[number];

export const AUTOMATION_CLAIM_STAGES = [
  "prepared",
  "run_created",
  "task_advanced",
  "execution_may_have_started",
] as const;
export type AutomationClaimStage = (typeof AUTOMATION_CLAIM_STAGES)[number];

export const AUTOMATION_ERROR_CODES = [
  "validation",
  "revision_conflict",
  "approval_required",
  "approval_expired",
  "approval_replayed",
  "blocked",
  "already_running",
  "archived",
  "not_found",
  "scheduler_unavailable",
  "repair_required",
  "security",
] as const;
export type AutomationErrorCode = (typeof AUTOMATION_ERROR_CODES)[number];

/** Emitted run errorCategory values (UI localization must cover these). */
export const AUTOMATION_ERROR_CATEGORIES = [
  "preflight",
  "budget",
  "provider",
  "auth",
  "interaction_required",
  "scheduler",
  "late_settlement",
  "abort_ignored_expired",
  "abort_ignored",
  "cancel_unconfirmed",
  "cancelled",
  "timeout",
  "overlap",
  "reconciliation",
  "shutdown",
  "runner",
  "runner_setup",
  "validation",
  "worker_missing",
  "worker_exit",
  "dispose_unconfirmed",
  "capacity",
  "approval_expired",
  "cwd_unavailable",
  "cwd_drift",
  "model_unavailable",
  "credential_unavailable",
  "tool_unavailable",
  "scheduler_unavailable",
  "policy_violation",
  "reauthorization_required",
] as const;
export type AutomationErrorCategory = (typeof AUTOMATION_ERROR_CATEGORIES)[number];

/** Emitted session unavailableReason values (UI localization must cover these). */
export const AUTOMATION_SESSION_UNAVAILABLE_REASONS = [
  "no_session_file",
  "budget_preflight",
  "extension_digest_mismatch",
  "preflight_blocked",
  "artifacts_deleted",
  "bind_extensions_failed",
  "headless_ui_unbound",
  "retention_tombstone",
  "retention_purged_transcript",
  "extension_staging_failed",
  "worker_missing",
  "worker_error",
  "child_exit_unverified",
  "empty_prompt",
  "setup_failed",
  "abort_ignored_unsealed",
  /** Dispose completed without a confirmed seal; technical detail is separate. */
  "dispose_unconfirmed",
] as const;
export type AutomationSessionUnavailableReason =
  (typeof AUTOMATION_SESSION_UNAVAILABLE_REASONS)[number];

/** Omission aggregate kinds (inbox localization must cover these). */
export const AUTOMATION_OMISSION_KINDS = ["dst_gap", "misfire_aggregate"] as const;
export type AutomationOmissionKind = (typeof AUTOMATION_OMISSION_KINDS)[number];

export const AUTOMATION_TRIGGERS = ["scheduled", "manual", "run_now"] as const;
export type AutomationTriggerKind = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_CWD_SOURCES = ["project", "default"] as const;
export type AutomationCwdSource = (typeof AUTOMATION_CWD_SOURCES)[number];
export type AutomationTrigger = "scheduled" | "manual";
export type AutomationSessionAvailability = "pending" | "available" | "unavailable";
export const AUTOMATION_SESSION_AVAILABILITIES = [
  "pending",
  "available",
  "unavailable",
] as const;
export type AutomationToolOrigin = "builtin" | "extension" | "custom";

export interface AutomationToolRiskFlags {
  headlessCompatible: boolean;
  localMutation: boolean;
  networkEgress: boolean;
  credentialUse: boolean;
  interactionRequired: boolean;
  blocked: boolean;
  blockedReason?: string;
}

export interface AutomationToolSnapshot {
  name: string;
  origin: AutomationToolOrigin;
  description?: string;
  sourceIdentity: string;
  sourcePath?: string;
  executableDigest: string;
  schemaHash: string;
  configHash: string;
  manifestLock?: string;
  hookInventory?: string[];
  risks: AutomationToolRiskFlags;
  credentialHandles?: string[];
}

export interface AutomationExtensionSourceSnapshot {
  sourceIdentity: string;
  sourcePath: string;
  executableDigest: string;
  manifestLock?: string;
  hookInventory: string[];
  configHash: string;
}

export interface AutomationBudgetPolicy {
  maxRunsPerDay: number;
  maxTokensPerRun: number;
  maxMonthlyCostUsd: number;
  consecutiveFailureThreshold: number;
}

export interface AutomationScheduleConfig {
  cron: string;
  timezone: string;
  schedulePolicyVersion: typeof AUTOMATION_SCHEDULE_POLICY_VERSION;
  minIntervalMs: number;
  misfireWindowMs: number;
  dstGapPolicy: "skip";
  dstFoldPolicy: "first";
  overlapPolicy: "skip";
}

export interface AutomationAgentConfig {
  provider: string;
  modelId: string;
  thinking?: string | null;
  prompt: string;
  maxRuntimeMs: number;
}

export interface AutomationTargetConfig {
  cwd: string;
  cwdSource: AutomationCwdSource;
}

export interface AutomationAuthorityConfig {
  authorityPolicyVersion: typeof AUTOMATION_AUTHORITY_POLICY_VERSION;
  tools: AutomationToolSnapshot[];
  extensions: AutomationExtensionSourceSnapshot[];
  policyHash: string;
  approvalExpiresAt: string | null;
  budgets: AutomationBudgetPolicy;
  credentialHandles: string[];
}

export interface AutomationTaskConfig {
  name: string;
  description: string;
  schedule: AutomationScheduleConfig;
  target: AutomationTargetConfig;
  agent: AutomationAgentConfig;
  authority: AutomationAuthorityConfig;
}

export interface AutomationTaskRecord {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  id: string;
  revision: string;
  approvedRevision: string;
  pendingRevision: string | null;
  status: AutomationTaskStatus;
  blockedReason: AutomationBlockedReason | null;
  name: string;
  description: string;
  approvedConfig: AutomationTaskConfig;
  pendingConfig: AutomationTaskConfig | null;
  nextRunAt: string | null;
  lastMaterializedOccurrenceKey: string | null;
  /**
   * Last recorded DST-gap/misfire omission identity so identical ticks emit once.
   * Format: `${kind}@${firstLocal}@${timezone}`.
   */
  lastOmissionKey: string | null;
  lastRunId: string | null;
  consecutiveFailures: number;
  runsToday: number;
  runsTodayDate: string | null;
  monthlyCostUsd: number;
  monthlyCostMonth: string | null;
  createdBySessionId: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  archivedAt: string | null;
}

export interface AutomationOccurrenceMeta {
  occurrenceKey: string;
  scheduledForUtc: string;
  localWallTime: string;
  localOffsetMinutes: number;
  timezone: string;
  schedulePolicyVersion: number;
  cron: string;
}

export interface AutomationRunLease {
  ownerId: string;
  epoch: number;
  fencingToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface AutomationSessionRef {
  sessionId: string | null;
  sessionFile: string | null;
  availability: AutomationSessionAvailability;
  /** Declared unavailable reason union member (localized in UI). */
  unavailableReason: string | null;
  /**
   * Optional technical detail for diagnostics (e.g. dispose failure cause).
   * Never used as the primary user-facing label; localize separately.
   */
  unavailableDetail?: string | null;
  sealed: boolean;
  seal?: {
    size: number;
    sha256: string;
    entryCount: number;
    sealedAt: string;
  } | null;
}

export interface AutomationRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface AutomationRunRecord {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  id: string;
  taskId: string;
  taskRevision: string;
  trigger: AutomationTrigger;
  status: AutomationRunStatus;
  blockedReason: AutomationBlockedReason | null;
  occurrence: AutomationOccurrenceMeta;
  lease: AutomationRunLease | null;
  promptHash: string;
  requestedModel: { provider: string; modelId: string; thinking?: string | null };
  actualModel: { provider: string; modelId: string; thinking?: string | null } | null;
  effectiveTools: AutomationToolSnapshot[];
  effectiveExtensions: AutomationExtensionSourceSnapshot[];
  session: AutomationSessionRef;
  summary: string | null;
  usage: AutomationRunUsage | null;
  errorCategory: string | null;
  errorMessage: string | null;
  sideEffectsStarted: boolean;
  cancelRequestedAt: string | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cwd: string;
  terminal: boolean;
}

export interface AutomationClaimRecord {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  occurrenceKey: string;
  taskId: string;
  runId: string;
  stage: AutomationClaimStage;
  ownerId: string;
  epoch: number;
  fencingToken: string;
  createdAt: string;
  updatedAt: string;
  finalized: boolean;
}

export interface AutomationPromotionRecord {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  status: "staging" | "committed" | "failed";
  sourceSessionFile: string;
  destinationSessionFile: string | null;
  destinationSessionId: string | null;
  /** Canonical run cwd — required for opening the promoted session in the correct workspace. */
  destinationCwd: string | null;
  sourceSeal: NonNullable<AutomationSessionRef["seal"]>;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  error: string | null;
}

export interface AutomationAuditEvent {
  seq: number;
  at: string;
  kind: string;
  actor: string;
  message: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AutomationAuditProjection {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  events: AutomationAuditEvent[];
  updatedAt: string;
}

export interface AutomationTasksFile {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  revision: string;
  updatedAt: string;
  tasks: Record<string, AutomationTaskRecord>;
  defaultCwdCanonical: string | null;
  defaultCwdInitializedAt: string | null;
  globalDisabled: boolean;
  storeEpoch: number;
}

export interface AutomationSchedulerStatusFile {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  ownerId: string | null;
  pid: number | null;
  hostname: string | null;
  epoch: number;
  heartbeatAt: string | null;
  nextWakeAt: string | null;
  lastScanAt: string | null;
  lastError: string | null;
  globalDisabled: boolean;
  nonterminalRunCount: number;
  available: boolean;
  repairRequired: boolean;
  repairReason: string | null;
  freeSpaceBytes: number | null;
  storageBytes: number | null;
  updatedAt: string;
}

export interface AutomationLockFile {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  kind: "store" | "scheduler";
  ownerId: string;
  pid: number;
  hostname: string;
  epoch: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** Present after a safe stale takeover. */
  previousOwnerId?: string;
  previousEpoch?: number;
}

export interface AutomationOmissionRecord {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  id: string;
  taskId: string;
  kind: "dst_gap" | "misfire_aggregate";
  timezone: string;
  firstLocal: string | null;
  lastLocal: string | null;
  firstUtc: string | null;
  lastUtc: string | null;
  count: number;
  reason: string;
  createdAt: string;
}

export function isAutomationTaskStatus(value: unknown): value is AutomationTaskStatus {
  return typeof value === "string" && (AUTOMATION_TASK_STATUSES as readonly string[]).includes(value);
}

export function isAutomationRunStatus(value: unknown): value is AutomationRunStatus {
  return typeof value === "string" && (AUTOMATION_RUN_STATUSES as readonly string[]).includes(value);
}

export function isAutomationBlockedReason(value: unknown): value is AutomationBlockedReason {
  return typeof value === "string" && (AUTOMATION_BLOCKED_REASONS as readonly string[]).includes(value);
}

export function isValidAutomationTaskId(value: string): boolean {
  return AUTOMATION_TASK_ID_RE.test(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

export function isValidAutomationRunId(value: string): boolean {
  return AUTOMATION_RUN_ID_RE.test(value) && !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

export function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return (AUTOMATION_TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function defaultBudgetPolicy(): AutomationBudgetPolicy {
  return {
    maxRunsPerDay: 48,
    maxTokensPerRun: 200_000,
    maxMonthlyCostUsd: 50,
    consecutiveFailureThreshold: AUTOMATION_DEFAULT_FAILURE_THRESHOLD,
  };
}

export function defaultScheduleConfig(cron: string, timezone: string): AutomationScheduleConfig {
  return {
    cron,
    timezone,
    schedulePolicyVersion: AUTOMATION_SCHEDULE_POLICY_VERSION,
    minIntervalMs: AUTOMATION_MIN_CRON_INTERVAL_MS,
    misfireWindowMs: AUTOMATION_MISFIRE_WINDOW_MS,
    dstGapPolicy: "skip",
    dstFoldPolicy: "first",
    overlapPolicy: "skip",
  };
}
