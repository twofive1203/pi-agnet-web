import {
  revokeServerAccessSession,
} from "@/lib/server-access-auth";
import {
  assertAuthRequestSameOrigin,
  buildSessionCookie,
  isServerAccessAuthEnabled,
  noStoreHeaders,
  readSessionTokenFromCookieHeader,
  resolveEffectiveProtocol,
} from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, body: Record<string, unknown>, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: noStoreHeaders({
      "Content-Type": "application/json; charset=utf-8",
      ...(headers as Record<string, string> | undefined),
    }),
  });
}

export async function POST(req: Request): Promise<Response> {
  // Logout is always safe/idempotent — even in local mode clear any stray cookie.
  if (isServerAccessAuthEnabled()) {
    try {
      assertAuthRequestSameOrigin(req);
    } catch {
      return json(403, { ok: false, error: "Request blocked" });
    }
  }

  const token = readSessionTokenFromCookieHeader(req.headers.get("cookie"));
  try {
    await revokeServerAccessSession(token);
  } catch {
    // Still clear cookie.
  }

  const secure = resolveEffectiveProtocol(req) === "https";
  const cookie = buildSessionCookie("", { clear: true, secure });
  return json(200, { ok: true }, { "Set-Cookie": cookie });
}
