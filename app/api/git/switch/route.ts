import { NextRequest, NextResponse } from "next/server";
import {
  GIT_WRITE_BUFFER,
  GIT_WRITE_TIMEOUT_MS,
  GitWorkbenchError,
  assertNoGitOperation,
  gitErrorResponse,
  resolveGitRepository,
  runGit,
  withGitMutationLock,
} from "@/lib/git-executor";
import { readGitWorkbenchOverview } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { cwd?: unknown; branch?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (!cwd) throw new GitWorkbenchError("INVALID_CWD", "cwd is required", { status: 400 });
    if (!branch) throw new GitWorkbenchError("INVALID_REQUEST", "branch is required", { status: 400 });

    const repo = await resolveGitRepository(cwd);
    return await withGitMutationLock(repo, async () => {
      const overview = await readGitWorkbenchOverview(repo.cwd);
      const selected = overview.localBranches.find((ref) => ref.name === branch);
      if (!selected) throw new GitWorkbenchError("REF_NOT_FOUND", `Local branch not found: ${branch}`, { status: 404 });
      if (selected.current) return NextResponse.json({ success: true, branch, switchedTo: branch });
      if (overview.isDirty) {
        throw new GitWorkbenchError("DIRTY_WORKING_TREE", "Cannot switch branches while the working tree has uncommitted changes.", { status: 409 });
      }
      if (overview.hasUnmerged) throw new GitWorkbenchError("UNMERGED_INDEX", "Cannot switch branches while the index has unmerged entries.", { status: 409 });
      await assertNoGitOperation(repo);
      if (selected.checkedOutPath && selected.checkedOutPath !== repo.repoRoot) {
        throw new GitWorkbenchError("BRANCH_IN_USE", "The branch is checked out in another linked worktree.", {
          status: 409,
          details: selected.checkedOutPath,
        });
      }
      await runGit(repo.cwd, ["switch", branch], { timeoutMs: GIT_WRITE_TIMEOUT_MS, maxBuffer: GIT_WRITE_BUFFER });
      return NextResponse.json({ success: true, branch, switchedTo: branch });
    });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
