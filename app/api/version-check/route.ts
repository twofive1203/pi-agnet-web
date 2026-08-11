import { checkPackageUpdates } from "@/lib/package-update-check";
import { noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Compare running web (spi) + pi versions against the public npm registry.
 * Used by the empty new-session hero to show a quiet update indicator.
 * Failures return updateAvailable=false rather than 5xx so the UI stays silent.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const forceRefresh = url.searchParams.get("refresh") === "1";
  const body = await checkPackageUpdates({ forceRefresh });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
