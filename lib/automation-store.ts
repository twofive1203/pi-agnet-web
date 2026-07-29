/**
 * Versioned Automation file store with revision CAS, atomic writes,
 * claim journal stages, terminal run freeze, audit chain, and promotion projection.
 */

import { createHash, randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import type { LockHandle } from "./automation-lock";
import { withAutomationStoreLock, AutomationLockError } from "./automation-lock";
import {
  getAutomationAuditDir,
  getAutomationAuditPath,
  getAutomationClaimPath,
  getAutomationClaimsDir,
  getAutomationOmissionsDir,
  getAutomationPromotionPath,
  getAutomationPromotionsDir,
  getAutomationRetentionPath,
  getAutomationRetentionDir,
  getAutomationRoot,
  getAutomationRunPath,
  getAutomationRunsDir,
  getAutomationSchedulerStatusPath,
  getAutomationSessionsRoot,
  getAutomationTasksPath,
  assertSafeAutomationId,
} from "./automation-paths";
import { ensureAutomationDefaultCwd } from "./automation-default-cwd";
import {
  AUTOMATION_SCHEMA_VERSION,
  isTerminalRunStatus,
  isValidAutomationRunId,
  isValidAutomationTaskId,
  type AutomationAuditEvent,
  type AutomationAuditProjection,
  type AutomationClaimRecord,
  type AutomationClaimStage,
  type AutomationOmissionRecord,
  type AutomationPromotionRecord,
  type AutomationRunRecord,
  type AutomationSchedulerStatusFile,
  type AutomationTaskConfig,
  type AutomationTaskRecord,
  type AutomationTasksFile,
} from "./automation-types";

export class AutomationStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly blockedReason?: string;

  constructor(
    message: string,
    options?: { status?: number; code?: string; blockedReason?: string },
  ) {
    super(message);
    this.name = "AutomationStoreError";
    this.status = options?.status ?? 400;
    this.code = options?.code ?? "validation";
    this.blockedReason = options?.blockedReason;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new AutomationStoreError(`Corrupt JSON: ${path}`, {
      status: 500,
      code: "repair_required",
    });
  }
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function hashChain(prev: string, payload: unknown): string {
  return createHash("sha256").update(`${prev}:${JSON.stringify(payload)}`).digest("hex");
}

export function ensureAutomationLayout(agentDir?: string): void {
  const root = getAutomationRoot(agentDir);
  for (const dir of [
    root,
    getAutomationClaimsDir(agentDir),
    getAutomationRunsDir(agentDir),
    getAutomationPromotionsDir(agentDir),
    getAutomationAuditDir(agentDir),
    getAutomationSessionsRoot(agentDir),
    getAutomationOmissionsDir(agentDir),
    getAutomationRetentionDir(agentDir),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  try {
    ensureAutomationDefaultCwd(agentDir);
  } catch {
    // Default cwd may be unavailable; layout still created. Callers surface block reasons.
  }
}

function emptyTasksFile(): AutomationTasksFile {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    revision: shortHash({ empty: true, at: 0 }),
    updatedAt: nowIso(),
    tasks: {},
    defaultCwdCanonical: null,
    defaultCwdInitializedAt: null,
    globalDisabled: false,
    storeEpoch: 0,
  };
}

export function readTasksFile(agentDir?: string): AutomationTasksFile {
  ensureAutomationLayout(agentDir);
  const path = getAutomationTasksPath(agentDir);
  if (!existsSync(path)) return emptyTasksFile();
  const raw = readJsonFile<AutomationTasksFile>(path);
  if (!raw || raw.schemaVersion !== AUTOMATION_SCHEMA_VERSION || !isRecord(raw.tasks)) {
    throw new AutomationStoreError("tasks.json schema invalid", {
      status: 500,
      code: "repair_required",
    });
  }
  return raw;
}

function writeTasksFile(file: AutomationTasksFile, agentDir?: string): void {
  const next: AutomationTasksFile = {
    ...file,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    revision: shortHash({
      tasks: file.tasks,
      globalDisabled: file.globalDisabled,
      defaultCwdCanonical: file.defaultCwdCanonical,
      storeEpoch: file.storeEpoch,
      updatedAt: file.updatedAt,
    }),
    updatedAt: nowIso(),
  };
  writeJsonAtomic(getAutomationTasksPath(agentDir), next);
}

export function computeTaskRevision(task: Omit<AutomationTaskRecord, "revision">): string {
  return shortHash(task);
}

export function withTaskRevision(task: Omit<AutomationTaskRecord, "revision">): AutomationTaskRecord {
  return { ...task, revision: computeTaskRevision(task) };
}

export function makeAutomationTaskId(name: string): string {
  const stamp = new Date().toISOString().slice(5, 10);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  const id = `${stamp}-${slug}-${randomBytes(2).toString("hex")}`.slice(0, 64);
  if (!isValidAutomationTaskId(id)) return `task-${randomBytes(4).toString("hex")}`;
  return id;
}

export function makeAutomationRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `run-${stamp}-${randomBytes(3).toString("hex")}`.toLowerCase().slice(0, 80);
  return isValidAutomationRunId(id) ? id : `run-${randomBytes(8).toString("hex")}`;
}

export async function mutateTasksFile<T>(
  mutator: (file: AutomationTasksFile, handle: LockHandle) => Promise<T> | T,
  options?: { agentDir?: string; expectedRevision?: string },
): Promise<T> {
  return withAutomationStoreLock(async (handle) => {
    const file = readTasksFile(options?.agentDir);
    if (options?.expectedRevision && options.expectedRevision !== file.revision) {
      throw new AutomationStoreError("Store revision conflict", {
        status: 409,
        code: "revision_conflict",
      });
    }
    handle.heartbeat();
    return mutator(file, handle);
  }, { agentDir: options?.agentDir });
}

export function listTaskRecords(agentDir?: string): AutomationTaskRecord[] {
  const file = readTasksFile(agentDir);
  return Object.values(file.tasks).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getTaskRecord(taskId: string, agentDir?: string): AutomationTaskRecord | null {
  assertSafeAutomationId("task", taskId);
  const file = readTasksFile(agentDir);
  return file.tasks[taskId] ?? null;
}

export async function upsertTaskRecord(
  task: AutomationTaskRecord,
  options?: { agentDir?: string; expectedTaskRevision?: string; expectedStoreRevision?: string },
): Promise<AutomationTaskRecord> {
  assertSafeAutomationId("task", task.id);
  return mutateTasksFile((file) => {
    const existing = file.tasks[task.id];
    if (existing && options?.expectedTaskRevision && existing.revision !== options.expectedTaskRevision) {
      throw new AutomationStoreError("Task revision conflict", {
        status: 409,
        code: "revision_conflict",
      });
    }
    if (options?.expectedStoreRevision && file.revision !== options.expectedStoreRevision) {
      throw new AutomationStoreError("Store revision conflict", {
        status: 409,
        code: "revision_conflict",
      });
    }
    const nextTask = withTaskRevision({
      ...task,
      updatedAt: nowIso(),
    });
    file.tasks[task.id] = nextTask;
    writeTasksFile(file, options?.agentDir);
    return nextTask;
  }, { agentDir: options?.agentDir });
}

export async function deleteTaskRecordSoft(
  taskId: string,
  expectedRevision: string,
  agentDir?: string,
): Promise<AutomationTaskRecord> {
  const existing = getTaskRecord(taskId, agentDir);
  if (!existing) {
    throw new AutomationStoreError("Task not found", { status: 404, code: "not_found" });
  }
  if (existing.revision !== expectedRevision) {
    throw new AutomationStoreError("Task revision conflict", {
      status: 409,
      code: "revision_conflict",
    });
  }
  if (existing.status === "archived") {
    throw new AutomationStoreError("Task already archived", { status: 409, code: "archived" });
  }
  return upsertTaskRecord(
    {
      ...existing,
      status: "archived",
      archivedAt: nowIso(),
      nextRunAt: null,
      pendingConfig: null,
      pendingRevision: null,
    },
    { agentDir, expectedTaskRevision: expectedRevision },
  );
}

export function readRunRecord(runId: string, agentDir?: string): AutomationRunRecord | null {
  assertSafeAutomationId("run", runId);
  return readJsonFile<AutomationRunRecord>(getAutomationRunPath(runId, agentDir));
}

export function writeRunRecord(run: AutomationRunRecord, agentDir?: string): void {
  assertSafeAutomationId("run", run.id);
  const path = getAutomationRunPath(run.id, agentDir);
  const existing = readRunRecord(run.id, agentDir);
  if (existing?.terminal) {
    throw new AutomationStoreError("Terminal run snapshot is immutable", {
      status: 409,
      code: "validation",
    });
  }
  const terminal = isTerminalRunStatus(run.status);
  writeJsonAtomic(path, {
    ...run,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    terminal,
    completedAt: terminal ? run.completedAt ?? nowIso() : run.completedAt,
  });
}

/**
 * Retention/tombstone projection writer.
 * NEVER overwrites terminal runs/<id>.json. State lives under retention/<id>.json.
 */
export function writeRunRetentionProjection(
  run: AutomationRunRecord & { retentionTombstone?: boolean; artifactsPurgedAt?: string | null },
  agentDir?: string,
): void {
  assertSafeAutomationId("run", run.id);
  const existing = readRunRecord(run.id, agentDir);
  if (!existing?.terminal) {
    throw new AutomationStoreError("Retention projection requires terminal run", {
      status: 409,
      code: "validation",
    });
  }
  ensureAutomationLayout(agentDir);
  mkdirSync(getAutomationRetentionDir(agentDir), { recursive: true });
  const projection = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    runId: existing.id,
    taskId: existing.taskId,
    occurrenceKey: existing.occurrence.occurrenceKey,
    status: existing.status,
    completedAt: existing.completedAt,
    terminal: true as const,
    retentionTombstone: Boolean((run as { retentionTombstone?: boolean }).retentionTombstone),
    artifactsPurgedAt:
      (run as { artifactsPurgedAt?: string | null }).artifactsPurgedAt ??
      (run.session?.sessionFile == null && existing.session?.sessionFile
        ? nowIso()
        : null),
    sessionAvailability: run.session?.availability ?? "unavailable",
    unavailableReason: run.session?.unavailableReason ?? null,
    originalSessionId: existing.session?.sessionId ?? null,
    originalSessionFile: existing.session?.sessionFile ?? null,
    sealed: existing.session?.sealed ?? false,
    updatedAt: nowIso(),
  };
  writeJsonAtomic(getAutomationRetentionPath(run.id, agentDir), projection);
}

export function readRunRetentionProjection(
  runId: string,
  agentDir?: string,
): Record<string, unknown> | null {
  return readJsonFile<Record<string, unknown>>(getAutomationRetentionPath(runId, agentDir));
}

/** True when a terminal run snapshot file still exists unchanged under runs/. */
export function terminalRunSnapshotExists(runId: string, agentDir?: string): boolean {
  const path = getAutomationRunPath(runId, agentDir);
  return existsSync(path);
}

export function deleteClaimRecord(occurrenceKey: string, agentDir?: string): void {
  try {
    const p = getAutomationClaimPath(occurrenceKey, agentDir);
    if (existsSync(p)) rmSync(p, { force: true });
  } catch {
    // best effort
  }
}

export function listRunRecords(options?: {
  agentDir?: string;
  taskId?: string;
  /** When set, return at most this many newest runs. Omit for full scan (retention). */
  limit?: number;
  /** Skip newest `offset` runs after sort (pagination). */
  offset?: number;
}): AutomationRunRecord[] {
  ensureAutomationLayout(options?.agentDir);
  const dir = getAutomationRunsDir(options?.agentDir);
  const runs: AutomationRunRecord[] = [];
  const seen = new Set<string>();
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    for (const name of files) {
      try {
        const run = readJsonFile<AutomationRunRecord>(join(dir, name));
        if (!run) continue;
        if (options?.taskId && run.taskId !== options.taskId) continue;
        runs.push(run);
        seen.add(run.id);
      } catch {
        // skip corrupt individual runs; repair surfaces separately
      }
    }
  }
  // After 365d retention deletes runs/<id>.json, APIs list tombstone projections only.
  const retDir = getAutomationRetentionDir(options?.agentDir);
  if (existsSync(retDir)) {
    for (const name of readdirSync(retDir).filter((n) => n.endsWith(".json"))) {
      try {
        const proj = readJsonFile<Record<string, unknown>>(join(retDir, name));
        if (!proj?.retentionTombstone) continue;
        const runId = String(proj.runId ?? name.replace(/\.json$/, ""));
        if (seen.has(runId)) continue;
        if (options?.taskId && proj.taskId && String(proj.taskId) !== options.taskId) continue;
        // Minimal synthetic record for list/projectRun tombstone path.
        const synthetic = {
          schemaVersion: AUTOMATION_SCHEMA_VERSION,
          id: runId,
          taskId: String(proj.taskId ?? ""),
          taskRevision: "tombstone",
          trigger: "scheduled",
          status: (proj.status as AutomationRunRecord["status"]) ?? "succeeded",
          blockedReason: null,
          occurrence: {
            occurrenceKey: String(proj.occurrenceKey ?? `${runId}@tombstone`),
            scheduledForUtc: String(proj.completedAt ?? new Date(0).toISOString()),
            localWallTime: "",
            localOffsetMinutes: 0,
            timezone: "UTC",
            schedulePolicyVersion: 1 as const,
            cron: "",
          },
          lease: null,
          promptHash: "",
          requestedModel: { provider: "", modelId: "" },
          actualModel: null,
          effectiveTools: [],
          effectiveExtensions: [],
          session: {
            sessionId: null,
            sessionFile: null,
            availability: "unavailable" as const,
            unavailableReason: "retention_tombstone",
            sealed: false,
            seal: null,
          },
          summary: null,
          usage: null,
          errorCategory: null,
          errorMessage: null,
          sideEffectsStarted: true,
          cancelRequestedAt: null,
          createdAt: String(proj.completedAt ?? new Date(0).toISOString()),
          claimedAt: null,
          startedAt: null,
          completedAt: (proj.completedAt as string | null) ?? null,
          cwd: "",
          terminal: true,
        } satisfies AutomationRunRecord;
        runs.push(synthetic);
        seen.add(runId);
      } catch {
        // skip corrupt projections
      }
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const offset = Math.max(0, options?.offset ?? 0);
  if (options?.limit && options.limit > 0) {
    return runs.slice(offset, offset + options.limit);
  }
  if (offset > 0) return runs.slice(offset);
  return runs;
}

/** Total run count matching filters (no limit truncation). */
export function countRunRecords(options?: {
  agentDir?: string;
  taskId?: string;
}): number {
  return listRunRecords({ agentDir: options?.agentDir, taskId: options?.taskId }).length;
}

export function readClaimRecord(occurrenceKey: string, agentDir?: string): AutomationClaimRecord | null {
  return readJsonFile<AutomationClaimRecord>(getAutomationClaimPath(occurrenceKey, agentDir));
}

export function writeClaimRecord(claim: AutomationClaimRecord, agentDir?: string): void {
  // Path is derived from occurrenceKey via hash encoding; original key stays in the record.
  writeJsonAtomic(getAutomationClaimPath(claim.occurrenceKey, agentDir), {
    ...claim,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    updatedAt: nowIso(),
  });
}

/** List all claim records by scanning claim files (works with hashed filenames). */
export function listClaimRecords(agentDir?: string): AutomationClaimRecord[] {
  ensureAutomationLayout(agentDir);
  const dir = getAutomationClaimsDir(agentDir);
  if (!existsSync(dir)) return [];
  const out: AutomationClaimRecord[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const claim = readJsonFile<AutomationClaimRecord>(join(dir, name));
      if (claim?.occurrenceKey) out.push(claim);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/**
 * Verify caller fencing against the live scheduler.lock before any side-effecting
 * write that advances occurrence authority (materialize / barrier / finalize).
 */
export function assertLiveSchedulerFencing(input: {
  ownerId: string;
  epoch: number;
  agentDir?: string;
  /** Tests may skip when no scheduler lock is present. */
  allowMissing?: boolean;
}): void {
  // Lazy import keeps store usable in unit contexts without circular init.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { inspectAutomationLock } = require("./automation-lock") as typeof import("./automation-lock");
  const sched = inspectAutomationLock("scheduler", input.agentDir);
  if (sched.corrupt || sched.empty) {
    throw new AutomationStoreError("Scheduler lock corrupt; repair required", {
      status: 409,
      code: "repair_required",
    });
  }
  if (!sched.lock) {
    if (input.allowMissing) return;
    throw new AutomationStoreError("Scheduler fencing required (no live leader)", {
      status: 409,
      code: "revision_conflict",
    });
  }
  if (sched.lock.ownerId !== input.ownerId || sched.lock.epoch !== input.epoch) {
    throw new AutomationStoreError("Scheduler fencing rejected (stale leader)", {
      status: 409,
      code: "revision_conflict",
    });
  }
}

export function advanceClaimStage(
  occurrenceKey: string,
  nextStage: AutomationClaimStage,
  options: { ownerId: string; epoch: number; fencingToken: string; agentDir?: string },
): AutomationClaimRecord {
  const claim = readClaimRecord(occurrenceKey, options.agentDir);
  if (!claim) {
    throw new AutomationStoreError("Claim not found", { status: 404, code: "not_found" });
  }
  if (claim.ownerId !== options.ownerId || claim.epoch !== options.epoch) {
    throw new AutomationStoreError("Claim fencing rejected", {
      status: 409,
      code: "revision_conflict",
    });
  }
  if (claim.fencingToken !== options.fencingToken) {
    throw new AutomationStoreError("Claim fencing token mismatch", {
      status: 409,
      code: "revision_conflict",
    });
  }
  const order: AutomationClaimStage[] = [
    "prepared",
    "run_created",
    "task_advanced",
    "execution_may_have_started",
  ];
  const cur = order.indexOf(claim.stage);
  const next = order.indexOf(nextStage);
  if (next < cur) {
    throw new AutomationStoreError("Claim stage cannot move backwards", {
      status: 409,
      code: "validation",
    });
  }
  const updated: AutomationClaimRecord = {
    ...claim,
    stage: nextStage,
    updatedAt: nowIso(),
  };
  writeClaimRecord(updated, options.agentDir);
  return updated;
}

/**
 * Authoritative occurrence materialization under store lock.
 * Stages: prepared → run_created → task_advanced → (caller) execution_may_have_started
 */
export async function materializeOccurrence(input: {
  taskId: string;
  occurrenceKey: string;
  run: AutomationRunRecord;
  nextRunAt: string | null;
  ownerId: string;
  epoch: number;
  fencingToken: string;
  agentDir?: string;
}): Promise<{ claim: AutomationClaimRecord; run: AutomationRunRecord; task: AutomationTaskRecord }> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    assertLiveSchedulerFencing({
      ownerId: input.ownerId,
      epoch: input.epoch,
      agentDir: input.agentDir,
    });
    const existingClaim = readClaimRecord(input.occurrenceKey, input.agentDir);
    if (existingClaim) {
      const existingRun = readRunRecord(existingClaim.runId, input.agentDir);
      const task = getTaskRecord(input.taskId, input.agentDir);
      if (!task || !existingRun) {
        throw new AutomationStoreError("Existing claim is incomplete", {
          status: 500,
          code: "repair_required",
        });
      }
      return { claim: existingClaim, run: existingRun, task };
    }

    const file = readTasksFile(input.agentDir);
    const task = file.tasks[input.taskId];
    if (!task) {
      throw new AutomationStoreError("Task not found", { status: 404, code: "not_found" });
    }
    if (task.lastMaterializedOccurrenceKey === input.occurrenceKey) {
      const run = task.lastRunId ? readRunRecord(task.lastRunId, input.agentDir) : null;
      if (run) {
        const claim = readClaimRecord(input.occurrenceKey, input.agentDir);
        if (claim) return { claim, run, task };
      }
    }

    const claim: AutomationClaimRecord = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      occurrenceKey: input.occurrenceKey,
      taskId: input.taskId,
      runId: input.run.id,
      stage: "prepared",
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finalized: false,
    };
    writeClaimRecord(claim, input.agentDir);

    writeRunRecord(input.run, input.agentDir);
    advanceClaimStage(input.occurrenceKey, "run_created", {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      agentDir: input.agentDir,
    });

    const nextTask = withTaskRevision({
      ...task,
      lastMaterializedOccurrenceKey: input.occurrenceKey,
      lastRunId: input.run.id,
      nextRunAt: input.nextRunAt,
      updatedAt: nowIso(),
    });
    file.tasks[input.taskId] = nextTask;
    writeTasksFile(file, input.agentDir);

    const claim3 = advanceClaimStage(input.occurrenceKey, "task_advanced", {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      agentDir: input.agentDir,
    });

    return { claim: claim3, run: input.run, task: nextTask };
  }, { agentDir: input.agentDir });
}

