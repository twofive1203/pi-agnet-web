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
    return jsonOk({ task: automationService.getTask(taskId) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { taskId } = await ctx.params;
    const body = await readJsonBody<Record<string, unknown>>(req);
    const task = await automationService.updateTask(
      taskId,
      {
        ...(body as object as Record<string, unknown>),
        expectedRevision: String(body.expectedRevision ?? ""),
      } as never,
      {
        mode: "browser",
        challengeId: body.challengeId as string | undefined,
        secret: body.secret as string | undefined,
        controlSessionRaw: controlSessionRaw(req),
      },
    );
    return jsonOk({ task });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { taskId } = await ctx.params;
    const body = await readJsonBody<{
      expectedRevision: string;
      challengeId?: string;
      secret?: string;
    }>(req);
    const task = await automationService.archive(
      taskId,
      body.expectedRevision,
      {
        mode: "browser",
        challengeId: body.challengeId,
        secret: body.secret,
        controlSessionRaw: controlSessionRaw(req),
      },
    );
    return jsonOk({ task });
  } catch (error) {
    return jsonError(error);
  }
}
