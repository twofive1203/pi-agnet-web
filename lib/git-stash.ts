import { createHash } from "node:crypto";
import type {
  GitCommitFileStatus,
  GitStashAction,
  GitStashDetailResponse,
  GitStashEntry,
  GitStashFile,
  GitStashFileDiffResponse,
  GitStashFileSource,
  GitStashListResponse,
  GitStashMutationRequest,
  GitStashMutationResponse,
} from "@/lib/types";
import {
  GIT_READ_TIMEOUT_MS,
  GIT_WRITE_BUFFER,
  GIT_WRITE_TIMEOUT_MS,
  GitWorkbenchError,
  resolveGitRepository,
  runGit,
  withGitMutationLock,
  type GitRepositoryIdentity,
} from "@/lib/git-executor";
import { buildGitTargetState, readRepositoryStatus } from "@/lib/git-repository-status";

export const GIT_STASH_MAX_ENTRIES = 200;
export const GIT_STASH_MAX_FILES = 5_000;
export const GIT_STASH_NAME_MAX_LENGTH = 200;
const GIT_STASH_DIFF_BUFFER = 2 * 1024 * 1024;
const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMON_DIFF_ARGS = ["--no-ext-diff", "--no-color", "--find-renames", "--find-copies", "--patch"] as const;

function stashRevision(entries: readonly Pick<GitStashEntry, "oid">[], totalCount: number): string {
  const digest = createHash("sha256").update(`pi-web-stash-v1\0${totalCount}\0`, "utf8");
  for (const entry of entries) digest.update(`${entry.oid}\0`, "utf8");
  return digest.digest("hex");
}

function parseStashSubject(subject: string): { name: string; sourceBranch: string | null } {
  const match = /^(?:On|WIP on) ([^:]+):\s*(.*)$/.exec(subject);
  if (!match) return { name: subject || "Stash", sourceBranch: null };
  return {
    sourceBranch: match[1]?.trim() || null,
    name: match[2]?.trim() || subject,
  };
}

async function hasStashRef(repo: GitRepositoryIdentity): Promise<boolean> {
  try {
    await runGit(repo.cwd, ["show-ref", "--verify", "--quiet", "refs/stash"]);
    return true;
  } catch {
    return false;
  }
}

async function readStashEntries(repo: GitRepositoryIdentity): Promise<{
  entries: GitStashEntry[];
  totalCount: number;
  truncated: boolean;
}> {
  if (!await hasStashRef(repo)) return { entries: [], totalCount: 0, truncated: false };
  const [logOutput, countOutput] = await Promise.all([
    runGit(repo.cwd, [
      "log",
      "-g",
      "--format=%H%x00%gs%x00%ct%x00%cI%x1e",
      `--max-count=${GIT_STASH_MAX_ENTRIES + 1}`,
      "refs/stash",
    ]),
    runGit(repo.cwd, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]),
  ]);
  const records = logOutput.stdout.split("\x1e").map((record) => record.replace(/^\n+|\n+$/g, "")).filter(Boolean);
  const parsed = records.flatMap((record, index): GitStashEntry[] => {
    const [oid = "", subject = "", timestampRaw = "", createdAt = ""] = record.split("\0");
    const normalizedOid = oid.trim().toLowerCase();
    if (!FULL_OID_PATTERN.test(normalizedOid)) return [];
    const parsedSubject = parseStashSubject(subject.trim());
    const timestamp = Number.parseInt(timestampRaw, 10) || 0;
    return [{
      oid: normalizedOid,
      shortOid: normalizedOid.slice(0, 8),
      displayRef: `stash@{${index}}`,
      subject: subject.trim(),
      name: parsedSubject.name,
      sourceBranch: parsedSubject.sourceBranch,
      createdAt: createdAt.trim() || new Date(timestamp * 1_000).toISOString(),
      timestamp,
    }];
  });
  const totalCount = Number.parseInt(countOutput.stdout.trim(), 10) || parsed.length;
  return {
    entries: parsed.slice(0, GIT_STASH_MAX_ENTRIES),
    totalCount,
    truncated: totalCount > GIT_STASH_MAX_ENTRIES || parsed.length > GIT_STASH_MAX_ENTRIES,
  };
}

export async function readGitStashCount(repo: GitRepositoryIdentity): Promise<number> {
  if (!await hasStashRef(repo)) return 0;
  const output = await runGit(repo.cwd, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]);
  return Number.parseInt(output.stdout.trim(), 10) || 0;
}

export async function readGitStashes(cwd: string): Promise<GitStashListResponse> {
  const repo = await resolveGitRepository(cwd);
  return readGitStashesForRepository(repo);
}

