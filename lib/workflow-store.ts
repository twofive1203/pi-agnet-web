/**
 * Project-local SnFlow task store under <cwd>/.pi/snflows/tasks/.
 * Archived tasks live in the sibling <cwd>/.pi/snflows/archived/ directory.
 * Strict parsing, allowed-root aware path resolution, atomic writes.
 * Does not read or write .trellis/.
 */

import { createHash, randomBytes } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import { buildWorkflowTaskSeedRequirements } from "./workflow-chat-context";
import { clearWorkflowCurrentTask, setWorkflowCurrentTask, getWorkflowCurrentTaskId } from "./workflow-current";
import {
  WORKFLOW_DOC_NAMES,
  WORKFLOW_SCHEMA_VERSION,
  canArchive,
  canComplete,
  canManuallyTransition,
  canMarkReady,
  canRecordCommit,
  canStartCheck,
  canStartImplement,
  isValidWorkflowRunId,
  isValidWorkflowTaskId,
  isWorkflowPriority,
  isWorkflowRunPhase,
  isWorkflowRunState,
  isWorkflowTaskStatus,
  projectStatusAfterRun,
  type WorkflowAllowedActions,
  type WorkflowCreateTaskInput,
  type WorkflowDocuments,
  type WorkflowPriority,
  type WorkflowRunRecord,
  type WorkflowTaskCommitMeta,
  type WorkflowTaskDetail,
  type WorkflowTaskRecord,
  type WorkflowTaskStatus,
  type WorkflowTaskSummary,
  type WorkflowTasksListResponse,
  type WorkflowUpdateTaskInput,
  WORKFLOW_ACTIVE_RUN_STATES,
} from "./workflow-types";

export const WORKFLOW_ROOT_SEGMENTS = [".pi", "snflows"] as const;
export const WORKFLOW_TASKS_DIR = "tasks";
export const WORKFLOW_ARCHIVED_DIR = "archived";

export const WORKFLOW_MAX_JSON_BYTES = 256 * 1024;
export const WORKFLOW_MAX_DOC_BYTES = 512 * 1024;
export const WORKFLOW_MAX_TITLE_CHARS = 200;
export const WORKFLOW_MAX_DESCRIPTION_CHARS = 4000;

export class WorkflowStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = "WorkflowStoreError";
    this.status = options?.status ?? 400;
    this.code = options?.code ?? "workflow_error";
  }
}

export class WorkflowSecurityError extends WorkflowStoreError {
  constructor(message: string) {
    super(message, { status: 400, code: "security" });
    this.name = "WorkflowSecurityError";
  }
}

export class WorkflowConflictError extends WorkflowStoreError {
  constructor(message: string) {
    super(message, { status: 409, code: "conflict" });
    this.name = "WorkflowConflictError";
  }
}

export class WorkflowNotFoundError extends WorkflowStoreError {
  constructor(message: string) {
    super(message, { status: 404, code: "not_found" });
    this.name = "WorkflowNotFoundError";
  }
}

interface StoreContext {
  cwd: string;
  workspaceRoot: string;
  workflowsRoot: string;
  tasksRoot: string;
  archiveRoot: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathIsInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}

function relativeLabel(root: string, target: string): string {
  const rel = path.relative(root, target) || ".";
  return rel.split(path.sep).join("/");
}

function safeRealPath(target: string, workspaceRoot: string): string {
  const real = realpathSync.native(target);
  if (!pathIsInside(workspaceRoot, real)) {
    throw new WorkflowSecurityError(`Path escapes workspace: ${relativeLabel(workspaceRoot, target)}`);
  }
  return real;
}

function assertPathWithinWorkspace(target: string, workspaceRoot: string, kind: "file" | "dir"): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    const real = safeRealPath(target, workspaceRoot);
    const realStat = statSync(real);
    if (kind === "dir" && !realStat.isDirectory()) {
      throw new WorkflowSecurityError(`Expected directory: ${relativeLabel(workspaceRoot, target)}`);
    }
    if (kind === "file" && !realStat.isFile()) {
      throw new WorkflowSecurityError(`Expected file: ${relativeLabel(workspaceRoot, target)}`);
    }
    return;
  }
  if (kind === "dir" && !stat.isDirectory()) {
    throw new WorkflowSecurityError(`Expected directory: ${relativeLabel(workspaceRoot, target)}`);
  }
  if (kind === "file" && !stat.isFile()) {
    throw new WorkflowSecurityError(`Expected file: ${relativeLabel(workspaceRoot, target)}`);
  }
  safeRealPath(target, workspaceRoot);
}

function nowIso(): string {
  return new Date().toISOString();
}

function computeTaskRevision(record: Omit<WorkflowTaskRecord, "revision">): string {
  return createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex")
    .slice(0, 16);
}

function withRevision(record: Omit<WorkflowTaskRecord, "revision">): WorkflowTaskRecord {
  return { ...record, revision: computeTaskRevision(record) };
}

function slugifyTitle(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "task";
}

function makeTaskId(title: string, explicit?: string): string {
  if (explicit) {
    const id = explicit.trim().toLowerCase();
    if (!isValidWorkflowTaskId(id)) {
      throw new WorkflowStoreError(
        "Task id must be a lowercase slug (letters, digits, hyphens; 1-80 chars)",
        { status: 400, code: "invalid_task_id" },
      );
    }
    return id;
  }
  const stamp = new Date().toISOString().slice(5, 10); // MM-DD
  const slug = slugifyTitle(title);
  const candidate = `${stamp}-${slug}`.slice(0, 80).replace(/-+$/g, "");
  if (isValidWorkflowTaskId(candidate)) return candidate;
  return `task-${randomBytes(4).toString("hex")}`;
}

function makeRunId(phase: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  return `${phase}-${stamp}-${suffix}`.toLowerCase().slice(0, 80);
}

export function createStoreContext(cwd: string): StoreContext {
  if (!cwd || !cwd.trim()) {
    throw new WorkflowStoreError("Missing project cwd", { status: 400, code: "missing_cwd" });
  }
  const workspaceRoot = canonicalizeCwd(cwd);
  if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
    throw new WorkflowStoreError(`Workspace is not a directory: ${cwd}`, {
      status: 400,
      code: "invalid_cwd",
    });
  }
  const workflowsRoot = path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS);
  const tasksRoot = path.join(workflowsRoot, WORKFLOW_TASKS_DIR);
  const archiveRoot = path.join(workflowsRoot, WORKFLOW_ARCHIVED_DIR);
  return { cwd: workspaceRoot, workspaceRoot, workflowsRoot, tasksRoot, archiveRoot };
}

