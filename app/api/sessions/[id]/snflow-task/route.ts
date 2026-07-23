import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { resolveSessionPath } from "@/lib/session-reader";
import { resolveWorkflowTaskForSession } from "@/lib/workflow-session-link";
import { WorkflowSecurityError, WorkflowStoreError } from "@/lib/workflow-store";
import type { SessionEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const session = SessionManager.open(filePath);
    const header = session.getHeader();
    const cwd = header?.cwd;
    if (!cwd) {
      return NextResponse.json({ task: null, reason: "no-workspace" });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const entries = session.getEntries() as unknown as SessionEntry[];
    const result = resolveWorkflowTaskForSession(cwd, id, entries);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkflowStoreError) {
      const status = error instanceof WorkflowSecurityError ? 400 : error.status;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