async function readGitStashesForRepository(repo: GitRepositoryIdentity): Promise<GitStashListResponse> {
  const [projection, target] = await Promise.all([
    readStashEntries(repo),
    buildGitTargetState(repo),
  ]);
  return {
    ...projection,
    revision: stashRevision(projection.entries, projection.totalCount),
    target,
  };
}

function normalizeFileStatus(value: string): GitCommitFileStatus {
  const status = value.charAt(0);
  return (["M", "A", "D", "R", "C", "T", "U"].includes(status) ? status : "?") as GitCommitFileStatus;
}

function parseNameStatusZ(output: string, source: GitStashFileSource): GitStashFile[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const files: GitStashFile[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index++] ?? "";
    const status = normalizeFileStatus(statusToken);
    if (status === "R" || status === "C") {
      const oldFile = tokens[index++];
      const file = tokens[index++];
      if (file) files.push({ status, file, oldFile, source });
    } else {
      const file = tokens[index++];
      if (file) files.push({ status, file, source });
    }
  }
  return files;
}

async function findCurrentStash(repo: GitRepositoryIdentity, oidInput: string): Promise<{
  list: GitStashListResponse;
  entry: GitStashEntry;
}> {
  const oid = oidInput.trim().toLowerCase();
  if (!FULL_OID_PATTERN.test(oid)) {
    throw new GitWorkbenchError("STASH_NOT_FOUND", "The selected stash was not found.", { status: 404 });
  }
  const list = await readGitStashesForRepository(repo);
  const entry = list.entries.find((candidate) => candidate.oid === oid);
  if (!entry) {
    throw new GitWorkbenchError("STASH_NOT_FOUND", "The selected stash is no longer available. Refresh the stash list.", { status: 404 });
  }
  return { list, entry };
}

async function readStashParents(repo: GitRepositoryIdentity, oid: string): Promise<string[]> {
  const output = await runGit(repo.cwd, ["show", "-s", "--format=%P", oid]);
  const parents = output.stdout.trim().split(/\s+/).filter(Boolean);
  if (parents.length < 2) {
    throw new GitWorkbenchError("STASH_NOT_FOUND", "The selected object is not a valid stash entry.", { status: 404 });
  }
  return parents;
}

export async function readGitStashDetail(cwd: string, oid: string): Promise<GitStashDetailResponse> {
  const repo = await resolveGitRepository(cwd);
  const { entry } = await findCurrentStash(repo, oid);
  const parents = await readStashParents(repo, entry.oid);
  const [worktreeOutput, indexOutput, untrackedOutput] = await Promise.all([
    runGit(repo.cwd, ["diff", "--find-renames", "--find-copies", "--name-status", "-z", parents[0]!, entry.oid]),
    runGit(repo.cwd, ["diff", "--find-renames", "--find-copies", "--name-status", "-z", parents[0]!, parents[1]!]),
    parents[2]
      ? runGit(repo.cwd, ["diff", "--find-renames", "--find-copies", "--name-status", "-z", EMPTY_TREE_HASH, parents[2]])
      : Promise.resolve({ stdout: "", stderr: "" }),
  ]);
  const byPath = new Map<string, GitStashFile>();
  for (const file of parseNameStatusZ(worktreeOutput.stdout, "tracked")) byPath.set(file.file, file);
  for (const file of parseNameStatusZ(indexOutput.stdout, "tracked")) {
    if (!byPath.has(file.file)) byPath.set(file.file, file);
  }
  for (const file of parseNameStatusZ(untrackedOutput.stdout, "untracked")) {
    if (!byPath.has(file.file)) byPath.set(file.file, file);
  }
  const allFiles = [...byPath.values()];
  return {
    entry,
    files: allFiles.slice(0, GIT_STASH_MAX_FILES),
    fileCount: allFiles.length,
    filesTruncated: allFiles.length > GIT_STASH_MAX_FILES,
  };
}

function literalPathspec(file: string): string {
  return `:(literal)${file}`;
}

function pathspecs(file: string, oldFile?: string): string[] {
  return oldFile && oldFile !== file
    ? [literalPathspec(file), literalPathspec(oldFile)]
    : [literalPathspec(file)];
}

function looksBinaryDiff(diff: string): boolean {
  return /(^|\n)Binary files .+ differ(\n|$)/.test(diff) || /(^|\n)GIT binary patch(\n|$)/.test(diff);
}

