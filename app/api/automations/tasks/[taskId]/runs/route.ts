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

type Ctx = { params: Promise<{ taskId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    withAutomationRead(req);
    const { taskId } = await ctx.params;
    const url = new URL(req.url);
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    const page = automationService.listRuns(taskId, undefined, offset, limit);
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { taskId } = await ctx.params;
    const body = await readJsonBody<{
      expectedRevision: string;
      challengeId?: string;
      secret?: string;
    }>(req);
    const run = await automationService.runNow(
      taskId,
      body.expectedRevision,
      {
        mode: "browser",
        challengeId: body.challengeId,
        secret: body.secret,
        controlSessionRaw: controlSessionRaw(req),
      },
    );
    return jsonOk({ run }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