function ensureTasksRoot(ctx: StoreContext): void {
  mkdirSync(ctx.tasksRoot, { recursive: true });
  assertPathWithinWorkspace(ctx.tasksRoot, ctx.workspaceRoot, "dir");
}

function taskDir(ctx: StoreContext, taskId: string, archived = false): string {
  if (!isValidWorkflowTaskId(taskId)) {
    throw new WorkflowStoreError("Invalid task id", { status: 400, code: "invalid_task_id" });
  }
  return path.join(archived ? ctx.archiveRoot : ctx.tasksRoot, taskId);
}

function resolveExistingTaskDir(ctx: StoreContext, taskId: string): { dir: string; archived: boolean } {
  if (!isValidWorkflowTaskId(taskId)) {
    throw new WorkflowStoreError("Invalid task id", { status: 400, code: "invalid_task_id" });
  }
  const active = taskDir(ctx, taskId);
  if (existsSync(active)) {
    assertPathWithinWorkspace(active, ctx.workspaceRoot, "dir");
    return { dir: active, archived: false };
  }
  const archivedDir = taskDir(ctx, taskId, true);
  if (existsSync(archivedDir)) {
    assertPathWithinWorkspace(archivedDir, ctx.workspaceRoot, "dir");
    return { dir: archivedDir, archived: true };
  }
  throw new WorkflowNotFoundError(`Task not found: ${taskId}`);
}

