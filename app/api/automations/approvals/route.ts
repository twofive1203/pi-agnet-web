import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";
import type { ApprovalAction } from "@/lib/automation-approval";

export const dynamic = "force-dynamic";

/**
 * Create an approval challenge.
 * Returns challengeId + normalized authority summary — NOT a consumable secret.
 * Clients must POST /api/automations/approvals/confirm after a real UI confirmation.
 *
 * Local-only trust boundary: this is loopback + control-session gated UX control,
 * not remote identity authentication. Body fields like `confirmed: true` are ignored.
 */
export async function POST(req: Request) {
  try {
    withAutomationMutation(req);
    const body = await readJsonBody<{
      action: ApprovalAction;
      taskId?: string;
      runId?: string;
      revision?: string;
      proposedConfig?: unknown;
      /** Ignored — confirmation is a separate endpoint after AppDialog. */
      confirmed?: unknown;
    }>(req);
    if (!body.action) {
      return jsonError(Object.assign(new Error("action required"), { status: 400, code: "validation" }));
    }
    // Reject attempts to short-circuit confirmation via body flags.
    if (body.confirmed === true) {
      return jsonError(
        Object.assign(new Error("confirmed body flag cannot assert approval; use /approvals/confirm after UI dialog"), {
          status: 403,
          code: "approval_required",
        }),
      );
    }
    const challenge = await automationService.createBrowserApproval({
      action: body.action,
      taskId: body.taskId,
      runId: body.runId,
      revision: body.revision,
      proposedConfig: body.proposedConfig,
      controlSessionRaw: controlSessionRaw(req),
    });
    return jsonOk(challenge);
  } catch (error) {
    return jsonError(error);
  }
}
