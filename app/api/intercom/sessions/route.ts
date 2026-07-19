import { NextResponse } from "next/server";
import { listIntercomSessions } from "@/lib/intercom-hub";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/intercom/sessions?cwd=...
 * List local pi-intercom broker sessions (best-effort).
 */
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
  const result = await listIntercomSessions(cwd || undefined);
  return NextResponse.json(result);
}
