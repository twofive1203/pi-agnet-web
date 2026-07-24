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
  const timestamp = "2026-07-24T00:00:00.000Z";

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
    archiveSessionFile,
    listAllArchivedSessions,
    unarchiveSessionFile,
  } = await import("../lib/session-reader");
  const { deleteSessionArtifacts, getSessionCompanionDir } = await import("../lib/session-artifacts");
  const range = {
    from: new Date("2026-07-23T00:00:00.000Z"),
    to: new Date("2026-07-25T00:00:00.000Z"),
    cwd,
  };

  const active = await getUsageStats({ ...range, includeArchived: false });
  assert.equal(active.totals.cost, 3);
  assert.equal(active.mainTotals.cost, 1);
  assert.equal(active.subagentTotals.cost, 2);
  assert.equal(active.subagentSessions, 1);
  assert.equal(active.bySession[0]?.subagentSessions, 1);

  const archivedPath = archiveSessionFile(parentPath);
  assert.equal(existsSync(parentPath), false);
  assert.equal(existsSync(childPath), false);
  assert.equal(existsSync(getSessionCompanionDir(archivedPath)), true);
  assert.equal((await listAllArchivedSessions()).length, 1);

  const archived = await getUsageStats({ ...range, includeArchived: true });
  assert.equal(archived.totals.cost, 3);
  assert.equal(archived.subagentTotals.cost, 2);

  // Recreate the legacy layout where archive moved only the parent JSONL.
  renameSync(getSessionCompanionDir(archivedPath), getSessionCompanionDir(parentPath));
  const legacyArchived = await getUsageStats({ ...range, includeArchived: true });
  assert.equal(legacyArchived.totals.cost, 3);
  assert.equal(legacyArchived.subagentTotals.cost, 2);

  const restoredPath = unarchiveSessionFile(archivedPath);
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
