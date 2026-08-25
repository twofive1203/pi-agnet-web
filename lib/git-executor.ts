import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { canonicalizeCwd, expandCwd } from "@/lib/cwd";
import type { GitFileChange, GitOperationState } from "@/lib/types";

export const GIT_READ_TIMEOUT_MS = 30_000;
export const GIT_WRITE_TIMEOUT_MS = 120_000;
export const GIT_READ_BUFFER = 8 * 1024 * 1024;
export const GIT_WRITE_BUFFER = 4 * 1024 * 1024;
const MAX_ERROR_DETAIL = 4_000;

export type GitErrorCode =
  | "INVALID_CWD"
  | "PATH_NOT_FOUND"
  | "NOT_DIRECTORY"
  | "ACCESS_DENIED"
  | "NOT_GIT_REPOSITORY"
  | "GIT_NOT_FOUND"
  | "GIT_TIMEOUT"
  | "GIT_OUTPUT_TOO_LARGE"
  | "GIT_FAILED"
  | "REPOSITORY_BUSY"
  | "OPERATION_IN_PROGRESS"
  | "STALE_REVISION"
  | "STALE_HEAD"
  | "STALE_REF"
  | "RECOVERY_REQUIRED"
  | "INVALID_REQUEST"
  | "REF_NOT_FOUND"
  | "COMMIT_NOT_FOUND"
  | "UNSAFE_OPERATION"
  | "DIRTY_WORKING_TREE"
  | "UNMERGED_INDEX"
  | "BRANCH_IN_USE"
  | "PUSH_REJECTED"
  | "PUSH_AUTH_FAILED"
  | "PUSH_HOOK_FAILED"
  | "PUSH_OUTCOME_UNKNOWN"
  | "CONFLICT_ABORTED";

export class GitWorkbenchError extends Error {
  readonly code: GitErrorCode;
  readonly status: number;
  readonly details?: string;
  readonly recoveryRequired?: boolean;
  readonly outcome?: "unknown";
  readonly stdout?: string;
  readonly stderr?: string;

