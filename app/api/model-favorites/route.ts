import { NextResponse } from "next/server";
import {
  ModelFavoritesValidationError,
  readModelFavorites,
  setModelFavorite,
} from "@/lib/model-favorites";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(readModelFavorites(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as {
      provider?: unknown;
      modelId?: unknown;
      favorite?: unknown;
    };
    const state = await setModelFavorite(
      { provider: body.provider, modelId: body.modelId },
      body.favorite,
    );
    return NextResponse.json(state, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof ModelFavoritesValidationError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
