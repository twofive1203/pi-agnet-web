import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    withAutomationRead(req);
    const { runId } = await ctx.params;
    const url = new URL(req.url);
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "200");
    return jsonOk(automationService.getRunSession(runId, undefined, offset, limit));
  } catch (error) {
    return jsonError(error);
  }
}
