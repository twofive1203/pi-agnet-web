import { readOpenAICodexWarmupHistory, recordOpenAICodexWarmupRun } from "@/lib/openai-codex-warmup-history";
import { ensureOpenAICodexWarmupScheduler } from "@/lib/openai-codex-warmup-scheduler";
import { warmOpenAICodexAccounts } from "@/lib/openai-codex-warmup";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_WARMUP_ACCOUNTS = 20;

function normalizeAccountIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const accountIds: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const accountId = item.trim();
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    accountIds.push(accountId);
  }
  return accountIds;
}

export async function GET() {
  ensureOpenAICodexWarmupScheduler();
  return Response.json(await readOpenAICodexWarmupHistory());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { accountIds?: unknown } | null;
  const accountIds = normalizeAccountIds(body?.accountIds);

  if (!accountIds) {
    return Response.json({ error: "accountIds must be an array of strings" }, { status: 400 });
  }
  if (accountIds.length === 0) {
    return Response.json({ error: "Select at least one account to warm up" }, { status: 400 });
  }
  if (accountIds.length > MAX_WARMUP_ACCOUNTS) {
    return Response.json({ error: `Select at most ${MAX_WARMUP_ACCOUNTS} accounts` }, { status: 400 });
  }

  ensureOpenAICodexWarmupScheduler();
  const startedAt = new Date().toISOString();
  const response = await warmOpenAICodexAccounts(accountIds);
  await recordOpenAICodexWarmupRun({
    source: "manual",
    startedAt,
    completedAt: new Date().toISOString(),
    accountIds,
    results: response.results,
  }).catch(() => {});
  return Response.json(response);
}
