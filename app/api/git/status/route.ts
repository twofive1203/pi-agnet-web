import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { readGitStatus } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  if (!cwd.trim()) {
    return NextResponse.json({ status: null, error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  }

  try {
    return NextResponse.json({ status: await readGitStatus(cwd) });
  } catch (error) {
    // Compatibility: the compact Inspector has always represented a normal
    // non-repository directory as `{ status: null }`, not as a load failure.
    if (error instanceof GitWorkbenchError && error.code === "NOT_GIT_REPOSITORY") {
      return NextResponse.json({ status: null, code: error.code });
    }
    const mapped = gitErrorResponse(error);
    return NextResponse.json({ status: null, ...mapped.body }, { status: mapped.status });
  }
}
