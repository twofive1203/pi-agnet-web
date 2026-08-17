/**
 * POST /api/desktop-control/session — mint a short-lived scoped control token.
 * Loopback only; Origin exact match or absent (Electron main).
 * Server mode requires a valid access key in the JSON body (no browser cookie).
 * Observer tokens are never accepted or issued here.
 */

import {
  assertDesktopControlAccessKey,
  assertDesktopControlLocalAccess,
  assertDesktopControlSessionOrigin,
  DESKTOP_CONTROL_TOKEN_HEADER,
  DesktopControlAccessError,
  issueDesktopControlToken,
} from "@/lib/desktop-control-access";
import { MAX_LOGIN_BODY_BYTES, noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SessionBody = {
  accessKey?: unknown;
};

function errorResponse(error: unknown): Response {
  if (error instanceof DesktopControlAccessError) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (error.code === "rate_limited") {
      headers["Retry-After"] = "30";
    }
    return new Response(
      JSON.stringify({ error: error.message, code: error.code }),
      {
        status: error.status,
        headers: noStoreHeaders(headers),
      },
    );
  }
  return new Response(JSON.stringify({ error: "Internal error", code: "error" }), {
    status: 500,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

async function readBoundedJsonBody(req: Request): Promise<SessionBody | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_LOGIN_BODY_BYTES) {
      await req.body?.cancel("session body too large").catch(() => undefined);
      return null;
    }
  }

  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LOGIN_BODY_BYTES) {
        await reader.cancel("session body too large").catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return {};
  try {
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return JSON.parse(text) as SessionBody;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const remote = assertDesktopControlLocalAccess(req);
    assertDesktopControlSessionOrigin(req);

    const contentType = req.headers.get("content-type") ?? "";
    // Empty body is allowed in local mode; server mode rejects missing key later.
    let body: SessionBody = {};
    if (contentType.toLowerCase().includes("application/json") || req.headers.get("content-length")) {
      const parsed = await readBoundedJsonBody(req);
      if (parsed == null) {
        return new Response(JSON.stringify({ error: "Invalid request", code: "bad_request" }), {
          status: 400,
          headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
        });
      }
      body = parsed;
    }

    await assertDesktopControlAccessKey(req, body.accessKey);

    const issued = issueDesktopControlToken({ remote });
    return new Response(
      JSON.stringify({
        token: issued.token,
        expiresAt: issued.expiresAt,
        ttlMs: issued.ttlMs,
        instanceId: issued.instanceId,
        scopes: issued.scopes,
        tokenHeader: DESKTOP_CONTROL_TOKEN_HEADER,
      }),
      {
        status: 200,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