function atomicWriteText(filePath: string, content: string, workspaceRoot: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  assertPathWithinWorkspace(dir, workspaceRoot, "dir");
  if (Buffer.byteLength(content, "utf8") > WORKFLOW_MAX_DOC_BYTES && filePath.endsWith(".md")) {
    throw new WorkflowStoreError(`Document exceeds ${WORKFLOW_MAX_DOC_BYTES} bytes`, {
      status: 413,
      code: "too_large",
    });
  }
  if (Buffer.byteLength(content, "utf8") > WORKFLOW_MAX_JSON_BYTES && filePath.endsWith(".json")) {
    throw new WorkflowStoreError(`JSON exceeds ${WORKFLOW_MAX_JSON_BYTES} bytes`, {
      status: 413,
      code: "too_large",
    });
  }
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, content, "utf8");
    // Ensure tmp stays inside workspace before rename.
    assertPathWithinWorkspace(tmp, workspaceRoot, "file");
    renameSync(tmp, filePath);
    if (existsSync(filePath)) assertPathWithinWorkspace(filePath, workspaceRoot, "file");
  } catch (error) {
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

function atomicWriteJson(filePath: string, value: unknown, workspaceRoot: string): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`, workspaceRoot);
}

function readTextLimited(filePath: string, maxBytes: number): string {
  const stat = statSync(filePath);
  if (stat.size > maxBytes) {
    throw new WorkflowStoreError(`File exceeds ${maxBytes} bytes: ${path.basename(filePath)}`, {
      status: 413,
      code: "too_large",
    });
  }
  return readFileSync(filePath, "utf8");
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new WorkflowStoreError(`Invalid ${field}: expected string or null`, {
    status: 409,
    code: "malformed_task",
  });
}

function parseCommit(value: unknown, fallbackRecordedAt: string): WorkflowTaskCommitMeta | null {
  // Agent hand-writes are messy here (plain string hash, missing recordedAt).
  // Never fail the whole task on commit metadata; salvage what we can or drop it.
  if (typeof value === "string") {
    const hash = value.trim();
    return hash ? { hash, recordedAt: fallbackRecordedAt } : null;
  }
  if (!isRecord(value)) return null;
  const hash = typeof value.hash === "string" ? value.hash.trim() : "";
  if (!hash) return null;
  const recordedAt =
    typeof value.recordedAt === "string" && value.recordedAt.trim()
      ? value.recordedAt
      : fallbackRecordedAt;
  const commit: WorkflowTaskCommitMeta = { hash, recordedAt };
  if (typeof value.note === "string" && value.note.trim()) {
    commit.note = value.note.trim();
  }
  return commit;
}

export function parseTaskRecord(raw: unknown, expectedId?: string): WorkflowTaskRecord {
  if (!isRecord(raw)) {
    throw new WorkflowStoreError("task.json root must be an object", {
      status: 409,
      code: "malformed_task",
    });
  }
  // Accept missing schemaVersion from agent-authored files; only reject unknown future versions.
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowStoreError(`Unsupported task schemaVersion: ${String(raw.schemaVersion)}`, {
      status: 409,
      code: "malformed_task",
    });
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : expectedId;
  if (!isValidWorkflowTaskId(id)) {
    throw new WorkflowStoreError("Invalid task.id", { status: 409, code: "malformed_task" });
  }
  if (expectedId && id !== expectedId) {
    throw new WorkflowStoreError(`task.json id mismatch: expected ${expectedId}`, {
      status: 409,
      code: "malformed_task",
    });
  }
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new WorkflowStoreError("Invalid task.title", { status: 409, code: "malformed_task" });
  }
  // Agent hand-writes often omit description; default empty rather than hide the task.
  const description = typeof raw.description === "string" ? raw.description : "";
  let status: WorkflowTaskStatus = "planning";
  if (raw.status !== undefined) {
    if (!isWorkflowTaskStatus(raw.status)) {
      throw new WorkflowStoreError(`Invalid task.status: ${String(raw.status)}`, {
        status: 409,
        code: "malformed_task",
      });
    }
    status = raw.status;
  }
  let priority: WorkflowPriority = "P2";
  if (raw.priority !== undefined) {
    if (!isWorkflowPriority(raw.priority)) {
      throw new WorkflowStoreError(`Invalid task.priority: ${String(raw.priority)}`, {
        status: 409,
        code: "malformed_task",
      });
    }
    priority = raw.priority;
  }
  const now = nowIso();
  const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : createdAt;
  const archived = typeof raw.archived === "boolean" ? raw.archived : false;

  const activeRunIdRaw =
    raw.activeRunId === undefined ? null : parseNullableString(raw.activeRunId, "activeRunId");
  // Terminal tasks cannot hold the workspace run lock; agent hand-writes often leave one behind.
  const activeRunId =
    archived || status === "completed" || status === "cancelled" ? null : activeRunIdRaw;
  const latestImplementRunId =
    raw.latestImplementRunId === undefined
      ? null
      : parseNullableString(raw.latestImplementRunId, "latestImplementRunId");
  const latestCheckRunId =
    raw.latestCheckRunId === undefined
      ? null
      : parseNullableString(raw.latestCheckRunId, "latestCheckRunId");
  if (activeRunId && !isValidWorkflowRunId(activeRunId)) {
    throw new WorkflowStoreError("Invalid activeRunId", { status: 409, code: "malformed_task" });
  }
  if (latestImplementRunId && !isValidWorkflowRunId(latestImplementRunId)) {
    throw new WorkflowStoreError("Invalid latestImplementRunId", { status: 409, code: "malformed_task" });
  }
  if (latestCheckRunId && !isValidWorkflowRunId(latestCheckRunId)) {
    throw new WorkflowStoreError("Invalid latestCheckRunId", { status: 409, code: "malformed_task" });
  }

  const withoutRevision = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    title: raw.title.trim(),
    description,
    status,
    priority,
    createdAt,
    updatedAt,
    completedAt: raw.completedAt === undefined ? null : parseNullableString(raw.completedAt, "completedAt"),
    activeRunId,
    latestImplementRunId,
    latestCheckRunId,
    commit: parseCommit(raw.commit, updatedAt),
    archived,
  };
  // Revision is derived content-hash. Agent hand-writes often invent a wrong hash;
  // accept the record and use the computed revision so the task still appears in UI.
  const expectedRevision = computeTaskRevision(withoutRevision);
  return { ...withoutRevision, revision: expectedRevision };
}

export function parseRunRecord(raw: unknown, expectedId?: string): WorkflowRunRecord {
  if (!isRecord(raw)) {
    throw new WorkflowStoreError("run.json root must be an object", {
      status: 409,
      code: "malformed_run",
    });
  }
  if (raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowStoreError(`Unsupported run schemaVersion: ${String(raw.schemaVersion)}`, {
      status: 409,
      code: "malformed_run",
    });
  }
  if (!isValidWorkflowRunId(raw.id)) {
    throw new WorkflowStoreError("Invalid run.id", { status: 409, code: "malformed_run" });
  }
  if (expectedId && raw.id !== expectedId) {
    throw new WorkflowStoreError(`run id mismatch: expected ${expectedId}`, {
      status: 409,
      code: "malformed_run",
    });
  }
  if (!isValidWorkflowTaskId(raw.taskId)) {
    throw new WorkflowStoreError("Invalid run.taskId", { status: 409, code: "malformed_run" });
  }
  if (!isWorkflowRunPhase(raw.phase)) {
    throw new WorkflowStoreError("Invalid run.phase", { status: 409, code: "malformed_run" });
  }
  if (!isWorkflowRunState(raw.state)) {
    throw new WorkflowStoreError("Invalid run.state", { status: 409, code: "malformed_run" });
  }
  if (typeof raw.agentName !== "string" || !raw.agentName.trim()) {
    throw new WorkflowStoreError("Invalid run.agentName", { status: 409, code: "malformed_run" });
  }
  for (const field of ["requestedCwd", "effectiveCwd", "hostSessionId", "taskRevision", "createdAt"] as const) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) {
      throw new WorkflowStoreError(`Invalid run.${field}`, { status: 409, code: "malformed_run" });
    }
  }

  const nullableString = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    throw new WorkflowStoreError("Invalid nullable string field in run record", {
      status: 409,
      code: "malformed_run",
    });
  };

  let error: WorkflowRunRecord["error"] = null;
  if (raw.error !== null && raw.error !== undefined) {
    if (!isRecord(raw.error) || typeof raw.error.code !== "string" || typeof raw.error.message !== "string") {
      throw new WorkflowStoreError("Invalid run.error", { status: 409, code: "malformed_run" });
    }
    error = { code: raw.error.code, message: raw.error.message };
  }

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: raw.id,
    taskId: raw.taskId,
    phase: raw.phase,
    agentName: raw.agentName.trim(),
    state: raw.state,
    requestedCwd: raw.requestedCwd as string,
    effectiveCwd: raw.effectiveCwd as string,
    hostSessionId: raw.hostSessionId as string,
    taskRevision: raw.taskRevision as string,
    parentSessionId:
      typeof raw.parentSessionId === "string" && raw.parentSessionId.trim()
        ? raw.parentSessionId
        : undefined,
    parentToolCallId:
      typeof raw.parentToolCallId === "string" && raw.parentToolCallId.trim()
        ? raw.parentToolCallId
        : undefined,
    nativeRunId: nullableString(raw.nativeRunId),
    asyncDir: nullableString(raw.asyncDir),
    sessionFile: nullableString(raw.sessionFile),
    outputFile: nullableString(raw.outputFile),
    model: nullableString(raw.model),
    thinking: nullableString(raw.thinking),
    summary: nullableString(raw.summary),
    createdAt: raw.createdAt as string,
    startedAt: nullableString(raw.startedAt),
    endedAt: nullableString(raw.endedAt),
    lastReconciledAt: nullableString(raw.lastReconciledAt),
    error,
    implementResult: isRecord(raw.implementResult)
      ? (raw.implementResult as unknown as WorkflowRunRecord["implementResult"])
      : null,
    checkResult: isRecord(raw.checkResult)
      ? (raw.checkResult as unknown as WorkflowRunRecord["checkResult"])
      : null,
    tokenUsage: isRecord(raw.tokenUsage) ? (raw.tokenUsage as WorkflowRunRecord["tokenUsage"]) : undefined,
    toolCount: typeof raw.toolCount === "number" ? raw.toolCount : undefined,
    turnCount: typeof raw.turnCount === "number" ? raw.turnCount : undefined,
  };
}

function defaultDocuments(title: string): WorkflowDocuments {
  return {
    requirements: `# Requirements\n\n## Goal\n\n${title}\n\n## Requirements\n\n- \n\n## Acceptance Criteria\n\n- \n\n## Out Of Scope\n\n- \n`,
    design: `# Design\n\n## Summary\n\n\n\n## Decisions\n\n- \n`,
    plan: `# Plan\n\n## Implementation Order\n\n1. \n\n## Validation\n\n- \n`,
  };
}

