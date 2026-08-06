import { getGrokUsageRefreshStatus, ensureGrokUsageRefreshScheduler } from "@/lib/grok-usage-refresh-scheduler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await ensureGrokUsageRefreshScheduler();
  return Response.json(await getGrokUsageRefreshStatus());
}
