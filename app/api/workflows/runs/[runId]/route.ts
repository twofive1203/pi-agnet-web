import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { readPiWebConfig } from "@/lib/pi-web-config";
import { getWorkflowRunStatus, WorkflowRuntimeError } from "@/lib/workflow-run-manager";
import { WorkflowSecurityError, WorkflowStoreError } from "@/lib/workflow-store";
import { isValidWorkflowRunId } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    const config = readPiWebConfig();
    if (!config.workflow.enabled) {
      return NextResponse.json({ error: "SnFlow panel is disabled" }, { status: 403 });
    }

    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const { runId } = await params;
    if (!isValidWorkflowRunId(runId)) {
      return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const result = await getWorkflowRunStatus(cwd, runId);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof WorkflowStoreError || error instanceof WorkflowRuntimeError) {
    const status = error instanceof WorkflowSecurityError ? 400 : error.status;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: 500 });
}
