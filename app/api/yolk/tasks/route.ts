import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { canonicalizeCwd } from "@/lib/cwd";
import { createYolkTask, listYolkTasks, YolkReaderSecurityError } from "@/lib/yolk-reader";
import type { YolkCreateTaskRequest } from "@/lib/yolk-types";

export const dynamic = "force-dynamic";

async function authorizeCwd(cwd: string): Promise<string | NextResponse> {
  const allowedRoots = await getAllowedRoots();
  const canonicalCwd = canonicalizeCwd(cwd);
  if (!isPathAllowed(cwd, allowedRoots) || !isPathAllowed(canonicalCwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return canonicalCwd;
}

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    const authorized = await authorizeCwd(cwd);
    if (authorized instanceof NextResponse) return authorized;
    return NextResponse.json(listYolkTasks(authorized));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof YolkReaderSecurityError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Partial<YolkCreateTaskRequest>;
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    const authorized = await authorizeCwd(cwd);
    if (authorized instanceof NextResponse) return authorized;
    const task = createYolkTask({
      cwd: authorized,
      title: typeof body.title === "string" ? body.title : "",
      priority: typeof body.priority === "string" ? body.priority : undefined,
      assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      prd: typeof body.prd === "string" ? body.prd : undefined,
    });
    return NextResponse.json({ task });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof YolkReaderSecurityError || /required|enabled|characters|fewer/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
