import { buildProcessHealthSnapshot } from "@/lib/process-runtime";
import { noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Minimal public runtime health probe for ops / load balancers.
 * Returns process identity, single-instance signals, live session/SSE aggregates,
 * and Automation scheduler role — never session ids, cwds, paths, or secrets.
 */
export async function GET(): Promise<Response> {
  const body = await buildProcessHealthSnapshot();
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
