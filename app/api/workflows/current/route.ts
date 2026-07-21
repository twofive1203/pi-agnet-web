import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { readPiWebConfig } from "@/lib/pi-web-config";
import { getWorkflowCurrentPointer } from "@/lib/workflow-current";
import { getWorkflowTaskDetail, WorkflowStoreError, WorkflowSecurityError } from "@/lib/workflow-store";
import { workflowPhaseForStatus } from "@/lib/workflow-guidance";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = readPiWebConfig();
    if (!config.workflow.enabled) {
      return NextResponse.json({ error: "Workflow panel is disabled" }, { status: 403 });
    }

    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const pointer = getWorkflowCurrentPointer(cwd);
    if (!pointer) {
      return NextResponse.json({ task: null, reason: "no-current" });
    }

    try {
      const task = getWorkflowTaskDetail(cwd, pointer.taskId);
      return NextResponse.json({
        task,
        pointer,
        phase: workflowPhaseForStatus(task.status),
      });
    } catch {
      return NextResponse.json({ task: null, reason: "task-not-found", pointer });
    }
  } catch (error) {
    if (error instanceof WorkflowStoreError) {
      const status = error instanceof WorkflowSecurityError ? 400 : error.status;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
