import { createHash } from "node:crypto";
import path from "node:path";
import type {
  GitBranchInfo,
  GitCommitCapabilities,
  GitCommitChangedFile,
  GitCommitDetail,
  GitCommitFileStatus,
  GitCommitInfo,
  GitCommitRef,
  GitGraphCommit,
  GitGraphData,
  GitStatusInfo,
  GitWorkbenchAuthor,
  GitWorkbenchLogPage,
  GitWorkbenchOverview,
  GitWorkbenchRef,
} from "@/lib/types";
import {
  GitWorkbenchError,
  parseStatusPorcelainV1Z,
  readGitOperationState,
  resolveGitRepository,
  runGit,
  type GitRepositoryIdentity,
} from "@/lib/git-executor";

export const GIT_WORKBENCH_DEFAULT_PAGE_SIZE = 100;
export const GIT_WORKBENCH_MAX_PAGE_SIZE = 200;
export const GIT_WORKBENCH_MAX_COMMITS = 500;
export const GIT_WORKBENCH_MAX_REFS = 5_000;
export const GIT_WORKBENCH_MAX_AUTHORS = 500;
export const GIT_WORKBENCH_MAX_FILES = 5_000;
const LOG_AUTHOR_SCAN_LIMIT = 20_000;

interface RepositoryStatusProjection {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitStatusInfo["staged"];
  unstaged: GitStatusInfo["unstaged"];
  untracked: string[];
  isDirty: boolean;
  hasUnmerged: boolean;
}

function trimmed(value: string): string {
  return value.trim();
}

async function gitText(repo: GitRepositoryIdentity, args: readonly string[]): Promise<string> {
  return (await runGit(repo.cwd, args)).stdout;
}

async function tryGitText(repo: GitRepositoryIdentity, args: readonly string[]): Promise<string> {
  try {
    return await gitText(repo, args);
  } catch {
    return "";
  }
}

async function gitSucceeds(repo: GitRepositoryIdentity, args: readonly string[]): Promise<boolean> {
  try {
    await runGit(repo.cwd, args);
    return true;
  } catch {
    return false;
  }
}

function parseAheadBehind(value: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw] = value.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
  };
}

function parseTrack(value: string): { ahead: number; behind: number } {
  const ahead = /ahead\s+(\d+)/.exec(value)?.[1];
  const behind = /behind\s+(\d+)/.exec(value)?.[1];
  return {
    ahead: Number.parseInt(ahead ?? "0", 10) || 0,
    behind: Number.parseInt(behind ?? "0", 10) || 0,
  };
}

