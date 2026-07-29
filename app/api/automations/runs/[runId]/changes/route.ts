import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    withAutomationRead(req);
    const { runId } = await ctx.params;
    return jsonOk(automationService.getRunChanges(runId));
  } catch (error) {
    return jsonError(error);
  }
}
