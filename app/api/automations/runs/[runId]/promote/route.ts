import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { runId } = await ctx.params;
    const body = await readJsonBody<{ challengeId?: string; secret?: string }>(req);
    const promotion = await automationService.promoteRun(runId, {
      mode: "browser",
      challengeId: body.challengeId,
      secret: body.secret,
      controlSessionRaw: controlSessionRaw(req),
    });
    return jsonOk({ promotion });
  } catch (error) {
    return jsonError(error);
  }
}