export async function markExecutionBarrier(input: {
  occurrenceKey: string;
  runId: string;
  ownerId: string;
  epoch: number;
  fencingToken: string;
  agentDir?: string;
}): Promise<AutomationRunRecord> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    assertLiveSchedulerFencing({
      ownerId: input.ownerId,
      epoch: input.epoch,
      agentDir: input.agentDir,
    });
    advanceClaimStage(input.occurrenceKey, "execution_may_have_started", {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      agentDir: input.agentDir,
    });
    const run = readRunRecord(input.runId, input.agentDir);
    if (!run) {
      throw new AutomationStoreError("Run not found", { status: 404, code: "not_found" });
    }
    if (run.lease && (run.lease.ownerId !== input.ownerId || run.lease.epoch !== input.epoch)) {
      throw new AutomationStoreError("Run fencing rejected", {
        status: 409,
        code: "revision_conflict",
      });
    }
    const next: AutomationRunRecord = {
      ...run,
      status: run.status === "claimed" || run.status === "queued" ? "running" : run.status,
      sideEffectsStarted: true,
      startedAt: run.startedAt ?? nowIso(),
    };
    writeRunRecord(next, input.agentDir);

    // Count runs/day at the dispatch barrier (authoritative start), not only on finalize.
    const file = readTasksFile(input.agentDir);
    const task = file.tasks[run.taskId];
    if (task && !run.startedAt) {
      const today = new Date().toISOString().slice(0, 10);
      const runsToday = task.runsTodayDate === today ? task.runsToday : 0;
      file.tasks[run.taskId] = withTaskRevision({
        ...task,
        lastRunId: run.id,
        runsToday: runsToday + 1,
        runsTodayDate: today,
        updatedAt: nowIso(),
      });
      writeTasksFile(file, input.agentDir);
    }
    return next;
  }, { agentDir: input.agentDir });
}

