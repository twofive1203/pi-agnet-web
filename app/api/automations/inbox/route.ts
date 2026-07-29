import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

/** Dedicated inbox/summary API: one merged time-ordered run+omission stream. */
export async function GET(req: Request) {
  try {
    withAutomationRead(req);
    const url = new URL(req.url);
    // Prefer single cursor; keep legacy dual params as aliases for offset/limit.
    const limit =
      Number(url.searchParams.get("limit") ?? url.searchParams.get("runLimit") ?? 50) || 50;
    const offset =
      Number(url.searchParams.get("offset") ?? url.searchParams.get("runOffset") ?? 0) || 0;
    const inbox = automationService.getInbox(undefined, {
      limit,
      offset,
    });
    return jsonOk(inbox);
  } catch (error) {
    return jsonError(error);
  }
}
