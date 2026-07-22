import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { readPiWebConfig } from "@/lib/pi-web-config";
import { getWorkflowSetupStatus } from "@/lib/workflow-setup";
import { WorkflowSecurityError, WorkflowStoreError } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const config = readPiWebConfig();
    if (!config.workflow.enabled) {
      return NextResponse.json({ error: "SnFlow panel is disabled" }, { status: 403 });
    }

    const cwd = request.nextUrl.searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "Missing cwd parameter" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    if (!isPathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json({ status: getWorkflowSetupStatus(cwd) });
  } catch (error) {
    if (error instanceof WorkflowStoreError) {
      const status = error instanceof WorkflowSecurityError ? 400 : error.status;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