  constructor(
    code: GitErrorCode,
    message: string,
    options: {
      status?: number;
      details?: string;
      recoveryRequired?: boolean;
      outcome?: "unknown";
      stdout?: string;
      stderr?: string;
    } = {},
  ) {
    super(message);
    this.name = "GitWorkbenchError";
    this.code = code;
    this.status = options.status ?? 500;
    this.details = options.details ? boundDetail(options.details) : undefined;
    this.recoveryRequired = options.recoveryRequired;
    this.outcome = options.outcome;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

export interface GitRepositoryIdentity {
  cwd: string;
  repoRoot: string;
  gitDir: string;
  commonDir: string;
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  network?: boolean;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

declare global {
  var __piGitMutationLocks: Set<string> | undefined;
}

function boundDetail(value: string): string {
  const normalized = value.trim();
  return normalized.length > MAX_ERROR_DETAIL
    ? `${normalized.slice(0, MAX_ERROR_DETAIL)}\n…`
    : normalized;
}

function errorText(error: unknown): { stdout: string; stderr: string; message: string } {
  const candidate = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  const stdout = typeof candidate.stdout === "string" ? candidate.stdout : candidate.stdout?.toString("utf8") ?? "";
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : candidate.stderr?.toString("utf8") ?? "";
  return {
    stdout,
    stderr,
    message: error instanceof Error ? error.message : String(error),
  };
}

function mapExecError(error: unknown, timeoutMs: number, network: boolean): GitWorkbenchError {
  if (error instanceof GitWorkbenchError) return error;
  const candidate = error as {
    code?: string | number;
    killed?: boolean;
    signal?: string;
    message?: string;
  };
  const text = errorText(error);
  const details = text.stderr || text.stdout || text.message || "Git command failed";

  if (candidate.code === "ENOENT") {
    return new GitWorkbenchError("GIT_NOT_FOUND", "Git executable was not found.", {
      status: 503,
      details,
      ...text,
    });
  }
  if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(candidate.message ?? "")) {
    return new GitWorkbenchError("GIT_OUTPUT_TOO_LARGE", "Git output exceeded the configured safety limit.", {
      status: 413,
      details,
      ...text,
    });
  }
  if (candidate.killed || candidate.signal === "SIGTERM" || candidate.code === "ETIMEDOUT") {
    return new GitWorkbenchError(
      network ? "PUSH_OUTCOME_UNKNOWN" : "GIT_TIMEOUT",
      network
        ? "Git push timed out; the remote outcome is unknown. Refresh before deciding whether to retry."
        : `Git operation timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
      {
        status: network ? 409 : 504,
        details,
        outcome: network ? "unknown" : undefined,
        ...text,
      },
    );
  }

  return new GitWorkbenchError("GIT_FAILED", "Git command failed.", {
    status: 500,
    details,
    ...text,
  });
}

export function runGit(
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? GIT_READ_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? GIT_READ_BUFFER;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    ...options.env,
  };

  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer,
        timeout: timeoutMs,
        windowsHide: true,
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(mapExecError(error, timeoutMs, Boolean(options.network)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export async function authorizeGitCwd(cwdInput: string): Promise<string> {
  const cwd = cwdInput.trim();
  if (!cwd) {
    throw new GitWorkbenchError("INVALID_CWD", "cwd is required", { status: 400 });
  }

  const expanded = expandCwd(cwd);
  let targetStat;
  try {
    targetStat = await stat(expanded);
  } catch {
    throw new GitWorkbenchError("PATH_NOT_FOUND", "Workspace path does not exist.", {
      status: 404,
      details: cwd,
    });
  }
  if (!targetStat.isDirectory()) {
    throw new GitWorkbenchError("NOT_DIRECTORY", "Workspace path is not a directory.", {
      status: 400,
      details: cwd,
    });
  }

  const canonical = await realpath(expanded).catch(() => canonicalizeCwd(expanded));
  const allowedRoots = await getAllowedRoots();
  if (!isPathAllowed(expanded, allowedRoots) || !isPathAllowed(canonical, allowedRoots)) {
    throw new GitWorkbenchError("ACCESS_DENIED", "Workspace is not authorized.", {
      status: 403,
      details: cwd,
    });
  }
  return canonical;
}

function absoluteGitPath(cwd: string, value: string): string {
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);
}

export async function resolveGitRepository(cwdInput: string): Promise<GitRepositoryIdentity> {
  const cwd = await authorizeGitCwd(cwdInput);
  try {
    const [root, gitDir, commonDir] = await Promise.all([
      runGit(cwd, ["rev-parse", "--show-toplevel"]),
      runGit(cwd, ["rev-parse", "--git-dir"]),
      runGit(cwd, ["rev-parse", "--git-common-dir"]),
    ]);
    return {
      cwd,
      repoRoot: absoluteGitPath(cwd, root.stdout),
      gitDir: absoluteGitPath(cwd, gitDir.stdout),
      commonDir: absoluteGitPath(cwd, commonDir.stdout),
    };
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code !== "GIT_FAILED") throw error;
    const detail = error instanceof GitWorkbenchError ? error.details : undefined;
    throw new GitWorkbenchError("NOT_GIT_REPOSITORY", "Not a Git repository.", {
      status: 400,
      details: detail,
    });
  }
}

async function markerExists(root: string, relative: string): Promise<boolean> {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

export async function readGitOperationState(repo: GitRepositoryIdentity): Promise<GitOperationState | null> {
  const checks: Array<[GitOperationState, string, string]> = [
    ["merge", repo.gitDir, "MERGE_HEAD"],
    ["rebase", repo.gitDir, "rebase-merge"],
    ["rebase", repo.gitDir, "rebase-apply"],
    ["cherry-pick", repo.gitDir, "CHERRY_PICK_HEAD"],
    ["revert", repo.gitDir, "REVERT_HEAD"],
    ["bisect", repo.commonDir, "BISECT_START"],
  ];
  for (const [state, root, marker] of checks) {
    if (await markerExists(root, marker)) return state;
  }
  return null;
}

export async function withGitMutationLock<T>(
  repo: GitRepositoryIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.__piGitMutationLocks ??= new Set<string>();
  const key = canonicalizeCwd(repo.commonDir);
  if (locks.has(key)) {
    throw new GitWorkbenchError("REPOSITORY_BUSY", "Another Git write operation is already running for this repository.", {
      status: 409,
    });
  }
  locks.add(key);
  try {
    return await operation();
  } finally {
    locks.delete(key);
  }
}

export async function assertNoGitOperation(repo: GitRepositoryIdentity): Promise<void> {
  const state = await readGitOperationState(repo);
  if (state) {
    throw new GitWorkbenchError("OPERATION_IN_PROGRESS", `A Git ${state} operation is already in progress.`, {
      status: 409,
      details: state,
    });
  }
}

function normalizeFileStatus(value: string): GitFileChange["status"] {
  return (["M", "A", "D", "R", "C", "U"].includes(value) ? value : "?") as GitFileChange["status"];
}

/** Parse `git status --porcelain=v1 -z`; rename/copy records are `XY new\0old\0`. */
export function parseStatusPorcelainV1Z(output: string): {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  untracked: string[];
  hasUnmerged: boolean;
} {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: string[] = [];
  let hasUnmerged = false;
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    const file = record.slice(3);
    if (x === "?" && y === "?") {
      untracked.push(file);
      continue;
    }

    const isRenameOrCopy = x === "R" || x === "C" || y === "R" || y === "C";
    const oldFile = isRenameOrCopy ? records[++index] || undefined : undefined;
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
      hasUnmerged = true;
    }
    if (x !== " ") staged.push({ status: normalizeFileStatus(x), file, oldFile });
    if (y !== " ") unstaged.push({ status: normalizeFileStatus(y), file, oldFile });
  }

  return { staged, unstaged, untracked, hasUnmerged };
}

export function gitErrorResponse(error: unknown): {
  body: { error: string; code: string; details?: string; recoveryRequired?: boolean; outcome?: "unknown" };
  status: number;
} {
  const mapped = error instanceof GitWorkbenchError
    ? error
    : new GitWorkbenchError("GIT_FAILED", error instanceof Error ? error.message : String(error));
  return {
    body: {
      error: mapped.message,
      code: mapped.code,
      details: mapped.details,
      recoveryRequired: mapped.recoveryRequired,
      outcome: mapped.outcome,
    },
    status: mapped.status,
  };
}