export async function finalizeRunRecord(
  runId: string,
  patch: Partial<AutomationRunRecord> & { status: AutomationRunRecord["status"] },
  options?: {
    agentDir?: string;
    ownerId?: string;
    epoch?: number;
    allowMissingLease?: boolean;
    /** New leader may force-ambiguous stale post-barrier runs from a prior owner. */
    allowTakeoverAmbiguous?: boolean;
    /** When true, skip live scheduler authority check (tests only). */
    skipSchedulerAuthorityCheck?: boolean;
  },
): Promise<AutomationRunRecord> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    const run = readRunRecord(runId, options?.agentDir);
    if (!run) {
      throw new AutomationStoreError("Run not found", { status: 404, code: "not_found" });
    }
    if (run.terminal) {
      throw new AutomationStoreError("Terminal run snapshot is immutable", {
        status: 409,
        code: "validation",
      });
    }

    // Reject stale leaders: caller fencing must match current scheduler authority when present.
    if (
      options?.ownerId &&
      options.epoch != null &&
      !options.skipSchedulerAuthorityCheck
    ) {
      assertLiveSchedulerFencing({
        ownerId: options.ownerId,
        epoch: options.epoch,
        agentDir: options.agentDir,
        // Finalize still requires a live lock when the caller claims fencing.
        allowMissing: false,
      });
    }

    if (run.lease && options?.ownerId && options.epoch != null) {
      const leaseMismatch =
        run.lease.ownerId !== options.ownerId || run.lease.epoch !== options.epoch;
      if (leaseMismatch) {
        // Leader takeover may mark post-barrier stale runs ambiguous under explicit authority.
        const takeoverAmbiguous =
          options.allowTakeoverAmbiguous === true &&
          patch.status === "ambiguous" &&
          isRunLeaseStale(run);
        if (!takeoverAmbiguous) {
          throw new AutomationStoreError("Run fencing rejected", {
            status: 409,
            code: "revision_conflict",
          });
        }
      }
    } else if (run.lease && !options?.allowMissingLease && options?.ownerId) {
      throw new AutomationStoreError("Run fencing required", {
        status: 409,
        code: "revision_conflict",
      });
    }

    const terminal = isTerminalRunStatus(patch.status);
    const next: AutomationRunRecord = {
      ...run,
      ...patch,
      id: run.id,
      taskId: run.taskId,
      occurrence: run.occurrence,
      terminal,
      lease: terminal ? null : patch.lease !== undefined ? patch.lease : run.lease,
      completedAt: terminal ? patch.completedAt ?? nowIso() : patch.completedAt ?? run.completedAt,
    };
    writeRunRecord(next, options?.agentDir);

    // Update task consecutive failure / last run pointers / budget counters.
    const file = readTasksFile(options?.agentDir);
    const task = file.tasks[run.taskId];
    if (task) {
      let consecutiveFailures = task.consecutiveFailures;
      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7);
      let runsToday = task.runsTodayDate === today ? task.runsToday : 0;
      const runsTodayDate = today;
      let monthlyCostUsd = task.monthlyCostMonth === month ? task.monthlyCostUsd : 0;
      const monthlyCostMonth = month;

      // runsToday is incremented at execution barrier; do not double-count here.
      // Only count here for terminal preflight/skipped paths that never crossed the barrier.
      if (terminal && !run.sideEffectsStarted && !run.startedAt) {
        if (
          run.status === "claimed" ||
          run.status === "queued" ||
          run.status === "blocked" ||
          run.status === "skipped"
        ) {
          runsToday += 1;
        }
      }
      if (terminal) {
        if (patch.status === "failed" || patch.status === "timed_out" || patch.status === "blocked") {
          consecutiveFailures += 1;
        } else if (patch.status === "succeeded") {
          consecutiveFailures = 0;
        }
        const usage = patch.usage ?? run.usage;
        if (usage?.costUsd != null && Number.isFinite(usage.costUsd)) {
          monthlyCostUsd += usage.costUsd;
        }
        if (usage?.totalTokens != null && Number.isFinite(usage.totalTokens)) {
          // Token counters accumulate in monthly projection via cost path; per-run ceiling is enforced by scheduler/preflight.
        }
      }

      // Persistently pause the task when consecutive failures hit the configured threshold.
      const threshold = task.approvedConfig.authority.budgets.consecutiveFailureThreshold;
      let nextStatus = task.status;
      let nextBlocked = task.blockedReason;
      if (
        terminal &&
        consecutiveFailures >= threshold &&
        (task.status === "active" || task.status === "paused")
      ) {
        nextStatus = "paused";
        nextBlocked = task.blockedReason;
      }

      file.tasks[run.taskId] = withTaskRevision({
        ...task,
        status: nextStatus,
        blockedReason: nextBlocked,
        lastRunId: run.id,
        consecutiveFailures,
        runsToday,
        runsTodayDate,
        monthlyCostUsd,
        monthlyCostMonth,
        updatedAt: nowIso(),
      });
      writeTasksFile(file, options?.agentDir);
    }

    return next;
  }, { agentDir: options?.agentDir });
}

