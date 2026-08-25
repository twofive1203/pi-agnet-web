import { NextRequest, NextResponse } from "next/server";
import { gitErrorResponse } from "@/lib/git-executor";
import { readGitWorkbenchOverview } from "@/lib/git-workbench";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  if (!cwd.trim()) {
    return NextResponse.json({ error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  }
  try {
    return NextResponse.json({ overview: await readGitWorkbenchOverview(cwd) });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
