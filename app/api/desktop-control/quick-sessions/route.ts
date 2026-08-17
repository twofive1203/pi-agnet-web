/**
 * POST /api/desktop-control/quick-sessions — start one Agent session.
 * Requires a scoped desktop-control token. Success only means the session was
 * created and the first Prompt dispatched; provider outcome stays on observer.
 */

import {
  assertDesktopControlToken,
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DesktopControlAccessError,
} from "@/lib/desktop-control-access";
import {
  createDesktopQuickSession,
  DESKTOP_QUICK_SESSION_MAX_BODY_BYTES,
} from "@/lib/desktop-quick-session";
import { noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof DesktopControlAccessError) {
    return new Response(JSON.stringify({ error: error.message, code: error.code }), {
      status: error.status,
      headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }
  return new Response(JSON.stringify({ error: "Internal error", code: "error" }), {
    status: 500,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

async function readBoundedJson(req: Request): Promise<unknown | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > DESKTOP_QUICK_SESSION_MAX_BODY_BYTES) {
      await req.body?.cancel("quick session body too large").catch(() => undefined);
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
      if (total > DESKTOP_QUICK_SESSION_MAX_BODY_BYTES) {
        await reader.cancel("quick session body too large").catch(() => undefined);
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
    return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    assertDesktopControlToken(req, DESKTOP_CONTROL_SCOPE_QUICK_SESSION);
    const body = await readBoundedJson(req);
    if (body == null) {
      return new Response(JSON.stringify({ error: "Invalid request", code: "bad_request" }), {
        status: 400,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      });
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const result = await createDesktopQuickSession({
      projectRef: record.projectRef,
      message: record.message,
      requestId: record.requestId,
    });
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.code, code: result.code }), {
        status: result.status,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      });
    }
    return new Response(
      JSON.stringify({
        sessionId: result.sessionId,
        deepLink: result.deepLink,
        duplicate: result.duplicate,
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