export function readPromotionRecord(runId: string, agentDir?: string): AutomationPromotionRecord | null {
  return readJsonFile<AutomationPromotionRecord>(getAutomationPromotionPath(runId, agentDir));
}

export function writePromotionRecord(record: AutomationPromotionRecord, agentDir?: string): void {
  writeJsonAtomic(getAutomationPromotionPath(record.runId, agentDir), {
    ...record,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    updatedAt: nowIso(),
  });
}

export function readAuditProjection(runId: string, agentDir?: string): AutomationAuditProjection | null {
  return readJsonFile<AutomationAuditProjection>(getAutomationAuditPath(runId, agentDir));
}

/** List all audit projection run ids under automations/audit/. */
export function listAuditProjectionIds(agentDir?: string): string[] {
  ensureAutomationLayout(agentDir);
  const dir = getAutomationAuditDir(agentDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.replace(/\.json$/i, ""));
  } catch {
    return [];
  }
}

/**
 * Append an audit event under store.lock (reentrancy-safe when already held).
 * Preserves monotonic sequence + integrity chain across concurrent processes.
 */
export async function appendAuditEvent(input: {
  runId: string;
  taskId: string;
  kind: string;
  actor: string;
  message: string;
  data?: Record<string, unknown>;
  agentDir?: string;
}): Promise<AutomationAuditProjection> {
  return withAutomationStoreLock(async () => appendAuditEventUnlocked(input), {
    agentDir: input.agentDir,
  });
}

