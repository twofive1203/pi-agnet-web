/**
 * POST /api/desktop-observer/session — mint a short-lived observer token.
 * Loopback + local mode; Origin exact match or absent (Electron main).
 */

import {
  assertDesktopObserverLocalAccess,
  assertDesktopObserverSessionOrigin,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DesktopObserverAccessError,
  issueDesktopObserverToken,
} from "@/lib/desktop-observer-access";
import { noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof DesktopObserverAccessError) {
    return new Response(
      JSON.stringify({ error: error.message, code: error.code }),
      {
        status: error.status,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      },
    );
  }
  return new Response(JSON.stringify({ error: "Internal error", code: "error" }), {
    status: 500,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const remote = assertDesktopObserverLocalAccess(req);
    assertDesktopObserverSessionOrigin(req);
    const issued = issueDesktopObserverToken({ remote });
    return new Response(
      JSON.stringify({
        token: issued.token,
        expiresAt: issued.expiresAt,
        ttlMs: issued.ttlMs,
        instanceId: issued.instanceId,
        tokenHeader: DESKTOP_OBSERVER_TOKEN_HEADER,
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
