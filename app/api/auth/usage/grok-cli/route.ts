import { NextRequest, NextResponse } from "next/server";
import { getGrokAccountUsage, getGrokUsage } from "@/lib/grok-usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") === "refresh" ? "refresh" : "cache";
  const accountId = request.nextUrl.searchParams.get("accountId")?.trim() || "";
  const provider = request.nextUrl.searchParams.get("provider")?.trim() || "grok-cli";

  if (accountId) {
    const result = await getGrokAccountUsage(provider, accountId, mode);
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  }

  const result = await getGrokUsage(mode);
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}
