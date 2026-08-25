import { NextRequest, NextResponse } from "next/server";
import { gitErrorResponse } from "@/lib/git-executor";
import { readGitStashDetail } from "@/lib/git-stash";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ oid: string }> },
) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? "";
  if (!cwd.trim()) return NextResponse.json({ error: "cwd is required", code: "INVALID_CWD" }, { status: 400 });
  try {
    const { oid } = await params;
    return NextResponse.json(await readGitStashDetail(cwd, oid), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = gitErrorResponse(error);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}
