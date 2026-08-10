/**
 * Project-level SnFlow detection, initialization, and asset updates.
 *
 * A project is "initialized" when <cwd>/.pi/snflows/tasks/ exists (backward
 * compatible). Full setup also installs managed extension/skill/agent/script
 * files and writes .pi/snflows/.version from the bundled asset manifest.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import path from "path";
import { canonicalizeCwd } from "./cwd";
import {
  SNFLOW_ASSET_FILES,
  SNFLOW_ASSETS_VERSION,
  buildScriptSnflowTask,
  type SnflowAssetFile,
} from "./snflow-assets";
import {
  applySnflowGitignorePolicy,
  type SnflowGitignoreResult,
} from "./workflow-gitignore";
import {
  WORKFLOW_ROOT_SEGMENTS,
  WORKFLOW_TASKS_DIR,
  WorkflowSecurityError,
  createStoreContext,
  createWorkflowTask,
  hasActiveNonArchivedWorkflowTask,
} from "./workflow-store";
import {
  getWorkflowCurrentTaskId,
  setWorkflowCurrentTask,
} from "./workflow-current";
import {
  BOOTSTRAP_SPEC_TASK_ID,
  BOOTSTRAP_TASK_DOCS,
  SNFLOW_SPEC_DIR,
  SNFLOW_SPEC_FILES,
} from "./snflow-spec-templates";

export type WorkflowSetupRecommendedAction = "initialize" | "update" | "ready";

export interface WorkflowSetupStatus {
  cwd: string;
  /** tasks/ directory exists — backward-compatible initialized signal. */
  initialized: boolean;
  hasSnflowsDir: boolean;
  hasTasksDir: boolean;
  hasArchivedDir: boolean;
  /** Project-owned specification directory exists. */
  hasSpec: boolean;
  /** Workspace-relative store root, e.g. ".pi/snflows". */
  pathLabel: string;
  /** Application-bundled asset version (manifest). */
  bundledVersion: string;
  /** Project .pi/snflows/.version when present. */
  projectVersion?: string;
  hasExtension: boolean;
  hasSkill: boolean;
  hasAgents: boolean;
  hasScript: boolean;
  /** True when version is missing/older or managed components are missing. */
  updateAvailable: boolean;
  recommendedAction: WorkflowSetupRecommendedAction;
  missingManagedFiles: string[];
}

export interface WorkflowSetupCommandResponse {
  success: boolean;
  /** Human-readable operation log for Settings output panel. */
  output: string;
  status: WorkflowSetupStatus;
  /** true when init created the tasks directory for the first time. */
  created?: boolean;
  gitignore?: SnflowGitignoreResult;
  error?: string;
}

export interface WorkflowSetupOptions {
  /** When false (default), keep managed SnFlow paths in project .gitignore. */
  trackInGit?: boolean;
}

const VERSION_FILE = ".version";
const EXTENSION_REL = ".pi/extensions/snflow/index.ts";
const SKILL_REL = ".pi/skills/snflow-dev/SKILL.md";
const AGENT_SEARCH_REL = ".pi/agents/snflow-search.md";
const AGENT_IMPLEMENT_REL = ".pi/agents/snflow-implement.md";
const AGENT_CHECK_REL = ".pi/agents/snflow-check.md";
const SCRIPT_REL = "scripts/snflow-task.ts";

