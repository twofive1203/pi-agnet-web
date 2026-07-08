import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import { YOLK_ARTIFACTS } from "./yolk-workflow-templates";
import { getYolkWorkflowStatus } from "./yolk-workflow-manager";
import type {
  YolkCreateTaskRequest,
  YolkTaskDetail,
  YolkTaskDocument,
  YolkTaskDocumentName,
  YolkTaskRecord,
  YolkTaskReadError,
  YolkTaskSummary,
  YolkTasksResponse,
} from "./yolk-types";

const TASK_JSON = "task.json";
const DOC_MAX_BYTES = 256 * 1024;
const TITLE_MAX_LENGTH = 180;
const PRD_MAX_LENGTH = 128 * 1024;

export class YolkReaderSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YolkReaderSecurityError";
  }
}

interface ReaderContext {
  cwd: string;
  workspaceRoot: string;
  tasksRoot: string;
}

interface TaskRecordInternal {
  key: string;
  dirName: string;
  dirPath: string;
  pathLabel: string;
  raw: YolkTaskRecord | null;
  readError?: string;
  modifiedMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return optionalString(value) ?? null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function pathIsInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}

function relativeLabel(root: string, target: string): string {
  return (path.relative(root, target) || ".").split(path.sep).join("/");
}

function safeRealPath(target: string, workspaceRoot: string): string {
  const real = realpathSync.native(target);
  if (!pathIsInside(workspaceRoot, real)) {
    throw new YolkReaderSecurityError(`Path escapes workspace: ${relativeLabel(workspaceRoot, target)}`);
  }
  return real;
}

function assertDirectoryWithinWorkspace(target: string, workspaceRoot: string): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    const real = safeRealPath(target, workspaceRoot);
    if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${target}`);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${target}`);
  safeRealPath(target, workspaceRoot);
}

function safeStatFile(filePath: string, workspaceRoot: string) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    const real = safeRealPath(filePath, workspaceRoot);
    const realStat = statSync(real);
    return realStat.isFile() ? realStat : null;
  }
  if (!stat.isFile()) return null;
  safeRealPath(filePath, workspaceRoot);
  return stat;
}

function safeFileExists(filePath: string, workspaceRoot: string): boolean {
  try {
    return !!safeStatFile(filePath, workspaceRoot);
  } catch {
    return false;
  }
}

function readFileWithLimit(filePath: string, maxBytes: number): { content: string; truncated: boolean } {
  const stat = statSync(filePath);
  if (stat.size <= maxBytes) return { content: readFileSync(filePath, "utf8"), truncated: false };
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), truncated: true };
  } finally {
    closeSync(fd);
  }
}

function createContext(cwd: string): ReaderContext {
  const workspaceRoot = canonicalizeCwd(cwd);
  const stat = statSync(workspaceRoot);
  if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
  return { cwd: workspaceRoot, workspaceRoot, tasksRoot: path.join(workspaceRoot, ".yolk", "tasks") };
}

