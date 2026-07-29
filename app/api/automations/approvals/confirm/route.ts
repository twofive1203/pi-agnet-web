import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

/**
 * Deliver the one-time approval secret only after the trusted UI has presented
 * the server authority summary and collected a real AppDialog confirmation.
 * Does not accept `confirmed: true` as proof by itself from arbitrary clients
 * beyond the local-only + control-session boundary (documented trust model).
 */
export async function POST(req: Request) {
  try {
    withAutomationMutation(req);
    const body = await readJsonBody<{
      challengeId?: string;
      /** Explicitly ignored — presence of this authenticated confirm call is the gate. */
      confirmed?: unknown;
    }>(req);
    if (!body.challengeId) {
      return jsonError(Object.assign(new Error("challengeId required"), { status: 400, code: "validation" }));
    }
    const result = automationService.confirmBrowserApproval({
      challengeId: body.challengeId,
      controlSessionRaw: controlSessionRaw(req),
    });
    return jsonOk(result);
  } catch (error) {
    return jsonError(error);
  }
}
