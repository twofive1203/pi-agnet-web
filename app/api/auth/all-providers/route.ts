import { createModelRegistry, isApiKeyAuthConfigured } from "@/lib/pi-auth";

export const dynamic = "force-dynamic";

// Providers handled primarily as OAuth subscriptions in the Models UI.
// Dual-auth providers like xai stay here so API-key login remains available.
const OAUTH_PROVIDER_IDS = new Set(["anthropic", "github-copilot", "openai-codex"]);

export async function GET() {
  const { runtime, registry } = await createModelRegistry();
  const all = registry.getAll();

  // Deduplicate by provider, skip OAuth-only providers and custom providers (source=models_json_key)
  const seen = new Set<string>();
  const result: {
    id: string;
    displayName: string;
    configured: boolean;
    source?: string;
    modelCount: number;
  }[] = [];

  for (const m of all) {
    if (seen.has(m.provider)) continue;
    seen.add(m.provider);
    if (OAUTH_PROVIDER_IDS.has(m.provider)) continue;
    const status = registry.getProviderAuthStatus(m.provider);
    // Skip providers whose key comes from models.json (those are custom providers)
    if (status.source === "models_json_key") continue;
    // OAuth credentials on dual-auth providers (e.g. xai subscription) must not
    // surface as an active API-key entry beside the OAuth tab.
    const configured = isApiKeyAuthConfigured(runtime, m.provider);
    const displayName = registry.getProviderDisplayName(m.provider);
    const modelCount = all.filter((x) => x.provider === m.provider).length;
    result.push({
      id: m.provider,
      displayName,
      configured,
      source: configured ? status.source : undefined,
      modelCount,
    });
  }

  return Response.json({ providers: result });
}
