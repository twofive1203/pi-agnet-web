import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import {
  YOLK_ALLOWED_MANAGED_PATHS,
  YOLK_MANAGED_TEMPLATES,
  YOLK_MANIFEST_PATH,
  YOLK_TASKS_PATH,
  YOLK_WORKFLOW_VERSION,
} from "./yolk-workflow-templates";
import type {
  YolkManagedFileRecord,
  YolkManagedFileStatus,
  YolkWorkflowActionResponse,
  YolkWorkflowConflict,
  YolkWorkflowManifest,
  YolkWorkflowRecommendedAction,
  YolkWorkflowStatus,
  YolkWorkflowStatusKind,
} from "./yolk-types";

const MANIFEST_SCHEMA_VERSION = 1;

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeLabel(root: string, target: string): string {
  return (path.relative(root, target) || ".").split(path.sep).join("/");
}

function pathIsInside(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}

function toWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!YOLK_ALLOWED_MANAGED_PATHS.has(normalized)) {
    throw new Error(`Yolk workflow path is not allowlisted: ${relativePath}`);
  }
  const target = path.resolve(workspaceRoot, ...normalized.split("/"));
  if (!pathIsInside(workspaceRoot, target)) {
    throw new Error(`Yolk workflow path escapes workspace: ${relativePath}`);
  }
  return target;
}

function safeFileSha(filePath: string, workspaceRoot: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    const real = realpathSync.native(filePath);
    if (!pathIsInside(workspaceRoot, real)) throw new Error(`Path escapes workspace: ${relativeLabel(workspaceRoot, filePath)}`);
    const realStat = statSync(real);
    if (!realStat.isFile()) throw new Error(`Expected file: ${relativeLabel(workspaceRoot, filePath)}`);
    return sha256(readFileSync(real));
  }
  if (!stat.isFile()) throw new Error(`Expected file: ${relativeLabel(workspaceRoot, filePath)}`);
  return sha256(readFileSync(filePath));
}

function parseManagedFileRecord(value: unknown): YolkManagedFileRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.templateVersion !== "string" || typeof value.sha256 !== "string") return null;
  return { templateVersion: value.templateVersion, sha256: value.sha256 };
}

function parseManifest(raw: unknown): YolkWorkflowManifest | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) return null;
  if (typeof raw.workflowVersion !== "string") return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") return null;
  const managedRaw = isRecord(raw.managedFiles) ? raw.managedFiles : null;
  if (!managedRaw) return null;
  const managedFiles: Record<string, YolkManagedFileRecord> = {};
  for (const [filePath, record] of Object.entries(managedRaw)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (!YOLK_ALLOWED_MANAGED_PATHS.has(normalized) || normalized === YOLK_MANIFEST_PATH || normalized === YOLK_TASKS_PATH) return null;
    const parsed = parseManagedFileRecord(record);
    if (!parsed) return null;
    managedFiles[normalized] = parsed;
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    workflowVersion: raw.workflowVersion,
    enabled: raw.enabled,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    managedFiles,
  };
}

function readManifest(workspaceRoot: string): { manifest?: YolkWorkflowManifest; malformed?: string } {
  const manifestPath = toWorkspacePath(workspaceRoot, YOLK_MANIFEST_PATH);
  if (!existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    const manifest = parseManifest(parsed);
    if (!manifest) return { malformed: "Manifest schema is invalid." };
    return { manifest };
  } catch (error) {
    return { malformed: error instanceof Error ? error.message : String(error) };
  }
}

function targetExists(workspaceRoot: string, relativePath: string): boolean {
  return existsSync(toWorkspacePath(workspaceRoot, relativePath));
}