/** Unlocked helper for callers already holding store.lock. */
export function appendAuditEventUnlocked(input: {
  runId: string;
  taskId: string;
  kind: string;
  actor: string;
  message: string;
  data?: Record<string, unknown>;
  agentDir?: string;
}): AutomationAuditProjection {
  const existing = readAuditProjection(input.runId, input.agentDir);
  const events = existing?.events ?? [];
  const prevHash = events.length ? events[events.length - 1]!.hash : "genesis";
  const seq = events.length + 1;
  const base = {
    seq,
    at: nowIso(),
    kind: input.kind,
    actor: input.actor,
    message: input.message,
    data: input.data,
    prevHash,
  };
  const event: AutomationAuditEvent = {
    ...base,
    hash: hashChain(prevHash, base),
  };
  const projection: AutomationAuditProjection = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    runId: input.runId,
    taskId: input.taskId,
    events: [...events, event],
    updatedAt: nowIso(),
  };
  writeJsonAtomic(getAutomationAuditPath(input.runId, input.agentDir), projection);
  return projection;
}

export function writeOmissionRecord(record: AutomationOmissionRecord, agentDir?: string): void {
  const dir = getAutomationOmissionsDir(agentDir);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, `${record.id}.json`), record);
}

/** List all omission records (DST gap / misfire aggregates). No newest-N truncation. */
export function listOmissionRecords(options?: {
  agentDir?: string;
  taskId?: string;
  limit?: number;
  offset?: number;
}): { omissions: AutomationOmissionRecord[]; total: number } {
  ensureAutomationLayout(options?.agentDir);
  const dir = getAutomationOmissionsDir(options?.agentDir);
  const out: AutomationOmissionRecord[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const rec = readJsonFile<AutomationOmissionRecord>(join(dir, name));
        if (!rec) continue;
        if (options?.taskId && rec.taskId !== options.taskId) continue;
        out.push(rec);
      } catch {
        // skip corrupt
      }
    }
  }
  out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const total = out.length;
  const offset = Math.max(0, options?.offset ?? 0);
  const limit = options?.limit && options.limit > 0 ? options.limit : out.length;
  return { omissions: out.slice(offset, offset + limit), total };
}

