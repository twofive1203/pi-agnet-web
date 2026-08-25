import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { GET } from "../app/api/git/diff/route";
import type {
  GitCommitFileDiffResponse,
  GitWorkingTreeFileDiffResponse,
} from "../lib/types";
import { registerAllowedRoot } from "../lib/allowed-roots";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return String(stdout).trim();
}

async function requestDiff(params: Record<string, string>) {
  const query = new URLSearchParams(params);
  return GET(new NextRequest(`http://localhost/api/git/diff?${query.toString()}`));
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-diff-"));
  try {
    await git(cwd, "init");
    registerAllowedRoot(cwd);
  await git(cwd, "config", "user.email", "smoke@example.test");
  await git(cwd, "config", "user.name", "Smoke Test");

  const file = path.join(cwd, "sample.txt");
  await writeFile(file, "base\n", "utf8");
  await git(cwd, "add", "sample.txt");
  await git(cwd, "commit", "-m", "base");
  const baseHash = await git(cwd, "rev-parse", "HEAD");

  const commitResponse = await requestDiff({ cwd, hash: baseHash, path: "sample.txt" });
  assert.equal(commitResponse.status, 200);
  const commitBody = await commitResponse.json() as GitCommitFileDiffResponse;
  assert.equal(commitBody.diffAvailable, true);
  assert.match(commitBody.diff ?? "", /\+base/);

  await writeFile(file, "base\nunstaged\n", "utf8");
  const unstagedResponse = await requestDiff({ cwd, scope: "unstaged", path: "sample.txt" });
  assert.equal(unstagedResponse.status, 200);
  const unstagedBody = await unstagedResponse.json() as GitWorkingTreeFileDiffResponse;
  assert.equal(unstagedBody.scope, "unstaged");
  assert.equal(unstagedBody.diffAvailable, true);
  assert.match(unstagedBody.diff ?? "", /\+unstaged/);

  await git(cwd, "add", "sample.txt");
  const stagedResponse = await requestDiff({ cwd, scope: "staged", path: "sample.txt" });
  assert.equal(stagedResponse.status, 200);
  const stagedBody = await stagedResponse.json() as GitWorkingTreeFileDiffResponse;
  assert.equal(stagedBody.scope, "staged");
  assert.equal(stagedBody.diffAvailable, true);
  assert.match(stagedBody.diff ?? "", /\+unstaged/);

  const invalidScope = await requestDiff({ cwd, scope: "index", path: "sample.txt" });
  assert.equal(invalidScope.status, 400);

  const missingSelector = await requestDiff({ cwd, path: "sample.txt" });
  assert.equal(missingSelector.status, 400);

    console.log("smoke-git-diff: OK");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
