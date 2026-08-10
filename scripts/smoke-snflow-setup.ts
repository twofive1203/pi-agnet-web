/**
 * Deterministic smoke checks for SnFlow project init/update/version assets.
 * Run: npx --yes tsx scripts/smoke-snflow-setup.ts
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";
import {
  SNFLOW_ASSET_FILES,
  SNFLOW_ASSETS_VERSION,
} from "../lib/snflow-assets";
import {
  AGENTS_MD_MANAGED_SECTION,
  AGENTS_MD_MARKER_BEGIN,
  AGENTS_MD_MARKER_END,
  BOOTSTRAP_SPEC_TASK_ID,
  BOOTSTRAP_TASK_DOCS,
  SNFLOW_SPEC_FILES,
} from "../lib/snflow-spec-templates";
import {
  getWorkflowCurrentTaskId,
  setWorkflowCurrentTask,
} from "../lib/workflow-current";
import {
  WorkflowSecurityError,
  createWorkflowTask,
  hasActiveNonArchivedWorkflowTask,
} from "../lib/workflow-store";
import {
  SNFLOW_GITIGNORE_BEGIN,
  SNFLOW_GITIGNORE_END,
  applySnflowGitignorePolicy,
} from "../lib/workflow-gitignore";
import {
  getWorkflowSetupStatus,
  hasWorkflowExtension,
  initializeWorkflowProject,
  isSnflowActiveForSession,
  isSnflowManagedAgentPath,
  isSnflowManagedExtensionPath,
  isSnflowManagedSkill,
  resolveWebuiRoot,
  updateWorkflowProject,
  versionLessThan,
} from "../lib/workflow-setup";

function writeTaskJson(taskDir: string, partial: Record<string, unknown>): void {
  mkdirSync(taskDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    path.join(taskDir, "task.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: partial.id,
      title: partial.title ?? "Task",
      description: "",
      status: partial.status ?? "planning",
      priority: "P2",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      revision: "manual",
      activeRunId: null,
      latestImplementRunId: null,
      latestCheckRunId: null,
      commit: null,
      ...partial,
    }, null, 2)}\n`,
    "utf8",
  );
  for (const name of ["requirements.md", "design.md", "plan.md"]) {
    writeFileSync(path.join(taskDir, name), `# ${name}\n`, "utf8");
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function runGit(cwd: string, args: string[]): SpawnSyncReturns<Buffer> {
  return spawnSync("git", args, { cwd, stdio: "pipe" });
}

function assertGitIgnored(cwd: string, relativePath: string, expected: boolean): void {
  const result = runGit(cwd, ["check-ignore", "-q", "--", relativePath]);
  const actual = result.status === 0;
  assert(
    actual === expected,
    `git check-ignore ${relativePath}: expected ignored=${expected}, status=${String(result.status)}, stderr=${result.stderr?.toString() ?? ""}`,
  );
}

function assertSetupSecurityRejection(action: () => unknown, label: string): void {
  let rejected = false;
  try {
    action();
  } catch (error) {
    rejected = error instanceof WorkflowSecurityError;
  }
  assert(rejected, `${label} must fail closed with WorkflowSecurityError`);
}

const root = mkdtempSync(path.join(tmpdir(), "snflow-setup-"));
const legacy = mkdtempSync(path.join(tmpdir(), "snflow-legacy-"));

try {
  const gitInit = runGit(root, ["init", "-q"]);
  assert(gitInit.status === 0, `git init failed: ${gitInit.stderr?.toString() ?? ""}`);

  let status = getWorkflowSetupStatus(root);
  assert(status.recommendedAction === "initialize", "fresh project should recommend initialize");
  assert(!status.initialized, "fresh project should not be initialized");

  const init = initializeWorkflowProject(root, { trackInGit: false });
  assert(init.success, "init should succeed");
  assert(init.created, "init should create tasks dir");
  assert(init.gitignore?.action === "ignored", "default init should ignore in git");
  assert(existsSync(path.join(root, ".gitignore")), ".gitignore should be created");
  const gi = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert(gi.includes(SNFLOW_GITIGNORE_BEGIN) && gi.includes(SNFLOW_GITIGNORE_END), "gitignore block markers");
  assert(gi.includes(".pi/snflows/*"), "gitignore should ignore SnFlow children");
  assert(gi.includes("!.pi/snflows/spec/"), "gitignore should re-include project specs");
  status = getWorkflowSetupStatus(root);
  assert(status.recommendedAction === "ready", `expected ready, got ${status.recommendedAction}`);
  assert(status.hasSpec, "fresh init should report hasSpec");
  assert(status.hasExtension && status.hasSkill && status.hasAgents && status.hasScript, "managed assets missing");
  assert(hasWorkflowExtension(root), "hasWorkflowExtension should be true");
  assert(existsSync(path.join(root, ".pi", "snflows", ".version")), "version file missing");
  assert(existsSync(path.join(root, "scripts", "snflow-task.ts")), "script missing");
  assert(!existsSync(path.join(root, "AGENTS.md")), "setup must leave AGENTS.md to the bootstrap task");

  // Seven skeleton files + bootstrap docs + current pointer on first init.
  assert(SNFLOW_SPEC_FILES.length === 7, `expected seven templates, got ${SNFLOW_SPEC_FILES.length}`);
  for (const file of SNFLOW_SPEC_FILES) {
    const installedPath = path.join(root, ...file.path.split("/"));
    assert(existsSync(installedPath), `spec template missing: ${file.path}`);
    assert(
      readFileSync(installedPath, "utf8") === file.content,
      `spec template content mismatch: ${file.path}`,
    );
  }

  const bootstrapDir = path.join(root, ".pi", "snflows", "tasks", BOOTSTRAP_SPEC_TASK_ID);
  for (const fileName of ["task.json", "requirements.md", "design.md", "plan.md"]) {
    assert(existsSync(path.join(bootstrapDir, fileName)), `bootstrap file missing: ${fileName}`);
  }
  const bootstrapTask = JSON.parse(readFileSync(path.join(bootstrapDir, "task.json"), "utf8")) as {
    id: string;
    title: string;
    status: string;
  };
  assert(bootstrapTask.id === BOOTSTRAP_SPEC_TASK_ID, "bootstrap task id mismatch");
  assert(bootstrapTask.title === BOOTSTRAP_TASK_DOCS.title, "bootstrap task title mismatch");
  assert(bootstrapTask.status === "planning", "bootstrap task should start in planning");
  assert(
    readFileSync(path.join(bootstrapDir, "requirements.md"), "utf8") === BOOTSTRAP_TASK_DOCS.requirements,
    "bootstrap requirements mismatch",
  );
  const bootstrapPlan = readFileSync(path.join(bootstrapDir, "plan.md"), "utf8");
  assert(bootstrapPlan === BOOTSTRAP_TASK_DOCS.plan, "bootstrap plan mismatch");
  assert(
    bootstrapPlan.includes("Only after steps 1-5 are complete"),
    "bootstrap plan must finish the specification before updating AGENTS.md",
  );
  assert(
    bootstrapPlan.includes(AGENTS_MD_MANAGED_SECTION),
    "bootstrap plan should carry the exact AGENTS.md managed section",
  );
  for (const directive of [
    "If AGENTS.md is missing, create it with this block",
    "If both markers already exist in the correct order, replace only the inclusive marked block",
    "If neither marker exists, append one blank line and this block",
    "If only one marker exists, or the end marker precedes the begin marker, stop and report",
    "Preserve all bytes outside the managed block",
  ]) {
    assert(bootstrapPlan.includes(directive), `bootstrap plan missing AGENTS.md directive: ${directive}`);
  }
  assert(
    AGENTS_MD_MANAGED_SECTION.startsWith(AGENTS_MD_MARKER_BEGIN) &&
      AGENTS_MD_MANAGED_SECTION.endsWith(AGENTS_MD_MARKER_END),
    "AGENTS.md managed section markers mismatch",
  );
  assert(
    AGENTS_MD_MANAGED_SECTION.split(AGENTS_MD_MARKER_BEGIN).length === 2 &&
      AGENTS_MD_MANAGED_SECTION.split(AGENTS_MD_MARKER_END).length === 2,
    "AGENTS.md managed section must contain exactly one marker pair",
  );
  assert(getWorkflowCurrentTaskId(root) === BOOTSTRAP_SPEC_TASK_ID, "bootstrap should be current after first init");
  assertGitIgnored(root, ".pi/snflows/tasks/00-bootstrap-spec/task.json", true);
  assertGitIgnored(root, ".pi/snflows/spec/index.md", false);

  const ext = readFileSync(path.join(root, ".pi", "extensions", "snflow", "index.ts"), "utf8");
  assert(ext.includes("before_agent_start"), "extension missing before_agent_start");
  assert(ext.includes("buildGuidance"), "extension missing buildGuidance");
  assert(ext.includes(".join(\"\\n\")"), "extension should join with real newlines");
  assert(
    ext.includes("Default path: the main Agent reads the approved task documents"),
    "ready-state guidance must keep the main Agent as the default writer",
  );
  assert(
    ext.includes("This task is already on the exceptional run-backed implement/check path"),
    "delegated lifecycle guidance must be limited to tasks already using the run-backed path",
  );
  assert(
    !ext.includes("The current chat native subagent tool is the only implement/check path"),
    "extension must not retain the old mandatory subagent path",
  );
  assert(
    !ext.includes("Approval to implement means dispatch snflow-implement"),
    "planning guidance must not force implementation delegation",
  );
  assert(
    ext.includes("Implementation and required validation are complete"),
    "ready-to-commit guidance must support both direct and delegated validation paths",
  );
  assert(
    ext.includes("If this task produced reusable conventions or lessons"),
    "ready-to-commit guidance must preserve project knowledge capture",
  );
  assert(ext.includes("`Active SnFlow task: ${base}`"), "extension template literals broken");
  assert(ext.includes("specRevision") && ext.includes("runId"), "extension dispatch must bind run and specification snapshot");
  assert(
    ext.includes("If only one marker exists or marker order is invalid"),
    "extension bootstrap guidance should fail closed on malformed AGENTS.md markers",
  );
  const transpiledExtension = ts.transpileModule(ext, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  const extensionErrors = (transpiledExtension.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert(extensionErrors.length === 0, `extension parse errors: ${extensionErrors.map((item) => item.code).join(", ")}`);
  const installedSearchAgent = readFileSync(path.join(root, ".pi", "agents", "snflow-search.md"), "utf8");
  assert(installedSearchAgent.includes("acceptanceRole: read-only"), "search agent must declare read-only acceptance");
  assert(installedSearchAgent.includes('turnBudget: {"maxTurns":5'), "search agent must have a tight turn budget");
  assert(installedSearchAgent.includes("roughly 1,500 characters"), "search agent output must stay bounded");
  const installedCheckAgent = readFileSync(path.join(root, ".pi", "agents", "snflow-check.md"), "utf8");
  assert(installedCheckAgent.includes("acceptanceRole: read-only"), "check agent must declare read-only acceptance");
  assert(installedCheckAgent.includes("completionGuard: false"), "check agent must disable implementation completion guard");
  const installedImplementAgent = readFileSync(path.join(root, ".pi", "agents", "snflow-implement.md"), "utf8");
  assert(installedImplementAgent.includes("completionGuard: true"), "implement agent must retain mutation-effect observation");

  const webuiRoot = resolveWebuiRoot();
  for (const asset of SNFLOW_ASSET_FILES.filter((file) => file.path !== "scripts/snflow-task.ts")) {
    const repositoryCopy = readFileSync(path.join(webuiRoot, ...asset.path.split("/")), "utf8");
    assert(repositoryCopy === asset.content, `repository/embedded asset mismatch: ${asset.path}`);
  }
  assert(
    readFileSync(path.join(webuiRoot, ".pi", "snflows", ".version"), "utf8").trim() === SNFLOW_ASSETS_VERSION,
    "repository asset version marker mismatch",
  );

  // Setup/update own SnFlow assets and bootstrap docs, never project-root AGENTS.md.
  const agentsOwnerProject = mkdtempSync(path.join(tmpdir(), "snflow-agents-owner-"));
  try {
    const agentsPath = path.join(agentsOwnerProject, "AGENTS.md");
    const ownerBytes = Buffer.from("# Project instructions\r\n\r\nKeep these bytes unchanged.\r\n", "utf8");
    writeFileSync(agentsPath, ownerBytes);
    const ownerInit = initializeWorkflowProject(agentsOwnerProject, { trackInGit: false });
    assert(ownerInit.success, "init with project-owned AGENTS.md should succeed");
    assert(readFileSync(agentsPath).equals(ownerBytes), "init must preserve project-owned AGENTS.md bytes");
    const ownerUpdate = updateWorkflowProject(agentsOwnerProject, { trackInGit: false });
    assert(ownerUpdate.success, "update with project-owned AGENTS.md should succeed");
    assert(readFileSync(agentsPath).equals(ownerBytes), "update must preserve project-owned AGENTS.md bytes");
  } finally {
    rmSync(agentsOwnerProject, { recursive: true, force: true });
  }

  // Legacy project: update installs skeleton + bootstrap, restores prior current.
  mkdirSync(path.join(legacy, ".pi", "snflows", "tasks"), { recursive: true });
  const legacyTask = createWorkflowTask(legacy, {
    id: "existing-task",
    title: "Existing task",
  });
  assert(getWorkflowCurrentTaskId(legacy) === legacyTask.id, "legacy task should be current before update");
  let legacyStatus = getWorkflowSetupStatus(legacy);
  assert(legacyStatus.initialized, "legacy tasks dir should count as initialized");
  assert(legacyStatus.recommendedAction === "update", "legacy without assets should need update");
  const updated = updateWorkflowProject(legacy, { trackInGit: false });
  assert(updated.success, "legacy update should succeed");
  legacyStatus = getWorkflowSetupStatus(legacy);
  assert(legacyStatus.recommendedAction === "ready", "legacy after update should be ready");
  assert(legacyStatus.hasSpec, "legacy update should install spec skeleton");
  assert(legacyStatus.hasExtension, "legacy update should install extension");
  assert(
    existsSync(path.join(legacy, ".pi", "snflows", "tasks", BOOTSTRAP_SPEC_TASK_ID)),
    "legacy update should create bootstrap task with new skeleton",
  );
  assert(
    getWorkflowCurrentTaskId(legacy) === legacyTask.id,
    "legacy update should restore the prior current task",
  );

  // Pre-existing user-owned spec (including empty): skip skeleton + bootstrap.
  const ownedSpecProject = mkdtempSync(path.join(tmpdir(), "snflow-owned-spec-"));
  try {
    const ownedSpecDir = path.join(ownedSpecProject, ".pi", "snflows", "spec");
    mkdirSync(ownedSpecDir, { recursive: true });
    const ownedFile = path.join(ownedSpecDir, "custom.md");
    writeFileSync(ownedFile, "# User-owned\n", "utf8");
    const ownedInit = initializeWorkflowProject(ownedSpecProject, { trackInGit: false });
    assert(ownedInit.success, "init with pre-existing user spec should succeed");
    assert(readFileSync(ownedFile, "utf8") === "# User-owned\n", "user spec must remain unchanged");
    assert(!existsSync(path.join(ownedSpecDir, "index.md")), "setup must not merge templates into user spec");
    assert(
      !existsSync(path.join(ownedSpecProject, ".pi", "snflows", "tasks", BOOTSTRAP_SPEC_TASK_ID)),
      "pre-existing spec must not create bootstrap task",
    );
  } finally {
    rmSync(ownedSpecProject, { recursive: true, force: true });
  }

  const emptySpecProject = mkdtempSync(path.join(tmpdir(), "snflow-empty-spec-"));
  try {
    const emptySpecDir = path.join(emptySpecProject, ".pi", "snflows", "spec");
    mkdirSync(emptySpecDir, { recursive: true });
    const emptySpecInit = initializeWorkflowProject(emptySpecProject, { trackInGit: false });
    assert(emptySpecInit.success, "init with empty user-owned spec should succeed");
    assert(readdirSync(emptySpecDir).length === 0, "empty user-owned spec must win unchanged");
    assert(
      !existsSync(path.join(emptySpecProject, ".pi", "snflows", "tasks", BOOTSTRAP_SPEC_TASK_ID)),
      "empty user-owned spec must not create bootstrap task",
    );
  } finally {
    rmSync(emptySpecProject, { recursive: true, force: true });
  }

  // First init ignores a stale pointer and selects bootstrap.
  const staleInitProject = mkdtempSync(path.join(tmpdir(), "snflow-stale-init-"));
  try {
    const snflowsRoot = path.join(staleInitProject, ".pi", "snflows");
    mkdirSync(snflowsRoot, { recursive: true });
    writeFileSync(
      path.join(snflowsRoot, "current.json"),
      `${JSON.stringify({ taskId: "removed-task", updatedAt: new Date(0).toISOString() })}\n`,
      "utf8",
    );
    const staleInit = initializeWorkflowProject(staleInitProject, { trackInGit: false });
    assert(staleInit.success, "first init with stale current pointer should succeed");
    assert(
      getWorkflowCurrentTaskId(staleInitProject) === BOOTSTRAP_SPEC_TASK_ID,
      "first init must select bootstrap instead of restoring stale current pointer",
    );
  } finally {
    rmSync(staleInitProject, { recursive: true, force: true });
  }

  // Update with stale current: bootstrap becomes current (stale not restorable).
  const staleUpdateProject = mkdtempSync(path.join(tmpdir(), "snflow-stale-update-"));
  try {
    const snflowsRoot = path.join(staleUpdateProject, ".pi", "snflows");
    mkdirSync(path.join(snflowsRoot, "tasks"), { recursive: true });
    writeFileSync(
      path.join(snflowsRoot, "current.json"),
      `${JSON.stringify({ taskId: "removed-task", updatedAt: new Date(0).toISOString() })}\n`,
      "utf8",
    );
    const staleUpdate = updateWorkflowProject(staleUpdateProject, { trackInGit: false });
    assert(staleUpdate.success, "update with stale current pointer should succeed");
    assert(
      getWorkflowCurrentTaskId(staleUpdateProject) === BOOTSTRAP_SPEC_TASK_ID,
      "update must not restore a current pointer that does not resolve to an active task",
    );
  } finally {
    rmSync(staleUpdateProject, { recursive: true, force: true });
  }

  // Active-only current restoration: physical archived/ must never restore.
  const archivedRestore = mkdtempSync(path.join(tmpdir(), "snflow-archived-restore-"));
  try {
    const snflowsRoot = path.join(archivedRestore, ".pi", "snflows");
    mkdirSync(path.join(snflowsRoot, "tasks"), { recursive: true });
    const archivedTaskId = "kept-archived-task";
    writeTaskJson(path.join(snflowsRoot, "archived", archivedTaskId), {
      id: archivedTaskId,
      title: "Archived",
      archived: false, // misleading metadata
    });
    setWorkflowCurrentTask(archivedRestore, archivedTaskId, { source: "select" });
    assert(
      !hasActiveNonArchivedWorkflowTask(archivedRestore, archivedTaskId),
      "physical archived location must not count as active",
    );

    const recovered = updateWorkflowProject(archivedRestore, { trackInGit: false });
    assert(recovered.success, "update with archived current pointer should succeed");
    assert(
      getWorkflowCurrentTaskId(archivedRestore) === BOOTSTRAP_SPEC_TASK_ID,
      "archived task must not be restored as current after bootstrap",
    );
    assert(
      existsSync(path.join(snflowsRoot, "archived", archivedTaskId, "task.json")),
      "archived task files must remain",
    );
  } finally {
    rmSync(archivedRestore, { recursive: true, force: true });
  }

  // Archived with missing archived flag still not restorable.
  const archivedMissingRestore = mkdtempSync(path.join(tmpdir(), "snflow-archived-missing-"));
  try {
    const snflowsRoot = path.join(archivedMissingRestore, ".pi", "snflows");
    mkdirSync(path.join(snflowsRoot, "tasks"), { recursive: true });
    const archivedMissing = "archived-missing-flag";
    const missingDir = path.join(snflowsRoot, "archived", archivedMissing);
    writeTaskJson(missingDir, { id: archivedMissing, title: "Missing flag" });
    const raw = JSON.parse(readFileSync(path.join(missingDir, "task.json"), "utf8")) as Record<string, unknown>;
    delete raw.archived;
    writeFileSync(path.join(missingDir, "task.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    setWorkflowCurrentTask(archivedMissingRestore, archivedMissing, { source: "select" });
    assert(
      !hasActiveNonArchivedWorkflowTask(archivedMissingRestore, archivedMissing),
      "archived path with missing archived field is not active",
    );
    const recovered = updateWorkflowProject(archivedMissingRestore, { trackInGit: false });
    assert(recovered.success, "update should succeed with archived missing-flag current");
    assert(
      getWorkflowCurrentTaskId(archivedMissingRestore) === BOOTSTRAP_SPEC_TASK_ID,
      "must not restore archived task with missing archived metadata",
    );
  } finally {
    rmSync(archivedMissingRestore, { recursive: true, force: true });
  }

  assert(versionLessThan("1.0.0", "1.0.1"), "1.0.0 < 1.0.1");
  assert(!versionLessThan("1.0.1", "1.0.0"), "1.0.1 !< 1.0.0");
  assert(!versionLessThan("1.0.0", "1.0.0"), "equal is not less");
  assert(versionLessThan(undefined, "1.0.0"), "missing version is less");

  writeFileSync(path.join(root, ".pi", "snflows", ".version"), "0.9.0\n", "utf8");
  status = getWorkflowSetupStatus(root);
  assert(status.updateAvailable && status.recommendedAction === "update", "downgraded version should need update");
  const bump = updateWorkflowProject(root, { trackInGit: false });
  assert(bump.success, "version bump update should succeed");
  status = getWorkflowSetupStatus(root);
  assert(!status.updateAvailable && status.recommendedAction === "ready", "after bump should be ready");

  // User task/spec data and current selection must survive update.
  const marker = path.join(root, ".pi", "snflows", "tasks", "keep-me.txt");
  const specMarker = path.join(root, ".pi", "snflows", "spec", "index.md");
  const customSpec = "# User-owned specification\n\nDo not overwrite.\n";
  writeFileSync(marker, "safe\n", "utf8");
  writeFileSync(specMarker, customSpec, "utf8");
  const selectedTask = createWorkflowTask(root, { id: "selected-task", title: "Selected task" });
  updateWorkflowProject(root, { trackInGit: false });
  assert(readFileSync(marker, "utf8").includes("safe"), "update must not touch task files");
  assert(readFileSync(specMarker, "utf8") === customSpec, "update must preserve user spec content");
  assert(getWorkflowCurrentTaskId(root) === selectedTask.id, "update must preserve current task");

  // Deleted/archived bootstrap is not recreated when spec already exists.
  const archivedBootstrap = path.join(root, ".pi", "snflows", "archived", BOOTSTRAP_SPEC_TASK_ID);
  renameSync(bootstrapDir, archivedBootstrap);
  updateWorkflowProject(root, { trackInGit: false });
  assert(!existsSync(bootstrapDir), "update must not recreate archived bootstrap task");
  assert(existsSync(archivedBootstrap), "archived bootstrap task must remain untouched");
  rmSync(archivedBootstrap, { recursive: true, force: true });
  updateWorkflowProject(root, { trackInGit: false });
  assert(!existsSync(bootstrapDir), "update must not recreate deleted bootstrap when spec remains");

  assert(isSnflowActiveForSession(root), "initialized project should activate SnFlow");
  const emptyProject = mkdtempSync(path.join(tmpdir(), "snflow-empty-"));
  try {
    assert(
      !isSnflowActiveForSession(emptyProject),
      "uninitialized project must not activate SnFlow",
    );
  } finally {
    rmSync(emptyProject, { recursive: true, force: true });
  }
  assert(
    isSnflowManagedExtensionPath(path.join(root, ".pi", "extensions", "snflow", "index.ts")),
    "extension path detector",
  );
  assert(isSnflowManagedSkill({ name: "snflow-dev" }), "skill name detector");
  assert(isSnflowManagedAgentPath(path.join(root, ".pi", "agents", "snflow-implement.md")), "agent path detector");
  assert(!isSnflowManagedExtensionPath(path.join(root, ".pi", "extensions", "other", "index.ts")), "non-snflow ext");

  const tracked = updateWorkflowProject(root, { trackInGit: true });
  assert(tracked.success, "update trackInGit=true should succeed");
  assert(
    tracked.gitignore?.action === "tracked" || tracked.gitignore?.action === "unchanged",
    "should remove ignore block",
  );
  const giTracked = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert(!giTracked.includes(SNFLOW_GITIGNORE_BEGIN), "managed block removed when trackInGit=true");

  const ignoredAgain = applySnflowGitignorePolicy(root, false);
  assert(ignoredAgain.changed && ignoredAgain.action === "ignored", "re-apply ignore policy");
  assertGitIgnored(root, ".pi/snflows/tasks/selected-task/task.json", true);
  assertGitIgnored(root, ".pi/snflows/spec/index.md", false);

  // Setup must reject workflow-root and spec symlink/junction escapes before writes.
  const escapeProject = mkdtempSync(path.join(tmpdir(), "snflow-escape-project-"));
  const escapeOutside = mkdtempSync(path.join(tmpdir(), "snflow-escape-outside-"));
  try {
    mkdirSync(path.join(escapeProject, ".pi"), { recursive: true });
    symlinkSync(
      escapeOutside,
      path.join(escapeProject, ".pi", "snflows"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assertSetupSecurityRejection(
      () => initializeWorkflowProject(escapeProject, { trackInGit: false }),
      ".pi/snflows escape",
    );
    assert(readdirSync(escapeOutside).length === 0, "workflow-root escape must not write outside cwd");
    assert(!existsSync(path.join(escapeProject, ".gitignore")), "escape rejection must happen before setup writes");
  } finally {
    rmSync(escapeProject, { recursive: true, force: true });
    rmSync(escapeOutside, { recursive: true, force: true });
  }

  const specLinkProject = mkdtempSync(path.join(tmpdir(), "snflow-spec-link-project-"));
  const specLinkOutside = mkdtempSync(path.join(tmpdir(), "snflow-spec-link-outside-"));
  try {
    mkdirSync(path.join(specLinkProject, ".pi", "snflows", "tasks"), { recursive: true });
    symlinkSync(
      specLinkOutside,
      path.join(specLinkProject, ".pi", "snflows", "spec"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert(!getWorkflowSetupStatus(specLinkProject).hasSpec, "linked external spec must not count as hasSpec");
    assertSetupSecurityRejection(
      () => updateWorkflowProject(specLinkProject, { trackInGit: false }),
      "spec link escape",
    );
    assert(readdirSync(specLinkOutside).length === 0, "spec link escape must not write outside cwd");
    assert(!existsSync(path.join(specLinkProject, ".pi", "extensions")), "spec link rejection must precede asset writes");
  } finally {
    rmSync(specLinkProject, { recursive: true, force: true });
    rmSync(specLinkOutside, { recursive: true, force: true });
  }

  // current.json and bootstrap task-dir junction/symlink escapes must fail before any setup writes.
  function assertNoSetupMutation(projectRoot: string, outsideRoot: string, label: string): void {
    assert(readdirSync(outsideRoot).length === 0, `${label} must not write outside cwd`);
    assert(!existsSync(path.join(projectRoot, ".gitignore")), `${label} must precede gitignore write`);
    assert(!existsSync(path.join(projectRoot, ".pi", "extensions")), `${label} must precede asset writes`);
    assert(!existsSync(path.join(projectRoot, ".pi", "snflows", "spec")), `${label} must precede spec writes`);
    assert(
      !existsSync(path.join(projectRoot, "scripts", "snflow-task.ts")),
      `${label} must precede managed script write`,
    );
  }

  const pointerEscapeProject = mkdtempSync(path.join(tmpdir(), "snflow-current-escape-project-"));
  const pointerEscapeOutside = mkdtempSync(path.join(tmpdir(), "snflow-current-escape-outside-"));
  try {
    const snflowsDir = path.join(pointerEscapeProject, ".pi", "snflows");
    mkdirSync(path.join(snflowsDir, "tasks"), { recursive: true });
    mkdirSync(path.join(snflowsDir, "archived"), { recursive: true });
    const currentPath = path.join(snflowsDir, "current.json");
    const outsideFile = path.join(pointerEscapeOutside, "planted-current.json");
    writeFileSync(outsideFile, "{}\n", "utf8");
    let linkedCurrent = false;
    try {
      symlinkSync(outsideFile, currentPath, process.platform === "win32" ? "file" : undefined);
      linkedCurrent = true;
    } catch {
      // Windows without symlink privilege cannot create file symlinks; dir junctions still cover bootstrap below.
      linkedCurrent = false;
    }
    if (linkedCurrent) {
      assertSetupSecurityRejection(
        () => initializeWorkflowProject(pointerEscapeProject, { trackInGit: false }),
        "current.json escape",
      );
      // Only the planted outside file may exist; setup must not add siblings.
      assert(
        readdirSync(pointerEscapeOutside).every((name) => name === "planted-current.json"),
        "current.json escape must not write outside cwd",
      );
      assert(!existsSync(path.join(pointerEscapeProject, ".gitignore")), "current.json escape must precede gitignore write");
      assert(!existsSync(path.join(pointerEscapeProject, ".pi", "extensions")), "current.json escape must precede asset writes");
      assert(!existsSync(path.join(pointerEscapeProject, ".pi", "snflows", "spec")), "current.json escape must precede spec writes");
    }
  } finally {
    rmSync(pointerEscapeProject, { recursive: true, force: true });
    rmSync(pointerEscapeOutside, { recursive: true, force: true });
  }

  const bootstrapEscapeProject = mkdtempSync(path.join(tmpdir(), "snflow-bootstrap-escape-project-"));
  const bootstrapEscapeOutside = mkdtempSync(path.join(tmpdir(), "snflow-bootstrap-escape-outside-"));
  try {
    mkdirSync(path.join(bootstrapEscapeProject, ".pi", "snflows", "tasks"), { recursive: true });
    mkdirSync(path.join(bootstrapEscapeProject, ".pi", "snflows", "archived"), { recursive: true });
    symlinkSync(
      bootstrapEscapeOutside,
      path.join(bootstrapEscapeProject, ".pi", "snflows", "tasks", BOOTSTRAP_SPEC_TASK_ID),
      process.platform === "win32" ? "junction" : "dir",
    );
    assertSetupSecurityRejection(
      () => initializeWorkflowProject(bootstrapEscapeProject, { trackInGit: false }),
      "bootstrap active task dir escape",
    );
    assertNoSetupMutation(bootstrapEscapeProject, bootstrapEscapeOutside, "bootstrap active escape");
  } finally {
    rmSync(bootstrapEscapeProject, { recursive: true, force: true });
    rmSync(bootstrapEscapeOutside, { recursive: true, force: true });
  }

  const bootstrapArchivedEscapeProject = mkdtempSync(path.join(tmpdir(), "snflow-bootstrap-arch-escape-project-"));
  const bootstrapArchivedEscapeOutside = mkdtempSync(path.join(tmpdir(), "snflow-bootstrap-arch-escape-outside-"));
  try {
    mkdirSync(path.join(bootstrapArchivedEscapeProject, ".pi", "snflows", "tasks"), { recursive: true });
    mkdirSync(path.join(bootstrapArchivedEscapeProject, ".pi", "snflows", "archived"), { recursive: true });
    symlinkSync(
      bootstrapArchivedEscapeOutside,
      path.join(bootstrapArchivedEscapeProject, ".pi", "snflows", "archived", BOOTSTRAP_SPEC_TASK_ID),
      process.platform === "win32" ? "junction" : "dir",
    );
    assertSetupSecurityRejection(
      () => updateWorkflowProject(bootstrapArchivedEscapeProject, { trackInGit: false }),
      "bootstrap archived task dir escape",
    );
    assertNoSetupMutation(bootstrapArchivedEscapeProject, bootstrapArchivedEscapeOutside, "bootstrap archived escape");
  } finally {
    rmSync(bootstrapArchivedEscapeProject, { recursive: true, force: true });
    rmSync(bootstrapArchivedEscapeOutside, { recursive: true, force: true });
  }

  // ---- Wrapper subprocess invocation smoke test ----
  const external = mkdtempSync(path.join(tmpdir(), "snflow-external-"));
  try {
    writeFileSync(
      path.join(external, "package.json"),
      JSON.stringify({ name: "test-external", private: true, type: "module" }, null, 2),
      "utf8",
    );

    const extInit = initializeWorkflowProject(external, { trackInGit: false });
    assert(extInit.success, "external project init should succeed");

    const wrapperScript = path.join(external, "scripts", "snflow-task.ts");
    assert(existsSync(wrapperScript), "wrapper script should exist");

    const wrContent = readFileSync(wrapperScript, "utf8");
    const expectedMarker = JSON.stringify(webuiRoot);
    assert(wrContent.includes(expectedMarker), "wrapper should embed WebUI root path");
    assert(
      wrContent.includes('await import(pathToFileURL(TARGET).href)'),
      "wrapper must use in-process dynamic import, not spawnSync",
    );
    assert(wrContent.includes('async () =>'), "wrapper must wrap top-level code in async IIFE");
    assert(!wrContent.includes('spawnSync'), "wrapper must NOT use spawnSync");
    assert(!wrContent.includes('createRequire'), "wrapper must NOT use createRequire resolution");
    assert(!wrContent.includes('fileURLToPath'), "wrapper must NOT use fileURLToPath heuristics");

    const tsxCli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "node_modules",
      "tsx",
      "dist",
      "cli.mjs",
    );
    assert(existsSync(tsxCli), `tsx CLI entry must exist: ${tsxCli}`);

    function runWrapper(args: string[]): SpawnSyncReturns<Buffer> {
      return spawnSync(process.execPath, [tsxCli, wrapperScript, ...args], {
        cwd: external,
        stdio: "pipe",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
          NODE_PATH: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules"),
        },
        timeout: 120000,
      });
    }

    const create = runWrapper(["create", "test wrapper task", "--seed", "smoke check"]);
    assert(
      create.status === 0,
      [
        `wrapper create exited ${create.status} (expected 0)`,
        "STDOUT:",
        create.stdout?.toString()?.slice(0, 800) || "(empty)",
        "STDERR:",
        create.stderr?.toString()?.slice(0, 800) || "(empty)",
      ].join("\n"),
    );
    const createOut = create.stdout?.toString() ?? "";
    assert(createOut.includes("Active SnFlow task:"), `output should show active task, got: ${createOut.slice(0, 400)}`);
    assert(createOut.includes("id="), `output should show id, got: ${createOut.slice(0, 400)}`);
    assert(createOut.includes("status=planning"), `output should show planning, got: ${createOut.slice(0, 400)}`);

    const tasksDir = path.join(external, ".pi", "snflows", "tasks");
    const taskDirs = readdirSync(tasksDir).filter((name) => name !== BOOTSTRAP_SPEC_TASK_ID);
    assert(taskDirs.length === 1, `expected one non-bootstrap task dir, got ${JSON.stringify(taskDirs)}`);

    const taskDir = path.join(tasksDir, taskDirs[0]);
    assert(existsSync(path.join(taskDir, "task.json")), "task.json must exist");
    assert(existsSync(path.join(taskDir, "requirements.md")), "requirements.md must exist");
    assert(existsSync(path.join(taskDir, "design.md")), "design.md must exist");
    assert(existsSync(path.join(taskDir, "plan.md")), "plan.md must exist");

    const taskMeta = JSON.parse(readFileSync(path.join(taskDir, "task.json"), "utf8")) as {
      id: string;
      status: string;
    };
    assert(typeof taskMeta.id === "string" && taskMeta.status === "planning", `task meta: id=${taskMeta.id} status=${taskMeta.status}`);

    const reqContent = readFileSync(path.join(taskDir, "requirements.md"), "utf8");
    assert(reqContent.includes("# Requirements"), "requirements.md should have heading");

    const currentJson = path.join(external, ".pi", "snflows", "current.json");
    assert(existsSync(currentJson), "current.json must exist after create");
    const current = JSON.parse(readFileSync(currentJson, "utf8")) as { taskId: string };
    assert(current.taskId === taskMeta.id, `current task should match created task: ${current.taskId} vs ${taskMeta.id}`);

    const list = runWrapper(["list"]);
    assert(list.status === 0, `wrapper list exited ${list.status}, expected 0`);
    const listOut = list.stdout?.toString() ?? "";
    assert(listOut.includes("planning"), `list output should show planning, got: ${listOut.slice(0, 400)}`);

    const show = runWrapper(["show", taskMeta.id]);
    assert(show.status === 0, `wrapper show exited ${show.status}, expected 0`);
    const showOut = show.stdout?.toString() ?? "";
    assert(showOut.includes(taskMeta.id), `show output should include task id: ${showOut.slice(0, 400)}`);

    const cur = runWrapper(["current"]);
    assert(cur.status === 0, `wrapper current exited ${cur.status}, expected 0`);
    const curOut = cur.stdout?.toString() ?? "";
    assert(curOut.includes(taskMeta.id), `current output should include task id: ${curOut.slice(0, 400)}`);

    const start = runWrapper(["start", taskMeta.id]);
    assert(start.status === 0, `wrapper start exited ${start.status}, expected 0`);
    assert((start.stdout?.toString() ?? "").includes("status=ready"), "start should mark task ready");
    const handoff = runWrapper(["handoff", taskMeta.id]);
    assert(handoff.status === 0, `wrapper handoff exited ${handoff.status}, expected 0`);
    assert(
      (handoff.stdout?.toString() ?? "").includes("status=ready_to_commit"),
      "handoff should mark validated direct work ready_to_commit",
    );

    console.log("smoke-snflow-setup: wrapper subprocess invocation OK");
  } finally {
    rmSync(external, { recursive: true, force: true });
  }

  console.log("smoke-snflow-setup: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
}
