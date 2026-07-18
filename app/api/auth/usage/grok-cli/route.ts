import { NextRequest, NextResponse } from "next/server";
import { getGrokUsage } from "@/lib/grok-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode");
  const refresh = mode === "refresh";

  const result = await getGrokUsage(refresh ? "refresh" : "cache");
  return NextResponse.json(result);
}
