import {
  isServerAccessAuthEnabled,
  noStoreHeaders,
  shouldWarnPlainHttp,
} from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal public probe: whether instance auth is required.
 * Intentionally omits project/session/model metadata.
 */
export async function GET(req: Request): Promise<Response> {
  const enabled = isServerAccessAuthEnabled();
  const body = {
    authRequired: enabled,
    httpWarning: enabled ? shouldWarnPlainHttp(req) : false,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