function readDocuments(dir: string, workspaceRoot: string): WorkflowDocuments & { has: WorkflowTaskSummary["hasDocuments"] } {
  const docs: WorkflowDocuments = { requirements: "", design: "", plan: "" };
  const has = { requirements: false, design: false, plan: false };
  const map: Array<{ key: keyof WorkflowDocuments; file: (typeof WORKFLOW_DOC_NAMES)[number] }> = [
    { key: "requirements", file: "requirements.md" },
    { key: "design", file: "design.md" },
    { key: "plan", file: "plan.md" },
  ];
  for (const { key, file } of map) {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) continue;
    assertPathWithinWorkspace(filePath, workspaceRoot, "file");
    docs[key] = readTextLimited(filePath, WORKFLOW_MAX_DOC_BYTES);
    has[key] = true;
  }
  return { ...docs, has };
}

function listRunRecords(dir: string, workspaceRoot: string): WorkflowRunRecord[] {
  const runsDir = path.join(dir, "runs");
  if (!existsSync(runsDir)) return [];
  assertPathWithinWorkspace(runsDir, workspaceRoot, "dir");
  const runs: WorkflowRunRecord[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith(".json")) continue;
    const runId = name.slice(0, -".json".length);
    const filePath = path.join(runsDir, name);
    try {
      assertPathWithinWorkspace(filePath, workspaceRoot, "file");
      const raw = JSON.parse(readTextLimited(filePath, WORKFLOW_MAX_JSON_BYTES)) as unknown;
      runs.push(parseRunRecord(raw, runId));
    } catch {
      // Skip malformed runs in list; detail path can surface errors.
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs;
}

function computeAllowedActions(task: WorkflowTaskRecord): WorkflowAllowedActions {
  const reasons: WorkflowAllowedActions["reasons"] = {};
  const active = Boolean(task.activeRunId);
  const archived = task.archived;

  const save = !archived;
  if (!save) reasons.save = "Archived tasks are read-only";

  const markReady = !archived && !active && canMarkReady(task.status);
  if (!markReady) {
    reasons.markReady = archived
      ? "Archived"
      : active
        ? "A run is active"
        : `Status ${task.status} cannot be marked ready`;
  }

  const runImplement = !archived && !active && canStartImplement(task.status);
  if (!runImplement) {
    reasons.runImplement = archived
      ? "Archived"
      : active
        ? "A run is active"
        : `Status ${task.status} cannot start implement`;
  }

  const runCheck = !archived && !active && canStartCheck(task.status);
  if (!runCheck) {
    reasons.runCheck = archived
      ? "Archived"
      : active
        ? "A run is active"
        : `Status ${task.status} cannot start check`;
  }

  const cancelRun = !archived && active;
  if (!cancelRun) reasons.cancelRun = active ? "Archived" : "No active run";

  const recordCommit = !archived && !active && canRecordCommit(task.status);
  if (!recordCommit) {
    reasons.recordCommit = archived
      ? "Archived"
      : active
        ? "A run is active"
        : `Status ${task.status} cannot record commit`;
  }

  const complete = !archived && !active && canComplete(task.status);
  if (!complete) {
    reasons.complete = archived
      ? "Archived"
      : active
        ? "A run is active"
        : `Status ${task.status} cannot complete`;
  }

  const archive = canArchive(task.status, task.archived) && !active;
  if (!archive) {
    reasons.archive = active
      ? "A run is active"
      : task.archived
        ? "Already archived"
        : `Status ${task.status} cannot archive`;
  }

  return {
    save,
    markReady,
    runImplement,
    runCheck,
    cancelRun,
    recordCommit,
    complete,
    archive,
    reasons,
  };
}

function toSummary(
  task: WorkflowTaskRecord,
  pathLabel: string,
  hasDocuments: WorkflowTaskSummary["hasDocuments"],
  readError?: string,
): WorkflowTaskSummary {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    revision: task.revision,
    activeRunId: task.activeRunId,
    latestImplementRunId: task.latestImplementRunId,
    latestCheckRunId: task.latestCheckRunId,
    commit: task.commit,
    archived: task.archived,
    pathLabel,
    hasDocuments,
    ...(readError ? { readError } : {}),
  };
}

function readTaskJson(dir: string, taskId: string, workspaceRoot: string): WorkflowTaskRecord {
  const taskJsonPath = path.join(dir, "task.json");
  if (!existsSync(taskJsonPath)) {
    throw new WorkflowNotFoundError(`task.json missing for ${taskId}`);
  }
  assertPathWithinWorkspace(taskJsonPath, workspaceRoot, "file");
  const rawText = readTextLimited(taskJsonPath, WORKFLOW_MAX_JSON_BYTES);
  const raw = JSON.parse(rawText) as unknown;
  const parsed = parseTaskRecord(raw, taskId);
  // Self-heal agent-authored / drifted revision and missing defaults so later
  // optimistic updates don't 409 on a hash the author never computed correctly.
  try {
    const rawObj = isRecord(raw) ? raw : null;
    const needsHeal =
      !rawObj ||
      rawObj.revision !== parsed.revision ||
      rawObj.schemaVersion !== WORKFLOW_SCHEMA_VERSION ||
      typeof rawObj.description !== "string" ||
      typeof rawObj.archived !== "boolean";
    if (needsHeal) {
      atomicWriteJson(taskJsonPath, parsed, workspaceRoot);
    }
  } catch {
    // Read path must still succeed even if heal write fails (permissions, etc.).
  }
  return parsed;
}

