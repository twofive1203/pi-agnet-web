import {
  controlSessionRaw,
  jsonError,
  readJsonBody,
  withAutomationMutation,
} from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ runId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    withAutomationMutation(req);
    const { runId } = await ctx.params;
    const body = await readJsonBody<{ challengeId?: string; secret?: string }>(req);
    if (!body.challengeId || !body.secret) {
      return jsonError(
        Object.assign(new Error("approval required"), {
          status: 403,
          code: "approval_required",
        }),
      );
    }
    const exported = await automationService.exportRun(runId, {
      mode: "browser",
      challengeId: body.challengeId,
      secret: body.secret,
      controlSessionRaw: controlSessionRaw(req),
    });
    return new NextResponse(new Uint8Array(exported.content), {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${exported.filename}"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
