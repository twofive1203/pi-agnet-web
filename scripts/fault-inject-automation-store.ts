import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  ensureAutomationLayout,
  readTasksFile,
  reconcileOccurrence,
  writeClaimRecord,
  AutomationStoreError,
} from "../lib/automation-store";
import { getAutomationTasksPath, getAutomationStoreLockPath } from "../lib/automation-paths";
import { inspectAutomationLock, repairAutomationLock } from "../lib/automation-lock";
import { AUTOMATION_SCHEMA_VERSION } from "../lib/automation-types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const agentDir = mkdtempSync(path.join(tmpdir(), "auto-fault-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  ensureAutomationLayout(agentDir);

  // Corrupt tasks.json fails closed
  writeFileSync(getAutomationTasksPath(agentDir), "{not-json", "utf8");
  let corrupt = false;
  try {
    readTasksFile(agentDir);
  } catch (e) {
    corrupt = e instanceof AutomationStoreError && e.code === "repair_required";
  }
  assert(corrupt, "corrupt tasks fail closed");

  // Empty lock requires repair
  writeFileSync(getAutomationStoreLockPath(agentDir), "", "utf8");
  const inspect = inspectAutomationLock("store", agentDir);
  assert(inspect.empty || inspect.corrupt, "empty lock detected");
  const repaired = repairAutomationLock("store", agentDir);
  assert(repaired.repaired, "lock repaired");

  // Restore tasks file after corrupt-path check so reconciliation can run.
  writeFileSync(
    getAutomationTasksPath(agentDir),
    JSON.stringify({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      revision: "r",
      updatedAt: new Date().toISOString(),
      tasks: {},
      defaultCwdCanonical: null,
      defaultCwdInitializedAt: null,
      globalDisabled: false,
      storeEpoch: 0,
    }),
    "utf8",
  );

  // Barrier stage reconciliation
  writeClaimRecord(
    {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      occurrenceKey: "occ-barrier",
      taskId: "task-x",
      runId: "run-x",
      stage: "execution_may_have_started",
      ownerId: "o",
      epoch: 1,
      fencingToken: "t",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finalized: false,
    },
    agentDir,
  );
  const rec = reconcileOccurrence("occ-barrier", agentDir);
  assert(rec.action === "mark_ambiguous" || rec.action === "stable" || rec.action === "prepared_without_run", "recon action");

  console.log("fault-inject-automation-store: ok");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