export async function readGitStashFileDiff(options: {
  cwd: string;
  oid: string;
  source: GitStashFileSource;
  file: string;
  oldFile?: string;
}): Promise<GitStashFileDiffResponse> {
  const detail = await readGitStashDetail(options.cwd, options.oid);
  const selected = detail.files.find((candidate) => (
    candidate.source === options.source
    && candidate.file === options.file
    && (candidate.oldFile ?? "") === (options.oldFile ?? "")
  ));
  if (!selected) {
    throw new GitWorkbenchError("INVALID_REQUEST", "The selected file is not part of this stash entry.", { status: 400 });
  }
  const repo = await resolveGitRepository(options.cwd);
  const parents = await readStashParents(repo, detail.entry.oid);
  const base = selected.source === "tracked" ? parents[0]! : EMPTY_TREE_HASH;
  const target = selected.source === "tracked" ? detail.entry.oid : parents[2];
  if (!target) {
    return { oid: detail.entry.oid, source: selected.source, file: selected.file, oldFile: selected.oldFile, diffAvailable: false, reason: "unavailable" };
  }
  try {
    const diffArgs = [
      "diff",
      ...COMMON_DIFF_ARGS,
      base,
      target,
      "--",
      ...pathspecs(selected.file, selected.oldFile),
    ];
    const output = await runGit(repo.cwd, diffArgs, { timeoutMs: GIT_READ_TIMEOUT_MS, maxBuffer: GIT_STASH_DIFF_BUFFER });
    let diff = output.stdout;
    if (!diff.trim() && selected.source === "tracked") {
      diff = (await runGit(repo.cwd, [
        "diff",
        ...COMMON_DIFF_ARGS,
        parents[0]!,
        parents[1]!,
        "--",
        ...pathspecs(selected.file, selected.oldFile),
      ], { timeoutMs: GIT_READ_TIMEOUT_MS, maxBuffer: GIT_STASH_DIFF_BUFFER })).stdout;
    }
    if (looksBinaryDiff(diff)) {
      return { oid: detail.entry.oid, source: selected.source, file: selected.file, oldFile: selected.oldFile, diffAvailable: false, reason: "binary" };
    }
    if (!diff.trim()) {
      return { oid: detail.entry.oid, source: selected.source, file: selected.file, oldFile: selected.oldFile, diffAvailable: false, reason: "unavailable" };
    }
    return { oid: detail.entry.oid, source: selected.source, file: selected.file, oldFile: selected.oldFile, diffAvailable: true, diff };
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "GIT_OUTPUT_TOO_LARGE") {
      return { oid: detail.entry.oid, source: selected.source, file: selected.file, oldFile: selected.oldFile, diffAvailable: false, reason: "too-large" };
    }
    throw error;
  }
}

function assertExpectedRevision(current: GitStashListResponse, expected: string): void {
  if (!expected || current.revision !== expected) {
    throw new GitWorkbenchError("STALE_REVISION", "The stash list changed. Refresh and confirm the selected entry again.", { status: 409 });
  }
}

function assertExpectedTarget(current: GitStashListResponse, expected: string): void {
  if (!expected || current.target.revision !== expected) {
    throw new GitWorkbenchError("STALE_TARGET", "The target worktree changed. Refresh and confirm the target branch again.", { status: 409 });
  }
}

function assertNoOperation(list: GitStashListResponse): void {
  if (list.target.operationState) {
    throw new GitWorkbenchError("OPERATION_IN_PROGRESS", `A Git ${list.target.operationState} operation is already in progress.`, {
      status: 409,
      details: list.target.operationState,
    });
  }
}

function assertCleanTarget(list: GitStashListResponse): void {
  if (list.target.hasUnmerged) {
    throw new GitWorkbenchError("UNMERGED_INDEX", "The index has unmerged entries.", { status: 409 });
  }
  if (list.target.isDirty) {
    throw new GitWorkbenchError("DIRTY_WORKING_TREE", "Apply and pop require a clean working tree.", { status: 409 });
  }
}

async function gitStashWrite(repo: GitRepositoryIdentity, args: readonly string[]): Promise<void> {
  await runGit(repo.cwd, args, { timeoutMs: GIT_WRITE_TIMEOUT_MS, maxBuffer: GIT_WRITE_BUFFER });
}

function operationDetails(error: unknown): string {
  return error instanceof GitWorkbenchError
    ? error.details ?? error.message
    : error instanceof Error ? error.message : String(error);
}

async function refreshedMutation(
  repo: GitRepositoryIdentity,
  action: GitStashAction,
  selectedOid: string | null,
  stashRetained?: boolean,
): Promise<GitStashMutationResponse> {
  return {
    success: true,
    action,
    stashes: await readGitStashesForRepository(repo),
    selectedOid,
    stashRetained,
  };
}

