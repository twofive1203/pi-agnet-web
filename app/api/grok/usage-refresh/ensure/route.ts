import { ensureGrokUsageRefreshScheduler } from "@/lib/grok-usage-refresh-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  return Response.json(await ensureGrokUsageRefreshScheduler());
}