export async function readRepositoryStatus(repo: GitRepositoryIdentity): Promise<RepositoryStatusProjection> {
  const porcelain = await gitText(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parsed = parseStatusPorcelainV1Z(porcelain);
  const [headOutput, branchOutput, upstreamOutput, aheadBehindOutput] = await Promise.all([
    tryGitText(repo, ["rev-parse", "--verify", "HEAD"]),
    tryGitText(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    tryGitText(repo, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    tryGitText(repo, ["rev-list", "--count", "--left-right", "HEAD...@{upstream}"]),
  ]);
  const counts = parseAheadBehind(aheadBehindOutput);
  return {
    branch: trimmed(branchOutput) || null,
    head: trimmed(headOutput) || null,
    upstream: trimmed(upstreamOutput) || null,
    ahead: counts.ahead,
    behind: counts.behind,
    ...parsed,
    isDirty: parsed.staged.length > 0 || parsed.unstaged.length > 0 || parsed.untracked.length > 0,
  };
}

function parseRecentLog(output: string): GitCommitInfo[] {
  return output.split("\n").flatMap((line) => {
    if (!line) return [];
    const [hash, author, relativeDate, date, message] = line.split("\0");
    if (!hash || message === undefined) return [];
    return [{ hash, author, relativeDate, date, message }];
  });
}

export async function readGitStatus(cwd: string): Promise<GitStatusInfo> {
  const repo = await resolveGitRepository(cwd);
  const status = await readRepositoryStatus(repo);
  const [recentOutput, stashOutput] = await Promise.all([
    status.head
      ? tryGitText(repo, ["log", "-10", "--format=%H%x00%an%x00%ar%x00%ai%x00%s"])
      : Promise.resolve(""),
    tryGitText(repo, ["stash", "list"]),
  ]);
  return {
    branch: status.branch,
    upstream: status.upstream,
    isDetached: Boolean(status.head && !status.branch),
    isDirty: status.isDirty,
    isWorktree: path.resolve(repo.gitDir) !== path.resolve(repo.commonDir),
    ahead: status.ahead,
    behind: status.behind,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
    recentCommits: parseRecentLog(recentOutput),
    stashCount: stashOutput.trim() ? stashOutput.trimEnd().split("\n").length : 0,
  };
}

function shortRefName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

function remoteFromRef(ref: string): string | undefined {
  if (!ref.startsWith("refs/remotes/")) return undefined;
  return ref.slice("refs/remotes/".length).split("/", 1)[0] || undefined;
}

interface RefProjection {
  localBranches: GitWorkbenchRef[];
  remoteBranches: GitWorkbenchRef[];
  tags: GitWorkbenchRef[];
  truncated: boolean;
}

async function readCheckedOutBranches(repo: GitRepositoryIdentity): Promise<Map<string, string>> {
  const output = await tryGitText(repo, ["worktree", "list", "--porcelain"]);
  const checkedOut = new Map<string, string>();
  let currentPath = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/")) {
      checkedOut.set(line.slice("branch ".length), currentPath);
    }
  }
  return checkedOut;
}

async function readRefs(repo: GitRepositoryIdentity): Promise<RefProjection> {
  const output = await gitText(repo, [
    "for-each-ref",
    `--count=${GIT_WORKBENCH_MAX_REFS + 1}`,
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream)%00%(upstream:short)%00%(upstream:track)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const lines = output.trimEnd() ? output.trimEnd().split("\n") : [];
  const truncated = lines.length > GIT_WORKBENCH_MAX_REFS;
  const checkedOut = await readCheckedOutBranches(repo);
  const localBranches: GitWorkbenchRef[] = [];
  const remoteBranches: GitWorkbenchRef[] = [];
  const tags: GitWorkbenchRef[] = [];

  for (const line of lines.slice(0, GIT_WORKBENCH_MAX_REFS)) {
    const [ref, target, headMarker, upstreamRef = "", upstreamName = "", track = ""] = line.split("\0");
    if (!ref || !target) continue;
    const tracking = parseTrack(track);
    if (ref.startsWith("refs/heads/")) {
      localBranches.push({
        kind: "local",
        ref,
        name: shortRefName(ref),
        target,
        current: headMarker === "*",
        upstreamRef: upstreamRef || null,
        upstreamName: upstreamName || null,
        ahead: tracking.ahead,
        behind: tracking.behind,
        checkedOutPath: checkedOut.get(ref) ?? null,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      // Symbolic remote HEAD aliases are navigation noise, not branches.
      if (ref.endsWith("/HEAD")) continue;
      remoteBranches.push({
        kind: "remote",
        ref,
        name: shortRefName(ref),
        target,
        remote: remoteFromRef(ref),
      });
    } else if (ref.startsWith("refs/tags/")) {
      tags.push({ kind: "tag", ref, name: shortRefName(ref), target });
    }
  }
  return { localBranches, remoteBranches, tags, truncated };
}

function authorId(name: string, email: string): string {
  return createHash("sha256").update(`${name}\0${email}`, "utf8").digest("base64url").slice(0, 20);
}

async function readAuthors(repo: GitRepositoryIdentity, hasHead: boolean): Promise<{ authors: GitWorkbenchAuthor[]; truncated: boolean }> {
  if (!hasHead) return { authors: [], truncated: false };
  const output = await tryGitText(repo, [
    "log",
    "--all",
    `--max-count=${LOG_AUTHOR_SCAN_LIMIT}`,
    "--format=%aN%x00%aE",
  ]);
  const byId = new Map<string, GitWorkbenchAuthor>();
  const lines = output.trimEnd() ? output.trimEnd().split("\n") : [];
  let truncated = lines.length >= LOG_AUTHOR_SCAN_LIMIT;
  for (const line of lines) {
    const [name = "", email = ""] = line.split("\0");
    const id = authorId(name, email);
    if (!byId.has(id)) {
      if (byId.size >= GIT_WORKBENCH_MAX_AUTHORS) {
        truncated = true;
        continue;
      }
      byId.set(id, { id, name, email, label: email ? `${name} <${email}>` : name });
    }
  }
  return {
    authors: [...byId.values()].sort((left, right) => left.label.localeCompare(right.label)),
    truncated,
  };
}

function buildRevision(head: string | null, refs: readonly GitWorkbenchRef[]): string {
  const digest = createHash("sha256");
  digest.update(`HEAD\0${head ?? ""}\0`, "utf8");
  for (const ref of [...refs].sort((left, right) => left.ref.localeCompare(right.ref))) {
    digest.update(`${ref.ref}\0${ref.target}\0`, "utf8");
  }
  return digest.digest("hex");
}

export async function readGitWorkbenchOverview(cwd: string): Promise<GitWorkbenchOverview> {
  const repo = await resolveGitRepository(cwd);
  const [status, refs, operationState, remotesOutput] = await Promise.all([
    readRepositoryStatus(repo),
    readRefs(repo),
    readGitOperationState(repo),
    tryGitText(repo, ["remote"]),
  ]);
  const authorsProjection = await readAuthors(repo, Boolean(status.head));
  const allRefs = [...refs.localBranches, ...refs.remoteBranches, ...refs.tags];
  return {
    cwd: repo.cwd,
    repoRoot: repo.repoRoot,
    commonDir: repo.commonDir,
    repositoryName: path.basename(repo.repoRoot),
    revision: buildRevision(status.head, allRefs),
    head: status.head,
    currentBranch: status.branch,
    isDetached: Boolean(status.head && !status.branch),
    isEmpty: !status.head,
    isDirty: status.isDirty,
    hasUnmerged: status.hasUnmerged,
    isWorktree: path.resolve(repo.gitDir) !== path.resolve(repo.commonDir),
    operationState,
    localBranches: refs.localBranches,
    remoteBranches: refs.remoteBranches,
    tags: refs.tags,
    remotes: remotesOutput.trimEnd() ? remotesOutput.trimEnd().split("\n").filter(Boolean).sort() : [],
    authors: authorsProjection.authors,
    truncation: { refs: refs.truncated, authors: authorsProjection.truncated },
  };
}

export function parseCommitRefs(raw: string): GitCommitRef[] {
  const refs: GitCommitRef[] = [];
  for (const decoration of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    if (decoration.startsWith("tag: refs/tags/")) refs.push({ type: "tag", name: decoration.slice(15) });
    else if (decoration.startsWith("HEAD -> refs/heads/")) refs.push({ type: "head", name: decoration.slice(19) });
    else if (decoration.startsWith("refs/heads/")) refs.push({ type: "branch", name: decoration.slice(11) });
    else if (decoration.startsWith("refs/remotes/")) refs.push({ type: "remote", name: decoration.slice(13) });
    else if (decoration.startsWith("refs/tags/")) refs.push({ type: "tag", name: decoration.slice(10) });
  }
  return refs;
}

function refsByTarget(overview: GitWorkbenchOverview): Map<string, GitCommitRef[]> {
  const byTarget = new Map<string, GitCommitRef[]>();
  const append = (target: string, ref: GitCommitRef) => {
    byTarget.set(target, [...(byTarget.get(target) ?? []), ref]);
  };
  for (const ref of overview.localBranches) {
    append(ref.target, { name: ref.name, type: ref.current ? "head" : "branch" });
  }
  for (const ref of overview.remoteBranches) append(ref.target, { name: ref.name, type: "remote" });
  for (const ref of overview.tags) append(ref.target, { name: ref.name, type: "tag" });
  return byTarget;
}

function parseLogRows(output: string, byTarget: Map<string, GitCommitRef[]>): GitGraphCommit[] {
  const commits: GitGraphCommit[] = [];
  for (const line of output.trimEnd() ? output.trimEnd().split("\n") : []) {
    const [hash, parentsRaw = "", author = "", authorEmail = "", timestampRaw = "", date = "", relativeDate = "", message = ""] = line.split("\0");
    if (!hash) continue;
    commits.push({
      hash,
      parents: parentsRaw ? parentsRaw.split(/\s+/) : [],
      author,
      authorEmail,
      timestamp: Number.parseInt(timestampRaw, 10) || undefined,
      date,
      relativeDate,
      message,
      refs: byTarget.get(hash) ?? [],
    });
  }
  return commits;
}

async function markCurrentBranchCommits(
  repo: GitRepositoryIdentity,
  overview: GitWorkbenchOverview,
  scope: string,
  commits: readonly GitGraphCommit[],
): Promise<GitGraphCommit[]> {
  if (commits.length === 0) return [];
  const currentRef = overview.currentBranch ? `refs/heads/${overview.currentBranch}` : null;
  if (!overview.head || !currentRef) {
    return commits.map((commit) => ({ ...commit, containedInCurrent: false }));
  }
  if (scope === currentRef) {
    return commits.map((commit) => ({ ...commit, containedInCurrent: true }));
  }
  const output = await gitText(repo, [
    "name-rev",
    "--name-only",
    `--refs=${currentRef}`,
    ...commits.map((commit) => commit.hash),
  ]);
  const names = output.trimEnd() ? output.trimEnd().split("\n") : [];
  return commits.map((commit, index) => ({
    ...commit,
    containedInCurrent: Boolean(names[index] && names[index] !== "undefined"),
  }));
}

function escapeGitRegex(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, "\\$&");
}

function validatePageNumber(raw: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new GitWorkbenchError("INVALID_REQUEST", `${name} must be an integer between ${minimum} and ${maximum}.`, { status: 400 });
  }
  return raw;
}

async function normalizeCommitHash(repo: GitRepositoryIdentity, hash: string): Promise<string> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    throw new GitWorkbenchError("COMMIT_NOT_FOUND", "Commit not found.", { status: 404 });
  }
  try {
    return trimmed(await gitText(repo, ["rev-parse", "--verify", `${hash}^{commit}`]));
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code !== "GIT_FAILED") throw error;
    throw new GitWorkbenchError("COMMIT_NOT_FOUND", "Commit not found.", { status: 404 });
  }
}

