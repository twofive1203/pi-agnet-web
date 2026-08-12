/**
 * GET /api/desktop-observer/protocol — local product/protocol/mode compatibility.
 * Loopback only; no observer token required (pre-session probe).
 * Server mode returns 200 with compatible:false for pet diagnostics.
 */

import {
  assertDesktopObserverLoopback,
  buildDesktopObserverProtocolPayload,
  DesktopObserverAccessError,
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

export async function GET(req: Request): Promise<Response> {
  try {
    assertDesktopObserverLoopback(req);
    const body = buildDesktopObserverProtocolPayload();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
