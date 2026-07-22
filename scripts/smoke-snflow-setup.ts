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
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(path.join(tmpdir(), "snflow-setup-"));
const legacy = mkdtempSync(path.join(tmpdir(), "snflow-legacy-"));

try {
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
  assert(gi.includes(".pi/snflows/"), "gitignore should list snflows");
  status = getWorkflowSetupStatus(root);
  assert(status.recommendedAction === "ready", `expected ready, got ${status.recommendedAction}`);
  assert(status.hasExtension && status.hasSkill && status.hasAgents && status.hasScript, "managed assets missing");
  assert(hasWorkflowExtension(root), "hasWorkflowExtension should be true");
  assert(existsSync(path.join(root, ".pi", "snflows", ".version")), "version file missing");
  assert(existsSync(path.join(root, "scripts", "snflow-task.ts")), "script missing");

  const ext = readFileSync(path.join(root, ".pi", "extensions", "snflow", "index.ts"), "utf8");
  assert(ext.includes("before_agent_start"), "extension missing before_agent_start");
  assert(ext.includes("buildGuidance"), "extension missing buildGuidance");
  assert(ext.includes(".join(\"\\n\")"), "extension should join with real newlines");
  assert(ext.includes("`Active SnFlow task: ${base}`"), "extension template literals broken");

  mkdirSync(path.join(legacy, ".pi", "snflows", "tasks"), { recursive: true });
  let legacyStatus = getWorkflowSetupStatus(legacy);
  assert(legacyStatus.initialized, "legacy tasks dir should count as initialized");
  assert(legacyStatus.recommendedAction === "update", "legacy without assets should need update");
  const updated = updateWorkflowProject(legacy, { trackInGit: false });
  assert(updated.success, "legacy update should succeed");
  legacyStatus = getWorkflowSetupStatus(legacy);
  assert(legacyStatus.recommendedAction === "ready", "legacy after update should be ready");
  assert(legacyStatus.hasExtension, "legacy update should install extension");

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

  // tasks data must survive update
  const marker = path.join(root, ".pi", "snflows", "tasks", "keep-me.txt");
  writeFileSync(marker, "safe\n", "utf8");
  updateWorkflowProject(root, { trackInGit: false });
  assert(readFileSync(marker, "utf8").includes("safe"), "update must not touch task files");

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

  // ---- Wrapper subprocess invocation smoke test ----
  // Create a temp external workspace, init it, verify wrapper content, then
  // actually invoke the generated wrapper via npx tsx from the external cwd
  // (matching the real usage pattern).
  const external = mkdtempSync(path.join(tmpdir(), "snflow-external-"));
  try {
    writeFileSync(
      path.join(external, "package.json"),
      JSON.stringify({ name: "test-external", private: true, type: "module" }, null, 2),
      "utf8",
    );

    const extInit = initializeWorkflowProject(external, { trackInGit: false });
    assert(extInit.success, "external project init should succeed");

    const webuiRoot = resolveWebuiRoot();
    const wrapperScript = path.join(external, "scripts", "snflow-task.ts");
    assert(existsSync(wrapperScript), "wrapper script should exist");

    // Verify wrapper content: must use in-process import, not spawn with --import tsx
    const wrContent = readFileSync(wrapperScript, "utf8");
    const expectedMarker = JSON.stringify(webuiRoot);
    assert(
      wrContent.includes(expectedMarker),
      "wrapper should embed WebUI root path",
    );
    assert(
      wrContent.includes('await import(pathToFileURL(TARGET).href)'),
      "wrapper must use in-process dynamic import, not spawnSync",
    );
    assert(
      wrContent.includes('async () =>'),
      "wrapper must wrap top-level code in async IIFE (no top-level await)",
    );
    assert(
      !wrContent.includes('spawnSync'),
      "wrapper must NOT use spawnSync",
    );
    assert(
      !wrContent.includes('createRequire'),
      "wrapper must NOT use createRequire resolution",
    );
    assert(
      !wrContent.includes('fileURLToPath'),
      "wrapper must NOT use fileURLToPath heuristics",
    );

    // Helper: invoke the wrapper via the locally-installed tsx CLI entry.
    // Using the local node_modules/tsx avoids the npx cache which may contain
    // a broken version that fails to resolve ESM-only package exports.
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
          // Help tsx find modules when the external project has none.
          NODE_PATH: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules"),
        },
        timeout: 120000,
      });
    }

    // 1) Create a task
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

    // 2) Verify task files on disk
    const tasksDir = path.join(external, ".pi", "snflows", "tasks");
    const taskDirs = readdirSync(tasksDir).filter((n) => n !== "keep-me.txt");
    assert(taskDirs.length === 1, `expected one task dir, got ${JSON.stringify(taskDirs)}`);

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

    // 3) Verify current.json pointer
    const currentJson = path.join(external, ".pi", "snflows", "current.json");
    assert(existsSync(currentJson), "current.json must exist after create");
    const current = JSON.parse(readFileSync(currentJson, "utf8")) as { taskId: string };
    assert(current.taskId === taskMeta.id, `current task should match created task: ${current.taskId} vs ${taskMeta.id}`);

    // 4) Verify list output
    const list = runWrapper(["list"]);
    assert(list.status === 0, `wrapper list exited ${list.status}, expected 0`);
    const listOut = list.stdout?.toString() ?? "";
    assert(listOut.includes("planning"), `list output should show planning, got: ${listOut.slice(0, 400)}`);

    // 5) Verify show output
    const show = runWrapper(["show", taskMeta.id]);
    assert(show.status === 0, `wrapper show exited ${show.status}, expected 0`);
    const showOut = show.stdout?.toString() ?? "";
    assert(showOut.includes(taskMeta.id), `show output should include task id: ${showOut.slice(0, 400)}`);

    // 6) Verify current command
    const cur = runWrapper(["current"]);
    assert(cur.status === 0, `wrapper current exited ${cur.status}, expected 0`);
    const curOut = cur.stdout?.toString() ?? "";
    assert(curOut.includes(taskMeta.id), `current output should include task id: ${curOut.slice(0, 400)}`);

    console.log("smoke-snflow-setup: wrapper subprocess invocation OK");
  } finally {
    rmSync(external, { recursive: true, force: true });
  }

  console.log("smoke-snflow-setup: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
}
