import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSubagentDetailDepth,
  resolveSubagentArtifactPath,
  SubagentDetailRequestError,
} from "../lib/subagent-detail-route";
import { createSubagentDetailFingerprint } from "../lib/parse-subagent-children";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-route-"));
  const sessions = join(root, "sessions");
  const runDir = join(sessions, "parent", "child", "run-0");
  const outside = join(root, "outside");
  await mkdir(runDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  const valid = join(runDir, "session.jsonl");
  const wrongName = join(runDir, "other.jsonl");
  const outsideFile = join(outside, "session.jsonl");
  await Promise.all([
    writeFile(valid, ""),
    writeFile(wrongName, ""),
    writeFile(outsideFile, ""),
  ]);

  try {
    assert.equal(createSubagentDetailFingerprint(10, 20.9), "v1:10:20");
    assert.equal(parseSubagentDetailDepth(null), 1);
    assert.equal(parseSubagentDetailDepth("3"), 3);
    assert.throws(() => parseSubagentDetailDepth("0"), SubagentDetailRequestError);
    assert.throws(() => parseSubagentDetailDepth("4"), SubagentDetailRequestError);
    assert.equal(resolveSubagentArtifactPath(valid, sessions), valid);
    assert.throws(() => resolveSubagentArtifactPath(wrongName, sessions), (error) =>
      error instanceof SubagentDetailRequestError && error.status === 403);
    assert.throws(() => resolveSubagentArtifactPath(outsideFile, sessions), (error) =>
      error instanceof SubagentDetailRequestError && error.status === 403);

    try {
      const link = join(runDir, "linked-session.jsonl");
      await symlink(outsideFile, link, "file");
      assert.throws(() => resolveSubagentArtifactPath(link, sessions), (error) =>
        error instanceof SubagentDetailRequestError && error.status === 403);
    } catch (error) {
      if ((error as { code?: string }).code !== "EPERM") throw error;
    }

    console.log("smoke-subagent-detail-route: OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
