import {
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
    automationService.ensure();
    return jsonOk({ tasks: automationService.listTasks() });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(req: Request) {
  try {
    withAutomationMutation(req);
    const body = await readJsonBody<{
      name: string;
      description?: string;
      cron: string;
      timezone: string;
      cwd?: string;
      cwdSource?: "project" | "default";
      provider: string;
      modelId: string;
      thinking?: string | null;
      prompt: string;
      maxRuntimeMs?: number;
      tools?: Array<{ name: string; origin?: string; sourcePath?: string }>;
      budgets?: {
        maxRunsPerDay?: number;
        maxTokensPerRun?: number;
        maxMonthlyCostUsd?: number;
        consecutiveFailureThreshold?: number;
      };
      approvalExpiresAt?: string | null;
    }>(req);
    const task = await automationService.createDraft(body);
    return jsonOk({ task }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
