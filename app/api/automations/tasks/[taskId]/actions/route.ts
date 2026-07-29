import {
  controlSessionRaw,
  jsonError,
  jsonOk,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ taskId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { taskId } = await ctx.params;
    const body = await readJsonBody<{
      action: "activate" | "resume" | "pause" | "archive";
      expectedRevision: string;
      challengeId?: string;
      secret?: string;
    }>(req);
    const approval = {
      mode: "browser" as const,
      challengeId: body.challengeId,
      secret: body.secret,
      controlSessionRaw: controlSessionRaw(req),
    };
    if (body.action === "pause") {
      return jsonOk({ task: await automationService.pause(taskId, body.expectedRevision) });
    }
    if (body.action === "archive") {
      return jsonOk({
        task: await automationService.archive(taskId, body.expectedRevision, approval),
      });
    }
    if (body.action === "activate" || body.action === "resume") {
      return jsonOk({
        task: await automationService.activate(taskId, body.expectedRevision, approval),
      });
    }
    return jsonError(Object.assign(new Error("Unknown action"), { status: 400, code: "validation" }));
  } catch (error) {
    return jsonError(error);
  }
}
