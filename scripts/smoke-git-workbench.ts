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
  GIT_WORKBENCH_MAX_REFS,
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
  parseGitPushUpstreamDestination,
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
    expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
    expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
    expectedHeadRef: state.headRef,
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
    expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "UNSAFE_OPERATION",
  );

  await git(repo, "branch", "twin", "HEAD");
  const sameTipMain = await currentOverview(repo);
  const sameTipHead = sameTipMain.head!;
  const sameTipParent = await git(repo, "rev-parse", "HEAD^");
  assert.equal(sameTipMain.headRef, "refs/heads/main");
  await git(repo, "switch", "twin");
  const sameTipTwin = await currentOverview(repo);
  assert.equal(sameTipTwin.head, sameTipHead);
  assert.equal(sameTipTwin.headRef, "refs/heads/twin");
  assert.notEqual(sameTipTwin.revision, sameTipMain.revision);
  const staleHeadRef = (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_HEAD_REF";
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "reset",
    cwd: repo,
    hash: sameTipParent,
    mode: "soft",
    expectedRevision: sameTipMain.revision,
    expectedHead: sameTipHead,
    expectedHeadRef: sameTipMain.headRef,
  }), staleHeadRef);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "reword",
    cwd: repo,
    hash: sameTipHead,
    message: "must not rewrite twin",
    expectedRevision: sameTipMain.revision,
    expectedHead: sameTipHead,
    expectedHeadRef: sameTipMain.headRef,
  }), staleHeadRef);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "checkout-local",
    cwd: repo,
    ref: featureRef.ref,
    expectedRevision: sameTipMain.revision,
    expectedHeadRef: sameTipMain.headRef,
  }), staleHeadRef);
  assert.equal(await git(repo, "rev-parse", "refs/heads/main"), sameTipHead);
  assert.equal(await git(repo, "rev-parse", "refs/heads/twin"), sameTipHead);
  assert.equal(await currentBranchName(repo), "twin");

  await git(repo, "switch", "main");
  const attachedSnapshot = await currentOverview(repo);
  await git(repo, "switch", "--detach", attachedSnapshot.head!);
  const detachedSnapshot = await currentOverview(repo);
  assert.equal(detachedSnapshot.head, attachedSnapshot.head);
  assert.equal(detachedSnapshot.headRef, null);
  assert.notEqual(detachedSnapshot.revision, attachedSnapshot.revision);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "reset",
    cwd: repo,
    hash: sameTipParent,
    mode: "soft",
    expectedRevision: attachedSnapshot.revision,
    expectedHead: attachedSnapshot.head!,
    expectedHeadRef: attachedSnapshot.headRef,
  }), staleHeadRef);
  await git(repo, "switch", "main");
  const reattachedSnapshot = await currentOverview(repo);
  assert.notEqual(reattachedSnapshot.revision, detachedSnapshot.revision);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "checkout-local",
    cwd: repo,
    ref: featureRef.ref,
    expectedRevision: detachedSnapshot.revision,
    expectedHeadRef: detachedSnapshot.headRef,
  }), staleHeadRef);
  await git(repo, "branch", "-D", "twin");

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
    expectedHeadRef: state.headRef,
  }), dirtyHistory);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "revert",
    cwd: repo,
    hash: featureHash,
    expectedRevision: state.revision,
    expectedHead: state.head!,
    expectedHeadRef: state.headRef,
  }), dirtyHistory);
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "reword",
    cwd: repo,
    hash: state.head!,
    message: "should not rewrite",
    expectedRevision: state.revision,
    expectedHead: state.head!,
    expectedHeadRef: state.headRef,
  }), dirtyHistory);
  const dropTarget = await git(repo, "rev-parse", "HEAD^");
  await assert.rejects(() => executeGitWorkbenchOperation({
    action: "drop",
    cwd: repo,
    hash: dropTarget,
    expectedRevision: state.revision,
    expectedHead: state.head!,
    expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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

async function runCompleteSnapshotSmoke(parent: string): Promise<void> {
  const repo = path.join(parent, "repo");
  const bare = path.join(parent, "remote.git");
  await mkdir(parent, { recursive: true });
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "snapshot@example.test");
  await git(repo, "config", "user.name", "Snapshot Smoke");
  registerAllowedRoot(repo);

  const base = await commitFile(repo, "base.txt", "base\n", "snapshot base");
  const tip = await commitFile(repo, "tip.txt", "tip\n", "snapshot tip");
  await git(parent, "init", "--bare", bare);
  await git(repo, "remote", "add", "zremote", bare);
  await git(repo, "branch", "zz-current", tip);
  await git(repo, "switch", "zz-current");
  await git(repo, "update-ref", "refs/remotes/zremote/zz-current", tip);
  await git(repo, "branch", "--set-upstream-to=zremote/zz-current", "zz-current");
  await git(repo, "pack-refs", "--all", "--prune");

  const packedRefs = new Map<string, string>();
  for (const line of (await git(repo, "show-ref")).split("\n")) {
    const [target, ref] = line.trim().split(/\s+/, 2);
    if (target && ref) packedRefs.set(ref, target);
  }
  for (let index = 0; index < GIT_WORKBENCH_MAX_REFS + 20; index += 1) {
    packedRefs.set(`refs/heads/bulk/${String(index).padStart(5, "0")}`, base);
  }
  const packedBody = [
    "# pack-refs with: peeled fully-peeled sorted",
    ...[...packedRefs].sort(([left], [right]) => left.localeCompare(right)).map(([ref, target]) => `${target} ${ref}`),
    "",
  ].join("\n");
  await writeFile(path.join(repo, ".git", "packed-refs"), packedBody, "utf8");

  const overview = await currentOverview(repo);
  assert.equal(overview.revisionComplete, true);
  assert.equal(overview.truncation.refs, true);
  const current = overview.localBranches.find((ref) => ref.ref === "refs/heads/zz-current");
  assert.ok(current?.current);
  assert.equal(current.upstreamRef, "refs/remotes/zremote/zz-current");
  assert.equal(overview.remoteBranches.some((ref) => ref.ref === current.upstreamRef), true);
  const hiddenRef = `refs/heads/bulk/${String(GIT_WORKBENCH_MAX_REFS + 10).padStart(5, "0")}`;
  assert.equal(overview.localBranches.some((ref) => ref.ref === hiddenRef), false);

  await git(repo, "update-ref", hiddenRef, tip);
  const changed = await currentOverview(repo);
  assert.notEqual(changed.revision, overview.revision);
  await assert.rejects(
    () => readGitWorkbenchLog({ cwd: repo, revision: overview.revision, offset: 1, limit: 1 }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_REVISION",
  );

  const constrainedRead = { completeRefMaxBufferBytes: 128 };
  const incomplete = await readGitWorkbenchOverview(repo, constrainedRead);
  assert.equal(incomplete.revisionComplete, false);
  assert.equal(incomplete.truncation.refs, true);
  const firstPage = await readGitWorkbenchLog({
    cwd: repo,
    revision: incomplete.revision,
    limit: 1,
    readOptions: constrainedRead,
  });
  assert.equal(firstPage.commits.length, 1);
  assert.equal(firstPage.hasMore, false);
  await assert.rejects(
    () => readGitWorkbenchLog({
      cwd: repo,
      revision: incomplete.revision,
      offset: 1,
      limit: 1,
      readOptions: constrainedRead,
    }),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "SNAPSHOT_INCOMPLETE",
  );
  await assert.rejects(
    () => executeGitWorkbenchOperation({
      action: "create-tag",
      cwd: repo,
      hash: tip,
      name: "must-not-write",
      expectedRevision: incomplete.revision,
    }, constrainedRead),
    (error: unknown) => error instanceof GitWorkbenchError && error.code === "SNAPSHOT_INCOMPLETE",
  );
  await assert.rejects(() => git(repo, "show-ref", "--verify", "--quiet", "refs/tags/must-not-write"));
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-git-workbench-"));
  const repo = path.join(root, "repo");
  const bare = path.join(root, "remote.git");
  const teamBare = path.join(root, "team-remote.git");
  const linked = path.join(root, "linked");
  try {
    await mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "smoke@example.test");
    await git(repo, "config", "user.name", "Smoke 用户");
    registerAllowedRoot(repo);

    const base = await commitFile(repo, "base.txt", "base\n", "base commit");
    await git(root, "init", "--bare", bare);
    await git(root, "init", "--bare", teamBare);
    await git(repo, "remote", "add", "origin", bare);
    await git(repo, "push", "-u", "origin", "main");
    await git(repo, "remote", "add", "team", teamBare);
    await git(repo, "push", "team", "main");
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

    const hiddenTree = await git(repo, "rev-parse", "HEAD^{tree}");
    const hiddenCommit = await git(repo, "commit-tree", hiddenTree, "-m", "custom-ref-only commit");
    await git(repo, "update-ref", "refs/custom/hidden", hiddenCommit);
    await git(repo, "update-ref", "refs/stash", hiddenCommit);
    const narrowUniverse = await currentOverview(repo);
    const narrowPage = await readGitWorkbenchLog({ cwd: repo, revision: narrowUniverse.revision, limit: 200 });
    assert.equal(narrowPage.commits.some((commit) => commit.hash === hiddenCommit), false);
    await git(repo, "update-ref", "refs/custom/hidden", base);
    assert.equal((await currentOverview(repo)).revision, narrowUniverse.revision);
    await git(repo, "update-ref", "-d", "refs/custom/hidden");
    await git(repo, "update-ref", "-d", "refs/stash");

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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
    });
    assert.doesNotMatch(await git(repo, "log", "--format=%s", "-6"), /linear one rewritten/);

    state = await currentOverview(repo);
    const cherry = await executeGitWorkbenchOperation({
      action: "cherry-pick",
      cwd: repo,
      hash: sourceCommit,
      expectedRevision: state.revision,
      expectedHead: state.head!,
      expectedHeadRef: state.headRef,
    });
    assert.equal(await git(repo, "show", "HEAD:source.txt"), "source");

    state = cherry.overview;
    await executeGitWorkbenchOperation({
      action: "revert",
      cwd: repo,
      hash: sourceCommit,
      expectedRevision: state.revision,
      expectedHead: state.head!,
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
      expectedHeadRef: state.headRef,
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
        expectedHeadRef: state.headRef,
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
    assert.equal(pushRef.upstreamRef, null);
    assert.deepEqual(parseGitPushUpstreamDestination("refs/remotes/origin/topic/name"), { remote: "origin", target: "topic/name" });
    assert.equal(parseGitPushUpstreamDestination("refs/heads/main"), null);
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: pushRef.ref,
        destination: { mode: "upstream", expectedUpstreamRef: "refs/remotes/origin/pushme" },
        expectedRevision: state.revision,
        expectedRefTip: pushRef.target,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_UPSTREAM",
    );

    const explicitTeamPush = await executeGitWorkbenchOperation({
      action: "push",
      cwd: repo,
      ref: pushRef.ref,
      destination: { mode: "explicit", remote: "team", target: "team-topic", setUpstream: false },
      expectedRevision: state.revision,
      expectedRefTip: pushRef.target,
    });
    assert.deepEqual(explicitTeamPush.destination, {
      mode: "explicit",
      remote: "team",
      target: "team-topic",
      ref: "refs/heads/team-topic",
    });
    assert.equal(await git(teamBare, "rev-parse", "refs/heads/team-topic"), pushRef.target);
    await assert.rejects(() => git(bare, "rev-parse", "--verify", "refs/heads/team-topic"));
    state = explicitTeamPush.overview;
    const stillExplicit = state.localBranches.find((ref) => ref.ref === pushRef.ref)!;
    assert.equal(stillExplicit.upstreamRef, null);

    const pushed = await executeGitWorkbenchOperation({
      action: "push",
      cwd: repo,
      ref: stillExplicit.ref,
      destination: { mode: "explicit", remote: "origin", target: "pushme", setUpstream: true },
      expectedRevision: state.revision,
      expectedRefTip: stillExplicit.target,
    });
    assert.deepEqual(pushed.destination, {
      mode: "explicit",
      remote: "origin",
      target: "pushme",
      ref: "refs/heads/pushme",
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
      expectedHeadRef: state.headRef,
    });
    assert.equal(checkedOut.overview.currentBranch, "pushme");

    await commitFile(repo, "push-exact.txt", "push exact\n", "push exact destination");
    state = await currentOverview(repo);
    let currentPushRef = state.localBranches.find((ref) => ref.name === "pushme")!;
    const originBeforeExact = await git(bare, "rev-parse", "refs/heads/pushme");
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        destination: { mode: "explicit", remote: "team", target: "alternate", setUpstream: false },
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_UPSTREAM",
    );
    assert.equal(await git(bare, "rev-parse", "refs/heads/pushme"), originBeforeExact);
    await assert.rejects(() => git(teamBare, "rev-parse", "--verify", "refs/heads/alternate"));

    const exactUpstreamPush = await executeGitWorkbenchOperation({
      action: "push",
      cwd: repo,
      ref: currentPushRef.ref,
      destination: { mode: "upstream", expectedUpstreamRef: currentPushRef.upstreamRef! },
      expectedRevision: state.revision,
      expectedRefTip: currentPushRef.target,
    });
    assert.deepEqual(exactUpstreamPush.destination, {
      mode: "upstream",
      remote: "origin",
      target: "pushme",
      ref: "refs/heads/pushme",
    });
    assert.equal(await git(bare, "rev-parse", "refs/heads/pushme"), currentPushRef.target);
    await assert.rejects(() => git(teamBare, "rev-parse", "--verify", "refs/heads/alternate"));

    state = exactUpstreamPush.overview;
    currentPushRef = state.localBranches.find((ref) => ref.name === "pushme")!;
    const expectedUpstreamRef = currentPushRef.upstreamRef!;
    await git(repo, "branch", "--set-upstream-to=team/main", "pushme");
    const staleUpstreamState = await currentOverview(repo);
    assert.equal(staleUpstreamState.revision, state.revision);
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        destination: { mode: "upstream", expectedUpstreamRef },
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
      }),
      (error: unknown) => error instanceof GitWorkbenchError && error.code === "STALE_UPSTREAM",
    );
    assert.equal(await git(bare, "rev-parse", "refs/heads/pushme"), currentPushRef.target);
    assert.equal(await git(teamBare, "rev-parse", "refs/heads/main"), base);
    await git(repo, "branch", "--set-upstream-to=origin/pushme", "pushme");

    const prePushHook = path.join(repo, ".git", "hooks", "pre-push");
    await writeFile(prePushHook, "#!/bin/sh\necho 'pre-push hook declined' >&2\nexit 1\n", "utf8");
    await chmod(prePushHook, 0o755);
    state = await currentOverview(repo);
    currentPushRef = state.localBranches.find((ref) => ref.name === "pushme")!;
    await assert.rejects(
      () => executeGitWorkbenchOperation({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        destination: { mode: "upstream", expectedUpstreamRef: currentPushRef.upstreamRef! },
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
        destination: { mode: "upstream", expectedUpstreamRef: currentPushRef.upstreamRef! },
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
        destination: { mode: "upstream", expectedUpstreamRef: currentPushRef.upstreamRef },
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
        force: true,
      }),
    });
    const strictResponse = await operateRoute(strictRequest);
    assert.equal(strictResponse.status, 400);
    assert.equal((await strictResponse.json()).code, "INVALID_REQUEST");

    const mixedDestinationResponse = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "push",
        cwd: repo,
        ref: currentPushRef.ref,
        destination: {
          mode: "upstream",
          expectedUpstreamRef: currentPushRef.upstreamRef,
          remote: "team",
          target: "alternate",
        },
        expectedRevision: state.revision,
        expectedRefTip: currentPushRef.target,
      }),
    }));
    assert.equal(mixedDestinationResponse.status, 400);
    assert.equal((await mixedDestinationResponse.json()).code, "INVALID_REQUEST");

    const missingHeadRefResponse = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "checkout-local",
        cwd: repo,
        ref: "refs/heads/main",
        expectedRevision: state.revision,
      }),
    }));
    assert.equal(missingHeadRefResponse.status, 400);
    assert.equal((await missingHeadRefResponse.json()).code, "INVALID_REQUEST");

    const validBodyState = await currentOverview(repo);
    const validBodyResponse = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create-tag",
        cwd: repo,
        hash: validBodyState.head,
        name: "route-body-ok",
        expectedRevision: validBodyState.revision,
      }),
    }));
    assert.equal(validBodyResponse.status, 200);
    assert.equal((await validBodyResponse.json()).success, true);

    const declaredTooLarge = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(64 * 1024 + 1) },
      body: "{}",
    }));
    assert.equal(declaredTooLarge.status, 413);

    const oversizedBody = JSON.stringify({ action: "create-tag", padding: "界".repeat(30_000) });
    const missingLengthRequest = new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedBody,
    });
    missingLengthRequest.headers.delete("content-length");
    const missingLengthResponse = await operateRoute(missingLengthRequest);
    assert.equal(missingLengthResponse.status, 413);

    const forgedLengthResponse = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: oversizedBody,
    }));
    assert.equal(forgedLengthResponse.status, 413);

    const invalidJsonResponse = await operateRoute(new NextRequest("http://localhost/api/git/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }));
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal((await invalidJsonResponse.json()).code, "INVALID_REQUEST");

    await runSafeCheckoutSmoke(path.join(root, "safe-switch"));
    await runCompleteSnapshotSmoke(path.join(root, "complete-snapshot"));

    console.log("smoke-git-workbench: OK");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
