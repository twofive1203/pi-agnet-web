import { jsonError, jsonOk, withAutomationRead } from "@/lib/automation-api";
import { automationService } from "@/lib/automation-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    withAutomationRead(req);
    const url = new URL(req.url);
    const taskId = url.searchParams.get("taskId") ?? undefined;
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const limit = Number(url.searchParams.get("limit") ?? 50) || 50;
    const page = automationService.listRuns(taskId, undefined, offset, limit);
    return jsonOk(page);
  } catch (error) {
    return jsonError(error);
  }
}
