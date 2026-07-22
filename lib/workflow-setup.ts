/**
 * Project-level SnFlow detection, initialization, and asset updates.
 *
 * A project is "initialized" when <cwd>/.pi/snflows/tasks/ exists (backward
 * compatible). Full setup also installs managed extension/skill/agent/script
 * files and writes .pi/snflows/.version from the bundled asset manifest.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
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
  createStoreContext,
} from "./workflow-store";

export type WorkflowSetupRecommendedAction = "initialize" | "update" | "ready";

export interface WorkflowSetupStatus {
  cwd: string;
  /** tasks/ directory exists — backward-compatible initialized signal. */
  initialized: boolean;
  hasSnflowsDir: boolean;
  hasTasksDir: boolean;
  hasArchivedDir: boolean;
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

/** Case-insensitive containment check (Windows drive letter / realpath safe). */
function pathIsInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const normRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget === normRoot || normTarget.startsWith(rootWithSep);
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
 * SnFlow is active for a session only when the selected project has been
 * initialized (`.pi/snflows/tasks/` exists). There is no global enable switch:
 * uninitialized projects never force SnFlow guidance/skills/agents.
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
  const projectVersion = readProjectVersion(ctx.workflowsRoot);
  const missingManagedFiles = listMissingManagedFiles(ctx.workspaceRoot);
  const hasExtension = isFile(toAbsolute(ctx.workspaceRoot, EXTENSION_REL));
  const hasSkill = isFile(toAbsolute(ctx.workspaceRoot, SKILL_REL));
  const hasAgents =
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
