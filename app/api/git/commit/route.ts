import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { readGitCommitDetail } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  const hash = req.nextUrl.searchParams.get("hash")?.trim() ?? "";
  if (!cwd.trim()) {
    return NextResponse.json({ detail: null, error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  }
  if (!hash) {
    return NextResponse.json({ detail: null, error: "hash is required", code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    return NextResponse.json({ detail: await readGitCommitDetail(cwd, hash) });
  } catch (error) {
    if (error instanceof GitWorkbenchError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ detail: null, code: error.code });
    }
    const mapped = gitErrorResponse(error);
    return NextResponse.json({ detail: null, ...mapped.body }, { status: mapped.status });
  }
}
