import { getDeepSeekProviderBalance } from "@/lib/deepseek-balance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 查询 API Key provider 的官方余额。
 *
 * @param _req 当前 HTTP 请求对象。
 * @param context Next.js 动态路由参数，包含 provider 标识。
 * @returns provider 的余额查询 JSON。
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const balance = await getDeepSeekProviderBalance(provider);
  return Response.json(balance);
}
