import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fetchGrokBillingPayloads } from "../lib/grok-billing-fetch.ts";

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
    "Grok compact trigger must prefer weekly/7d usage over monthly",
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

  const modelsSource = await readFile(new URL("../components/ModelsConfig.tsx", import.meta.url), "utf8");
  assert.match(
    modelsSource,
    /supportsAccountUsage/,
    "Models xAI/Grok account list must enable per-account weekly usage chrome",
  );
  assert.match(
    modelsSource,
    /mode=refresh&provider=.*accountId=|accountId=.*mode=refresh/,
    "Models must refresh Grok weekly usage per saved account",
  );
  assert.match(
    modelsSource,
    /QUOTA_TIER_LABELS\.seven_day\} window/,
    "Models Grok usage card must label weekly as the shared 7d window",
  );

  const routeSource = await readFile(new URL("../app/api/auth/usage/grok-cli/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /getGrokAccountUsage/, "usage route must support per-account Grok queries");

  const usageSource = await readFile(new URL("../lib/grok-usage.ts", import.meta.url), "utf8");
  assert.match(usageSource, /export async function getGrokAccountUsage/);
  assert.match(usageSource, /name: "seven_day"/);

  const quotaDisplaySource = await readFile(new URL("../lib/quota-display.ts", import.meta.url), "utf8");
  assert.match(quotaDisplaySource, /seven_day:\s*"7d"/);
  assert.match(quotaDisplaySource, /LEGACY_GROK_WEEKLY_TIER_NAME|weekly.*seven_day/);

  const originalFetch = globalThis.fetch;
  try {
    const starts = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      starts.push({ url, at: performance.now() });
      await new Promise((resolve) => setTimeout(resolve, url.includes("format=credits") ? 40 : 80));
      if (url.includes("format=credits")) {
        return Response.json({ weekly: true });
      }
      return Response.json({ monthly: true });
    };

    const startedAt = performance.now();
    const result = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    const elapsed = performance.now() - startedAt;
    assert.equal(starts.length, 2);
    assert.ok(Math.abs(starts[0].at - starts[1].at) < 20, "billing requests must start together");
    assert.ok(elapsed < 140, `concurrent requests should share latency, elapsed=${elapsed.toFixed(1)}ms`);
    assert.deepEqual(result.monthlyPayload, { monthly: true });
    assert.deepEqual(result.weeklyPayload, { weekly: true });

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("format=credits")) throw new Error("optional weekly unavailable");
      return Response.json({ monthly: true });
    };
    const degraded = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    assert.deepEqual(degraded.monthlyPayload, { monthly: true });
    assert.equal(degraded.weeklyPayload, null);

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.includes("format=credits")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ monthly: true });
      }
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(Response.json({ weekly: true })), 200);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };
    const fastMonthlyStarted = performance.now();
    const fastMonthly = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    assert.ok(performance.now() - fastMonthlyStarted < 100, "optional weekly must not extend monthly latency");
    assert.equal(fastMonthly.weeklyPayload, null);

    let weeklyAborted = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.includes("format=credits")) return new Response(null, { status: 401 });
      return await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          weeklyAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };
    const unauthorized = await fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    );
    assert.equal(unauthorized.monthlyResponse.status, 401);
    assert.equal(unauthorized.weeklyPayload, null);
    assert.equal(weeklyAborted, true, "authoritative monthly failure must abort optional weekly work");

    globalThis.fetch = async (input) => String(input).includes("format=credits")
      ? Response.json({ weekly: true })
      : new Response("not-json", { status: 200 });
    await assert.rejects(() => fetchGrokBillingPayloads(
      "https://example.invalid/v1",
      { authorization: "Bearer test" },
      1_000,
    ));

    console.log("smoke-grok-usage: OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
