import { createHash } from "node:crypto";
import path from "node:path";
import type { GitStatusInfo } from "@/lib/types";
import {
  parseStatusPorcelainV1Z,
  readGitOperationState,
  runGit,
  type GitRepositoryIdentity,
} from "@/lib/git-executor";

export interface RepositoryStatusProjection {
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

function parseAheadBehind(value: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw] = value.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
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
    branch: branchOutput.trim() || null,
    head: headOutput.trim() || null,
    upstream: upstreamOutput.trim() || null,
    ahead: counts.ahead,
    behind: counts.behind,
    ...parsed,
    isDirty: parsed.staged.length > 0 || parsed.unstaged.length > 0 || parsed.untracked.length > 0,
  };
}

export async function buildGitTargetState(repo: GitRepositoryIdentity): Promise<{
  cwd: string;
  repoRoot: string;
  branch: string | null;
  head: string | null;
  isDetached: boolean;
  isDirty: boolean;
  hasUnmerged: boolean;
  isWorktree: boolean;
  operationState: Awaited<ReturnType<typeof readGitOperationState>>;
  revision: string;
}> {
  const [status, operationState] = await Promise.all([
    readRepositoryStatus(repo),
    readGitOperationState(repo),
  ]);
  const revision = createHash("sha256")
    .update([
      repo.cwd,
      status.head ?? "",
      status.branch ?? "",
      status.isDirty ? "dirty" : "clean",
      status.hasUnmerged ? "unmerged" : "merged",
      operationState ?? "",
    ].join("\0"), "utf8")
    .digest("hex");
  return {
    cwd: repo.cwd,
    repoRoot: repo.repoRoot,
    branch: status.branch,
    head: status.head,
    isDetached: Boolean(status.head && !status.branch),
    isDirty: status.isDirty,
    hasUnmerged: status.hasUnmerged,
    isWorktree: path.resolve(repo.gitDir) !== path.resolve(repo.commonDir),
    operationState,
    revision,
  };
}