function writeTaskBundle(
  ctx: StoreContext,
  dir: string,
  task: WorkflowTaskRecord,
  documents?: Partial<WorkflowDocuments>,
): void {
  mkdirSync(dir, { recursive: true });
  assertPathWithinWorkspace(dir, ctx.workspaceRoot, "dir");
  atomicWriteJson(path.join(dir, "task.json"), task, ctx.workspaceRoot);
  if (documents) {
    if (documents.requirements !== undefined) {
      atomicWriteText(path.join(dir, "requirements.md"), documents.requirements, ctx.workspaceRoot);
    }
    if (documents.design !== undefined) {
      atomicWriteText(path.join(dir, "design.md"), documents.design, ctx.workspaceRoot);
    }
    if (documents.plan !== undefined) {
      atomicWriteText(path.join(dir, "plan.md"), documents.plan, ctx.workspaceRoot);
    }
  }
}

function findActiveCwdRunId(ctx: StoreContext): string | null {
  if (!existsSync(ctx.tasksRoot)) return null;
  for (const name of readdirSync(ctx.tasksRoot)) {
    if (!isValidWorkflowTaskId(name)) continue;
    const dir = path.join(ctx.tasksRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const task = readTaskJson(dir, name, ctx.workspaceRoot);
      if (task.activeRunId) return task.activeRunId;
    } catch {
      // ignore malformed while scanning lock
    }
  }
  return null;
}

