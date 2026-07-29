import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
  withAutomationRead,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    withAutomationRead(req);
    return jsonOk({ scheduler: automationService.schedulerStatus() });
  } catch (error) {
    return jsonError(error);
  }
}

/** Mutations: set_global_disabled (requires approval challenge after UI confirm). */
export async function POST(req: Request) {
  try {
    withAutomationMutation(req);
    const body = await readJsonBody<{
      action?: string;
      disabled?: boolean;
      challengeId?: string;
      secret?: string;
    }>(req);
    if (body.action === "set_disabled" || body.action === "set_global_disabled") {
      const scheduler = await automationService.setDisabled(
        Boolean(body.disabled),
        {
          mode: "browser",
          challengeId: body.challengeId,
          secret: body.secret,
          controlSessionRaw: controlSessionRaw(req),
        },
      );
      return jsonOk({ scheduler });
    }
    return jsonError(
      Object.assign(new Error("Unknown scheduler status action"), {
        status: 400,
        code: "validation",
      }),
    );
  } catch (error) {
    return jsonError(error);
  }
}