function buildManagedStatuses(workspaceRoot: string, manifest?: YolkWorkflowManifest): { statuses: YolkManagedFileStatus[]; conflicts: YolkWorkflowConflict[]; outdated: boolean } {
  const statuses: YolkManagedFileStatus[] = [];
  const conflicts: YolkWorkflowConflict[] = [];
  let outdated = false;

  for (const template of YOLK_MANAGED_TEMPLATES) {
    const expectedSha256 = sha256(template.content);
    const managedRecord = manifest?.managedFiles[template.path];
    const filePath = toWorkspacePath(workspaceRoot, template.path);
    let currentSha256: string | undefined;
    let exists = false;
    try {
      currentSha256 = safeFileSha(filePath, workspaceRoot);
      exists = currentSha256 !== undefined;
    } catch (error) {
      conflicts.push({
        path: template.path,
        reason: "invalid-type",
        detail: error instanceof Error ? error.message : String(error),
      });
      exists = true;
    }

    const managed = !!managedRecord;
    const changed = exists && managed ? currentSha256 !== managedRecord.sha256 : exists && !managed;
    if (!manifest && exists) {
      conflicts.push({ path: template.path, reason: "unmanaged-existing", detail: "File exists before yolk workflow manifest was created." });
    } else if (manifest && exists && !managed) {
      conflicts.push({ path: template.path, reason: "unmanaged-existing", detail: "File exists but is not recorded in .yolk/manifest.json." });
    } else if (manifest && exists && managedRecord && currentSha256 !== managedRecord.sha256) {
      conflicts.push({ path: template.path, reason: "modified-managed", detail: "File differs from the last managed hash." });
    } else if (manifest && !exists && managedRecord) {
      // Missing managed files can be restored safely by enable/update.
    }

    if (managedRecord && currentSha256 === managedRecord.sha256 && currentSha256 !== expectedSha256) outdated = true;
    if (managedRecord && managedRecord.templateVersion !== template.templateVersion && currentSha256 === managedRecord.sha256) outdated = true;

    statuses.push({
      path: template.path,
      templateVersion: template.templateVersion,
      exists,
      managed,
      currentSha256,
      expectedSha256,
      changed,
    });
  }

  return { statuses, conflicts, outdated };
}

function statusMessage(status: YolkWorkflowStatusKind): string {
  if (status === "missing") return "Yolk workflow is not installed for this workspace.";
  if (status === "ready") return "Yolk workflow is enabled and managed files are current.";
  if (status === "disabled") return "Yolk workflow is installed but disabled for this workspace.";
  if (status === "outdated") return "Yolk workflow managed templates can be updated safely.";
  if (status === "conflict") return "Yolk workflow has file conflicts that require manual resolution.";
  return "Yolk workflow status is blocked.";
}

function recommendedAction(status: YolkWorkflowStatusKind): YolkWorkflowRecommendedAction {
  if (status === "missing") return "enable";
  if (status === "disabled") return "enable";
  if (status === "outdated") return "update";
  if (status === "conflict") return "resolve-conflicts";
  if (status === "ready") return "disable";
  return "none";
}

export function getYolkWorkflowStatus(cwd: string): YolkWorkflowStatus {
  const workspaceRoot = canonicalizeCwd(cwd);
  try {
    const stat = statSync(workspaceRoot);
    if (!stat.isDirectory()) throw new Error(`Workspace is not a directory: ${cwd}`);
    const { manifest, malformed } = readManifest(workspaceRoot);
    if (malformed) {
      return {
        cwd: workspaceRoot,
        status: "blocked",
        enabled: false,
        pathLabel: ".yolk/manifest.json",
        workflowVersion: YOLK_WORKFLOW_VERSION,
        recommendedAction: "none",
        conflicts: [{ path: YOLK_MANIFEST_PATH, reason: "invalid-type", detail: malformed }],
        managedFiles: [],
        message: "Yolk workflow manifest is malformed.",
      };
    }

    const { statuses, conflicts, outdated } = buildManagedStatuses(workspaceRoot, manifest);
    const hasTasksDir = targetExists(workspaceRoot, YOLK_TASKS_PATH);
    if (!manifest && hasTasksDir && conflicts.length === 0) {
      conflicts.push({ path: YOLK_TASKS_PATH, reason: "unmanaged-existing", detail: "Tasks directory exists before yolk workflow manifest was created." });
    }
    const hasAnyTarget = hasTasksDir || statuses.some((item) => item.exists);
    let status: YolkWorkflowStatusKind;
    if (conflicts.length > 0) status = "conflict";
    else if (!manifest) status = hasAnyTarget ? "conflict" : "missing";
    else if (!manifest.enabled) status = "disabled";
    else if (outdated) status = "outdated";
    else status = "ready";

    return {
      cwd: workspaceRoot,
      status,
      enabled: manifest?.enabled === true && status !== "conflict",
      pathLabel: ".yolk",
      workflowVersion: YOLK_WORKFLOW_VERSION,
      recommendedAction: recommendedAction(status),
      manifest,
      conflicts,
      managedFiles: statuses,
      message: statusMessage(status),
    };
  } catch (error) {
    return {
      cwd: workspaceRoot,
      status: "blocked",
      enabled: false,
      pathLabel: ".yolk",
      workflowVersion: YOLK_WORKFLOW_VERSION,
      recommendedAction: "none",
      conflicts: [{ path: ".", reason: "invalid-type", detail: error instanceof Error ? error.message : String(error) }],
      managedFiles: [],
      message: "Yolk workflow cannot inspect this workspace.",
    };
  }
}

