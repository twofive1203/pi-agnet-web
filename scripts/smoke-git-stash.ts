import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { GET as listRoute, POST as createRoute } from "../app/api/git/stashes/route";
import { GET as detailRoute } from "../app/api/git/stashes/[oid]/route";
import { GET as diffRoute } from "../app/api/git/stashes/[oid]/diff/route";
import { POST as actionRoute } from "../app/api/git/stashes/[oid]/actions/route";
import { registerAllowedRoot } from "../lib/allowed-roots";
import { GitWorkbenchError, resolveGitRepository, withGitMutationLock } from "../lib/git-executor";
import {
  executeGitStashMutation,
  readGitStashDetail,
  readGitStashFileDiff,
  readGitStashes,
} from "../lib/git-stash";
import { readGitStatus } from "../lib/git-workbench";
import type { GitStashDetailResponse, GitStashListResponse, GitStashMutationResponse } from "../lib/types";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout).trim();
}

async function initRepo(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "stash-smoke@example.test");
  await git(repo, "config", "user.name", "Stash Smoke 用户");
  registerAllowedRoot(repo);
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message);
}

function jsonRequest(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-stash-"));
  try {
    const repo = await initRepo(root, "repo");
    await writeFile(path.join(repo, ".gitignore"), "*.ignored\n", "utf8");
    await writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(repo, "index-only.txt"), "original\n", "utf8");
    await commitAll(repo, "base");

    const empty = await readGitStashes(repo);
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.totalCount, 0);
    assert.equal(empty.truncated, false);
    assert.match(empty.revision, /^[0-9a-f]{64}$/);
    assert.equal((await readGitStatus(repo)).stashCount, 0);

    await writeFile(path.join(repo, "tracked.txt"), "staged\n", "utf8");
    await git(repo, "add", "--", "tracked.txt");
    await writeFile(path.join(repo, "tracked.txt"), "staged and unstaged\n", "utf8");
    await writeFile(path.join(repo, "index-only.txt"), "index snapshot\n", "utf8");
    await git(repo, "add", "--", "index-only.txt");
    await writeFile(path.join(repo, "index-only.txt"), "original\n", "utf8");
    const untrackedName = process.platform === "win32" ? "space Unicode 文件.txt" : "space Unicode\n文件.txt";
    await writeFile(path.join(repo, untrackedName), "untracked\n", "utf8");
    await writeFile(path.join(repo, "keep.ignored"), "ignored\n", "utf8");

    const createResponse = await createRoute(jsonRequest("http://localhost/api/git/stashes", {
      cwd: repo,
      name: "快照 one",
      includeUntracked: true,
    }));
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json() as GitStashMutationResponse;
    assert.equal(created.action, "create");
    assert.ok(created.selectedOid);
    assert.equal(created.stashes.entries[0]?.name, "快照 one");
    assert.equal(created.stashes.entries[0]?.displayRef, "stash@{0}");
    assert.equal(created.stashes.target.isDirty, false);
    assert.equal((await readGitStatus(repo)).stashCount, 1);
    assert.equal(await git(repo, "status", "--short", "--ignored"), "!! keep.ignored");

    const listResponse = await listRoute(new NextRequest(`http://localhost/api/git/stashes?cwd=${encodeURIComponent(repo)}`));
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as GitStashListResponse;
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0]?.oid, created.selectedOid);

    const detailResponse = await detailRoute(
      new NextRequest(`http://localhost/api/git/stashes/${created.selectedOid}?cwd=${encodeURIComponent(repo)}`),
      { params: Promise.resolve({ oid: created.selectedOid! }) },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as GitStashDetailResponse;
    assert.equal(detail.fileCount, 3);
    assert.equal(detail.files.some((file) => file.file === "tracked.txt" && file.source === "tracked"), true);
    assert.equal(detail.files.some((file) => file.file === "index-only.txt" && file.source === "tracked"), true);
    assert.equal(detail.files.some((file) => file.file === untrackedName && file.source === "untracked"), true);

    for (const file of detail.files) {
      const params = new URLSearchParams({ cwd: repo, source: file.source, path: file.file });
      if (file.oldFile) params.set("oldPath", file.oldFile);
      const response = await diffRoute(
        new NextRequest(`http://localhost/api/git/stashes/${created.selectedOid}/diff?${params.toString()}`),
        { params: Promise.resolve({ oid: created.selectedOid! }) },
      );
      assert.equal(response.status, 200);
      const diff = await response.json();
      assert.equal(diff.diffAvailable, true, file.file);
      assert.match(diff.diff, /diff --git/);
    }

    const applyResponse = await actionRoute(jsonRequest(
      `http://localhost/api/git/stashes/${created.selectedOid}/actions`,
      {
        action: "apply",
        cwd: repo,
        reinstateIndex: false,
        expectedRevision: list.revision,
        expectedTargetRevision: list.target.revision,
      },
    ), { params: Promise.resolve({ oid: created.selectedOid! }) });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json() as GitStashMutationResponse;
    assert.equal(applied.stashRetained, true);
    assert.equal(applied.stashes.entries.some((entry) => entry.oid === created.selectedOid), true);
    let status = await readGitStatus(repo);
    assert.equal(status.isDirty, true);
    assert.equal(status.staged.length, 0);

    await git(repo, "reset", "--hard", "HEAD");
    await unlink(path.join(repo, untrackedName));
    const beforeIndexedApply = await readGitStashes(repo);
    await executeGitStashMutation({
      action: "apply",
      cwd: repo,
      oid: created.selectedOid!,
      reinstateIndex: true,
      expectedRevision: beforeIndexedApply.revision,
      expectedTargetRevision: beforeIndexedApply.target.revision,
    });
    status = await readGitStatus(repo);
    assert.equal(status.staged.some((file) => file.file === "tracked.txt"), true);
    assert.equal(status.unstaged.some((file) => file.file === "tracked.txt"), true);
    await git(repo, "reset", "--hard", "HEAD");
    await unlink(path.join(repo, untrackedName));

    await writeFile(path.join(repo, "tracked.txt"), "second\n", "utf8");
    await writeFile(path.join(repo, "left-untracked.txt"), "left\n", "utf8");
    const second = await executeGitStashMutation({ action: "create", cwd: repo, name: "second", includeUntracked: false });
    assert.ok(second.selectedOid);
    assert.equal(second.stashes.target.isDirty, true);
    const secondDetail = await readGitStashDetail(repo, second.selectedOid!);
    assert.equal(secondDetail.files.some((file) => file.source === "untracked"), false);
    assert.equal((await readGitStatus(repo)).untracked.includes("left-untracked.txt"), true);
    await unlink(path.join(repo, "left-untracked.txt"));

    const beforePop = await readGitStashes(repo);
    const popped = await executeGitStashMutation({
      action: "pop",
      cwd: repo,
      oid: second.selectedOid!,
      reinstateIndex: false,
      expectedRevision: beforePop.revision,
      expectedTargetRevision: beforePop.target.revision,
    });
    assert.equal(popped.stashes.entries.some((entry) => entry.oid === second.selectedOid), false);
    assert.equal(popped.stashes.entries.some((entry) => entry.oid === created.selectedOid), true);
    await git(repo, "reset", "--hard", "HEAD");

    await writeFile(path.join(repo, "dirty-preserved.txt"), "dirty\n", "utf8");
    const beforeDrop = await readGitStashes(repo);
    await executeGitStashMutation({ action: "drop", cwd: repo, oid: created.selectedOid!, expectedRevision: beforeDrop.revision });
    assert.equal((await readGitStatus(repo)).untracked.includes("dirty-preserved.txt"), true);
    assert.equal((await readGitStashes(repo)).entries.length, 0);
    await unlink(path.join(repo, "dirty-preserved.txt"));

    const staleRepo = await initRepo(root, "stale");
    await writeFile(path.join(staleRepo, "file.txt"), "base\n", "utf8");
    await commitAll(staleRepo, "base");
    await git(staleRepo, "branch", "other");
    await writeFile(path.join(staleRepo, "file.txt"), "stash-a\n", "utf8");
    const stashA = await executeGitStashMutation({ action: "create", cwd: staleRepo, name: "A", includeUntracked: true });
    const staleSnapshot = await readGitStashes(staleRepo);
    await writeFile(path.join(staleRepo, "file.txt"), "stash-b\n", "utf8");
    await executeGitStashMutation({ action: "create", cwd: staleRepo, name: "B", includeUntracked: true });
    await assert.rejects(
      () => executeGitStashMutation({ action: "drop", cwd: staleRepo, oid: stashA.selectedOid!, expectedRevision: staleSnapshot.revision }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_REVISION",
    );
    const targetSnapshot = await readGitStashes(staleRepo);
    await git(staleRepo, "switch", "other");
    await assert.rejects(
      () => executeGitStashMutation({
        action: "apply",
        cwd: staleRepo,
        oid: stashA.selectedOid!,
        reinstateIndex: false,
        expectedRevision: targetSnapshot.revision,
        expectedTargetRevision: targetSnapshot.target.revision,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_TARGET",
    );

    const conflictRepo = await initRepo(root, "conflict");
    await writeFile(path.join(conflictRepo, "conflict.txt"), "base\n", "utf8");
    await commitAll(conflictRepo, "base");
    await writeFile(path.join(conflictRepo, "conflict.txt"), "stash\n", "utf8");
    const conflictStash = await executeGitStashMutation({ action: "create", cwd: conflictRepo, name: "conflict", includeUntracked: true });
    await writeFile(path.join(conflictRepo, "conflict.txt"), "branch\n", "utf8");
    await commitAll(conflictRepo, "branch change");
    const beforeConflict = await readGitStashes(conflictRepo);
    await assert.rejects(
      () => executeGitStashMutation({
        action: "pop",
        cwd: conflictRepo,
        oid: conflictStash.selectedOid!,
        reinstateIndex: false,
        expectedRevision: beforeConflict.revision,
        expectedTargetRevision: beforeConflict.target.revision,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STASH_CONFLICT" && error.stashRetained === true,
    );
    assert.equal((await readGitStashes(conflictRepo)).entries.some((entry) => entry.oid === conflictStash.selectedOid), true);
    assert.equal((await resolveGitRepository(conflictRepo)) !== null, true);
    assert.equal((await readGitStatus(conflictRepo)).isDirty, true);

    const specialRepo = await initRepo(root, "special");
    await writeFile(path.join(specialRepo, "rename old.txt"), "rename\n", "utf8");
    await writeFile(path.join(specialRepo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(specialRepo, "large.txt"), "a".repeat(1_200_000), "utf8");
    await commitAll(specialRepo, "special base");
    await git(specialRepo, "mv", "rename old.txt", "renamed 文件.txt");
    await writeFile(path.join(specialRepo, "binary.dat"), Buffer.from([0, 9, 8, 7]));
    await writeFile(path.join(specialRepo, "large.txt"), "b".repeat(1_200_000), "utf8");
    const special = await executeGitStashMutation({ action: "create", cwd: specialRepo, name: "special", includeUntracked: true });
    const specialDetail = await readGitStashDetail(specialRepo, special.selectedOid!);
    const rename = specialDetail.files.find((file) => file.status === "R");
    assert.equal(rename?.oldFile, "rename old.txt");
    assert.equal(rename?.file, "renamed 文件.txt");
    const binary = specialDetail.files.find((file) => file.file === "binary.dat")!;
    assert.equal((await readGitStashFileDiff({ cwd: specialRepo, oid: special.selectedOid!, ...binary })).reason, "binary");
    const large = specialDetail.files.find((file) => file.file === "large.txt")!;
    assert.equal((await readGitStashFileDiff({ cwd: specialRepo, oid: special.selectedOid!, ...large })).reason, "too-large");

    const linked = path.join(root, "linked");
    await git(specialRepo, "worktree", "add", "-b", "linked", linked, "main");
    registerAllowedRoot(linked);
    const mainList = await readGitStashes(specialRepo);
    const linkedList = await readGitStashes(linked);
    assert.deepEqual(linkedList.entries.map((entry) => entry.oid), mainList.entries.map((entry) => entry.oid));
    assert.notEqual(linkedList.target.cwd, mainList.target.cwd);
    const mainIdentity = await resolveGitRepository(specialRepo);
    const linkedIdentity = await resolveGitRepository(linked);
    await assert.rejects(
      () => withGitMutationLock(mainIdentity, () => withGitMutationLock(linkedIdentity, async () => undefined)),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "REPOSITORY_BUSY",
    );

    const extraField = await createRoute(jsonRequest("http://localhost/api/git/stashes", {
      cwd: specialRepo,
      name: "invalid",
      includeUntracked: true,
      extra: true,
    }));
    assert.equal(extraField.status, 400);
    const oversized = await createRoute(jsonRequest("http://localhost/api/git/stashes", {
      cwd: specialRepo,
      name: "x".repeat(17_000),
      includeUntracked: true,
    }));
    assert.equal(oversized.status, 413);
    const unknownAction = await actionRoute(jsonRequest("http://localhost/api/git/stashes/dead/actions", {
      action: "clear",
      cwd: specialRepo,
      expectedRevision: mainList.revision,
    }), { params: Promise.resolve({ oid: "dead" }) });
    assert.equal(unknownAction.status, 400);
    const invalidOid = await detailRoute(
      new NextRequest(`http://localhost/api/git/stashes/dead?cwd=${encodeURIComponent(specialRepo)}`),
      { params: Promise.resolve({ oid: "dead" }) },
    );
    assert.equal(invalidOid.status, 404);

    console.log("git stash smoke: ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
