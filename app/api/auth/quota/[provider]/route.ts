import { consumeOAuthAccountResetCredit, consumeOAuthProviderResetCredit, getOAuthAccountSubscriptionQuota, getOAuthProviderSubscriptionQuota } from "@/lib/subscription-quota";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountIdFromBody(body: unknown): string | null {
  if (!isRecord(body) || typeof body.accountId !== "string") return null;
  const accountId = body.accountId.trim();
  return accountId ? accountId : null;
}

/**
 * 查询 OAuth provider 的官方订阅额度。
 *
 * @param req 当前 HTTP 请求对象。
 * @param context Next.js 动态路由参数，包含 provider 标识。
 * @returns provider 的订阅额度 JSON。
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const accountId = new URL(req.url).searchParams.get("accountId");
  const quota = accountId?.trim()
    ? await getOAuthAccountSubscriptionQuota(provider, accountId)
    : await getOAuthProviderSubscriptionQuota(provider);
  return Response.json(quota);
}

/**
 * 消耗一个 OAuth provider 的 Codex rate-limit reset credit 并刷新订阅额度。
 *
 * @param req 当前 HTTP 请求对象，可包含可选 accountId。
 * @param context Next.js 动态路由参数，包含 provider 标识。
 * @returns 刷新后的订阅额度 JSON，失败时包含用户可见错误。
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const body = await req.json().catch(() => null) as unknown;
  const accountId = accountIdFromBody(body);
  const quota = accountId
    ? await consumeOAuthAccountResetCredit(provider, accountId)
    : await consumeOAuthProviderResetCredit(provider);
  return Response.json(quota, { status: quota.success ? 200 : 502 });
}