export function listWorkflowTasks(cwd: string, includeArchived = false): WorkflowTasksListResponse {
  const ctx = createStoreContext(cwd);
  const pathLabel = relativeLabel(ctx.workspaceRoot, ctx.tasksRoot);
  if (!existsSync(ctx.tasksRoot)) {
    return {
      cwd: ctx.workspaceRoot,
      exists: false,
      pathLabel,
      tasks: [],
      statusCounts: {},
      archivedCount: 0,
      activeCwdRunId: null,
      currentTaskId: getWorkflowCurrentTaskId(ctx.workspaceRoot),
      errors: [],
    };
  }
  assertPathWithinWorkspace(ctx.tasksRoot, ctx.workspaceRoot, "dir");

  const tasks: WorkflowTaskSummary[] = [];
  const errors: WorkflowTasksListResponse["errors"] = [];
  let archivedCount = 0;
  const statusCounts: Record<string, number> = {};

  const scanDir = (dir: string, archived: boolean) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      errors.push({ pathLabel: relativeLabel(ctx.workspaceRoot, dir), message: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const name of entries) {
      const taskPath = path.join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(taskPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (!isValidWorkflowTaskId(name)) {
        errors.push({
          id: name,
          pathLabel: relativeLabel(ctx.workspaceRoot, taskPath),
          message:
            "Skipped: directory name is not a valid task id (use lowercase letters, digits, hyphens; e.g. 03-28-fix-auth).",
        });
        continue;
      }
      try {
        assertPathWithinWorkspace(taskPath, ctx.workspaceRoot, "dir");
        const task = readTaskJson(taskPath, name, ctx.workspaceRoot);
        const docs = readDocuments(taskPath, ctx.workspaceRoot);
        const summary = toSummary(task, relativeLabel(ctx.workspaceRoot, taskPath), docs.has);
        if (archived || task.archived) {
          archivedCount += 1;
          if (!includeArchived) continue;
        }
        statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
        tasks.push(summary);
      } catch (error) {
        errors.push({
          id: name,
          pathLabel: relativeLabel(ctx.workspaceRoot, taskPath),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  scanDir(ctx.tasksRoot, false);
  if (includeArchived && existsSync(ctx.archiveRoot)) {
    assertPathWithinWorkspace(ctx.archiveRoot, ctx.workspaceRoot, "dir");
    scanDir(ctx.archiveRoot, true);
  }

  tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    cwd: ctx.workspaceRoot,
    exists: true,
    pathLabel,
    tasks,
    statusCounts,
    archivedCount,
    activeCwdRunId: findActiveCwdRunId(ctx),
    currentTaskId: getWorkflowCurrentTaskId(ctx.workspaceRoot),
    errors,
  };
}

export function getWorkflowTaskDetail(cwd: string, taskId: string): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  const task = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  const docs = readDocuments(located.dir, ctx.workspaceRoot);
  const runs = listRunRecords(located.dir, ctx.workspaceRoot);
  const summary = toSummary(task, relativeLabel(ctx.workspaceRoot, located.dir), docs.has);
  return {
    ...summary,
    documents: {
      requirements: docs.requirements,
      design: docs.design,
      plan: docs.plan,
    },
    runs,
    allowedActions: computeAllowedActions(task),
  };
}

/**
 * True only when `taskId` exists under a real (non-linked) `tasks/<id>`
 * directory with parseable metadata and `archived === false`.
 * Never falls through to archived/; used for current-pointer restoration.
 */
export function hasActiveNonArchivedWorkflowTask(cwd: string, taskId: string): boolean {
  if (!isValidWorkflowTaskId(taskId)) return false;
  try {
    const ctx = createStoreContext(cwd);
    const active = taskDir(ctx, taskId, false);
    const stat = lstatSync(active);
    // Reject symlink/junction task dirs; require a physical tasks/<id> tree.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    assertPathWithinWorkspace(active, ctx.workspaceRoot, "dir");
    const task = readTaskJson(active, taskId, ctx.workspaceRoot);
    return task.archived === false;
  } catch {
    return false;
  }
}

export function createWorkflowTask(cwd: string, input: WorkflowCreateTaskInput): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const title = input.title?.trim() ?? "";
  if (!title) {
    throw new WorkflowStoreError("Title is required", { status: 400, code: "invalid_title" });
  }
  if (title.length > WORKFLOW_MAX_TITLE_CHARS) {
    throw new WorkflowStoreError(`Title exceeds ${WORKFLOW_MAX_TITLE_CHARS} characters`, {
      status: 400,
      code: "invalid_title",
    });
  }
  const description = (input.description ?? "").trim();
  if (description.length > WORKFLOW_MAX_DESCRIPTION_CHARS) {
    throw new WorkflowStoreError(`Description exceeds ${WORKFLOW_MAX_DESCRIPTION_CHARS} characters`, {
      status: 400,
      code: "invalid_description",
    });
  }
  const priority = input.priority ?? "P2";
  if (!isWorkflowPriority(priority)) {
    throw new WorkflowStoreError("Invalid priority", { status: 400, code: "invalid_priority" });
  }

  ensureTasksRoot(ctx);
  let id = makeTaskId(title, input.id);
  // Avoid collisions by appending short suffix.
  if (existsSync(taskDir(ctx, id))) {
    const suffix = randomBytes(2).toString("hex");
    const base = id.slice(0, 80 - suffix.length - 1);
    id = `${base}-${suffix}`;
    if (!isValidWorkflowTaskId(id) || existsSync(taskDir(ctx, id))) {
      throw new WorkflowConflictError(`Task id already exists: ${input.id ?? id}`);
    }
  }

  const timestamp = nowIso();
  const documents = defaultDocuments(title);
  if (typeof input.seedText === "string" && input.seedText.trim() && typeof input.requirements !== "string") {
    documents.requirements = buildWorkflowTaskSeedRequirements({
      title,
      userGoal: input.seedText,
      extraNotes: description || undefined,
    });
  }
  if (typeof input.requirements === "string") documents.requirements = input.requirements;
  if (typeof input.design === "string") documents.design = input.design;
  if (typeof input.plan === "string") documents.plan = input.plan;

  const task = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    title,
    description,
    status: "planning",
    priority,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    activeRunId: null,
    latestImplementRunId: null,
    latestCheckRunId: null,
    commit: null,
    archived: false,
  });

  const dir = taskDir(ctx, id);
  writeTaskBundle(ctx, dir, task, documents);
  mkdirSync(path.join(dir, "runs"), { recursive: true });
  // Creating a task auto-targets it as the cwd current task.
  setWorkflowCurrentTask(ctx.workspaceRoot, id, {
    source: input.sessionId ? "session" : "create",
    sessionId: input.sessionId,
  });

  if (input.markReady) {
    const detail = getWorkflowTaskDetail(ctx.workspaceRoot, id);
    return markWorkflowTaskReady(ctx.workspaceRoot, id, detail.revision);
  }
  return getWorkflowTaskDetail(ctx.workspaceRoot, id);
}

export function updateWorkflowTask(cwd: string, taskId: string, input: WorkflowUpdateTaskInput): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  if (current.revision !== input.expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${input.expectedRevision} but current is ${current.revision}`,
    );
  }
  if (current.activeRunId) {
    // Allow document/metadata edits only when not changing status while a run is active?
    // Design: optimistic revisions for authoring. Block status transitions while active.
    if (input.status !== undefined && input.status !== current.status) {
      throw new WorkflowConflictError("Cannot change status while a run is active");
    }
  }

  let title = current.title;
  let description = current.description;
  let priority = current.priority;
  let status = current.status;

  if (input.title !== undefined) {
    title = input.title.trim();
    if (!title) throw new WorkflowStoreError("Title is required", { status: 400, code: "invalid_title" });
    if (title.length > WORKFLOW_MAX_TITLE_CHARS) {
      throw new WorkflowStoreError(`Title exceeds ${WORKFLOW_MAX_TITLE_CHARS} characters`, {
        status: 400,
        code: "invalid_title",
      });
    }
  }
  if (input.description !== undefined) {
    description = input.description;
    if (description.length > WORKFLOW_MAX_DESCRIPTION_CHARS) {
      throw new WorkflowStoreError(`Description exceeds ${WORKFLOW_MAX_DESCRIPTION_CHARS} characters`, {
        status: 400,
        code: "invalid_description",
      });
    }
  }
  if (input.priority !== undefined) {
    if (!isWorkflowPriority(input.priority)) {
      throw new WorkflowStoreError("Invalid priority", { status: 400, code: "invalid_priority" });
    }
    priority = input.priority;
  }
  if (input.status !== undefined && input.status !== current.status) {
    if (!isWorkflowTaskStatus(input.status)) {
      throw new WorkflowStoreError("Invalid status", { status: 400, code: "invalid_status" });
    }
    if (!canManuallyTransition(current.status, input.status)) {
      throw new WorkflowStoreError(
        `Cannot transition from ${current.status} to ${input.status}`,
        { status: 409, code: "invalid_transition" },
      );
    }
    status = input.status;
  }

  const documents: Partial<WorkflowDocuments> = {};
  if (input.requirements !== undefined) documents.requirements = input.requirements;
  if (input.design !== undefined) documents.design = input.design;
  if (input.plan !== undefined) documents.plan = input.plan;

  const next = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: current.id,
    title,
    description,
    status,
    priority,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    completedAt: status === "completed" ? current.completedAt ?? nowIso() : status === "cancelled" ? current.completedAt : null,
    activeRunId: current.activeRunId,
    latestImplementRunId: current.latestImplementRunId,
    latestCheckRunId: current.latestCheckRunId,
    commit: current.commit,
    archived: current.archived,
  });

  writeTaskBundle(ctx, located.dir, next, documents);
  return getWorkflowTaskDetail(ctx.workspaceRoot, taskId);
}

export function markWorkflowTaskReady(cwd: string, taskId: string, expectedRevision: string): WorkflowTaskDetail {
  return updateWorkflowTask(cwd, taskId, { expectedRevision, status: "ready" });
}

export function writeWorkflowRunRecord(cwd: string, taskId: string, run: WorkflowRunRecord): WorkflowRunRecord {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  if (!isValidWorkflowRunId(run.id)) {
    throw new WorkflowStoreError("Invalid run id", { status: 400, code: "invalid_run_id" });
  }
  if (run.taskId !== taskId) {
    throw new WorkflowStoreError("run.taskId mismatch", { status: 400, code: "invalid_run" });
  }
  const parsed = parseRunRecord(run, run.id);
  const runsDir = path.join(located.dir, "runs");
  mkdirSync(runsDir, { recursive: true });
  atomicWriteJson(path.join(runsDir, `${parsed.id}.json`), parsed, ctx.workspaceRoot);
  return parsed;
}

export function readWorkflowRunRecord(cwd: string, taskId: string, runId: string): WorkflowRunRecord {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (!isValidWorkflowRunId(runId)) {
    throw new WorkflowStoreError("Invalid run id", { status: 400, code: "invalid_run_id" });
  }
  const filePath = path.join(located.dir, "runs", `${runId}.json`);
  if (!existsSync(filePath)) {
    throw new WorkflowNotFoundError(`Run not found: ${runId}`);
  }
  assertPathWithinWorkspace(filePath, ctx.workspaceRoot, "file");
  const raw = JSON.parse(readTextLimited(filePath, WORKFLOW_MAX_JSON_BYTES)) as unknown;
  return parseRunRecord(raw, runId);
}

export function findWorkflowRunById(
  cwd: string,
  runId: string,
): { taskId: string; run: WorkflowRunRecord } {
  const ctx = createStoreContext(cwd);
  if (!isValidWorkflowRunId(runId)) {
    throw new WorkflowStoreError("Invalid run id", { status: 400, code: "invalid_run_id" });
  }
  if (!existsSync(ctx.tasksRoot)) {
    throw new WorkflowNotFoundError(`Run not found: ${runId}`);
  }

  const searchTaskDir = (dir: string, taskId: string): { taskId: string; run: WorkflowRunRecord } | null => {
    const filePath = path.join(dir, "runs", `${runId}.json`);
    if (!existsSync(filePath)) return null;
    assertPathWithinWorkspace(filePath, ctx.workspaceRoot, "file");
    const raw = JSON.parse(readTextLimited(filePath, WORKFLOW_MAX_JSON_BYTES)) as unknown;
    return { taskId, run: parseRunRecord(raw, runId) };
  };

  for (const name of readdirSync(ctx.tasksRoot)) {
    if (!isValidWorkflowTaskId(name)) continue;
    const dir = path.join(ctx.tasksRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const hit = searchTaskDir(dir, name);
      if (hit) return hit;
    } catch {
      // continue
    }
  }

  if (existsSync(ctx.archiveRoot)) {
    for (const name of readdirSync(ctx.archiveRoot)) {
      if (!isValidWorkflowTaskId(name)) continue;
      const dir = path.join(ctx.archiveRoot, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const hit = searchTaskDir(dir, name);
        if (hit) return hit;
      } catch {
        // continue
      }
    }
  }

  throw new WorkflowNotFoundError(`Run not found: ${runId}`);
}

export interface BeginWorkflowRunInput {
  phase: "implement" | "check";
  expectedRevision: string;
  agentName: string;
  hostSessionId: string;
  requestedCwd: string;
  effectiveCwd: string;
  runId?: string;
  parentSessionId?: string;
  parentToolCallId?: string;
}

export function beginWorkflowRun(cwd: string, taskId: string, input: BeginWorkflowRunInput): {
  task: WorkflowTaskDetail;
  run: WorkflowRunRecord;
} {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  if (current.revision !== input.expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${input.expectedRevision} but current is ${current.revision}`,
    );
  }
  if (current.activeRunId) {
    throw new WorkflowConflictError(`Task already has active run ${current.activeRunId}`);
  }
  const cwdActive = findActiveCwdRunId(ctx);
  if (cwdActive) {
    throw new WorkflowConflictError(`Workspace already has active workflow run ${cwdActive}`);
  }
  if (input.phase === "implement" && !canStartImplement(current.status)) {
    throw new WorkflowStoreError(`Cannot start implement from status ${current.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }
  if (input.phase === "check" && !canStartCheck(current.status)) {
    throw new WorkflowStoreError(`Cannot start check from status ${current.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }

  // Require documents for dispatch.
  const docs = readDocuments(located.dir, ctx.workspaceRoot);
  if (!docs.has.requirements || !docs.has.design || !docs.has.plan) {
    throw new WorkflowStoreError("Task is missing requirements.md, design.md, or plan.md", {
      status: 409,
      code: "missing_documents",
    });
  }

  const runId = input.runId ?? makeRunId(input.phase);
  if (!isValidWorkflowRunId(runId)) {
    throw new WorkflowStoreError("Invalid run id", { status: 400, code: "invalid_run_id" });
  }
  const timestamp = nowIso();
  const run: WorkflowRunRecord = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: runId,
    taskId,
    phase: input.phase,
    agentName: input.agentName,
    state: "starting",
    requestedCwd: input.requestedCwd,
    effectiveCwd: input.effectiveCwd,
    hostSessionId: input.hostSessionId,
    taskRevision: current.revision,
    parentSessionId: input.parentSessionId,
    parentToolCallId: input.parentToolCallId,
    nativeRunId: null,
    asyncDir: null,
    sessionFile: null,
    outputFile: null,
    model: null,
    thinking: null,
    summary: null,
    createdAt: timestamp,
    startedAt: null,
    endedAt: null,
    lastReconciledAt: null,
    error: null,
    implementResult: null,
    checkResult: null,
  };

  writeWorkflowRunRecord(ctx.workspaceRoot, taskId, run);

  const nextStatus: WorkflowTaskStatus = input.phase === "implement" ? "implementing" : "checking";
  const next = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: current.id,
    title: current.title,
    description: current.description,
    status: nextStatus,
    priority: current.priority,
    createdAt: current.createdAt,
    updatedAt: timestamp,
    completedAt: null,
    activeRunId: runId,
    latestImplementRunId: input.phase === "implement" ? runId : current.latestImplementRunId,
    latestCheckRunId: input.phase === "check" ? runId : current.latestCheckRunId,
    commit: current.commit,
    archived: false,
  });
  writeTaskBundle(ctx, located.dir, next);
  return {
    task: getWorkflowTaskDetail(ctx.workspaceRoot, taskId),
    run,
  };
}