export function readSchedulerStatus(agentDir?: string): AutomationSchedulerStatusFile {
  const path = getAutomationSchedulerStatusPath(agentDir);
  const fallback: AutomationSchedulerStatusFile = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    ownerId: null,
    pid: null,
    hostname: null,
    epoch: 0,
    heartbeatAt: null,
    nextWakeAt: null,
    lastScanAt: null,
    lastError: null,
    globalDisabled: false,
    nonterminalRunCount: 0,
    available: false,
    repairRequired: false,
    repairReason: null,
    freeSpaceBytes: null,
    storageBytes: null,
    updatedAt: nowIso(),
  };
  if (!existsSync(path)) return fallback;
  try {
    const raw = readJsonFile<AutomationSchedulerStatusFile>(path);
    return raw ?? fallback;
  } catch {
    return {
      ...fallback,
      repairRequired: true,
      repairReason: "scheduler_status_corrupt",
    };
  }
}

export function writeSchedulerStatus(
  status: AutomationSchedulerStatusFile,
  agentDir?: string,
): void {
  writeJsonAtomic(getAutomationSchedulerStatusPath(agentDir), {
    ...status,
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    updatedAt: nowIso(),
  });
}

export async function setGlobalDisabled(
  disabled: boolean,
  agentDir?: string,
): Promise<AutomationTasksFile> {
  return mutateTasksFile((file) => {
    file.globalDisabled = disabled;
    writeTasksFile(file, agentDir);
    const status = readSchedulerStatus(agentDir);
    writeSchedulerStatus({ ...status, globalDisabled: disabled }, agentDir);
    return file;
  }, { agentDir });
}

export function estimateAutomationStorageBytes(agentDir?: string): number {
  const root = getAutomationRoot(agentDir);
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      } catch {
        // ignore
      }
    }
  };
  walk(root);
  return total;
}

export function createDraftTaskRecord(input: {
  id?: string;
  config: AutomationTaskConfig;
  createdBySessionId?: string | null;
}): AutomationTaskRecord {
  const id = input.id ?? makeAutomationTaskId(input.config.name);
  if (!isValidAutomationTaskId(id)) {
    throw new AutomationStoreError("Invalid task id", { status: 400, code: "validation" });
  }
  const now = nowIso();
  return withTaskRevision({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    approvedRevision: "draft",
    pendingRevision: null,
    status: "draft",
    blockedReason: null,
    name: input.config.name,
    description: input.config.description,
    approvedConfig: input.config,
    pendingConfig: null,
    nextRunAt: null,
    lastMaterializedOccurrenceKey: null,
    lastOmissionKey: null,
    lastRunId: null,
    consecutiveFailures: 0,
    runsToday: 0,
    runsTodayDate: null,
    monthlyCostUsd: 0,
    monthlyCostMonth: null,
    createdBySessionId: input.createdBySessionId ?? null,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    archivedAt: null,
  });
}

export { AutomationLockError, withAutomationStoreLock };

function isRunLeaseStale(run: AutomationRunRecord, now = Date.now()): boolean {
  if (!run.lease) return true;
  const exp = Date.parse(run.lease.expiresAt);
  if (!Number.isFinite(exp)) return true;
  return exp <= now;
}

/** Renew an in-flight run lease while the owner still holds fencing. */
export async function renewRunLease(input: {
  runId: string;
  ownerId: string;
  epoch: number;
  ttlMs: number;
  agentDir?: string;
}): Promise<AutomationRunRecord | null> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    assertLiveSchedulerFencing({
      ownerId: input.ownerId,
      epoch: input.epoch,
      agentDir: input.agentDir,
    });
    const run = readRunRecord(input.runId, input.agentDir);
    if (!run || run.terminal) return run;
    if (!run.lease) return run;
    if (run.lease.ownerId !== input.ownerId || run.lease.epoch !== input.epoch) {
      throw new AutomationStoreError("Run fencing rejected", {
        status: 409,
        code: "revision_conflict",
      });
    }
    const now = nowIso();
    const next: AutomationRunRecord = {
      ...run,
      lease: {
        ...run.lease,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      },
    };
    writeRunRecord(next, input.agentDir);
    return next;
  }, { agentDir: input.agentDir });
}

