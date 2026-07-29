import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { getAuthorizedAutomationRun } from "@/lib/automation-session";
import { getSessionFileDiff } from "@/lib/session-file-changes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    withAutomationRead(req);
    const { runId } = await ctx.params;
    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return jsonError(Object.assign(new Error("path required"), { status: 400, code: "validation" }));
    }
    const run = getAuthorizedAutomationRun(runId);
    if (!run.session.sessionId) {
      return jsonOk({ available: false, reason: "no_session" });
    }
    const diff = getSessionFileDiff(run.session.sessionId, path);
    return jsonOk({ available: Boolean(diff), diff });
  } catch (error) {
    return jsonError(error);
  }
}
