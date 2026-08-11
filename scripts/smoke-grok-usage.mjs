import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fetchGrokBillingPayloads, GrokBillingPayloadError } from "../lib/grok-billing-fetch.ts";

async function main() {
  const panelSource = await readFile(new URL("../components/GrokUsagePanel.tsx", import.meta.url), "utf8");
  assert.match(
    panelSource,
    /if \(!open\) return;\s+void loadUsage\(false\);\s+void loadAccounts\(\);/,
    "opening the top-bar Grok panel must reload the latest cached usage before rendering quotas",
  );
  assert.match(
    panelSource,
    /label=\{QUOTA_TIER_LABELS\[tier\.name\]\}/,
    "Grok top-bar pies must use the shared 7d tier labels like ChatGPT",
  );
  assert.match(
    panelSource,
    /weeklyTierFromUsage|findWeeklyQuotaTier/,
    "Grok compact trigger must prefer weekly/7d usage",
  );
  assert.doesNotMatch(
    panelSource,
    /monthlyCredits|monthlyLine|result\.monthly|data\.monthly/,
    "Grok top-bar panel must not surface monthly credits",
  );
  assert.match(
    panelSource,
    /\/api\/grok\/usage-refresh\/status/,
    "Grok panel must surface backend auto-refresh scheduler status",
  );

  const schedulerSource = await readFile(new URL("../lib/grok-usage-refresh-scheduler.ts", import.meta.url), "utf8");
  assert.match(schedulerSource, /export async function ensureGrokUsageRefreshScheduler/);
  assert.match(schedulerSource, /getGrokAccountUsage/);
  assert.match(schedulerSource, /grok-usage-refresh\.lock/);

  const oauthDetailSource = await readFile(new URL("../components/models/OAuthDetail.tsx", import.meta.url), "utf8");
  assert.match(
    oauthDetailSource,
    /supportsAccountUsage/,
    "Models xAI/Grok account list must enable per-account weekly usage chrome",
  );
  assert.match(
    oauthDetailSource,
    /mode=refresh&provider=.*accountId=|accountId=.*mode=refresh/,
    "Models must refresh Grok weekly usage per saved account",
  );
  assert.match(
    oauthDetailSource,
    /QUOTA_TIER_LABELS\.seven_day\} window/,
    "Models Grok usage card must label weekly as the shared 7d window",
  );
  assert.doesNotMatch(
    oauthDetailSource,
    /Monthly credits|data\.monthly|result\?\.monthly|prev\.monthly/,
    "Models Grok usage card must not surface monthly credits",
  );

  const routeSource = await readFile(new URL("../app/api/auth/usage/grok-cli/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /getGrokAccountUsage/, "usage route must support per-account Grok queries");

  const usageSource = await readFile(new URL("../lib/grok-usage.ts", import.meta.url), "utf8");
  assert.match(usageSource, /export async function getGrokAccountUsage/);
  assert.match(usageSource, /name: "seven_day"/);
  assert.doesNotMatch(usageSource, /GrokMonthlyUsage|parseMonthlyUsage|result\.monthly/, "usage domain must be weekly-only");
  assert.match(usageSource, /CACHE_VERSION = 2/, "weekly-only cache schema must bump past monthly caches");

  const billingSource = await readFile(new URL("../lib/grok-billing-fetch.ts", import.meta.url), "utf8");
  assert.match(billingSource, /billing\?format=credits/);
  assert.doesNotMatch(billingSource, /monthlyResponse|monthlyPayload/, "billing helper must not fetch monthly endpoint");

  const quotaDisplaySource = await readFile(new URL("../lib/quota-display.ts", import.meta.url), "utf8");
  assert.match(quotaDisplaySource, /seven_day:\s*"7d"/);
  assert.match(quotaDisplaySource, /LEGACY_GROK_WEEKLY_TIER_NAME|weekly.*seven_day/);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      assert.match(url, /billing\?format=credits/, "only weekly billing endpoint should be requested");
      return Response.json({ weekly: true });
    };

    const result = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    assert.deepEqual(result.weeklyPayload, { weekly: true });
    assert.equal(result.weeklyResponse.status, 200);

    globalThis.fetch = async () => new Response(null, { status: 401 });
    const unauthorized = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    assert.equal(unauthorized.weeklyResponse.status, 401);
    assert.equal(unauthorized.weeklyPayload, null);

    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    await assert.rejects(
      () => fetchGrokBillingPayloads(
        "https://example.invalid/v1",
        { authorization: "Bearer test" },
        1_000,
      ),
      (error) => error instanceof GrokBillingPayloadError,
    );

    console.log("smoke-grok-usage: OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
