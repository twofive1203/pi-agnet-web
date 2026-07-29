/**
 * Deterministic smoke checks for SnFlow store/prompts/types.
 * Run: npx tsx scripts/smoke-workflow-store.ts
 *  or: node scripts/smoke-workflow-store.mjs
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { mkdtempSync } from "fs";
import {
  beginWorkflowRun,
  createWorkflowTask,
  getWorkflowTaskDetail,
  listWorkflowTasks,
  markWorkflowTaskReady,
  updateWorkflowTask,
  WorkflowConflictError,
  WorkflowStoreError,
} from "../lib/workflow-store";
import {
  agentNameForPhase,
  normalizeCheckResult,
  normalizeImplementResult,
} from "../lib/workflow-prompts";
import {
  canStartCheck,
  canStartImplement,
  isValidWorkflowTaskId,
} from "../lib/workflow-types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(isValidWorkflowTaskId("fix-auth"), "valid id");
assert(!isValidWorkflowTaskId("../x"), "reject traversal");
assert(canStartImplement("ready"), "implement ready");
assert(!canStartCheck("ready"), "check not from ready");
assert(agentNameForPhase("implement") === "snflow-implement", "snflow implement agent");
assert(agentNameForPhase("check") === "snflow-check", "snflow check agent");

const impl = normalizeImplementResult(
  '```json\n{"summary":"ok","changedFiles":["a.ts"],"validation":[],"residualRisks":[]}\n```',
);
assert(impl?.summary === "ok", "implement normalize");
const check = normalizeCheckResult(
  '```json\n{"verdict":"pass","summary":"good","findings":[],"validation":[]}\n```',
);
assert(check?.verdict === "pass", "check normalize");
const advisoryCheck = normalizeCheckResult(
  '```json\n{"verdict":"changes_requested","summary":"optional cleanup","findings":[{"severity":"warning","summary":"consider refactor"}],"validation":[]}\n```',
);
assert(advisoryCheck?.verdict === "pass", "advisory findings do not block check");
assert(advisoryCheck?.findings.some((finding) => finding.summary.includes("user choice")), "advisory normalization is visible");
const passingAdvisoryCheck = normalizeCheckResult(
  '```json\n{"verdict":"pass","summary":"good with note","findings":[{"severity":"info","summary":"optional follow-up"}],"validation":[]}\n```',
);
assert(passingAdvisoryCheck?.verdict === "pass", "passing advisory result stays pass");
const emptyChangesCheck = normalizeCheckResult(
  '```json\n{"verdict":"changes_requested","summary":"no blockers","findings":[],"validation":[]}\n```',
);
assert(emptyChangesCheck?.verdict === "pass", "changes_requested without blockers normalizes to pass");
const blockingCheck = normalizeCheckResult(
  '```json\n{"verdict":"pass","summary":"incorrect pass","findings":[{"severity":"error","summary":"acceptance criterion failed"}],"validation":[]}\n```',
);
assert(blockingCheck?.verdict === "changes_requested", "error findings always block check");
assert(normalizeCheckResult("plain")?.verdict === "changes_requested", "missing json");

const projectA = mkdtempSync(path.join(tmpdir(), "wf-a-"));
const projectB = mkdtempSync(path.join(tmpdir(), "wf-b-"));

try {
  const empty = listWorkflowTasks(projectA);
  assert(empty.exists === false, "empty namespace");
  assert(empty.tasks.length === 0, "no tasks");
  assert(empty.currentTaskId === null, "no current task");

  const created = createWorkflowTask(projectA, {
    title: "Fix Auth Refresh",
    priority: "P1",
    seedText: "Please fix auth token refresh on 401",
  });
  assert(created.status === "planning", "planning");
  assert(created.documents.requirements.includes("auth token refresh"), "seeded requirements");
  assert(created.pathLabel.includes(".pi/snflows/tasks/"), "namespace path");
  assert(listWorkflowTasks(projectA).currentTaskId === created.id, "create sets current task");

  const child = createWorkflowTask(projectA, {
    title: "Refresh token implementation",
    parentTaskId: created.id,
    priority: "P1",
  });
  assert(child.parentTaskId === created.id, "child parent persisted");
  assert(getWorkflowTaskDetail(projectA, created.id).children.some((task) => task.id === child.id), "parent exposes child");
  assert(listWorkflowTasks(projectA, true).tasks.find((task) => task.id === created.id)?.childCount === 1, "child count");
  let nestedRejected = false;
  try {
    createWorkflowTask(projectA, { title: "Nested task", parentTaskId: child.id });
  } catch (error) {
    nestedRejected = error instanceof WorkflowStoreError;
  }
  assert(nestedRejected, "nested child rejected");

  assert(listWorkflowTasks(projectB).tasks.length === 0, "project isolation");

  const prev = process.cwd();
  process.chdir(projectB);
  assert(listWorkflowTasks(projectA).tasks.length === 2, "explicit cwd ignores process.cwd");
  process.chdir(prev);

  const ready = markWorkflowTaskReady(projectA, created.id, created.revision);
  assert(ready.status === "ready", "mark ready");

  const begun = beginWorkflowRun(projectA, created.id, {
    phase: "implement",
    expectedRevision: ready.revision,
    agentName: "worker",
    hostSessionId: "host-test",
    requestedCwd: projectA,
    effectiveCwd: projectA,
  });
  assert(begun.task.status === "implementing", "implementing");
  assert(begun.task.activeRunId === begun.run.id, "active run");

  let conflict = false;
  try {
    beginWorkflowRun(projectA, created.id, {
      phase: "implement",
      expectedRevision: begun.task.revision,
      agentName: "worker",
      hostSessionId: "host-test",
      requestedCwd: projectA,
      effectiveCwd: projectA,
    });
  } catch (error) {
    conflict = error instanceof WorkflowConflictError;
  }
  assert(conflict, "active run collision");

  let revConflict = false;
  try {
    updateWorkflowTask(projectA, created.id, { expectedRevision: "deadbeef", title: "Nope" });
  } catch (error) {
    revConflict = error instanceof WorkflowConflictError;
  }
  assert(revConflict, "revision conflict");

  const badDir = path.join(projectA, ".pi", "snflows", "tasks", "bad-task");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(path.join(badDir, "task.json"), JSON.stringify({ schemaVersion: 1, id: "bad-task" }), "utf8");
  const listed = listWorkflowTasks(projectA, true);
  assert(listed.errors.some((item) => item.id === "bad-task"), "malformed fails closed in list");

  let trav = false;
  try {
    getWorkflowTaskDetail(projectA, "../secret");
  } catch (error) {
    trav = error instanceof WorkflowStoreError;
  }
  assert(trav, "traversal rejected");

  try {
    const outside = mkdtempSync(path.join(tmpdir(), "wf-out-"));
    const link = path.join(projectA, ".pi", "snflows", "tasks", "linky");
    symlinkSync(outside, link, "dir");
    writeFileSync(path.join(outside, "task.json"), '{"schemaVersion":1}', "utf8");
    let secured = false;
    try {
      getWorkflowTaskDetail(projectA, "linky");
    } catch {
      secured = true;
    }
    assert(secured, "symlink escape fails closed");
    rmSync(outside, { recursive: true, force: true });
  } catch {
    // Windows may block symlink without elevation.
  }

  assert(
    existsSync(path.join(projectA, ".pi", "snflows", "tasks", created.id, "task.json")),
    "task persisted",
  );
  console.log("OK workflow-store smoke");
} finally {
  for (const project of [projectA, projectB]) {
    try {
      rmSync(project, { recursive: true, force: true });
    } catch {
      // Windows can briefly retain a temp directory after symlink checks.
    }
  }
}
