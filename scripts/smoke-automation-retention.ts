import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  ensureAutomationLayout,
  makeAutomationRunId,
  readRunRecord,
  readRunRetentionProjection,
  terminalRunSnapshotExists,
  writeRunRecord,
} from "../lib/automation-store";
import { getAutomationRunPath, getAutomationTaskSessionDir } from "../lib/automation-paths";
import { runAutomationRetention } from "../lib/automation-retention";
import { AUTOMATION_SCHEMA_VERSION } from "../lib/automation-types";
import { computeFileSeal } from "../lib/automation-session";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-ret-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  ensureAutomationLayout(agentDir);
  try {
    const runId = makeAutomationRunId();
    const taskId = "task-ret";
    const sessionDir = getAutomationTaskSessionDir(taskId, runId, agentDir);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "old.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const seal = computeFileSeal(sessionFile);
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();

    writeRunRecord(
      {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        id: runId,
        taskId,
        taskRevision: "r",
        trigger: "scheduled",
        status: "succeeded",
        blockedReason: null,
        occurrence: {
          occurrenceKey: `${taskId}@old`,
          scheduledForUtc: old,
          localWallTime: old,
          localOffsetMinutes: 0,
          timezone: "UTC",
          schedulePolicyVersion: 1,
          cron: "0 8 * * *",
        },
        lease: null,
        promptHash: "p",
        requestedModel: { provider: "p", modelId: "m" },
        actualModel: null,
        effectiveTools: [],
        effectiveExtensions: [],
        session: {
          sessionId: "s",
          sessionFile,
          availability: "available",
          unavailableReason: null,
          sealed: true,
          seal,
        },
        summary: "old",
        usage: null,
        errorCategory: null,
        errorMessage: null,
        sideEffectsStarted: true,
        cancelRequestedAt: null,
        createdAt: old,
        claimedAt: old,
        startedAt: old,
        completedAt: old,
        cwd: sessionDir,
        terminal: true,
      },
      agentDir,
    );

    const snapshotBefore = readFileSync(getAutomationRunPath(runId, agentDir), "utf8");
    const report = await runAutomationRetention({
      agentDir,
      transcriptRetentionMs: 90 * 24 * 60 * 60 * 1000,
    });
    assert(report.deletedTranscripts >= 1, "deleted old transcript");
    assert(!existsSync(sessionFile), "file gone");
    const snapshotAfter = readFileSync(getAutomationRunPath(runId, agentDir), "utf8");
    assert(snapshotBefore === snapshotAfter, "terminal runs/<id>.json immutable");
    assert(terminalRunSnapshotExists(runId, agentDir), "snapshot still exists");
    const runStill = readRunRecord(runId, agentDir);
    assert(runStill?.session.sessionFile === sessionFile, "authoritative session path unchanged");
    const proj = readRunRetentionProjection(runId, agentDir);
    assert(proj != null, "external retention projection written");

    const runId2 = makeAutomationRunId();
    const sessionFile2 = path.join(getAutomationTaskSessionDir(taskId, runId2, agentDir), "live.jsonl");
    mkdirSync(path.dirname(sessionFile2), { recursive: true });
    writeFileSync(sessionFile2, "{}\n");
    writeRunRecord(
      {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        id: runId2,
        taskId,
        taskRevision: "r",
        trigger: "manual",
        status: "running",
        blockedReason: null,
        occurrence: {
          occurrenceKey: `${taskId}@live`,
          scheduledForUtc: new Date().toISOString(),
          localWallTime: "t",
          localOffsetMinutes: 0,
          timezone: "UTC",
          schedulePolicyVersion: 1,
          cron: "0 8 * * *",
        },
        lease: null,
        promptHash: "p",
        requestedModel: { provider: "p", modelId: "m" },
        actualModel: null,
        effectiveTools: [],
        effectiveExtensions: [],
        session: {
          sessionId: "s2",
          sessionFile: sessionFile2,
          availability: "available",
          unavailableReason: null,
          sealed: false,
          seal: null,
        },
        summary: null,
        usage: null,
        errorCategory: null,
        errorMessage: null,
        sideEffectsStarted: true,
        cancelRequestedAt: null,
        createdAt: new Date().toISOString(),
        claimedAt: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        cwd: sessionDir,
        terminal: false,
      },
      agentDir,
    );
    await runAutomationRetention({ agentDir, transcriptRetentionMs: 0 });
    assert(existsSync(sessionFile2), "active preserved");
    console.log("smoke-automation-retention: ok");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
