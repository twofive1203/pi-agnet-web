import {
  createDefaultModelRuntime,
  isProviderUsingOAuth,
  listOAuthProviders,
} from "@/lib/pi-auth";
import { OPENAI_CODEX_PROVIDER_ID, syncActiveOAuthAccountCredential } from "@/lib/oauth-accounts";

export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = await createDefaultModelRuntime();
  const providers = listOAuthProviders(runtime);

  const EXCLUDED = new Set(["anthropic"]);
  const DISPLAY_NAMES: Record<string, string> = {
    "openai-codex": "ChatGPT Plus/Pro",
    "github-copilot": "GitHub Copilot",
  };

  const result = await Promise.all(
    providers
      .filter((p) => !EXCLUDED.has(p.id))
      .map(async (p) => {
        if (p.id === OPENAI_CODEX_PROVIDER_ID) {
          await syncActiveOAuthAccountCredential(p.id).catch(() => {});
        }
        // Dual-auth providers (xai, etc.) may store an API key under the same id.
        // Only treat real OAuth auth as "logged in" for the subscription tab.
        const loggedIn = isProviderUsingOAuth(runtime, p.id);
        return {
          id: p.id,
          name: DISPLAY_NAMES[p.id] ?? p.name,
          usesCallbackServer: p.usesCallbackServer,
          loggedIn,
        };
      })
  );

  return Response.json({ providers: result });
}