/** Reconcile claim journal against run/task projections (idempotent). */
export function reconcileOccurrence(occurrenceKey: string, agentDir?: string): {
  action:
    | "none"
    | "prepared_without_run"
    | "needs_task_advance"
    | "safe_redispatch"
    | "running_healthy"
    | "await_lease_expiry"
    | "mark_ambiguous"
    | "stable";
  claim: AutomationClaimRecord | null;
  run: AutomationRunRecord | null;
} {
  const claim = readClaimRecord(occurrenceKey, agentDir);
  if (!claim) return { action: "none", claim: null, run: null };
  const run = readRunRecord(claim.runId, agentDir);
  const task = getTaskRecord(claim.taskId, agentDir);

  if (claim.stage === "prepared" && !run) {
    // Safe to drop prepared-only claim for retry by caller.
    return { action: "prepared_without_run", claim, run: null };
  }
  if (claim.stage === "run_created" && run && task && task.lastMaterializedOccurrenceKey !== occurrenceKey) {
    return { action: "needs_task_advance", claim, run };
  }
  if (claim.stage === "task_advanced" && run && !run.sideEffectsStarted && !run.terminal) {
    return { action: "safe_redispatch", claim, run };
  }
  if (claim.stage === "execution_may_have_started" && run && !run.terminal) {
    // Healthy in-process runs must never be terminalized as ambiguous, even if the
    // on-disk lease briefly lags behind heartbeat renewal. Only stale/unowned
    // uncertain execution becomes ambiguous.
    let active = false;
    try {
      // Lazy import avoids circular init issues with scheduler.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getActiveRun } = require("./automation-run-registry") as typeof import("./automation-run-registry");
      active = Boolean(getActiveRun(run.id));
    } catch {
      active = false;
    }
    if (active) {
      return { action: "running_healthy", claim, run };
    }
    const leaseStale = isRunLeaseStale(run);
    if (!leaseStale) {
      // Lease still valid — wait for expiry/heartbeat loss before ambiguous.
      return { action: "await_lease_expiry", claim, run };
    }
    // Stale lease and not actively owned in this process → uncertain execution.
    return { action: "mark_ambiguous", claim, run };
  }
  return { action: "stable", claim, run };
}

/**
 * Idempotent recovery for prepared_without_run.
 * Prefer re-creating a missing run shell from claim metadata when possible;
 * otherwise drop the claim so the occurrence can be safely retried.
 */
export async function recoverPreparedWithoutRun(
  occurrenceKey: string,
  agentDir?: string,
  options?: {
    ownerId?: string;
    epoch?: number;
    fencingToken?: string;
    recreateRun?: AutomationRunRecord | null;
  },
): Promise<{ recovered: "recreated" | "dropped" | "noop" }> {
  return withAutomationStoreLock(async () => {
    const claim = readClaimRecord(occurrenceKey, agentDir);
    if (!claim || claim.stage !== "prepared") return { recovered: "noop" as const };
    const run = readRunRecord(claim.runId, agentDir);
    if (run) return { recovered: "noop" as const };

    // If a fully-formed run shell is provided by the reconciler, recreate it and advance.
    if (options?.recreateRun && options.recreateRun.id === claim.runId) {
      writeRunRecord(options.recreateRun, agentDir);
      const ownerId = options.ownerId ?? claim.ownerId;
      const epoch = options.epoch ?? claim.epoch;
      const fencingToken = options.fencingToken ?? claim.fencingToken;
      // Transfer claim fencing if a new authority is taking over.
      const nextClaim: AutomationClaimRecord = {
        ...claim,
        ownerId,
        epoch,
        fencingToken,
        stage: "run_created",
        updatedAt: nowIso(),
      };
      writeClaimRecord(nextClaim, agentDir);
      return { recovered: "recreated" as const };
    }

    // Safe drop: prepared-only with no run → occurrence may be reclaimed later.
    deleteClaimRecord(occurrenceKey, agentDir);
    return { recovered: "dropped" as const };
  }, { agentDir });
}

/** Idempotent recovery: advance task pointer after run_created without task_advanced. */
export async function recoverNeedsTaskAdvance(
  occurrenceKey: string,
  agentDir?: string,
  options?: { ownerId?: string; epoch?: number; fencingToken?: string },
): Promise<void> {
  await withAutomationStoreLock(async () => {
    const claim = readClaimRecord(occurrenceKey, agentDir);
    if (!claim || claim.stage !== "run_created") return;
    const run = readRunRecord(claim.runId, agentDir);
    if (!run) return;
    const file = readTasksFile(agentDir);
    const task = file.tasks[claim.taskId];
    if (!task) return;

    const ownerId = options?.ownerId ?? claim.ownerId;
    const epoch = options?.epoch ?? claim.epoch;
    const fencingToken = options?.fencingToken ?? claim.fencingToken;

    // Transfer claim fencing to current authority when provided.
    if (
      claim.ownerId !== ownerId ||
      claim.epoch !== epoch ||
      claim.fencingToken !== fencingToken
    ) {
      writeClaimRecord(
        {
          ...claim,
          ownerId,
          epoch,
          fencingToken,
          updatedAt: nowIso(),
        },
        agentDir,
      );
    }

    if (task.lastMaterializedOccurrenceKey === occurrenceKey) {
      advanceClaimStage(occurrenceKey, "task_advanced", {
        ownerId,
        epoch,
        fencingToken,
        agentDir,
      });
      return;
    }
    file.tasks[claim.taskId] = withTaskRevision({
      ...task,
      lastMaterializedOccurrenceKey: occurrenceKey,
      lastRunId: run.id,
      updatedAt: nowIso(),
    });
    writeTasksFile(file, agentDir);
    advanceClaimStage(occurrenceKey, "task_advanced", {
      ownerId,
      epoch,
      fencingToken,
      agentDir,
    });
  }, { agentDir });
}

/**
 * Atomically transfer BOTH claim and run fencing to a new leader authority.
 * Required before barrier on safe_redispatch; must run under store lock.
 */