function writeManifest(workspaceRoot: string, manifest: YolkWorkflowManifest): void {
  const manifestPath = toWorkspacePath(workspaceRoot, YOLK_MANIFEST_PATH);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function createManifest(enabled: boolean): YolkWorkflowManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    workflowVersion: YOLK_WORKFLOW_VERSION,
    enabled,
    createdAt: now,
    updatedAt: now,
    managedFiles: {},
  };
}

function assertNoBlockingConflicts(status: YolkWorkflowStatus): void {
  if (status.status === "blocked" || status.status === "conflict") {
    throw new Error(status.conflicts.map((conflict) => `Conflict ${conflict.path}: ${conflict.detail}`).join("\n") || status.message);
  }
}

function writeManagedTemplates(workspaceRoot: string, manifest: YolkWorkflowManifest, updateExisting: boolean): string[] {
  const written: string[] = [];
  for (const template of YOLK_MANAGED_TEMPLATES) {
    const filePath = toWorkspacePath(workspaceRoot, template.path);
    const exists = existsSync(filePath);
    if (exists && !updateExisting) {
      const currentSha256 = safeFileSha(filePath, workspaceRoot);
      if (currentSha256 === sha256(template.content)) {
        manifest.managedFiles[template.path] = { templateVersion: template.templateVersion, sha256: currentSha256 };
      }
      continue;
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, template.content, "utf8");
    manifest.managedFiles[template.path] = { templateVersion: template.templateVersion, sha256: sha256(template.content) };
    written.push(template.path);
  }
  mkdirSync(toWorkspacePath(workspaceRoot, YOLK_TASKS_PATH), { recursive: true });
  return written;
}

export function enableYolkWorkflow(cwd: string): YolkWorkflowActionResponse {
  const before = getYolkWorkflowStatus(cwd);
  assertNoBlockingConflicts(before);
  const workspaceRoot = before.cwd;
  const manifest = before.manifest ?? createManifest(true);
  const now = new Date().toISOString();
  manifest.enabled = true;
  manifest.workflowVersion = YOLK_WORKFLOW_VERSION;
  manifest.updatedAt = now;
  const written = writeManagedTemplates(workspaceRoot, manifest, before.status === "outdated");
  writeManifest(workspaceRoot, manifest);
  const status = getYolkWorkflowStatus(workspaceRoot);
  return {
    success: status.status === "ready",
    status,
    output: written.length > 0 ? `Wrote ${written.length} managed Yolk workflow file(s).` : "Yolk workflow enabled. Managed files were already present.",
  };
}

export function disableYolkWorkflow(cwd: string): YolkWorkflowActionResponse {
  const before = getYolkWorkflowStatus(cwd);
  if (before.status === "blocked") throw new Error(before.message);
  const workspaceRoot = before.cwd;
  const manifest = before.manifest ?? createManifest(false);
  manifest.enabled = false;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(workspaceRoot, manifest);
  const status = getYolkWorkflowStatus(workspaceRoot);
  return { success: status.status === "disabled", status, output: "Yolk workflow disabled. Project-local files were left in place." };
}

export function updateYolkWorkflow(cwd: string): YolkWorkflowActionResponse {
  const before = getYolkWorkflowStatus(cwd);
  assertNoBlockingConflicts(before);
  if (!before.manifest) return enableYolkWorkflow(cwd);
  const manifest = before.manifest;
  manifest.workflowVersion = YOLK_WORKFLOW_VERSION;
  manifest.updatedAt = new Date().toISOString();
  const written = writeManagedTemplates(before.cwd, manifest, true);
  writeManifest(before.cwd, manifest);
  const status = getYolkWorkflowStatus(before.cwd);
  return {
    success: status.status === "ready" || status.status === "disabled",
    status,
    output: written.length > 0 ? `Updated ${written.length} managed Yolk workflow file(s).` : "Yolk workflow managed files are already current.",
  };
}
