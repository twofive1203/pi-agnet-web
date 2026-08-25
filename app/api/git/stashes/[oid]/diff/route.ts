import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { readGitStashFileDiff } from "@/lib/git-stash";
import type { GitStashFileSource } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ oid: string }> },
) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  const file = req.nextUrl.searchParams.get("path") ?? "";
  const oldFile = req.nextUrl.searchParams.get("oldPath") || undefined;
  const sourceParam = req.nextUrl.searchParams.get("source") ?? "";
  if (!cwd.trim()) return NextResponse.json({ error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  if (!file) return NextResponse.json({ error: "path is required", code: "INVALID_REQUEST" }, { status: 400 });
  if (sourceParam !== "tracked" && sourceParam !== "untracked") {
    return NextResponse.json({ error: "source must be tracked or untracked", code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const { oid } = await params;
    return NextResponse.json(await readGitStashFileDiff({
      cwd,
      oid,
      source: sourceParam as GitStashFileSource,
      file,
      oldFile,
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = gitErrorResponse(error instanceof URIError
      ? new GitWorkbenchError("INVALID_REQUEST", "Invalid stash object id.", { status: 400 })
      : error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
