import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { POST as operateRoute } from "../app/api/git/operations/route";
import { registerAllowedRoot } from "../lib/allowed-roots";
import {
  GitWorkbenchError,
  resolveGitRepository,
  withGitMutationLock,
} from "../lib/git-executor";
import {
  readGitCommitDetail,
  readGitStatus,
  readGitWorkbenchLog,
  readGitWorkbenchOverview,
} from "../lib/git-workbench";
import { executeGitWorkbenchOperation } from "../lib/git-workbench-operations";
import { buildGitChangedFileTree } from "../lib/git-workbench-client";
import { buildGitWorkbenchUrl } from "../lib/git-workbench-url";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return String(stdout).trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(cwd, file), content, "utf8");
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function currentOverview(cwd: string) {
  return readGitWorkbenchOverview(cwd);
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-workbench-"));
  const repo = path.join(root, "repo");
  const bare = path.join(root, "remote.git");
  const linked = path.join(root, "linked");
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "smoke@example.test");
    await git(repo, "config", "user.name", "Smoke 用户");
    registerAllowedRoot(repo);

    const base = await commitFile(repo, "base.txt", "base\n", "base commit");
    await git(root, "init", "--bare", bare);
    await git(repo, "remote", "add", "origin", bare);
    await git(repo, "push", "-u", "origin", "main");

    await git(repo, "switch", "-c", "source", base);
    const sourceCommit = await commitFile(repo, "source.txt", "source\n", "source change");
    await git(repo, "switch", "main");
    const firstLinear = await commitFile(repo, "one.txt", "one\n", "linear one");
    await commitFile(repo, "two.txt", "two\n", "linear two");
    await git(repo, "tag", "v-local", firstLinear);

    assert.equal(buildGitWorkbenchUrl("C:\\工作 区\\repo"), "/git?cwd=C%3A%5C%E5%B7%A5%E4%BD%9C+%E5%8C%BA%5Crepo");
    const tree = buildGitChangedFileTree([
      { status: "M", file: "src/deep/module/a.ts" },
      { status: "R", oldFile: "old/b.ts", file: "src/deep/module/b.ts" },
      { status: "A", file: "README.md" },
    ]);
    assert.equal(tree[0]?.kind, "folder");
    assert.equal(tree[0]?.name, "src/deep/module");
    assert.equal(tree[1]?.name, "README.md");
    assert.equal(tree[0]?.children?.[1]?.change?.oldFile, "old/b.ts");

    const overview = await currentOverview(repo);
    assert.equal(overview.currentBranch, "main");
    assert.equal(overview.localBranches.some((ref) => ref.name === "source"), true);
    assert.equal(overview.remoteBranches.some((ref) => ref.name === "origin/main"), true);
    assert.equal(overview.tags.some((ref) => ref.name === "v-local"), true);
    assert.equal(overview.authors.some((author) => author.name === "Smoke 用户"), true);
    assert.equal(overview.isDirty, false);

    const allPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, limit: 2 });
    assert.equal(allPage.commits.length, 2);
    assert.equal(allPage.hasMore, true);
    const nextPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, offset: 2, limit: 2 });
    assert.equal(nextPage.commits.some((commit) => allPage.commits.some((seen) => seen.hash === commit.hash)), false);

    const searchPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, query: "SOURCE CHANGE", limit: 20 });
    assert.deepEqual(searchPage.commits.map((commit) => commit.hash), [sourceCommit]);
    const hashPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, query: sourceCommit.slice(0, 9), limit: 20 });
    assert.deepEqual(hashPage.commits.map((commit) => commit.hash), [sourceCommit]);
    const author = overview.authors.find((candidate) => candidate.name === "Smoke 用户");
    assert.ok(author);
    const authorPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, authorId: author.id, limit: 20 });
    assert.ok(authorPage.commits.length >= 3);

    await git(repo, "tag", "stale-marker", "HEAD");
    await assert.rejects(
      () => readGitWorkbenchLog({ cwd: repo, revision: overview.revision, offset: 2, limit: 2 }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_REVISION",
    );
    await git(repo, "tag", "-d", "stale-marker");

    const publishedDetail = await readGitCommitDetail(repo, base);
    assert.equal(publishedDetail.capabilities?.facts.published, true);
    assert.equal(publishedDetail.capabilities?.reword.allowed, false);
    const unpushedDetail = await readGitCommitDetail(repo, firstLinear);
    assert.equal(unpushedDetail.capabilities?.reword.allowed, true);

    const specialFiles = [
      "space name.txt",
      process.platform === "win32" ? "quote'name.txt" : "quote\"name.txt",
      "unicode-文件.txt",
      process.platform === "win32" ? "arrow -＞ name.txt" : "arrow -> name.txt",
      process.platform === "win32" ? "line-break.txt" : "line\nbreak.txt",
    ];
    for (const file of specialFiles) await writeFile(path.join(repo, file), file, "utf8");
    const specialStatus = await readGitStatus(repo);
    for (const file of specialFiles) assert.equal(specialStatus.untracked.includes(file), true, file);
    for (const file of specialFiles) await unlink(path.join(repo, file));
    await commitFile(repo, "rename old.txt", "rename\n", "rename fixture");
    await git(repo, "mv", "rename old.txt", "renamed 文件.txt");
    const renamedStatus = await readGitStatus(repo);
    assert.equal(renamedStatus.staged.some((change) => change.status === "R" && change.oldFile === "rename old.txt" && change.file === "renamed 文件.txt"), true);
    await git(repo, "reset", "--hard", "HEAD");

    await git(repo, "worktree", "add", "-b", "linked-smoke", linked, "main");
    registerAllowedRoot(linked);
    const mainIdentity = await resolveGitRepository(repo);
    const linkedIdentity = await resolveGitRepository(linked);
    assert.equal(path.resolve(mainIdentity.commonDir), path.resolve(linkedIdentity.commonDir));
    await assert.rejects(
      () => withGitMutationLock(mainIdentity, () => withGitMutationLock(linkedIdentity, async () => undefined)),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "REPOSITORY_BUSY",
    );

    let state = await currentOverview(repo);
    const rewordResponse = await executeGitWorkbenchOperation({
      action: "reword",
      cwd: repo,
      hash: firstLinear,
      message: "linear one rewritten — \"quoted\"",
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.equal(rewordResponse.success, true);
    assert.match(await git(repo, "log", "--format=%s", "-6"), /linear one rewritten/);

    state = await currentOverview(repo);
    const rewrittenFirst = (await readGitWorkbenchLog({ cwd: repo, revision: state.revision, query: "linear one rewritten", limit: 5 })).commits[0]?.hash;
    assert.ok(rewrittenFirst);
    await executeGitWorkbenchOperation({
      action: "drop",
      cwd: repo,
      hash: rewrittenFirst,
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.doesNotMatch(await git(repo, "log", "--format=%s", "-6"), /linear one rewritten/);

    state = await currentOverview(repo);
    const cherry = await executeGitWorkbenchOperation({
      action: "cherry-pick",
      cwd: repo,
      hash: sourceCommit,
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.equal(await git(repo, "show", "HEAD:source.txt"), "source");

    state = cherry.overview;
    await executeGitWorkbenchOperation({
      action: "revert",
      cwd: repo,
      hash: sourceCommit,
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    await assert.rejects(() => git(repo, "show", "HEAD:source.txt"));

    state = await currentOverview(repo);
    const beforeReset = state.head!;
    const resetTarget = await git(repo, "rev-parse", `${beforeReset}^`);
    const soft = await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: resetTarget,
      mode: "soft",
      expectedRevision: state.revision,
      expectedHead: beforeReset,
    });
    assert.equal((await readGitStatus(repo)).staged.length > 0, true);
    state = soft.overview;
    await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: beforeReset,
      mode: "hard",
      confirmTarget: beforeReset.slice(0, 8),
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.equal((await readGitStatus(repo)).isDirty, false);

    state = await currentOverview(repo);
    const mixed = await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: resetTarget,
      mode: "mixed",
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.equal((await readGitStatus(repo)).unstaged.length > 0, true);
    state = mixed.overview;
    await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: beforeReset,
      mode: "hard",
      confirmTarget: beforeReset.slice(0, 8),
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });

    await writeFile(path.join(repo, "base.txt"), "base\nlocal keep\n", "utf8");
    state = await currentOverview(repo);
    const kept = await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: resetTarget,
      mode: "keep",
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.match(await readFile(path.join(repo, "base.txt"), "utf8"), /local keep/);
    state = kept.overview;
    await executeGitWorkbenchOperation({
      action: "reset",
      cwd: repo,
      hash: beforeReset,
      mode: "hard",
      confirmTarget: beforeReset.slice(0, 8),
      expectedRevision: state.revision,
      expectedHead: state.head!,
    });
    assert.equal((await readGitStatus(repo)).isDirty, false);

    const conflictBase = await commitFile(repo, "conflict.txt", "base\n", "conflict base");
    await git(repo, "switch", "-c", "conflict-source", conflictBase);
    const conflictSource = await commitFile(repo, "conflict.txt", "source\n", "conflict source");
    await git(repo, "switch", "main");
    await commitFile(repo, "conflict.txt", "current\n", "conflict current");
    state = await currentOverview(repo);
    const conflictHead = state.head!;
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "cherry-pick",
        cwd: repo,
        hash: conflictSource,
        expectedRevision: state.revision,
        expectedHead: conflictHead,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "CONFLICT_ABORTED",
    );
    const afterConflict = await currentOverview(repo);
    assert.equal(afterConflict.head, conflictHead);
    assert.equal(afterConflict.operationState, null);
    assert.equal(afterConflict.isDirty, false);

    state = afterConflict;
    const createTag = await executeGitWorkbenchOperation({
      action: "create-tag",
      cwd: repo,
      hash: state.head!,
      name: "workbench-tag",
      expectedRevision: state.revision,
    });
    assert.equal(createTag.overview.tags.some((ref) => ref.name === "workbench-tag"), true);

    state = createTag.overview;
    const createBranch = await executeGitWorkbenchOperation({
      action: "create-branch",
      cwd: repo,
      hash: state.head!,
      name: "pushme",
      expectedRevision: state.revision,
    });
    state = createBranch.overview;
    const pushRef = state.localBranches.find((ref) => ref.name === "pushme");
    assert.ok(pushRef);
    const pushed = await executeGitWorkbenchOperation({
      action: "push",
      cwd: repo,
      ref: pushRef.ref,
      remote: "origin",
      target: "pushme",
      setUpstream: true,
      expectedRevision: state.revision,
      expectedRefTip: pushRef.target,
    });
    assert.equal(await git(bare, "rev-parse", "refs/heads/pushme"), pushRef.target);

    state = pushed.overview;
    const remotePushme = state.remoteBranches.find((ref) => ref.name === "origin/pushme");
    assert.ok(remotePushme);
    const checkedOut = await executeGitWorkbenchOperation({
      action: "checkout-remote",
      cwd: repo,
      ref: remotePushme.ref,
      expectedRevision: state.revision,
    });
    assert.equal(checkedOut.overview.currentBranch, "pushme");

    const prePushHook = path.join(repo, ".git", "hooks", "pre-push");
    await writeFile(prePushHook, "#!/bin/sh\necho 'pre-push hook declined' >&2\nexit 1\n", "utf8");
    await chmod(prePushHook, 0o755);
    state = await currentOverview(repo);
    const currentPushRef = state.localBranches.find((ref) => ref.name === "pushme")!;
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "PUSH_HOOK_FAILED",
    );
    await unlink(prePushHook);

    await git(repo, "push", "origin", "refs/heads/source:refs/heads/divergent-source");
    await git(bare, "update-ref", "refs/heads/pushme", sourceCommit);
    state = await currentOverview(repo);
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "PUSH_REJECTED",
    );

    const strictRequest = new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "push",
        cwd: repo,
        ref: "refs/heads/pushme",
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
        force: true,
      }),
    });
    const strictResponse = await operateRoute(strictRequest);
    assert.equal(strictResponse.status, 400);
    assert.equal((await strictResponse.json()).code, "INVALID_REQUEST");

    console.log("smoke-git-workbench: OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