function isDirectory(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return existsSync(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

function parseVersionParts(version: string | undefined): number[] {
  if (!version) return [];
  const match =
    version.match(/(\d+)\.(\d+)\.(\d+)/) ??
    version.match(/(\d+)\.(\d+)/) ??
    version.match(/(\d+)/);
  if (!match) return [];
  return match.slice(1).map((part) => Number(part));
}

/** True when `version` is strictly lower than `required` (SemVer-ish). */
export function versionLessThan(version: string | undefined, required: string): boolean {
  const left = parseVersionParts(version);
  const right = parseVersionParts(required);
  if (right.length === 0) return false;
  if (left.length === 0) return true;
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

function toAbsolute(workspaceRoot: string, relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  return path.join(workspaceRoot, ...parts);
}

/** Case-insensitive containment check for canonical and lexical paths. */
function pathIsInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget === normRoot || normTarget.startsWith(rootWithSep);
}

function relativeLabel(workspaceRoot: string, target: string): string {
  return (path.relative(workspaceRoot, target) || ".").split(path.sep).join("/");
}

function fsErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function tryLstat(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function safeRealPath(workspaceRoot: string, target: string): string {
  let real: string;
  try {
    real = realpathSync.native(target);
  } catch {
    throw new WorkflowSecurityError(
      `Cannot safely resolve setup path: ${relativeLabel(workspaceRoot, target)}`,
    );
  }
  if (!pathIsInsideWorkspace(workspaceRoot, real)) {
    throw new WorkflowSecurityError(
      `Path escapes workspace: ${relativeLabel(workspaceRoot, target)}`,
    );
  }
  return real;
}

/**
 * Validate every existing path component stays inside the canonical workspace.
 * Used as the setup write boundary before creating/updating SnFlow assets.
 */
function assertExistingPathBoundary(workspaceRoot: string, target: string): void {
  const root = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(target);
  if (!pathIsInsideWorkspace(root, resolvedTarget)) {
    throw new WorkflowSecurityError(
      `Refusing to access outside workspace: ${relativeLabel(root, resolvedTarget)}`,
    );
  }

  const relative = path.relative(root, resolvedTarget);
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  safeRealPath(root, current);

  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = tryLstat(current);
    if (!stat) break;

    const real = safeRealPath(root, current);
    const isFinal = index === parts.length - 1;
    if (!isFinal && !statSync(real).isDirectory()) {
      throw new WorkflowSecurityError(
        `Expected setup parent directory: ${relativeLabel(root, current)}`,
      );
    }
  }
}

/**
 * Preflight for bootstrap active/archived task directories.
 * Missing paths are valid; external escapes and any linked final task dir
 * fail closed before setup mutates managed assets or the current pointer.
 */
function assertBootstrapTaskPathBoundary(workspaceRoot: string, target: string): void {
  assertExistingPathBoundary(workspaceRoot, target);
  const stat = tryLstat(target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new WorkflowSecurityError(
      `Refusing linked bootstrap task path: ${relativeLabel(workspaceRoot, target)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new WorkflowSecurityError(
      `Expected bootstrap task directory: ${relativeLabel(workspaceRoot, target)}`,
    );
  }
  safeRealPath(workspaceRoot, target);
}

function assertSetupWriteBoundary(workspaceRoot: string): void {
  const destinations = [
    path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS),
    path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS, WORKFLOW_TASKS_DIR),
    path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS, "archived"),
    path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS, VERSION_FILE),
    // current.json is written during bootstrap pointer setup; reject escapes first.
    path.join(workspaceRoot, ...WORKFLOW_ROOT_SEGMENTS, "current.json"),
    path.join(workspaceRoot, ".gitignore"),
    toAbsolute(workspaceRoot, SNFLOW_SPEC_DIR),
    ...SNFLOW_ASSET_FILES.map((file) => toAbsolute(workspaceRoot, file.path)),
  ];
  for (const destination of destinations) {
    assertExistingPathBoundary(workspaceRoot, destination);
  }

  const bootstrapActive = path.join(
    workspaceRoot,
    ...WORKFLOW_ROOT_SEGMENTS,
    WORKFLOW_TASKS_DIR,
    BOOTSTRAP_SPEC_TASK_ID,
  );
  const bootstrapArchived = path.join(
    workspaceRoot,
    ...WORKFLOW_ROOT_SEGMENTS,
    "archived",
    BOOTSTRAP_SPEC_TASK_ID,
  );
  assertBootstrapTaskPathBoundary(workspaceRoot, bootstrapActive);
  assertBootstrapTaskPathBoundary(workspaceRoot, bootstrapArchived);
}

function readProjectVersion(workflowsRoot: string): string | undefined {
  const versionPath = path.join(workflowsRoot, VERSION_FILE);
  try {
    if (!isFile(versionPath)) return undefined;
    const value = readFileSync(versionPath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function listMissingManagedFiles(workspaceRoot: string): string[] {
  const missing: string[] = [];
  for (const file of SNFLOW_ASSET_FILES) {
    if (!isFile(toAbsolute(workspaceRoot, file.path))) {
      missing.push(file.path);
    }
  }
  return missing;
}

/**
 * Resolve the WebUI's own package root directory.
 *
 * The explicit environment override is useful for linked/local installs. When
 * it is absent, the WebUI server cwd is considered only after validating that
 * it is this package, never merely a target project's package directory.
 */
export function resolveWebuiRoot(): string {
  const fromEnv = process.env.SNAIL_PI_WEB_ROOT?.trim();
  const rawCandidate = fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd();
  const candidate = path.resolve(rawCandidate);
  const pkgJson = path.join(candidate, "package.json");
  const scriptPath = path.join(candidate, "scripts", "workflow-task.ts");
  let packageName: unknown;
  try {
    packageName = (JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: unknown }).name;
  } catch {
    packageName = undefined;
  }
  if (packageName === "@twofive/snail-pi-web" && isFile(scriptPath)) {
    return candidate;
  }
  const errors: string[] = [];
  if (packageName !== "@twofive/snail-pi-web") {
    errors.push(`package.json is not @twofive/snail-pi-web at ${pkgJson}`);
  }
  if (!isFile(scriptPath)) {
    errors.push(`scripts/workflow-task.ts not found at ${scriptPath}`);
  }
  const hint = fromEnv
    ? `SNAIL_PI_WEB_ROOT=${fromEnv}`
    : `process.cwd()=${process.cwd()}`;
  throw new Error(`Cannot resolve Snail Pi Web root (${hint}): ${errors.join("; ")}`);
}

function atomicWriteFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.tmp-snflow-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  writeFileSync(tmp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  renameSync(tmp, filePath);
}

function installManagedFiles(
  workspaceRoot: string,
  files: readonly SnflowAssetFile[],
  webuiRoot?: string,
): string[] {
  if (!files.length) {
    throw new Error("SnFlow asset manifest is empty; bundled templates failed to load");
  }
  const written: string[] = [];
  for (const file of files) {
    if (!file.path || typeof file.content !== "string" || file.content.length === 0) {
      throw new Error(`Invalid SnFlow asset entry: ${file.path || "(missing path)"}`);
    }
    let content = file.content;
    // When installing the wrapper script, embed the WebUI root directly
    // to avoid fragile tsx resolution in the child process.
    if (webuiRoot && file.path === "scripts/snflow-task.ts") {
      content = buildScriptSnflowTask(webuiRoot);
    }
    const abs = toAbsolute(workspaceRoot, file.path);
    // Defense in depth: only allow known whitelist relative paths under workspace.
    if (!pathIsInsideWorkspace(workspaceRoot, abs)) {
      throw new Error(`Refusing to write outside workspace: ${file.path}`);
    }
    atomicWriteFile(path.resolve(abs), content);
    written.push(file.path);
  }
  return written;
}

interface SpecInstallResult {
  installed: string[];
  /** True when an existing user-owned/safe-linked spec was left untouched. */
  existed: boolean;
}

/**
 * True when a safe existing specification directory is present.
 * External symlink/junction escapes fail closed. Internal safe links are
 * treated as user-owned and count as existing (setup skips writing).
 */
function getExistingSpecDirectory(workspaceRoot: string, specRoot: string): boolean {
  const stat = tryLstat(specRoot);
  if (!stat) return false;
  assertExistingPathBoundary(workspaceRoot, specRoot);
  if (stat.isSymbolicLink()) {
    const real = safeRealPath(workspaceRoot, specRoot);
    if (!statSync(real).isDirectory()) {
      throw new WorkflowSecurityError(
        `Expected SnFlow specification directory: ${relativeLabel(workspaceRoot, specRoot)}`,
      );
    }
    return true;
  }
  if (!stat.isDirectory()) {
    throw new WorkflowSecurityError(
      `Expected SnFlow specification directory: ${relativeLabel(workspaceRoot, specRoot)}`,
    );
  }
  return true;
}

/**
 * Install the project specification skeleton only when `.pi/snflows/spec/` is
 * absent. Existing directories (including empty ones and internal safe links) are
 * left untouched. Uses per-file atomicWriteFile; a mid-process crash may leave
 * a partial directory (accepted residual risk from the source design).
 */
function installSpecSkeletonIfMissing(workspaceRoot: string): SpecInstallResult {
  const specRoot = toAbsolute(workspaceRoot, SNFLOW_SPEC_DIR);
  assertExistingPathBoundary(workspaceRoot, path.dirname(specRoot));

  if (getExistingSpecDirectory(workspaceRoot, specRoot)) {
    return { installed: [], existed: true };
  }

  const installed: string[] = [];
  for (const file of SNFLOW_SPEC_FILES) {
    const abs = toAbsolute(workspaceRoot, file.path);
    if (!pathIsInsideWorkspace(workspaceRoot, abs)) {
      throw new WorkflowSecurityError(`Refusing to write outside workspace: ${file.path}`);
    }
    assertExistingPathBoundary(workspaceRoot, path.dirname(abs));
    atomicWriteFile(path.resolve(abs), file.content);
    installed.push(file.path);
  }
  return { installed, existed: false };
}

/**
 * Restore current only when it points at a physical, valid, non-archived task
 * under tasks/<id>. Never falls through to archived/.
 */
function getRestorableCurrentTaskId(workspaceRoot: string): string | null {
  const taskId = getWorkflowCurrentTaskId(workspaceRoot);
  if (!taskId) return null;
  return hasActiveNonArchivedWorkflowTask(workspaceRoot, taskId) ? taskId : null;
}

/**
 * Ensure the bootstrap task exists. Idempotent for active or archived
 * bootstrap directories. On update, restores a restorable prior current task.
 */
function isPhysicalDirectory(target: string): boolean {
  const stat = tryLstat(target);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

function ensureBootstrapSpecTask(
  workspaceRoot: string,
  lines: string[],
  options: { restorePreviousCurrent: boolean },
): void {
  const ctx = createStoreContext(workspaceRoot);
  const activeDir = path.join(ctx.tasksRoot, BOOTSTRAP_SPEC_TASK_ID);
  const archivedDir = path.join(ctx.archiveRoot, BOOTSTRAP_SPEC_TASK_ID);
  // Do not follow junctions/symlinks when deciding whether bootstrap exists.
  const activeExists = isPhysicalDirectory(activeDir);
  if (activeExists || isPhysicalDirectory(archivedDir)) {
    if (activeExists && !options.restorePreviousCurrent) {
      setWorkflowCurrentTask(ctx.workspaceRoot, BOOTSTRAP_SPEC_TASK_ID, { source: "select" });
    }
    lines.push(`Specification bootstrap task ${BOOTSTRAP_SPEC_TASK_ID} already exists; skipped.`);
    return;
  }

  const previousTaskId = options.restorePreviousCurrent
    ? getRestorableCurrentTaskId(ctx.workspaceRoot)
    : null;
  try {
    createWorkflowTask(ctx.workspaceRoot, {
      id: BOOTSTRAP_SPEC_TASK_ID,
      title: BOOTSTRAP_TASK_DOCS.title,
      description: BOOTSTRAP_TASK_DOCS.description,
      priority: "P1",
      requirements: BOOTSTRAP_TASK_DOCS.requirements,
      design: BOOTSTRAP_TASK_DOCS.design,
      plan: BOOTSTRAP_TASK_DOCS.plan,
    });
    if (previousTaskId && previousTaskId !== BOOTSTRAP_SPEC_TASK_ID) {
      setWorkflowCurrentTask(ctx.workspaceRoot, previousTaskId, { source: "select" });
    }
    lines.push(
      `Created specification bootstrap task ${BOOTSTRAP_SPEC_TASK_ID}; open it from the SnFlow panel.`,
    );
  } catch (error) {
    lines.push(
      `Warning: could not create specification bootstrap task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function applySpecInstallResult(
  workspaceRoot: string,
  lines: string[],
  options: { restorePreviousCurrent: boolean },
): void {
  const spec = installSpecSkeletonIfMissing(workspaceRoot);
  if (spec.existed) {
    lines.push(`Project specification directory ${SNFLOW_SPEC_DIR} already exists; left unchanged.`);
    return;
  }
  lines.push(`Installed ${spec.installed.length} project specification skeleton file(s).`);
  ensureBootstrapSpecTask(workspaceRoot, lines, {
    restorePreviousCurrent: options.restorePreviousCurrent,
  });
}

function writeVersionFile(workflowsRoot: string, version: string): void {
  atomicWriteFile(path.join(workflowsRoot, VERSION_FILE), `${version}\n`);
}

/** Lightweight never-throw check used by session-start guidance injection. */
export function isWorkflowProjectInitialized(cwd: string): boolean {
  try {
    const root = canonicalizeCwd(cwd);
    return isDirectory(path.join(root, ...WORKFLOW_ROOT_SEGMENTS, WORKFLOW_TASKS_DIR));
  } catch {
    return false;
  }
}

/** True when the project has the SnFlow pi extension installed (guidance owner). */
export function hasWorkflowExtension(cwd: string): boolean {
  try {
    const root = canonicalizeCwd(cwd);
    return isFile(toAbsolute(root, EXTENSION_REL));
  } catch {
    return false;
  }
}

/**
 * SnFlow resources are available to a session only when the selected project
 * has been initialized (`.pi/snflows/tasks/` exists). Workflow entry remains
 * opt-in; this availability signal only controls managed guidance/skills/agents.
 */
export function isSnflowActiveForSession(cwd: string): boolean {
  return isWorkflowProjectInitialized(cwd);
}

function normalizeFsPath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** True when a loaded extension path is the managed SnFlow project extension. */
export function isSnflowManagedExtensionPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const normalized = normalizeFsPath(filePath);
  return (
    normalized.includes("/.pi/extensions/snflow/") ||
    normalized.endsWith("/.pi/extensions/snflow/index.ts") ||
    normalized.endsWith("/extensions/snflow/index.ts")
  );
}

/** True when a skill name/path is the managed SnFlow skill. */
export function isSnflowManagedSkill(skill: { name?: string; path?: string; filePath?: string }): boolean {
  const name = typeof skill.name === "string" ? skill.name.toLowerCase() : "";
  if (name === "snflow-dev" || name === "workflow-dev") return true;
  const pathValue = skill.path ?? skill.filePath ?? "";
  const normalized = normalizeFsPath(pathValue);
  return (
    normalized.includes("/.pi/skills/snflow-dev/") ||
    normalized.includes("/skills/snflow-dev/") ||
    normalized.includes("/.pi/skills/workflow-dev/")
  );
}

/** True when an agents file path is a managed SnFlow agent definition. */
export function isSnflowManagedAgentPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false;
  const normalized = normalizeFsPath(filePath);
  const base = normalized.split("/").pop() ?? "";
  return (
    base === "snflow-implement.md" ||
    base === "snflow-check.md" ||
    normalized.includes("/.pi/agents/snflow-")
  );
}

export function getWorkflowSetupStatus(cwd: string): WorkflowSetupStatus {
  const ctx = createStoreContext(cwd);
  const hasTasksDir = isDirectory(ctx.tasksRoot);
  const hasSnflowsDir = isDirectory(ctx.workflowsRoot);
  const hasArchivedDir = isDirectory(ctx.archiveRoot);
  let hasSpec = false;
  try {
    hasSpec = getExistingSpecDirectory(
      ctx.workspaceRoot,
      toAbsolute(ctx.workspaceRoot, SNFLOW_SPEC_DIR),
    );
  } catch {
    // Status is informational; unsafe linked paths are never reported as specs.
    hasSpec = false;
  }
  const projectVersion = readProjectVersion(ctx.workflowsRoot);
  const missingManagedFiles = listMissingManagedFiles(ctx.workspaceRoot);
  const hasExtension = isFile(toAbsolute(ctx.workspaceRoot, EXTENSION_REL));
  const hasSkill = isFile(toAbsolute(ctx.workspaceRoot, SKILL_REL));
  const hasAgents =
    isFile(toAbsolute(ctx.workspaceRoot, AGENT_SEARCH_REL)) &&
    isFile(toAbsolute(ctx.workspaceRoot, AGENT_IMPLEMENT_REL)) &&
    isFile(toAbsolute(ctx.workspaceRoot, AGENT_CHECK_REL));
  const hasScript = isFile(toAbsolute(ctx.workspaceRoot, SCRIPT_REL));

  const versionNeedsUpdate =
    hasTasksDir &&
    (projectVersion === undefined || versionLessThan(projectVersion, SNFLOW_ASSETS_VERSION));
  const componentsMissing = hasTasksDir && missingManagedFiles.length > 0;
  const updateAvailable = versionNeedsUpdate || componentsMissing;

  let recommendedAction: WorkflowSetupRecommendedAction;
  if (!hasTasksDir) {
    recommendedAction = "initialize";
  } else if (updateAvailable) {
    recommendedAction = "update";
  } else {
    recommendedAction = "ready";
  }

  return {
    cwd: ctx.workspaceRoot,
    initialized: hasTasksDir,
    hasSnflowsDir,
    hasTasksDir,
    hasArchivedDir,
    hasSpec,
    pathLabel: WORKFLOW_ROOT_SEGMENTS.join("/"),
    bundledVersion: SNFLOW_ASSETS_VERSION,
    ...(projectVersion ? { projectVersion } : {}),
    hasExtension,
    hasSkill,
    hasAgents,
    hasScript,
    updateAvailable,
    recommendedAction,
    missingManagedFiles,
  };
}

function applyGitPolicyLines(
  cwd: string,
  trackInGit: boolean,
  lines: string[],
): SnflowGitignoreResult {
  const gitignore = applySnflowGitignorePolicy(cwd, trackInGit);
  if (gitignore.action === "ignored") {
    lines.push(
      gitignore.changed
        ? `Git: ignored managed SnFlow paths via ${path.basename(gitignore.path ?? ".gitignore")} (trackInGit=false).`
        : "Git: managed SnFlow ignore block already present.",
    );
  } else if (gitignore.action === "tracked") {
    lines.push("Git: removed SnFlow managed ignore block (trackInGit=true).");
  } else if (gitignore.action === "noop") {
    lines.push("Git: trackInGit=true and no .gitignore to edit.");
  }
  return gitignore;
}

export function initializeWorkflowProject(
  cwd: string,
  options: WorkflowSetupOptions = {},
): WorkflowSetupCommandResponse {
  const trackInGit = options.trackInGit === true;
  const ctx = createStoreContext(cwd);
  assertSetupWriteBoundary(ctx.workspaceRoot);
  const created = !isDirectory(ctx.tasksRoot);
  const lines: string[] = [];

  mkdirSync(ctx.tasksRoot, { recursive: true });
  mkdirSync(ctx.archiveRoot, { recursive: true });
  lines.push(
    created
      ? `Created ${WORKFLOW_ROOT_SEGMENTS.join("/")}/tasks and archived directories.`
      : `SnFlow task directories already present under ${WORKFLOW_ROOT_SEGMENTS.join("/")}.`,
  );

  let webuiRoot: string;
  try {
    webuiRoot = resolveWebuiRoot();
  } catch (error) {
    return {
      success: false,
      created,
      output: lines.join("\n"),
      status: getWorkflowSetupStatus(ctx.workspaceRoot),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const written = installManagedFiles(ctx.workspaceRoot, SNFLOW_ASSET_FILES, webuiRoot);
  lines.push(`Installed ${written.length} managed SnFlow file(s):`);
  for (const file of written) lines.push(`  - ${file}`);

  applySpecInstallResult(ctx.workspaceRoot, lines, {
    restorePreviousCurrent: !created,
  });

  writeVersionFile(ctx.workflowsRoot, SNFLOW_ASSETS_VERSION);
  lines.push(`Wrote ${WORKFLOW_ROOT_SEGMENTS.join("/")}/${VERSION_FILE} = ${SNFLOW_ASSETS_VERSION}`);

  const gitignore = applyGitPolicyLines(ctx.workspaceRoot, trackInGit, lines);

  const status = getWorkflowSetupStatus(ctx.workspaceRoot);
  // Fail closed: directories alone are not a successful full init.
  if (status.missingManagedFiles.length > 0 || !status.projectVersion) {
    return {
      success: false,
      created,
      output: lines.join("\n"),
      status,
      gitignore,
      error: `SnFlow assets incomplete after init: missing ${status.missingManagedFiles.join(", ") || ".version"}`,
    };
  }
  return {
    success: true,
    created,
    output: lines.join("\n"),
    status,
    gitignore,
  };
}

export function updateWorkflowProject(
  cwd: string,
  options: WorkflowSetupOptions = {},
): WorkflowSetupCommandResponse {
  const trackInGit = options.trackInGit === true;
  const ctx = createStoreContext(cwd);
  assertSetupWriteBoundary(ctx.workspaceRoot);
  if (!isDirectory(ctx.tasksRoot)) {
    return {
      success: false,
      output: "",
      error: "SnFlow is not initialized for this project. Run Initialize first.",
      status: getWorkflowSetupStatus(ctx.workspaceRoot),
    };
  }

  const before = getWorkflowSetupStatus(ctx.workspaceRoot);
  const lines: string[] = [];
  lines.push(
    `Updating SnFlow assets (project ${before.projectVersion ?? "none"} → bundled ${SNFLOW_ASSETS_VERSION}).`,
  );

  // Ensure archive dir exists; never touch tasks/ contents.
  mkdirSync(ctx.archiveRoot, { recursive: true });

  let webuiRoot: string;
  try {
    webuiRoot = resolveWebuiRoot();
  } catch (error) {
    return {
      success: false,
      output: lines.join("\n"),
      status: getWorkflowSetupStatus(ctx.workspaceRoot),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const written = installManagedFiles(ctx.workspaceRoot, SNFLOW_ASSET_FILES, webuiRoot);
  lines.push(`Rewrote ${written.length} managed SnFlow file(s):`);
  for (const file of written) lines.push(`  - ${file}`);

  applySpecInstallResult(ctx.workspaceRoot, lines, {
    restorePreviousCurrent: true,
  });

  writeVersionFile(ctx.workflowsRoot, SNFLOW_ASSETS_VERSION);
  lines.push(`Updated ${WORKFLOW_ROOT_SEGMENTS.join("/")}/${VERSION_FILE} = ${SNFLOW_ASSETS_VERSION}`);
  lines.push("Task data under tasks/ and archived/ was not modified.");

  const gitignore = applyGitPolicyLines(ctx.workspaceRoot, trackInGit, lines);

  const status = getWorkflowSetupStatus(ctx.workspaceRoot);
  return {
    success: true,
    output: lines.join("\n"),
    status,
    gitignore,
  };
}
