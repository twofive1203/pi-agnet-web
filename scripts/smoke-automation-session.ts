import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  ensureAutomationLayout,
  makeAutomationRunId,
  writeRunRecord,
} from "../lib/automation-store";
import { getAutomationTaskSessionDir } from "../lib/automation-paths";
import { isPromoteEligible, readAutomationTranscript, computeFileSeal } from "../lib/automation-session";
import { AUTOMATION_SCHEMA_VERSION } from "../lib/automation-types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const agentDir = mkdtempSync(path.join(tmpdir(), "auto-sess-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
ensureAutomationLayout(agentDir);

const runId = makeAutomationRunId();
const taskId = "task-sess";
const sessionDir = getAutomationTaskSessionDir(taskId, runId, agentDir);
mkdirSync(sessionDir, { recursive: true });
const sessionFile = path.join(sessionDir, "x.jsonl");
writeFileSync(
  sessionFile,
  JSON.stringify({
    type: "session",
    version: 3,
    id: "sid",
    timestamp: new Date().toISOString(),
    cwd: sessionDir,
  }) +
    "\n" +
    JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hi" },
    }) +
    "\n",
);
const seal = computeFileSeal(sessionFile);

const run = {
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  id: runId,
  taskId,
  taskRevision: "r1",
  trigger: "manual" as const,
  status: "succeeded" as const,
  blockedReason: null,
  occurrence: {
    occurrenceKey: `${taskId}@1`,
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
    sessionId: "sid",
    sessionFile,
    availability: "available" as const,
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
  cwd: sessionDir,
  terminal: true,
};
writeRunRecord(run, agentDir);

const tr = readAutomationTranscript({ runId, agentDir });
assert(tr.total === 2, "entries");
assert(isPromoteEligible(run).ok, "promote eligible");

const noSess = { ...run, session: { ...run.session, availability: "unavailable" as const, sessionFile: null, sealed: false, seal: null } };
assert(!isPromoteEligible(noSess).ok, "no session not eligible");

// Isolation: ordinary session discovery should not see automation path by design of storage root.
assert(sessionFile.includes(`${path.sep}automations${path.sep}`) || sessionFile.includes("/automations/"), "under automations root");

rmSync(agentDir, { recursive: true, force: true });
console.log("smoke-automation-session: ok");
