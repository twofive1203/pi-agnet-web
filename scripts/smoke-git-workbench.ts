import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { POST as operateRoute } from "../app/api/git/operations/route";
import { POST as switchRoute } from "../app/api/git/switch/route";
import { registerAllowedRoot } from "../lib/allowed-roots";
import { isGitCheckoutOverwriteRefusal, runSafeGitSwitch } from "../lib/git-branch-switch";
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
import {
  buildGitChangedFileTree,
  buildGitRemoteRefGroups,
  clampGitWorkbenchChangesRatio,
  clampGitWorkbenchColumns,
  collectGitFileTreeFolderIds,
  DEFAULT_GIT_WORKBENCH_LAYOUT,
  getGitWorkbenchChangesRatioBounds,
  parseGitWorkbenchLayoutPreference,
} from "../lib/git-workbench-client";
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

async function readRepoFile(cwd: string, file: string): Promise<string> {
  return readFile(path.join(cwd, file), "utf8");
}

async function currentBranchName(cwd: string): Promise<string> {
  return git(cwd, "branch", "--show-current");
}

async function postSwitch(cwd: string, branch: string) {
  return switchRoute(new NextRequest("http://localhost/api/git/switch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, branch }),
  }));
}

async function runSafeCheckoutSmoke(parent: string): Promise<void> {
  const source = await readFile(path.join(process.cwd(), "lib", "git-branch-switch.ts"), "utf8");
  assert.doesNotMatch(source, /--force|--discard-changes|--merge\b/);
  assert.match(source, /--no-overwrite-ignore/);
  assert.equal(isGitCheckoutOverwriteRefusal("error: Your local changes to the following files would be overwritten by checkout:\n\tshared.txt\n"), true);
  assert.equal(isGitCheckoutOverwriteRefusal("error: The following untracked working tree files would be overwritten by checkout:\n\tonly-feature.txt\n"), true);
  assert.equal(isGitCheckoutOverwriteRefusal("fatal: invalid reference: no-such-branch\n"), false);
  assert.equal(isGitCheckoutOverwriteRefusal("fatal: 'feature' is already used by worktree at '/tmp/linked'\n"), false);

  await mkdir(parent, { recursive: true });
  const repo = path.join(parent, "repo");
  const bare = path.join(parent, "remote.git");
  const linked = path.join(parent, "linked");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "smoke@example.test");
  await git(repo, "config", "user.name", "Smoke 用户");
  registerAllowedRoot(repo);

  await commitFile(repo, "keep.txt", "keep\n", "keep");
  await commitFile(repo, "shared.txt", "base\n", "shared base");
  await git(parent, "init", "--bare", bare);
  await git(repo, "remote", "add", "origin", bare);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "switch", "-c", "feature");
  await commitFile(repo, "shared.txt", "feature\n", "feature shared");
  await commitFile(repo, "only-feature.txt", "feature-only\n", "feature only");
  await git(repo, "switch", "main");
  const identity = await resolveGitRepository(repo);
  const featureHash = await git(repo, "rev-parse", "feature");

  await writeFile(path.join(repo, "keep.txt"), "keep local\n", "utf8");
  await runSafeGitSwitch(identity, { kind: "existing", name: "feature" });
  assert.equal(await currentBranchName(repo), "feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep local\n");
  assert.equal((await readGitStatus(repo)).unstaged.some((change) => change.file === "keep.txt"), true);

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  await writeFile(path.join(repo, "keep.txt"), "keep staged\n", "utf8");
  await git(repo, "add", "--", "keep.txt");
  await runSafeGitSwitch(identity, { kind: "existing", name: "feature" });
  assert.equal(await currentBranchName(repo), "feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep staged\n");
  const stagedStatus = await readGitStatus(repo);
  assert.equal(stagedStatus.staged.some((change) => change.file === "keep.txt"), true);
  assert.equal(stagedStatus.unstaged.some((change) => change.file === "keep.txt"), false);

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  await writeFile(path.join(repo, "scratch 文件.txt"), "scratch\n", "utf8");
  await runSafeGitSwitch(identity, { kind: "existing", name: "feature" });
  assert.equal(await currentBranchName(repo), "feature");
  assert.equal(await readRepoFile(repo, "scratch 文件.txt"), "scratch\n");
  assert.equal((await readGitStatus(repo)).untracked.includes("scratch 文件.txt"), true);

  await git(repo, "switch", "main");
  await unlink(path.join(repo, "scratch 文件.txt"));
  await git(repo, "reset", "--hard");
  const conflictHead = await git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "shared.txt"), "main local\n", "utf8");
  await assert.rejects(
    () => runSafeGitSwitch(identity, { kind: "existing", name: "feature" }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "CHECKOUT_CONFLICT" && error.status === 409,
  );
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await git(repo, "rev-parse", "HEAD"), conflictHead);
  assert.equal(await readRepoFile(repo, "shared.txt"), "main local\n");
  assert.equal((await readGitStatus(repo)).unstaged.some((change) => change.file === "shared.txt"), true);

  await git(repo, "checkout", "--", "shared.txt");
  await writeFile(path.join(repo, "only-feature.txt"), "untracked\n", "utf8");
  await assert.rejects(
    () => runSafeGitSwitch(identity, { kind: "existing", name: "feature" }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "CHECKOUT_CONFLICT",
  );
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await readRepoFile(repo, "only-feature.txt"), "untracked\n");
  await unlink(path.join(repo, "only-feature.txt"));

  await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n", "utf8");
  await git(repo, "add", "--", ".gitignore");
  await git(repo, "commit", "-m", "ignore ignored.txt");
  await git(repo, "switch", "-c", "with-ignored");
  await writeFile(path.join(repo, "ignored.txt"), "tracked-on-branch\n", "utf8");
  await git(repo, "add", "-f", "--", "ignored.txt");
  await git(repo, "commit", "-m", "track ignored");
  await git(repo, "switch", "main");
  await writeFile(path.join(repo, "ignored.txt"), "local-ignored\n", "utf8");
  await assert.rejects(
    () => runSafeGitSwitch(identity, { kind: "existing", name: "with-ignored" }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "CHECKOUT_CONFLICT",
  );
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await readRepoFile(repo, "ignored.txt"), "local-ignored\n");
  await unlink(path.join(repo, "ignored.txt"));

  await assert.rejects(
    () => runSafeGitSwitch(identity, { kind: "existing", name: "missing-branch" }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "GIT_FAILED",
  );

  await writeFile(path.join(repo, "keep.txt"), "keep create\n", "utf8");
  let state = await currentOverview(repo);
  const created = await executeGitWorkbenchOperation({
    action: "create-branch",
    cwd: repo,
    hash: featureHash,
    name: "from-feature",
    checkout: true,
    expectedRevision: state.revision,
    expectedHead: state.head!,
  });
  assert.equal(created.overview.currentBranch, "from-feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep create\n");

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  await writeFile(path.join(repo, "shared.txt"), "block create\n", "utf8");
  state = await currentOverview(repo);
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "create-branch",
      cwd: repo,
      hash: featureHash,
      name: "blocked-create",
      checkout: true,
      expectedRevision: state.revision,
      expectedHead: state.head!,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "CHECKOUT_CONFLICT",
  );
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await readRepoFile(repo, "shared.txt"), "block create\n");
  await assert.rejects(() => git(repo, "show-ref", "--verify", "--quiet", "refs/heads/blocked-create"));
  await git(repo, "checkout", "--", "shared.txt");

  await writeFile(path.join(repo, "keep.txt"), "keep route\n", "utf8");
  const switchOk = await postSwitch(repo, "feature");
  assert.equal(switchOk.status, 200);
  assert.deepEqual(await switchOk.json(), { success: true, branch: "feature", switchedTo: "feature" });
  assert.equal(await currentBranchName(repo), "feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep route\n");

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  await writeFile(path.join(repo, "shared.txt"), "route conflict\n", "utf8");
  const switchConflict = await postSwitch(repo, "feature");
  assert.equal(switchConflict.status, 409);
  assert.equal((await switchConflict.json()).code, "CHECKOUT_CONFLICT");
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await readRepoFile(repo, "shared.txt"), "route conflict\n");

  const missing = await postSwitch(repo, "no-such");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "REF_NOT_FOUND");
  const current = await postSwitch(repo, "main");
  assert.equal(current.status, 200);
  await git(repo, "checkout", "--", "shared.txt");

  await writeFile(path.join(repo, "keep.txt"), "keep workbench\n", "utf8");
  state = await currentOverview(repo);
  const featureRef = state.localBranches.find((ref) => ref.name === "feature");
  assert.ok(featureRef);
  const localCheckout = await executeGitWorkbenchOperation({
    action: "checkout-local",
    cwd: repo,
    ref: featureRef.ref,
    expectedRevision: state.revision,
  });
  assert.equal(localCheckout.overview.currentBranch, "feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep workbench\n");

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  await writeFile(path.join(repo, "shared.txt"), "ops conflict\n", "utf8");
  state = await currentOverview(repo);
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "checkout-local",
      cwd: repo,
      ref: featureRef.ref,
      expectedRevision: state.revision,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "CHECKOUT_CONFLICT",
  );
  assert.equal(await currentBranchName(repo), "main");
  assert.equal(await readRepoFile(repo, "shared.txt"), "ops conflict\n");
  await git(repo, "checkout", "--", "shared.txt");

  await git(repo, "push", "origin", "feature");
  await git(repo, "fetch", "origin");
  await writeFile(path.join(repo, "keep.txt"), "keep remote\n", "utf8");
  state = await currentOverview(repo);
  const remoteFeature = state.remoteBranches.find((ref) => ref.name === "origin/feature");
  assert.ok(remoteFeature);
  const remoteCheckout = await executeGitWorkbenchOperation({
    action: "checkout-remote",
    cwd: repo,
    ref: remoteFeature.ref,
    localName: "tracked-feature",
    expectedRevision: state.revision,
  });
  assert.equal(remoteCheckout.overview.currentBranch, "tracked-feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep remote\n");
  assert.equal(remoteCheckout.overview.localBranches.find((ref) => ref.name === "tracked-feature")?.upstreamRef, remoteFeature.ref);

  await git(repo, "switch", "main");
  await writeFile(path.join(repo, "keep.txt"), "keep existing track\n", "utf8");
  state = await currentOverview(repo);
  const existingTrack = await executeGitWorkbenchOperation({
    action: "checkout-remote",
    cwd: repo,
    ref: remoteFeature.ref,
    localName: "tracked-feature",
    expectedRevision: state.revision,
  });
  assert.equal(existingTrack.overview.currentBranch, "tracked-feature");
  assert.equal(await readRepoFile(repo, "keep.txt"), "keep existing track\n");

  await git(repo, "switch", "main");
  await git(repo, "reset", "--hard");
  state = await currentOverview(repo);
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "checkout-remote",
      cwd: repo,
      ref: remoteFeature.ref,
      localName: "main",
      expectedRevision: state.revision,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "UNSAFE_OPERATION",
  );

  await writeFile(path.join(repo, "keep.txt"), "dirty history\n", "utf8");
  state = await currentOverview(repo);
  assert.equal(state.isDirty, true);
  const dirtyHistory = (error: unknown) => error instanceof GitWorkbenchError && error.code === "UNSAFE_OPERATION" && error.details === "dirty-working-tree";
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "cherry-pick",
    cwd: repo,
    hash: featureHash,
    expectedRevision: state.revision,
    expectedHead: state.head!,
  }), dirtyHistory);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "revert",
    cwd: repo,
    hash: featureHash,
    expectedRevision: state.revision,
    expectedHead: state.head!,
  }), dirtyHistory);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "reword",
    cwd: repo,
    hash: state.head!,
    message: "should not rewrite",
    expectedRevision: state.revision,
    expectedHead: state.head!,
  }), dirtyHistory);
  const dropTarget = await git(repo, "rev-parse", "HEAD^");
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "drop",
    cwd: repo,
    hash: dropTarget,
    expectedRevision: state.revision,
    expectedHead: state.head!,
  }), dirtyHistory);
  await git(repo, "reset", "--hard");

  await git(repo, "worktree", "add", "-b", "occupied", linked, "main");
  registerAllowedRoot(linked);
  await writeFile(path.join(repo, "keep.txt"), "dirty occupied\n", "utf8");
  state = await currentOverview(repo);
  const occupied = state.localBranches.find((ref) => ref.name === "occupied");
  assert.ok(occupied);
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "checkout-local",
      cwd: repo,
      ref: occupied.ref,
      expectedRevision: state.revision,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "BRANCH_IN_USE",
  );
  assert.equal(await currentBranchName(repo), "main");

  const staleRevision = state.revision;
  await git(repo, "reset", "--hard");
  await commitFile(repo, "stale.txt", "stale\n", "stale marker");
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "checkout-local",
      cwd: repo,
      ref: featureRef.ref,
      expectedRevision: staleRevision,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_REVISION",
  );
  assert.equal(await currentBranchName(repo), "main");

  await git(repo, "switch", "-c", "merge-left");
  await commitFile(repo, "conflict-op.txt", "left\n", "left");
  await git(repo, "switch", "main");
  await commitFile(repo, "conflict-op.txt", "right\n", "right");
  await assert.rejects(() => git(repo, "merge", "merge-left"));
  const mergeSwitch = await postSwitch(repo, "feature");
  assert.equal(mergeSwitch.status, 409);
  assert.equal(["UNMERGED_INDEX", "OPERATION_IN_PROGRESS"].includes((await mergeSwitch.json()).code), true);
  await git(repo, "merge", "--abort");
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
    await git(repo, "remote", "add", "team", bare);
    await git(repo, "fetch", "team", "main");

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
    assert.deepEqual([...collectGitFileTreeFolderIds(tree)], ["folder:src/deep/module"]);

    assert.deepEqual(parseGitWorkbenchLayoutPreference(null), DEFAULT_GIT_WORKBENCH_LAYOUT);
    assert.deepEqual(parseGitWorkbenchLayoutPreference("not-json"), DEFAULT_GIT_WORKBENCH_LAYOUT);
    assert.deepEqual(
      parseGitWorkbenchLayoutPreference(JSON.stringify({ refsWidth: 312.4, inspectorWidth: 506.7, changesRatio: 0.64 })),
      { refsWidth: 312, inspectorWidth: 507, changesRatio: 0.64 },
    );
    assert.deepEqual(
      clampGitWorkbenchColumns(960, { refsWidth: 240, inspectorWidth: 420, changesRatio: 0.5 }),
      { refsWidth: 190, inspectorWidth: 338, changesRatio: 0.5 },
    );
    assert.deepEqual(getGitWorkbenchChangesRatioBounds(606), { min: 0.3, max: 0.7 });
    assert.equal(clampGitWorkbenchChangesRatio(0.1, 606), 0.3);
    assert.equal(clampGitWorkbenchChangesRatio(0.9, 606), 0.7);

    const overview = await currentOverview(repo);
    assert.equal(overview.currentBranch, "main");
    assert.equal(overview.localBranches.some((ref) => ref.name === "source"), true);
    assert.equal(overview.remoteBranches.some((ref) => ref.name === "origin/main" && ref.remote === "origin"), true);
    assert.equal(overview.remoteBranches.some((ref) => ref.name === "team/main" && ref.remote === "team"), true);
    assert.deepEqual(overview.remotes, ["origin", "team"]);
    assert.deepEqual(
      buildGitRemoteRefGroups(overview.remotes, overview.remoteBranches).map((group) => [group.remote, group.refs.map((ref) => ref.name)]),
      [["origin", ["origin/main"]], ["team", ["team/main"]]],
    );
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
    assert.equal(searchPage.commits[0]?.containedInCurrent, false);
    const hashPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, query: sourceCommit.slice(0, 9), limit: 20 });
    assert.deepEqual(hashPage.commits.map((commit) => commit.hash), [sourceCommit]);
    assert.equal(hashPage.commits[0]?.containedInCurrent, false);
    const basePage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, query: base.slice(0, 9), limit: 20 });
    assert.equal(basePage.commits[0]?.containedInCurrent, true);
    const currentBranchPage = await readGitWorkbenchLog({ cwd: repo, revision: overview.revision, scope: "refs/heads/main", limit: 20 });
    assert.equal(currentBranchPage.commits.every((commit) => commit.containedInCurrent), true);
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

    await runSafeCheckoutSmoke(path.join(root, "safe-switch"));

    console.log("smoke-git-workbench: OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