export async function transferClaimAndRunFencing(input: {
  occurrenceKey: string;
  runId: string;
  ownerId: string;
  epoch: number;
  fencingToken: string;
  agentDir?: string;
  /** Optional run status override after transfer. */
  status?: AutomationRunRecord["status"];
  leaseTtlMs?: number;
}): Promise<{ claim: AutomationClaimRecord; run: AutomationRunRecord }> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    assertLiveSchedulerFencing({
      ownerId: input.ownerId,
      epoch: input.epoch,
      agentDir: input.agentDir,
    });
    const claim = readClaimRecord(input.occurrenceKey, input.agentDir);
    if (!claim) {
      throw new AutomationStoreError("Claim not found", { status: 404, code: "not_found" });
    }
    if (claim.stage === "execution_may_have_started") {
      throw new AutomationStoreError("Cannot transfer fencing after barrier", {
        status: 409,
        code: "revision_conflict",
      });
    }
    const run = readRunRecord(input.runId, input.agentDir);
    if (!run || run.terminal) {
      throw new AutomationStoreError("Run not transferable", {
        status: 409,
        code: "validation",
      });
    }
    const ttl = input.leaseTtlMs ?? 60_000;
    const now = nowIso();
    const nextClaim: AutomationClaimRecord = {
      ...claim,
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      updatedAt: now,
    };
    const nextRun: AutomationRunRecord = {
      ...run,
      status: input.status ?? run.status,
      lease: {
        ownerId: input.ownerId,
        epoch: input.epoch,
        fencingToken: input.fencingToken,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(Date.now() + ttl).toISOString(),
      },
    };
    writeClaimRecord(nextClaim, input.agentDir);
    writeRunRecord(nextRun, input.agentDir);
    return { claim: nextClaim, run: nextRun };
  }, { agentDir: input.agentDir });
}

/**
 * Atomic pre-materialize gate recheck under store.lock.
 * Ensures concurrent manual run-now cannot both pass overlap/concurrency/kill-switch.
 */
export async function materializeOccurrenceWithGateRecheck(input: {
  taskId: string;
  occurrenceKey: string;
  run: AutomationRunRecord;
  nextRunAt: string | null;
  ownerId: string;
  epoch: number;
  fencingToken: string;
  agentDir?: string;
  /** Returns blocked gate or null to proceed. Called under store lock after re-read. */
  recheckGate: (ctx: {
    task: AutomationTaskRecord;
    tasksFile: AutomationTasksFile;
    activeRunsForTask: number;
    /** Authoritative nonterminal run count across ALL tasks, counted under lock. */
    globalActiveRuns: number;
  }) => { blocked: true; reason: string; code: string } | { blocked: false };
  /**
   * Optional hint from the registry; authoritative count is always recomputed
   * under store.lock immediately before claim.
   */
  globalActiveRuns?: number;
}): Promise<
  | { ok: true; claim: AutomationClaimRecord; run: AutomationRunRecord; task: AutomationTaskRecord }
  | { ok: false; reason: string; code: string; task: AutomationTaskRecord | null }
> {
  return withAutomationStoreLock(async (handle) => {
    handle.heartbeat();
    assertLiveSchedulerFencing({
      ownerId: input.ownerId,
      epoch: input.epoch,
      agentDir: input.agentDir,
    });

    const existingClaim = readClaimRecord(input.occurrenceKey, input.agentDir);
    if (existingClaim) {
      const existingRun = readRunRecord(existingClaim.runId, input.agentDir);
      const task = getTaskRecord(input.taskId, input.agentDir);
      if (!task || !existingRun) {
        throw new AutomationStoreError("Existing claim is incomplete", {
          status: 500,
          code: "repair_required",
        });
      }
      return { ok: true as const, claim: existingClaim, run: existingRun, task };
    }

    const file = readTasksFile(input.agentDir);
    const task = file.tasks[input.taskId];
    if (!task) {
      return { ok: false as const, reason: "Task not found", code: "not_found", task: null };
    }

    // Authoritative nonterminal count across ALL tasks, inside store.lock.
    // Concurrent run-now across different tasks with limit 1 must yield one winner.
    const allActive = listRunRecords({ agentDir: input.agentDir }).filter(
      (r) =>
        !r.terminal &&
        (r.status === "running" ||
          r.status === "claimed" ||
          r.status === "queued" ||
          r.status === "cancel_requested"),
    );
    const globalActiveRuns = allActive.length;
    const activeRunsForTask = allActive.filter((r) => r.taskId === input.taskId).length;

    const gate = input.recheckGate({
      task,
      tasksFile: file,
      activeRunsForTask,
      globalActiveRuns,
    });
    if (gate.blocked) {
      return { ok: false as const, reason: gate.reason, code: gate.code, task };
    }

    if (task.lastMaterializedOccurrenceKey === input.occurrenceKey) {
      const run = task.lastRunId ? readRunRecord(task.lastRunId, input.agentDir) : null;
      if (run) {
        const claim = readClaimRecord(input.occurrenceKey, input.agentDir);
        if (claim) return { ok: true as const, claim, run, task };
      }
    }

    const claim: AutomationClaimRecord = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      occurrenceKey: input.occurrenceKey,
      taskId: input.taskId,
      runId: input.run.id,
      stage: "prepared",
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finalized: false,
    };
    writeClaimRecord(claim, input.agentDir);
    writeRunRecord(input.run, input.agentDir);
    advanceClaimStage(input.occurrenceKey, "run_created", {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      agentDir: input.agentDir,
    });

    const nextTask = withTaskRevision({
      ...task,
      lastMaterializedOccurrenceKey: input.occurrenceKey,
      lastRunId: input.run.id,
      nextRunAt: input.nextRunAt,
      updatedAt: nowIso(),
    });
    file.tasks[input.taskId] = nextTask;
    writeTasksFile(file, input.agentDir);

    const claim3 = advanceClaimStage(input.occurrenceKey, "task_advanced", {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      agentDir: input.agentDir,
    });

    return { ok: true as const, claim: claim3, run: input.run, task: nextTask };
  }, { agentDir: input.agentDir });
}

export function removePathBestEffort(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