async function executeCreate(
  repo: GitRepositoryIdentity,
  request: Extract<GitStashMutationRequest, { action: "create" }>,
): Promise<GitStashMutationResponse> {
  const name = request.name.trim();
  if (!name || name.length > GIT_STASH_NAME_MAX_LENGTH || /[\r\n\0]/.test(name)) {
    throw new GitWorkbenchError("INVALID_REQUEST", `Stash name must be between 1 and ${GIT_STASH_NAME_MAX_LENGTH} characters.`, { status: 400 });
  }
  const current = await readGitStashesForRepository(repo);
  assertNoOperation(current);
  if (current.target.hasUnmerged) {
    throw new GitWorkbenchError("UNMERGED_INDEX", "Cannot create a stash while the index has unmerged entries.", { status: 409 });
  }
  if (!current.target.head) {
    throw new GitWorkbenchError("UNSAFE_OPERATION", "Create the initial commit before creating a stash.", { status: 409 });
  }
  const status = await readRepositoryStatus(repo);
  const hasTracked = status.staged.length > 0 || status.unstaged.length > 0;
  const hasSelectedUntracked = request.includeUntracked && status.untracked.length > 0;
  if (!hasTracked && !hasSelectedUntracked) {
    throw new GitWorkbenchError("NOTHING_TO_STASH", "There are no selected changes to stash.", { status: 409 });
  }
  const args = ["stash", "push", "--quiet", "--message", name];
  if (request.includeUntracked) args.push("--include-untracked");
  try {
    await gitStashWrite(repo, args);
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "GIT_TIMEOUT") {
      throw new GitWorkbenchError("STASH_OUTCOME_UNKNOWN", "Stash creation timed out. Refresh before deciding whether to retry.", {
        status: 409,
        outcome: "unknown",
        details: operationDetails(error),
      });
    }
    throw error;
  }
  const refreshed = await refreshedMutation(repo, "create", null);
  return { ...refreshed, selectedOid: refreshed.stashes.entries[0]?.oid ?? null };
}

async function executeApplyOrPop(
  repo: GitRepositoryIdentity,
  request: Extract<GitStashMutationRequest, { action: "apply" | "pop" }>,
): Promise<GitStashMutationResponse> {
  const { list, entry } = await findCurrentStash(repo, request.oid);
  assertExpectedRevision(list, request.expectedRevision);
  assertExpectedTarget(list, request.expectedTargetRevision);
  assertNoOperation(list);
  assertCleanTarget(list);
  const args = ["stash", request.action];
  if (request.reinstateIndex) args.push("--index");
  args.push(request.action === "apply" ? entry.oid : entry.displayRef);
  try {
    await gitStashWrite(repo, args);
  } catch (error) {
    const refreshed = await readGitStashesForRepository(repo);
    const status = await readRepositoryStatus(repo);
    const retained = refreshed.entries.some((candidate) => candidate.oid === entry.oid);
    if (status.hasUnmerged) {
      throw new GitWorkbenchError("STASH_CONFLICT", "The stash conflicted. The worktree now contains conflicts and the stash was retained.", {
        status: 409,
        details: operationDetails(error),
        stashRetained: retained,
      });
    }
    if (error instanceof GitWorkbenchError && error.code === "GIT_TIMEOUT") {
      throw new GitWorkbenchError("STASH_OUTCOME_UNKNOWN", "The stash operation timed out. Refresh and inspect the worktree before retrying.", {
        status: 409,
        outcome: "unknown",
        details: operationDetails(error),
        stashRetained: retained,
      });
    }
    throw new GitWorkbenchError("GIT_FAILED", `Git stash ${request.action} failed. Refresh and inspect the worktree before retrying.`, {
      status: 409,
      details: operationDetails(error),
      stashRetained: retained,
    });
  }
  return refreshedMutation(repo, request.action, request.action === "apply" ? entry.oid : null, request.action === "apply");
}

async function executeDrop(
  repo: GitRepositoryIdentity,
  request: Extract<GitStashMutationRequest, { action: "drop" }>,
): Promise<GitStashMutationResponse> {
  const { list, entry } = await findCurrentStash(repo, request.oid);
  assertExpectedRevision(list, request.expectedRevision);
  assertNoOperation(list);
  try {
    await gitStashWrite(repo, ["stash", "drop", "--quiet", entry.displayRef]);
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "GIT_TIMEOUT") {
      const refreshed = await readGitStashesForRepository(repo);
      throw new GitWorkbenchError("STASH_OUTCOME_UNKNOWN", "Dropping the stash timed out. Refresh before retrying.", {
        status: 409,
        outcome: "unknown",
        details: operationDetails(error),
        stashRetained: refreshed.entries.some((candidate) => candidate.oid === entry.oid),
      });
    }
    throw error;
  }
  return refreshedMutation(repo, "drop", null, false);
}

export async function executeGitStashMutation(request: GitStashMutationRequest): Promise<GitStashMutationResponse> {
  const repo = await resolveGitRepository(request.cwd);
  return withGitMutationLock(repo, async () => {
    switch (request.action) {
      case "create": return executeCreate(repo, request);
      case "apply":
      case "pop": return executeApplyOrPop(repo, request);
      case "drop": return executeDrop(repo, request);
    }
  });
}
