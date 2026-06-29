import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

interface GitExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

class GitSwitchUserError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "GitSwitchUserError";
  }
}

function getGitErrorMessage(error: unknown): string {
  const err = error as Partial<GitExecError>;
  const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString();
  const stdout = typeof err.stdout === "string" ? err.stdout : err.stdout?.toString();
  const message = error instanceof Error ? error.message : String(error);
  return (stderr || stdout || message || "Git command failed").trim();
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return String(stdout);
}

async function assertGitRepository(cwd: string): Promise<void> {
  try {
    await git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new GitSwitchUserError("Not a Git repository", 400);
  }
}

async function assertLocalBranchExists(cwd: string, branch: string): Promise<void> {
  try {
    await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
  } catch {
    throw new GitSwitchUserError(`Local branch not found: ${branch}`, 404);
  }
}

async function assertCleanWorkingTree(cwd: string): Promise<void> {
  let dirtyOutput: string;
  try {
    dirtyOutput = (await git(["status", "--porcelain"], cwd)).trim();
  } catch (error) {
    throw new GitSwitchUserError(
      `Unable to verify working tree cleanliness: ${getGitErrorMessage(error)}`,
      500,
    );
  }

  if (dirtyOutput) {
    throw new GitSwitchUserError(
      "Cannot switch branches while the working tree has uncommitted changes.",
      409,
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      cwd?: unknown;
      branch?: unknown;
    };

    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!branch) {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }

    await assertGitRepository(cwd);
    await assertLocalBranchExists(cwd, branch);
    await assertCleanWorkingTree(cwd);

    try {
      await git(["switch", "--", branch], cwd);
    } catch (error) {
      throw new GitSwitchUserError(
        `Failed to switch to branch "${branch}": ${getGitErrorMessage(error)}`,
        500,
      );
    }

    return NextResponse.json({ success: true, branch, switchedTo: branch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof GitSwitchUserError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