async function isCommitInScope(repo: GitRepositoryIdentity, hash: string, scope: string): Promise<boolean> {
  if (scope === "all") {
    const containing = await tryGitText(repo, [
      "for-each-ref",
      `--contains=${hash}`,
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    return Boolean(containing.trim());
  }
  return gitSucceeds(repo, ["merge-base", "--is-ancestor", hash, scope]);
}

export async function readGitWorkbenchLog(options: {
  cwd: string;
  revision: string;
  scope?: string;
  query?: string;
  authorId?: string | null;
  offset?: number;
  limit?: number;
}): Promise<GitWorkbenchLogPage> {
  const overview = await readGitWorkbenchOverview(options.cwd);
  if (options.revision !== overview.revision) {
    throw new GitWorkbenchError("STALE_REVISION", "Repository refs changed. Refresh the workbench before loading more commits.", { status: 409 });
  }
  const scope = options.scope?.trim() || "all";
  const allowedRefs = new Set([
    ...overview.localBranches.map((ref) => ref.ref),
    ...overview.remoteBranches.map((ref) => ref.ref),
    ...overview.tags.map((ref) => ref.ref),
  ]);
  if (scope !== "all" && !allowedRefs.has(scope)) {
    throw new GitWorkbenchError("REF_NOT_FOUND", "Selected Git ref was not found.", { status: 404 });
  }
  const offset = validatePageNumber(options.offset ?? 0, "offset", 0, GIT_WORKBENCH_MAX_COMMITS);
  const limit = validatePageNumber(options.limit ?? GIT_WORKBENCH_DEFAULT_PAGE_SIZE, "limit", 1, GIT_WORKBENCH_MAX_PAGE_SIZE);
  const query = (options.query ?? "").trim().slice(0, 256);
  const selectedAuthor = options.authorId
    ? overview.authors.find((author) => author.id === options.authorId)
    : undefined;
  if (options.authorId && !selectedAuthor) {
    throw new GitWorkbenchError("INVALID_REQUEST", "Selected author is not available for this repository snapshot.", { status: 400 });
  }
  if (!overview.head) {
    return { revision: overview.revision, scope, query, authorId: selectedAuthor?.id ?? null, offset, limit, commits: [], hasMore: false };
  }

  const repo = await resolveGitRepository(overview.cwd);
  const byTarget = refsByTarget(overview);
  const targetArgs = scope === "all" ? ["--all"] : [scope];
  const format = "--format=%H%x00%P%x00%aN%x00%aE%x00%at%x00%aI%x00%ar%x00%s";

  if (/^[0-9a-fA-F]{4,40}$/.test(query)) {
    try {
      const normalized = await normalizeCommitHash(repo, query);
      const inScope = await isCommitInScope(repo, normalized, scope);
      const authorMatches = !selectedAuthor || trimmed(await gitText(repo, ["show", "-s", "--format=%aN%x00%aE", normalized])) === `${selectedAuthor.name}\0${selectedAuthor.email}`;
      const exactOutput = inScope && authorMatches && offset === 0
        ? await gitText(repo, ["show", "-s", format, normalized])
        : "";
      const commits = await markCurrentBranchCommits(repo, overview, scope, parseLogRows(exactOutput, byTarget));
      return { revision: overview.revision, scope, query, authorId: selectedAuthor?.id ?? null, offset, limit, commits, hasMore: false };
    } catch (error) {
      if (!(error instanceof GitWorkbenchError) || error.code !== "COMMIT_NOT_FOUND") throw error;
      // Fall through to literal subject search when a hexadecimal query is not a commit.
    }
  }

  const args = [
    "log",
    ...targetArgs,
    `--skip=${offset}`,
    `--max-count=${limit + 1}`,
    "--date=iso-strict",
    format,
  ];
  if (query) args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${query}`);
  if (selectedAuthor) args.push(`--author=${escapeGitRegex(`${selectedAuthor.name} <${selectedAuthor.email}>`)}`);
  const output = await gitText(repo, args);
  const rows = parseLogRows(output, byTarget);
  const commits = await markCurrentBranchCommits(repo, overview, scope, rows.slice(0, limit));
  return {
    revision: overview.revision,
    scope,
    query,
    authorId: selectedAuthor?.id ?? null,
    offset,
    limit,
    commits,
    hasMore: rows.length > limit,
  };
}

export async function readGitGraph(cwd: string, options: { branch?: string; maxCount?: number } = {}): Promise<GitGraphData> {
  const overview = await readGitWorkbenchOverview(cwd);
  const branchName = options.branch?.trim() ?? "";
  const selected = branchName
    ? overview.localBranches.find((ref) => ref.name === branchName)
    : undefined;
  if (branchName && !selected) {
    throw new GitWorkbenchError("REF_NOT_FOUND", `Local branch not found: ${branchName}`, { status: 404 });
  }
  const limit = Math.min(Math.max(options.maxCount ?? 50, 1), GIT_WORKBENCH_MAX_PAGE_SIZE);
  const page = await readGitWorkbenchLog({
    cwd: overview.cwd,
    revision: overview.revision,
    scope: selected?.ref ?? "all",
    offset: 0,
    limit,
  });
  const branches: GitBranchInfo[] = overview.localBranches.map((ref) => ({
    name: ref.name,
    isCurrent: Boolean(ref.current),
    upstream: ref.upstreamName ?? null,
    ahead: ref.ahead ?? 0,
    behind: ref.behind ?? 0,
    latestCommit: ref.target,
  }));
  return { commits: page.commits, branches };
}

function normalizeStatus(raw: string): GitCommitFileStatus {
  const status = raw.charAt(0);
  return (["M", "A", "D", "R", "C", "T", "U"].includes(status) ? status : "?") as GitCommitFileStatus;
}

function parseNameStatus(output: string): GitCommitChangedFile[] {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const files: GitCommitChangedFile[] = [];
  for (let index = 0; index < tokens.length && files.length < GIT_WORKBENCH_MAX_FILES; ) {
    const status = normalizeStatus(tokens[index++] ?? "");
    if (status === "R" || status === "C") {
      const oldFile = tokens[index++];
      const file = tokens[index++];
      if (file) files.push({ status, file, oldFile });
    } else {
      const file = tokens[index++];
      if (file) files.push({ status, file });
    }
  }
  return files;
}

function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number; binary?: boolean }> {
  const stats = new Map<string, { additions?: number; deletions?: number; binary?: boolean }>();
  const tokens = output.split("\0").filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; ) {
    const parts = (tokens[index++] ?? "").split("\t");
    if (parts.length < 3) continue;
    const [addRaw, deleteRaw] = parts;
    let file = parts.slice(2).join("\t");
    let oldFile: string | undefined;
    if (!file) {
      oldFile = tokens[index++];
      file = tokens[index++] ?? "";
    }
    if (!file) continue;
    const binary = addRaw === "-" || deleteRaw === "-";
    const value = {
      additions: binary ? undefined : Number.parseInt(addRaw, 10) || 0,
      deletions: binary ? undefined : Number.parseInt(deleteRaw, 10) || 0,
      binary,
    };
    stats.set(file, value);
    if (oldFile) stats.set(oldFile, value);
  }
  return stats;
}

async function readChangedFiles(repo: GitRepositoryIdentity, hash: string, parents: string[]): Promise<{ files: GitCommitChangedFile[]; truncated: boolean }> {
  const nameArgs = parents.length === 0
    ? ["diff-tree", "--root", "--no-commit-id", "-r", "--find-renames", "--find-copies", "--name-status", "-z", hash]
    : ["diff", "--find-renames", "--find-copies", "--name-status", "-z", parents[0], hash];
  const numstatArgs = parents.length === 0
    ? ["diff-tree", "--root", "--no-commit-id", "-r", "--find-renames", "--find-copies", "--numstat", "-z", hash]
    : ["diff", "--find-renames", "--find-copies", "--numstat", "-z", parents[0], hash];
  const [names, numbers] = await Promise.all([gitText(repo, nameArgs), tryGitText(repo, numstatArgs)]);
  const parsed = parseNameStatus(names);
  const stats = parseNumstat(numbers);
  return {
    files: parsed.map((file) => ({ ...file, ...stats.get(file.file) })),
    truncated: parsed.length >= GIT_WORKBENCH_MAX_FILES && names.split("\0").length > GIT_WORKBENCH_MAX_FILES * 2,
  };
}

function disabled(reason: NonNullable<GitCommitCapabilities[keyof Omit<GitCommitCapabilities, "facts">]>["reason"]): { allowed: false; reason: typeof reason } {
  return { allowed: false, reason };
}

export async function readCommitCapabilities(
  repo: GitRepositoryIdentity,
  overview: GitWorkbenchOverview,
  hash: string,
  parents: string[],
): Promise<GitCommitCapabilities> {
  const merge = parents.length > 1;
  const root = parents.length === 0;
  const head = overview.head === hash;
  const currentFirstParentHashes = overview.head
    ? (await tryGitText(repo, ["rev-list", "--first-parent", "HEAD"])).trim().split("\n").filter(Boolean)
    : [];
  const currentFirstParent = currentFirstParentHashes.includes(hash);
  const containedInCurrent = overview.head ? await gitSucceeds(repo, ["merge-base", "--is-ancestor", hash, "HEAD"]) : false;
  const published = Boolean((await tryGitText(repo, [
    "for-each-ref",
    `--contains=${hash}`,
    "--format=%(refname)",
    "refs/remotes",
  ])).trim());
  const rangeMerge = overview.head && containedInCurrent
    ? Boolean((await tryGitText(repo, ["rev-list", "--merges", `${hash}..HEAD`])).trim())
    : true;
  const linearToHead = currentFirstParent && !merge && !rangeMerge;
  const noBranchReason = overview.isDetached || !overview.currentBranch ? "detached-head" as const : null;
  const blockedReason = overview.operationState
    ? "operation-in-progress" as const
    : overview.hasUnmerged
      ? "unmerged-index" as const
      : null;
  const cleanReason = overview.isDirty ? "dirty-working-tree" as const : null;

  const cherryPick = noBranchReason
    ? disabled(noBranchReason)
    : blockedReason
      ? disabled(blockedReason)
      : cleanReason
        ? disabled(cleanReason)
        : merge
          ? disabled("merge-commit")
          : containedInCurrent
            ? disabled("already-contained")
            : { allowed: true };
  const revert = noBranchReason
    ? disabled(noBranchReason)
    : blockedReason
      ? disabled(blockedReason)
      : cleanReason
        ? disabled(cleanReason)
        : merge
          ? disabled("merge-commit")
          : { allowed: true };
  const reset = noBranchReason
    ? disabled(noBranchReason)
    : blockedReason
      ? disabled(blockedReason)
      : head
        ? disabled("current-commit")
        : { allowed: true };
  const rewriteReason = noBranchReason
    ?? blockedReason
    ?? cleanReason
    ?? (merge ? "merge-commit" as const : null)
    ?? (root ? "root-commit" as const : null)
    ?? (published ? "published-commit" as const : null)
    ?? (!currentFirstParent ? "not-current-first-parent" as const : null)
    ?? (!linearToHead ? "non-linear-range" as const : null);

  return {
    cherryPick,
    reset,
    revert,
    reword: rewriteReason ? disabled(rewriteReason) : { allowed: true },
    drop: head ? disabled("current-commit") : rewriteReason ? disabled(rewriteReason) : { allowed: true },
    newBranch: overview.operationState ? disabled("operation-in-progress") : { allowed: true },
    newTag: overview.operationState ? disabled("operation-in-progress") : { allowed: true },
    facts: { published, currentFirstParent, linearToHead, merge, root, head, containedInCurrent },
  };
}

export async function readGitCommitDetail(cwd: string, hashInput: string): Promise<GitCommitDetail> {
  const overview = await readGitWorkbenchOverview(cwd);
  const repo = await resolveGitRepository(overview.cwd);
  const hash = await normalizeCommitHash(repo, hashInput.trim());
  const format = "%H%x00%h%x00%P%x00%aN%x00%aE%x00%aI%x00%ar%x00%cN%x00%cE%x00%cI%x00%s%x00%b%x00%D";
  const metadata = await gitText(repo, ["show", "-s", "--decorate=full", `--format=${format}`, hash]);
  const parts = metadata.split("\0");
  if (parts.length < 13) {
    throw new GitWorkbenchError("GIT_FAILED", "Unable to parse commit metadata.");
  }
  const [fullHash, shortHash, parentsRaw, authorName, authorEmail, authorDate, authorRelativeDate, committerName, committerEmail, committerDate, subject, body, refsRaw] = parts;
  const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
  const changed = await readChangedFiles(repo, fullHash.trim(), parents);
  const capabilities = await readCommitCapabilities(repo, overview, fullHash.trim(), parents);
  return {
    hash: fullHash.trim(),
    shortHash: shortHash.trim(),
    parents,
    author: { name: authorName.trim(), email: authorEmail.trim(), date: authorDate.trim(), relativeDate: authorRelativeDate.trim() },
    committer: { name: committerName.trim(), email: committerEmail.trim(), date: committerDate.trim() },
    subject: subject.trim(),
    body: body.trim(),
    refs: parseCommitRefs((refsRaw ?? "").trim()),
    files: changed.files,
    filesTruncated: changed.truncated,
    capabilities,
  };
}

export async function normalizeGitCommit(cwd: string, hash: string): Promise<{ repo: GitRepositoryIdentity; hash: string }> {
  const repo = await resolveGitRepository(cwd);
  return { repo, hash: await normalizeCommitHash(repo, hash) };
}

export async function isGitCommandSuccessful(repo: GitRepositoryIdentity, args: readonly string[]): Promise<boolean> {
  return gitSucceeds(repo, args);
}