export function updateWorkflowTaskProjection(
  cwd: string,
  taskId: string,
  mutator: (task: WorkflowTaskRecord) => Omit<WorkflowTaskRecord, "revision">,
): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  const nextBase = mutator(current);
  const next = withRevision({ ...nextBase, updatedAt: nowIso() });
  writeTaskBundle(ctx, located.dir, next);
  return getWorkflowTaskDetail(ctx.workspaceRoot, taskId);
}

/** Repair the task-side projection after a terminal run record was persisted. */
export function repairWorkflowTerminalProjection(
  cwd: string,
  taskId: string,
  run: WorkflowRunRecord,
): WorkflowTaskDetail {
  const current = getWorkflowTaskDetail(cwd, taskId);
  const currentLatestRunId = run.phase === "implement"
    ? current.latestImplementRunId
    : current.latestCheckRunId;
  const ownsProjection = current.activeRunId === run.id ||
    (current.activeRunId === null && currentLatestRunId === run.id);
  const projected = projectStatusAfterRun(run.phase, run.state, run.checkResult?.verdict ?? null);
  if (!ownsProjection || (
    current.activeRunId === null &&
    currentLatestRunId === run.id &&
    (!projected || current.status === projected)
  )) {
    return current;
  }

  return updateWorkflowTaskProjection(cwd, taskId, (task) => {
    const latestRunId = run.phase === "implement" ? task.latestImplementRunId : task.latestCheckRunId;
    if (task.activeRunId !== run.id && (task.activeRunId !== null || latestRunId !== run.id)) {
      return task;
    }
    return {
      ...task,
      status: projected ?? task.status,
      activeRunId: null,
      latestImplementRunId:
        run.phase === "implement" ? run.id : task.latestImplementRunId,
      latestCheckRunId:
        run.phase === "check" ? run.id : task.latestCheckRunId,
    };
  });
}

