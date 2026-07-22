import { NextRequest, NextResponse } from "next/server";
import { getAllowedRoots, isPathAllowed } from "@/lib/allowed-roots";
import { canonicalizeCwd } from "@/lib/cwd";
import { readPiWebConfig } from "@/lib/pi-web-config";
import { initializeWorkflowProject } from "@/lib/workflow-setup";
import { WorkflowSecurityError, WorkflowStoreError } from "@/lib/workflow-store";

export const dynamic = "force-dynamic";

/**
 * Initialize SnFlow for an authorized workspace: create task dirs, install
 * managed extension/skill/agent/script assets, and write .version.
 * Activation is project-local (tasks/ presence); there is no global enable switch.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }

    const allowedRoots = await getAllowedRoots();
    const canonicalCwd = canonicalizeCwd(cwd);
    if (!isPathAllowed(cwd, allowedRoots) || !isPathAllowed(canonicalCwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const trackInGit = readPiWebConfig().workflow.trackInGit === true;
    const result = initializeWorkflowProject(canonicalCwd, { trackInGit });
    if (!result.success) {
      return NextResponse.json(result, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkflowStoreError) {
      const status = error instanceof WorkflowSecurityError ? 400 : error.status;
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
