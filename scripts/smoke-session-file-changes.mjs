/**
 * Smoke checks for serialized asynchronous session changed-file projection.
 * Run: node --import tsx scripts/smoke-session-file-changes.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(os.tmpdir(), "pi-session-changes-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "workspace");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { recordSessionFileChangeEvent } = await import("../lib/session-file-changes.ts");
const sessionId = "session-async-smoke";
const firstPath = path.join(cwd, "first.txt");
const secondPath = path.join(cwd, "second.txt");
await writeFile(firstPath, "before first\n");
await writeFile(secondPath, "before second\n");

const event = (type, toolCallId, filePath) => ({
  type,
  toolCallId,
  toolName: "edit",
  args: { path: filePath },
  isError: false,
});

try {
  const firstStart = recordSessionFileChangeEvent({
    sessionId,
    cwd,
    event: event("tool_execution_start", "edit-1", firstPath),
  });
  assert.equal(typeof firstStart?.then, "function", "projection must return a promise");
  const secondStart = recordSessionFileChangeEvent({
    sessionId,
    cwd,
    event: event("tool_execution_start", "edit-2", secondPath),
  });

  // Tool execution may mutate the file as soon as the event callback returns.
  // The queued async sidecar work must retain snapshots captured at event time.
  await Promise.all([
    writeFile(firstPath, "after first\n"),
    writeFile(secondPath, "after second\n"),
  ]);
  await Promise.all([firstStart, secondStart]);

  const [firstEnd, secondEnd] = await Promise.all([
    recordSessionFileChangeEvent({
      sessionId,
      cwd,
      event: event("tool_execution_end", "edit-1", firstPath),
    }),
    recordSessionFileChangeEvent({
      sessionId,
      cwd,
      event: event("tool_execution_end", "edit-2", secondPath),
    }),
  ]);
  assert.equal(firstEnd.changed, true);
  assert.equal(secondEnd.changed, true);

  const sidecarPath = path.join(agentDir, "session-changes", `${encodeURIComponent(sessionId)}.json`);
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  assert.deepEqual(Object.keys(sidecar.files).sort(), ["first.txt", "second.txt"]);
  assert.deepEqual(sidecar.pendingTools, {});
  assert.match(sidecar.files["first.txt"].diff, /after first/);
  assert.match(sidecar.files["second.txt"].diff, /after second/);

  console.log("All asynchronous session file-change smoke checks passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