export function completeWorkflowTask(
  cwd: string,
  taskId: string,
  input: { expectedRevision: string; commitHash?: string; note?: string },
): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  if (current.revision !== input.expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${input.expectedRevision} but current is ${current.revision}`,
    );
  }
  if (current.activeRunId) {
    throw new WorkflowConflictError("Cannot complete while a run is active");
  }
  if (!canComplete(current.status) && !(current.status === "ready_to_commit")) {
    throw new WorkflowStoreError(`Cannot complete from status ${current.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }

  let commit = current.commit;
  if (input.commitHash?.trim()) {
    commit = {
      hash: input.commitHash.trim(),
      recordedAt: nowIso(),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    };
  }

  const next = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: current.id,
    title: current.title,
    description: current.description,
    status: "completed",
    priority: current.priority,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    completedAt: nowIso(),
    activeRunId: null,
    latestImplementRunId: current.latestImplementRunId,
    latestCheckRunId: current.latestCheckRunId,
    commit,
    archived: false,
  });
  writeTaskBundle(ctx, located.dir, next);
  return getWorkflowTaskDetail(ctx.workspaceRoot, taskId);
}

export function recordWorkflowCommit(
  cwd: string,
  taskId: string,
  input: { expectedRevision: string; commitHash: string; note?: string },
): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  if (current.revision !== input.expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${input.expectedRevision} but current is ${current.revision}`,
    );
  }
  if (!canRecordCommit(current.status)) {
    throw new WorkflowStoreError(`Cannot record commit from status ${current.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }
  const hash = input.commitHash.trim();
  if (!hash) {
    throw new WorkflowStoreError("commitHash is required", { status: 400, code: "invalid_commit" });
  }
  const next = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: current.id,
    title: current.title,
    description: current.description,
    status: current.status,
    priority: current.priority,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    completedAt: current.completedAt,
    activeRunId: current.activeRunId,
    latestImplementRunId: current.latestImplementRunId,
    latestCheckRunId: current.latestCheckRunId,
    commit: {
      hash,
      recordedAt: nowIso(),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    archived: false,
  });
  writeTaskBundle(ctx, located.dir, next);
  return getWorkflowTaskDetail(ctx.workspaceRoot, taskId);
}

export function archiveWorkflowTask(
  cwd: string,
  taskId: string,
  expectedRevision: string,
): WorkflowTaskDetail {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  if (located.archived) {
    throw new WorkflowStoreError("Task is already archived", { status: 409, code: "archived" });
  }
  const current = readTaskJson(located.dir, taskId, ctx.workspaceRoot);
  if (current.revision !== expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${expectedRevision} but current is ${current.revision}`,
    );
  }
  if (current.activeRunId) {
    throw new WorkflowConflictError("Cannot archive while a run is active");
  }
  if (!canArchive(current.status, current.archived)) {
    throw new WorkflowStoreError(`Cannot archive from status ${current.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }

  const destDir = taskDir(ctx, taskId, true);
  if (existsSync(destDir)) {
    throw new WorkflowConflictError(`Archive destination already exists for ${taskId}`);
  }
  mkdirSync(path.dirname(destDir), { recursive: true });
  assertPathWithinWorkspace(path.dirname(destDir), ctx.workspaceRoot, "dir");

  const next = withRevision({
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: current.id,
    title: current.title,
    description: current.description,
    status: current.status,
    priority: current.priority,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
    completedAt: current.completedAt,
    activeRunId: null,
    latestImplementRunId: current.latestImplementRunId,
    latestCheckRunId: current.latestCheckRunId,
    commit: current.commit,
    archived: true,
  });
  // Write archived flag first in place, then move the directory.
  writeTaskBundle(ctx, located.dir, next);
  renameSync(located.dir, destDir);
  assertPathWithinWorkspace(destDir, ctx.workspaceRoot, "dir");
  // Archiving the current task releases the cwd pointer.
  if (getWorkflowCurrentTaskId(ctx.workspaceRoot) === taskId) {
    clearWorkflowCurrentTask(ctx.workspaceRoot);
  }
  return getWorkflowTaskDetail(ctx.workspaceRoot, taskId);
}

export function getWorkflowTaskDocumentsPaths(cwd: string, taskId: string): {
  taskDir: string;
  requirements: string;
  design: string;
  plan: string;
  pathLabels: { requirements: string; design: string; plan: string; taskJson: string };
} {
  const ctx = createStoreContext(cwd);
  const located = resolveExistingTaskDir(ctx, taskId);
  return {
    taskDir: located.dir,
    requirements: path.join(located.dir, "requirements.md"),
    design: path.join(located.dir, "design.md"),
    plan: path.join(located.dir, "plan.md"),
    pathLabels: {
      requirements: relativeLabel(ctx.workspaceRoot, path.join(located.dir, "requirements.md")),
      design: relativeLabel(ctx.workspaceRoot, path.join(located.dir, "design.md")),
      plan: relativeLabel(ctx.workspaceRoot, path.join(located.dir, "plan.md")),
      taskJson: relativeLabel(ctx.workspaceRoot, path.join(located.dir, "task.json")),
    },
  };
}

export function hasActiveWorkflowRunInCwd(cwd: string): string | null {
  const ctx = createStoreContext(cwd);
  return findActiveCwdRunId(ctx);
}

export function isActiveRunState(state: string): boolean {
  return WORKFLOW_ACTIVE_RUN_STATES.has(state as never);
}
