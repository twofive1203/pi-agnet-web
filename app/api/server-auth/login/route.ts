import {
  checkLoginRateLimit,
  createServerAccessSession,
  recordLoginFailure,
  recordLoginSuccess,
  ServerAccessError,
} from "@/lib/server-access-auth";
import {
  MAX_ACCESS_KEY_LENGTH,
  MAX_LOGIN_BODY_BYTES,
  assertAuthRequestSameOrigin,
  buildSessionCookie,
  clientKeyFromRequest,
  isServerAccessAuthEnabled,
  noStoreHeaders,
  resolveEffectiveProtocol,
} from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginBody = {
  accessKey?: unknown;
};

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
  if (!isServerAccessAuthEnabled()) {
    // Local mode: login is a no-op success so clients can be dumb.
    return json(200, { ok: true, authRequired: false });
  }

  try {
    assertAuthRequestSameOrigin(req);
  } catch {
    return json(403, { ok: false, error: "Request blocked" });
  }

  const clientKey = clientKeyFromRequest(req);
  const rate = checkLoginRateLimit(clientKey);
  if (!rate.allowed) {
    return json(
      429,
      { ok: false, error: "Too many attempts. Try again later." },
      { "Retry-After": String(rate.retryAfterSec) },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    recordLoginFailure(clientKey);
    return json(400, { ok: false, error: "Invalid request" });
  }

  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_LOGIN_BODY_BYTES) {
    recordLoginFailure(clientKey);
    return json(400, { ok: false, error: "Invalid request" });
  }

  let body: LoginBody;
  try {
    body = JSON.parse(Buffer.from(raw).toString("utf8")) as LoginBody;
  } catch {
    recordLoginFailure(clientKey);
    return json(400, { ok: false, error: "Invalid request" });
  }

  const accessKey = typeof body.accessKey === "string" ? body.accessKey : "";
  if (!accessKey || accessKey.length > MAX_ACCESS_KEY_LENGTH) {
    recordLoginFailure(clientKey);
    return json(401, { ok: false, error: "Invalid access key" });
  }

  try {
    const session = await createServerAccessSession(accessKey);
    recordLoginSuccess(clientKey);
    const secure = resolveEffectiveProtocol(req) === "https";
    const cookie = buildSessionCookie(session.token, {
      maxAgeSec: session.maxAgeSec,
      secure,
    });
    return json(
      200,
      { ok: true, authRequired: true, expiresAt: session.expiresAt },
      { "Set-Cookie": cookie },
    );
  } catch (error) {
    if (error instanceof ServerAccessError) {
      if (error.code === "invalid_credentials") {
        recordLoginFailure(clientKey);
        return json(401, { ok: false, error: "Invalid access key" });
      }
      if (error.code === "rate_limited") {
        return json(
          429,
          { ok: false, error: "Too many attempts. Try again later." },
          error.retryAfterSec != null ? { "Retry-After": String(error.retryAfterSec) } : undefined,
        );
      }
      // Fail closed — do not leak path/details.
      return json(503, { ok: false, error: "Authentication unavailable" });
    }
    return json(503, { ok: false, error: "Authentication unavailable" });
  }
}
