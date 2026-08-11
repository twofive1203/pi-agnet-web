import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-web-usage-subagents-"));
const agentDir = join(root, "agent");
const cwd = join(root, "workspace");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(cwd, { recursive: true });

function messageEntry(id: string, parentId: string | null, timestamp: string, cost: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: id }],
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  };
}

function writeJsonl(filePath: string, lines: unknown[]) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

async function main() {
try {
  const encodedCwd = "--smoke-workspace--";
  const parentName = "2026-07-24T00-00-00-000Z_smoke-parent";
  const parentPath = join(agentDir, "sessions", encodedCwd, `${parentName}.jsonl`);
  const childPath = join(agentDir, "sessions", encodedCwd, parentName, "run-id", "run-0", "session.jsonl");
  // Midday UTC keeps the local calendar day stable across common offsets.
  const timestamp = "2026-07-24T12:00:00.000Z";

  writeJsonl(parentPath, [
    { type: "session", version: 3, id: "smoke-parent", timestamp, cwd },
    messageEntry("main-call", null, timestamp, 1),
  ]);
  writeJsonl(childPath, [
    { type: "session", version: 3, id: "smoke-child", timestamp, cwd },
    messageEntry("child-call", null, timestamp, 2),
  ]);

  const { getUsageStats } = await import("../lib/usage-stats");
  const {
    archiveSessionArtifacts,
    deleteSessionArtifacts,
    getSessionCompanionDir,
    unarchiveSessionArtifacts,
  } = await import("../lib/session-artifacts");
  const { invalidateSessionIndex } = await import("../lib/session-index");

  // Local calendar bounds around the fixture day (avoid UTC Date string drift).
  const range = {
    from: new Date(2026, 6, 23, 0, 0, 0, 0),
    to: new Date(2026, 6, 25, 23, 59, 59, 999),
    cwd,
  };

  const active = await getUsageStats({ ...range, includeArchived: false });
  assert.equal(active.totals.cost, 3);
  assert.equal(active.mainTotals.cost, 1);
  assert.equal(active.subagentTotals.cost, 2);
  assert.equal(active.subagentSessions, 1);
  assert.equal(active.bySession[0]?.subagentSessions, 1);
  assert.ok(active.byDay.length >= 1);
  assert.equal(active.timeline, undefined);
  assert.ok(active.scope.timezone);

  // Opt-in auto timeline keeps accounting and reconciles bucket Token sums.
  const withTimeline = await getUsageStats({ ...range, includeArchived: false, timeline: "auto" });
  assert.equal(withTimeline.totals.cost, 3);
  assert.equal(withTimeline.mainTotals.cost, 1);
  assert.equal(withTimeline.subagentTotals.cost, 2);
  assert.equal(withTimeline.byDay.length, 0);
  assert.ok(withTimeline.timeline);
  assert.equal(withTimeline.timeline!.granularity, "day");
  const bucketTokens = withTimeline.timeline!.buckets.reduce(
    (sum, bucket) => ({
      input: sum.input + bucket.totals.input,
      output: sum.output + bucket.totals.output,
      cacheRead: sum.cacheRead + bucket.totals.cacheRead,
      cacheWrite: sum.cacheWrite + bucket.totals.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(bucketTokens.input, withTimeline.totals.input);
  assert.equal(bucketTokens.output, withTimeline.totals.output);
  assert.equal(bucketTokens.cacheRead, withTimeline.totals.cacheRead);
  assert.equal(bucketTokens.cacheWrite, withTimeline.totals.cacheWrite);
  assert.equal(withTimeline.scope.timezone, active.scope.timezone);

  // Use artifacts helpers directly so this smoke stays free of session-reader /
  // pi-coding-agent CJS export surface while still covering archive layouts.
  const archivedPath = archiveSessionArtifacts(parentPath);
  invalidateSessionIndex();
  assert.equal(existsSync(parentPath), false);
  assert.equal(existsSync(childPath), false);
  assert.equal(existsSync(getSessionCompanionDir(archivedPath)), true);

  const archived = await getUsageStats({ ...range, includeArchived: true });
  assert.equal(archived.totals.cost, 3);
  assert.equal(archived.subagentTotals.cost, 2);

  const archivedTimeline = await getUsageStats({ ...range, includeArchived: true, timeline: "auto" });
  assert.equal(archivedTimeline.totals.cost, 3);
  assert.equal(archivedTimeline.subagentTotals.cost, 2);
  assert.ok(archivedTimeline.timeline);
  assert.equal(
    archivedTimeline.timeline!.buckets.reduce((sum, b) => sum + b.totals.input, 0),
    archivedTimeline.totals.input,
  );

  // Recreate the legacy layout where archive moved only the parent JSONL.
  renameSync(getSessionCompanionDir(archivedPath), getSessionCompanionDir(parentPath));
  invalidateSessionIndex();
  const legacyArchived = await getUsageStats({ ...range, includeArchived: true });
  assert.equal(legacyArchived.totals.cost, 3);
  assert.equal(legacyArchived.subagentTotals.cost, 2);

  const restoredPath = unarchiveSessionArtifacts(archivedPath);
  invalidateSessionIndex();
  assert.equal(restoredPath, parentPath);
  assert.equal(existsSync(childPath), true);

  deleteSessionArtifacts(restoredPath);
  assert.equal(existsSync(restoredPath), false);
  assert.equal(existsSync(getSessionCompanionDir(restoredPath)), false);

  console.log("Usage subagent aggregation and session artifact lifecycle smoke checks passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
}

void main();
