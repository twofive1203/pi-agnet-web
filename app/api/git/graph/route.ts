import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { GIT_WORKBENCH_MAX_PAGE_SIZE, readGitGraph } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  if (!cwd.trim()) {
    return NextResponse.json({ data: null, error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  }
  const maxCountRaw = Number.parseInt(req.nextUrl.searchParams.get("maxCount") ?? "50", 10);
  const maxCount = Number.isFinite(maxCountRaw)
    ? Math.min(Math.max(maxCountRaw, 1), GIT_WORKBENCH_MAX_PAGE_SIZE)
    : 50;
  const branch = req.nextUrl.searchParams.get("branch")?.trim() || undefined;

  try {
    return NextResponse.json({ data: await readGitGraph(cwd, { branch, maxCount }) });
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ data: null, code: error.code });
    }
    const mapped = gitErrorResponse(error);
    return NextResponse.json({ data: null, ...mapped.body }, { status: mapped.status });
  }
}
