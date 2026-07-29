import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDraftTaskRecord,
  ensureAutomationLayout,
  getTaskRecord,
  materializeOccurrence,
  makeAutomationRunId,
  readRunRecord,
  upsertTaskRecord,
  withTaskRevision,
  AutomationStoreError,
} from "../lib/automation-store";
import { acquireAutomationLock } from "../lib/automation-lock";
import { buildTaskConfigFromInput } from "../lib/automation-service";
import { AUTOMATION_SCHEMA_VERSION, isValidAutomationTaskId } from "../lib/automation-types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-store-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert(isValidAutomationTaskId("daily-news"), "valid id");
    assert(!isValidAutomationTaskId("../x"), "reject traversal");
    assert(!isValidAutomationTaskId("a/b"), "reject slash");

    ensureAutomationLayout(agentDir);
    const config = await buildTaskConfigFromInput({
      name: "News",
      cron: "0 8 * * *",
      timezone: "Asia/Shanghai",
      cwdSource: "default",
      provider: "anthropic",
      modelId: "claude-test",
      prompt: "Summarize news",
      tools: [{ name: "read", origin: "builtin" }],
      agentDir,
    });

    const draft = createDraftTaskRecord({ config });
    const saved = await upsertTaskRecord(draft, { agentDir });
    assert(saved.revision, "has revision");
    const loaded = getTaskRecord(saved.id, agentDir);
    assert(loaded?.name === "News", "reload name");

    let conflict = false;
    try {
      await upsertTaskRecord(
        withTaskRevision({ ...loaded!, name: "Other", updatedAt: new Date().toISOString() }),
        { agentDir, expectedTaskRevision: "stale-revision" },
      );
    } catch (e) {
      conflict = e instanceof AutomationStoreError && e.code === "revision_conflict";
    }
    assert(conflict, "revision conflict");

    // materialize/barrier require live scheduler fencing.
    const leader = await acquireAutomationLock({
      kind: "scheduler",
      agentDir,
      ownerId: "o1",
      ttlMs: 30_000,
      timeoutMs: 2000,
    });

    const runId = makeAutomationRunId();
    const occurrenceKey = `${saved.id}@test-occ`;
    const run = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: runId,
      taskId: saved.id,
      taskRevision: saved.revision,
      trigger: "manual" as const,
      status: "claimed" as const,
      blockedReason: null,
      occurrence: {
        occurrenceKey,
        scheduledForUtc: new Date().toISOString(),
        localWallTime: "2026-01-01T08:00:00",
        localOffsetMinutes: 480,
        timezone: "Asia/Shanghai",
        schedulePolicyVersion: 1,
        cron: "0 8 * * *",
      },
      lease: {
        ownerId: leader.ownerId,
        epoch: leader.epoch,
        fencingToken: leader.fencingToken,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      promptHash: "x",
      requestedModel: { provider: "anthropic", modelId: "claude-test" },
      actualModel: null,
      effectiveTools: [],
      effectiveExtensions: [],
      session: {
        sessionId: null,
        sessionFile: null,
        availability: "pending" as const,
        unavailableReason: null,
        sealed: false,
        seal: null,
      },
      summary: null,
      usage: null,
      errorCategory: null,
      errorMessage: null,
      sideEffectsStarted: false,
      cancelRequestedAt: null,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      cwd: config.target.cwd,
      terminal: false,
    };

    const m1 = await materializeOccurrence({
      taskId: saved.id,
      occurrenceKey,
      run,
      nextRunAt: new Date(Date.now() + 86400000).toISOString(),
      ownerId: leader.ownerId,
      epoch: leader.epoch,
      fencingToken: leader.fencingToken,
      agentDir,
    });
    assert(m1.claim.stage === "task_advanced", "claim advanced");
    const m2 = await materializeOccurrence({
      taskId: saved.id,
      occurrenceKey,
      run: { ...run, id: makeAutomationRunId() },
      nextRunAt: null,
      ownerId: leader.ownerId,
      epoch: leader.epoch,
      fencingToken: leader.fencingToken,
      agentDir,
    });
    assert(m2.run.id === runId, "same occurrence converges");
    assert(readRunRecord(runId, agentDir)?.id === runId, "run readable");
    leader.release();
    console.log("smoke-automation-store: ok");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