function parseTaskJson(taskJsonPath: string): YolkTaskRecord {
  const parsed = JSON.parse(readFileSync(taskJsonPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("task.json root must be an object");
  const id = optionalString(parsed.id);
  const title = optionalString(parsed.title);
  const status = optionalString(parsed.status);
  const createdAt = optionalString(parsed.createdAt);
  const updatedAt = optionalString(parsed.updatedAt);
  if (!id || !title || !status || !createdAt || !updatedAt) {
    throw new Error("task.json is missing required id/title/status/createdAt/updatedAt fields");
  }
  return {
    schemaVersion: 1,
    id,
    title,
    status,
    priority: optionalString(parsed.priority),
    assignee: optionalString(parsed.assignee),
    parent: nullableString(parsed.parent),
    children: stringArray(parsed.children),
    createdAt,
    updatedAt,
    notes: optionalString(parsed.notes),
  };
}

function scanTaskDirectory(ctx: ReaderContext, dirPath: string): TaskRecordInternal {
  const dirName = path.basename(dirPath);
  const key = dirName;
  const pathLabel = relativeLabel(ctx.workspaceRoot, dirPath);
  let modifiedMs = 0;
  try {
    const stat = lstatSync(dirPath);
    modifiedMs = stat.mtimeMs;
    assertDirectoryWithinWorkspace(dirPath, ctx.workspaceRoot);
  } catch (error) {
    if (error instanceof YolkReaderSecurityError) throw error;
    return { key, dirName, dirPath, pathLabel, raw: null, modifiedMs, readError: error instanceof Error ? error.message : String(error) };
  }

  try {
    const taskJsonPath = path.join(dirPath, TASK_JSON);
    safeStatFile(taskJsonPath, ctx.workspaceRoot);
    return { key, dirName, dirPath, pathLabel, raw: parseTaskJson(taskJsonPath), modifiedMs };
  } catch (error) {
    if (error instanceof YolkReaderSecurityError) throw error;
    return { key, dirName, dirPath, pathLabel, raw: null, modifiedMs, readError: error instanceof Error ? error.message : String(error) };
  }
}

function scanTaskRecords(ctx: ReaderContext): { records: TaskRecordInternal[]; errors: YolkTaskReadError[] } {
  if (!existsSync(ctx.tasksRoot)) return { records: [], errors: [] };
  assertDirectoryWithinWorkspace(ctx.tasksRoot, ctx.workspaceRoot);
  const records: TaskRecordInternal[] = [];
  const errors: YolkTaskReadError[] = [];
  for (const entry of readdirSync(ctx.tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const record = scanTaskDirectory(ctx, path.join(ctx.tasksRoot, entry.name));
    records.push(record);
    if (record.readError) errors.push({ key: record.key, pathLabel: record.pathLabel, message: record.readError });
  }
  return { records, errors };
}

function hasArtifacts(record: TaskRecordInternal, workspaceRoot: string): Record<YolkTaskDocumentName, boolean> {
  return YOLK_ARTIFACTS.reduce<Record<YolkTaskDocumentName, boolean>>((result, fileName) => {
    result[fileName] = safeFileExists(path.join(record.dirPath, fileName), workspaceRoot);
    return result;
  }, { "prd.md": false, "design.md": false, "implement.md": false, "check.md": false });
}

function recordToSummary(record: TaskRecordInternal, workspaceRoot: string): YolkTaskSummary {
  const raw = record.raw;
  return {
    key: record.key,
    id: raw?.id ?? record.dirName,
    title: raw?.title ?? record.dirName,
    status: raw?.status ?? (record.readError ? "unknown" : "planning"),
    priority: raw?.priority,
    assignee: raw?.assignee,
    parent: raw?.parent ?? null,
    children: raw?.children ?? [],
    createdAt: raw?.createdAt,
    updatedAt: raw?.updatedAt,
    notes: raw?.notes,
    pathLabel: record.pathLabel,
    hasArtifacts: hasArtifacts(record, workspaceRoot),
    readError: record.readError,
  };
}

function sortSummaries(a: YolkTaskSummary, b: YolkTaskSummary): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.title.localeCompare(b.title);
}

function readDocument(record: TaskRecordInternal, workspaceRoot: string, fileName: YolkTaskDocumentName): YolkTaskDocument | undefined {
  const filePath = path.join(record.dirPath, fileName);
  if (!existsSync(filePath)) return undefined;
  const stat = safeStatFile(filePath, workspaceRoot);
  if (!stat) return undefined;
  const { content, truncated } = readFileWithLimit(filePath, DOC_MAX_BYTES);
  return { fileName, content, truncated };
}

export function listYolkTasks(cwd: string): YolkTasksResponse {
  const ctx = createContext(cwd);
  const workflowStatus = getYolkWorkflowStatus(ctx.cwd);
  const installed = workflowStatus.status !== "missing";
  const enabled = workflowStatus.enabled;
  if (!installed || !enabled) {
    return { cwd: ctx.cwd, exists: installed, enabled, pathLabel: ".yolk/tasks", tasks: [], statusCounts: {}, errors: [] };
  }
  const scanned = scanTaskRecords(ctx);
  const tasks = scanned.records.map((record) => recordToSummary(record, ctx.workspaceRoot)).sort(sortSummaries);
  const statusCounts: Record<string, number> = {};
  for (const task of tasks) statusCounts[task.status] = (statusCounts[task.status] ?? 0) + 1;
  return { cwd: ctx.cwd, exists: true, enabled, pathLabel: ".yolk/tasks", tasks, statusCounts, errors: scanned.errors };
}

export function getYolkTaskDetail(cwd: string, taskKey: string): YolkTaskDetail | null {
  if (!/^[A-Za-z0-9._-]+$/.test(taskKey)) throw new YolkReaderSecurityError("Invalid yolk task key");
  const ctx = createContext(cwd);
  const workflowStatus = getYolkWorkflowStatus(ctx.cwd);
  if (!workflowStatus.enabled) return null;
  const scanned = scanTaskRecords(ctx);
  const record = scanned.records.find((candidate) => candidate.key === taskKey);
  if (!record) return null;
  const summary = recordToSummary(record, ctx.workspaceRoot);
  const documents = YOLK_ARTIFACTS.reduce<YolkTaskDetail["documents"]>((result, fileName) => {
    const document = readDocument(record, ctx.workspaceRoot, fileName);
    if (document) result[fileName] = document;
    return result;
  }, {});
  return { ...summary, documents };
}

function slugifyTitle(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52);
  return slug || "task";
}

function datePrefix(now: Date): string {
  return `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function createTaskId(title: string): string {
  return `${datePrefix(new Date())}-${slugifyTitle(title)}-${randomBytes(3).toString("hex")}`;
}

export function createYolkTask(input: YolkCreateTaskRequest): YolkTaskDetail {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  if (title.length > TITLE_MAX_LENGTH) throw new Error(`title must be ${TITLE_MAX_LENGTH} characters or fewer`);
  const prd = (input.prd ?? "").trim();
  if (prd.length > PRD_MAX_LENGTH) throw new Error(`prd must be ${PRD_MAX_LENGTH} characters or fewer`);

  const ctx = createContext(input.cwd);
  const workflowStatus = getYolkWorkflowStatus(ctx.cwd);
  if (!workflowStatus.enabled) throw new Error("Yolk workflow is not enabled for this workspace");
  if (!pathIsInside(ctx.workspaceRoot, ctx.tasksRoot)) throw new YolkReaderSecurityError("Tasks path escapes workspace");
  mkdirSync(ctx.tasksRoot, { recursive: true });
  assertDirectoryWithinWorkspace(ctx.tasksRoot, ctx.workspaceRoot);

  let taskId = createTaskId(title);
  let taskDir = path.join(ctx.tasksRoot, taskId);
  for (let attempt = 0; existsSync(taskDir) && attempt < 5; attempt += 1) {
    taskId = createTaskId(title);
    taskDir = path.join(ctx.tasksRoot, taskId);
  }
  if (existsSync(taskDir)) throw new Error("Could not create a unique yolk task id");
  if (!pathIsInside(ctx.workspaceRoot, taskDir)) throw new YolkReaderSecurityError("Task path escapes workspace");

  const now = new Date().toISOString();
  const task: YolkTaskRecord = {
    schemaVersion: 1,
    id: taskId,
    title,
    status: "planning",
    priority: input.priority?.trim() || "P2",
    assignee: input.assignee?.trim() || undefined,
    parent: null,
    children: [],
    createdAt: now,
    updatedAt: now,
    notes: "",
  };

  mkdirSync(taskDir, { recursive: false });
  writeFileSync(path.join(taskDir, TASK_JSON), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  writeFileSync(path.join(taskDir, "prd.md"), prd ? `${prd}\n` : `# ${title}\n\n## Goal\n\nTBD.\n`, "utf8");
  const detail = getYolkTaskDetail(ctx.cwd, taskId);
  if (!detail) throw new Error("Created task could not be read back");
  return detail;
}
