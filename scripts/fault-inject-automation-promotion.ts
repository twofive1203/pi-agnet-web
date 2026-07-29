import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  ensureAutomationLayout,
  makeAutomationRunId,
  readPromotionRecord,
  writeRunRecord,
} from "../lib/automation-store";
import { getAutomationTaskSessionDir } from "../lib/automation-paths";
import { computeFileSeal } from "../lib/automation-session";
import { promoteAutomationRun } from "../lib/automation-promotion";
import { AUTOMATION_SCHEMA_VERSION } from "../lib/automation-types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-promo-"));
  const projectCwd = mkdtempSync(path.join(tmpdir(), "auto-proj-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  ensureAutomationLayout(agentDir);

  try {
    const runId = makeAutomationRunId();
    const taskId = "task-promo";
    const sessionDir = getAutomationTaskSessionDir(taskId, runId, agentDir);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "x.jsonl");
    const sessionId = "sid-promo-1";
    const body =
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd: projectCwd,
      }) +
      "\n" +
      JSON.stringify({
        type: "message",
        id: "e1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "hi" },
      }) +
      "\n";
    writeFileSync(sessionFile, body);
    const seal = computeFileSeal(sessionFile);

    writeRunRecord(
      {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        id: runId,
        taskId,
        taskRevision: "r1",
        trigger: "manual",
        status: "succeeded",
        blockedReason: null,
        occurrence: {
          occurrenceKey: `${taskId}@p`,
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
          sessionId,
          sessionFile,
          availability: "available",
          unavailableReason: null,
          sealed: true,
          seal,
        },
        summary: "ok",
        usage: null,
        errorCategory: null,
        errorMessage: null,
        sideEffectsStarted: true,
        cancelRequestedAt: null,
        createdAt: new Date().toISOString(),
        claimedAt: null,
        startedAt: null,
        completedAt: new Date().toISOString(),
        cwd: projectCwd,
        terminal: true,
      },
      agentDir,
    );

    const a = await promoteAutomationRun({ runId, agentDir });
    const b = await promoteAutomationRun({ runId, agentDir });
    assert(a.status === "committed", "committed");
    assert(b.destinationSessionFile === a.destinationSessionFile, "idempotent destination");
    assert(readPromotionRecord(runId, agentDir)?.status === "committed", "projection committed");
    assert(readFileSync(sessionFile, "utf8").includes("message"), "source intact");
    console.log("fault-inject-automation-promotion: ok");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
