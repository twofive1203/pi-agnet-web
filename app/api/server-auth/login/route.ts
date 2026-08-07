import {
  consumeLoginAttempt,
  createServerAccessSession,
  recordLoginSuccess,
  ServerAccessError,
} from "@/lib/server-access-auth";
import {
  getAutomationRemoteAddress,
  installAutomationConnectionCapture,
} from "@/lib/automation-connection-context";
import {
  MAX_ACCESS_KEY_LENGTH,
  MAX_LOGIN_BODY_BYTES,
  assertAuthRequestSameOrigin,
  buildSessionCookie,
  clientKeyFromRequest,
  isSecureTransportRequired,
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

async function readBoundedRequestBody(req: Request): Promise<Buffer | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_LOGIN_BODY_BYTES) {
      await req.body?.cancel("login body too large").catch(() => undefined);
      return null;
    }
  }

  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel("login body too large").catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function socketRemoteAddress(): string | null {
  try {
    installAutomationConnectionCapture();
  } catch {
    // Missing socket context falls back to one shared fail-closed bucket, never forwarded headers.
  }
  return getAutomationRemoteAddress();
}

export async function POST(req: Request): Promise<Response> {
  if (!isServerAccessAuthEnabled()) {
    // Local mode: login is a no-op success so clients can be dumb.
    return json(200, { ok: true, authRequired: false });
  }

  if (isSecureTransportRequired(req)) {
    return json(426, {
      ok: false,
      error: "HTTPS is required",
      code: "secure_transport_required",
    });
  }

  try {
    assertAuthRequestSameOrigin(req);
  } catch {
    return json(403, { ok: false, error: "Request blocked" });
  }

  const clientKey = clientKeyFromRequest(req, socketRemoteAddress());
  const rate = consumeLoginAttempt(clientKey);
  if (!rate.allowed) {
    return json(
      429,
      { ok: false, error: "Too many attempts. Try again later." },
      { "Retry-After": String(rate.retryAfterSec) },
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json(400, { ok: false, error: "Invalid request" });
  }

  const raw = await readBoundedRequestBody(req);
  if (!raw) {
    return json(400, { ok: false, error: "Invalid request" });
  }

  let body: LoginBody;
  try {
    body = JSON.parse(raw.toString("utf8")) as LoginBody;
  } catch {
    return json(400, { ok: false, error: "Invalid request" });
  }

  const accessKey = typeof body.accessKey === "string" ? body.accessKey : "";
  if (!accessKey || accessKey.length > MAX_ACCESS_KEY_LENGTH) {
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
