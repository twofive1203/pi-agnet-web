import { NextResponse } from "next/server";
import {
  validateUpstreamPayload,
  writePricingCache,
  getPricingSummary,
  getPricingCatalog,
  lookupCachedPricing,
  SOURCE_URL as PRICING_SOURCE_URL,
} from "@/lib/model-pricing";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * GET /api/model-pricing
 *
 * Without params: returns cache summary only (never performs network I/O).
 * With ?model and optional ?provider: performs a cached lookup and returns candidates when ambiguous.
 * With ?catalog=1: returns the normalized cached catalog for the pricing viewer.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider")?.trim() || "";
    const model = url.searchParams.get("model")?.trim() || "";
    const summary = getPricingSummary();

    if (url.searchParams.get("catalog") === "1") {
      return NextResponse.json({ ok: true, mode: "catalog", ...summary, items: getPricingCatalog() });
    }

    if (!model) {
      return NextResponse.json({ ok: true, mode: "summary", ...summary });
    }

    const lookup = lookupCachedPricing(provider, model);
    return NextResponse.json({ ok: true, mode: "lookup", provider, model, lookup });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * POST /api/model-pricing
 *
 * Fetches the pi.dev model pricing endpoint, validates the response,
 * persists a local cache atomically, and returns the new summary.
 * On failure the old cache is preserved and an error is returned.
 */
export async function POST() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(PRICING_SOURCE_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { ok: false, error: `Upstream returned HTTP ${response.status}` },
        { status: 502 }
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Upstream did not return valid JSON" },
        { status: 502 }
      );
    }

    const index = validateUpstreamPayload(payload);
    const modelCount = Object.values(index).reduce(
      (acc, models) => acc + Object.keys(models).length,
      0
    );

    if (modelCount === 0) {
      return NextResponse.json(
        { ok: false, error: "Upstream returned no usable pricing data" },
        { status: 502 }
      );
    }

    const cache = writePricingCache(index, PRICING_SOURCE_URL);

    return NextResponse.json({
      ok: true,
      mode: "sync-result",
      sourceUrl: cache.sourceUrl,
      syncedAt: cache.syncedAt,
      providerCount: cache.providerCount,
      modelCount: cache.modelCount,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return NextResponse.json(
        { ok: false, error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s` },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
