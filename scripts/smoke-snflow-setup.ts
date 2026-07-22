/**
 * Deterministic smoke checks for SnFlow project init/update/version assets.
 * Run: npx --yes tsx scripts/smoke-snflow-setup.ts
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  getWorkflowSetupStatus,
  hasWorkflowExtension,
  initializeWorkflowProject,
  isSnflowActiveForSession,
  isSnflowManagedAgentPath,
  isSnflowManagedExtensionPath,
  isSnflowManagedSkill,
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

  const init = initializeWorkflowProject(root);
  assert(init.success, "init should succeed");
  assert(init.created, "init should create tasks dir");
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
  const updated = updateWorkflowProject(legacy);
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
  const bump = updateWorkflowProject(root);
  assert(bump.success, "version bump update should succeed");
  status = getWorkflowSetupStatus(root);
  assert(!status.updateAvailable && status.recommendedAction === "ready", "after bump should be ready");

  // tasks data must survive update
  const marker = path.join(root, ".pi", "snflows", "tasks", "keep-me.txt");
  writeFileSync(marker, "safe\n", "utf8");
  updateWorkflowProject(root);
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

  console.log("smoke-snflow-setup: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(legacy, { recursive: true, force: true });
}
