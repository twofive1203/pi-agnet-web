import { NextRequest, NextResponse } from "next/server";
import { GitWorkbenchError, gitErrorResponse } from "@/lib/git-executor";
import { readGitWorkbenchLog } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

function integerParam(value: string | null, fallback: number, name: string): number {
  if (value === null || value === "") return fallback;
  if (!/^-?\d+$/.test(value)) {
    throw new GitWorkbenchError("INVALID_REQUEST", `${name} must be an integer.`, { status: 400 });
  }
  return Number(value);
}

export async function GET(req: NextRequest) {
  try {
    const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
    const revision = req.nextUrl.searchParams.get("revision") ?? "";
    if (!cwd.trim()) throw new GitWorkbenchError("INVALID_CWD", "cwd is required", { status: 400 });
    if (!revision) throw new GitWorkbenchError("INVALID_REQUEST", "revision is required", { status: 400 });
    const page = await readGitWorkbenchLog({
      cwd,
      revision,
      scope: req.nextUrl.searchParams.get("scope") ?? "all",
      query: req.nextUrl.searchParams.get("query") ?? "",
      authorId: req.nextUrl.searchParams.get("author"),
      offset: integerParam(req.nextUrl.searchParams.get("offset"), 0, "offset"),
      limit: integerParam(req.nextUrl.searchParams.get("limit"), 100, "limit"),
    });
    return NextResponse.json({ page });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
