/**
 * GET /api/desktop-control/projects — bounded path-free project catalog.
 * Requires a scoped desktop-control token. Never returns cwd or Prompt.
 */

import {
  assertDesktopControlToken,
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DesktopControlAccessError,
} from "@/lib/desktop-control-access";
import {
  assertDesktopProjectCatalogSafe,
  buildDesktopProjectCatalog,
} from "@/lib/desktop-project-catalog";
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
    const catalog = await buildDesktopProjectCatalog();
    assertDesktopProjectCatalogSafe(catalog);
    return new Response(JSON.stringify(catalog), {
      status: 200,
      headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
