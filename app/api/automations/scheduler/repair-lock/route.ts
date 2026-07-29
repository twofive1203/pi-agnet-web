import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    withAutomationMutation(req);
    const body = await readJsonBody<{ challengeId?: string; secret?: string }>(req);
    const result = await automationService.repairSchedulerLock({
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
