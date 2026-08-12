/**
 * GET /api/desktop-observer/snapshot — current bounded observer snapshot.
 */

import {
  assertDesktopObserverToken,
  DesktopObserverAccessError,
} from "@/lib/desktop-observer-access";
import { getTaskObserverHub } from "@/lib/task-observer-hub";
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
    assertDesktopObserverToken(req);
    const url = new URL(req.url);
    const reset = url.searchParams.get("reset") === "1" || url.searchParams.get("reset") === "true";
    const hub = getTaskObserverHub();
    const { json } = hub.getSnapshot({ reset });
    return new Response(json, {
      status: 200,
      headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
