/**
 * GET /api/desktop-control/models?projectRef= — bounded path-free model catalog.
 * Requires a scoped desktop-control token. Never returns cwd or thinking maps.
 */

import {
  assertDesktopControlToken,
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DesktopControlAccessError,
} from "@/lib/desktop-control-access";
import {
  assertDesktopQuickSessionModelCatalogSafe,
  buildDesktopQuickSessionModelCatalog,
} from "@/lib/desktop-quick-session-models";
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

export async function GET(req: Request): Promise<Response> {
  try {
    assertDesktopControlToken(req, DESKTOP_CONTROL_SCOPE_QUICK_SESSION);
    const projectRef = new URL(req.url).searchParams.get("projectRef");
    const result = await buildDesktopQuickSessionModelCatalog(projectRef);
    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.code, code: result.code }), {
        status: result.status,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      });
    }
    assertDesktopQuickSessionModelCatalogSafe(result.catalog);
    return new Response(JSON.stringify(result.catalog), {
      status: 200,
      headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
