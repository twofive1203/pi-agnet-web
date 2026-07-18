import { NextResponse } from "next/server";
import {
  createModelRegistry,
  isApiKeyAuthConfigured,
  removeStoredCredential,
  setStoredApiKey,
} from "@/lib/pi-auth";
import { reloadRpcAuthState } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  const { runtime, registry } = await createModelRegistry();
  const status = registry.getProviderAuthStatus(provider);
  // Do not treat OAuth subscription credentials as API-key configuration.
  const configured = isApiKeyAuthConfigured(runtime, provider);
  const displayName = registry.getProviderDisplayName(provider);
  const models = registry.getAll().filter((m) => m.provider === provider).length;
  return NextResponse.json({
    provider,
    displayName,
    configured,
    source: configured ? status.source : undefined,
    models,
  });
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    const { apiKey } = await req.json() as { apiKey?: string };
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
    }
    await setStoredApiKey(provider, apiKey.trim());
    reloadRpcAuthState();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(_req: Request, { params }: Params) {
  const { provider } = await params;
  try {
    await removeStoredCredential(provider);
    reloadRpcAuthState();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
