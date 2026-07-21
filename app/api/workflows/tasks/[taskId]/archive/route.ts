import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { readPiWebConfig } from "@/lib/pi-web-config";
import {
  archiveWorkflowTask,
  WorkflowSecurityError,
  WorkflowStoreError,
} from "@/lib/workflow-store";
import { isValidWorkflowTaskId } from "@/lib/workflow-types";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
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

    const { taskId } = await params;
    if (!isValidWorkflowTaskId(taskId)) {
      return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = (await request.json()) as unknown;
    if (!isRecord(body) || typeof body.expectedRevision !== "string" || !body.expectedRevision) {
      return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
    }

    const task = archiveWorkflowTask(cwd, taskId, body.expectedRevision);
    return NextResponse.json({ task });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

function storeErrorResponse(error: unknown): NextResponse {
  if (error instanceof WorkflowStoreError) {
    const status = error instanceof WorkflowSecurityError ? 400 : error.status;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status: 500 });
}
