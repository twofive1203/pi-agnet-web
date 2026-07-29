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

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { runId } = await ctx.params;
    const body = await readJsonBody<{ challengeId?: string; secret?: string }>(req);
    const result = await automationService.deleteRunArtifacts(runId, {
      mode: "browser",
      challengeId: body.challengeId,
      secret: body.secret,
      controlSessionRaw: controlSessionRaw(req),
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
