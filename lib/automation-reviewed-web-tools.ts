/**
 * Reviewed immutable registry + safe adapters for Automation web_search / web_fetch.
 * Name-only allowlists are insufficient — execution must go through these adapters
 * and automationSafeFetch (DNS/connect/redirect/size/time).
 *
 * Executable digests cover registry metadata AND the adapter/network implementation
 * content so code changes invalidate existing approvals.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { automationSafeFetch } from "./automation-network-policy";
import type { AutomationToolSnapshot } from "./automation-types";

export const AUTOMATION_REVIEWED_WEB_REGISTRY = Object.freeze({
  web_search: Object.freeze({
    name: "web_search" as const,
    version: 1,
    sourceIdentity: "reviewed:automation/web_search@1",
    description: "Headless web search via Automation-reviewed SSRF-safe adapter",
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        query: Object.freeze({ type: "string" }),
        limit: Object.freeze({ type: "number" }),
      }),
      required: Object.freeze(["query"]),
    }),
    config: Object.freeze({ provider: "duckduckgo-html", maxResults: 5 }),
  }),
  web_fetch: Object.freeze({
    name: "web_fetch" as const,
    version: 1,
    sourceIdentity: "reviewed:automation/web_fetch@1",
    description: "Headless HTTP(S) fetch via Automation-reviewed SSRF-safe adapter",
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        url: Object.freeze({ type: "string" }),
      }),
      required: Object.freeze(["url"]),
    }),
    config: Object.freeze({ maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 20_000 }),
  }),
});

export type ReviewedWebToolName = keyof typeof AUTOMATION_REVIEWED_WEB_REGISTRY;

export function isReviewedWebRegistryName(name: string): name is ReviewedWebToolName {
  return name === "web_search" || name === "web_fetch";
}

function tryReadModuleSource(fileBase: string): string {
  const bases = [
    typeof __dirname !== "undefined" ? __dirname : "",
    join(process.cwd(), "lib"),
    process.cwd(),
  ].filter(Boolean);
  const names = [`${fileBase}.ts`, `${fileBase}.js`, `${fileBase}.mjs`, `${fileBase}.cjs`];
  for (const base of bases) {
    for (const name of names) {
      const full = join(base, name);
      try {
        if (existsSync(full)) return readFileSync(full, "utf8");
      } catch {
        // continue
      }
    }
  }
  // Fallback: parent of cwd/lib when running from compiled .next traces
  try {
    const alt = join(dirname(typeof __filename !== "undefined" ? __filename : process.cwd()), `${fileBase}.js`);
    if (existsSync(alt)) return readFileSync(alt, "utf8");
  } catch {
    // ignore
  }
  return "";
}

/**
 * Fingerprint of the actual adapter + network implementation content.
 * Prefer on-disk module source; always include function source as a secondary signal.
 */
export function reviewedWebImplementationFingerprint(name: ReviewedWebToolName): string {
  const networkSrc = tryReadModuleSource("automation-network-policy");
  const adapterSrc = tryReadModuleSource("automation-reviewed-web-tools");
  const h = createHash("sha256");
  h.update(`tool:${name}\n`);
  h.update("network-module:\n");
  h.update(networkSrc || automationSafeFetch.toString());
  h.update("\nadapter-module:\n");
  h.update(adapterSrc || `${ddgSearch.toString()}\n${createAutomationReviewedWebTools.toString()}`);
  // Include live function bodies so in-memory edits during tests also move the digest.
  h.update("\nfn:automationSafeFetch:\n");
  h.update(automationSafeFetch.toString());
  if (name === "web_search") {
    h.update("\nfn:ddgSearch:\n");
    h.update(ddgSearch.toString());
  }
  return h.digest("hex");
}

export function reviewedWebToolDigest(name: ReviewedWebToolName): string {
  const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[name];
  const impl = reviewedWebImplementationFingerprint(name);
  return createHash("sha256")
    .update(JSON.stringify({ entry, implementationFingerprint: impl }))
    .digest("hex");
}

export function buildReviewedWebToolSnapshot(name: ReviewedWebToolName): AutomationToolSnapshot {
  const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[name];
  const schemaHash = createHash("sha256").update(JSON.stringify(entry.schema)).digest("hex");
  const configHash = createHash("sha256").update(JSON.stringify(entry.config)).digest("hex");
  return {
    name: entry.name,
    origin: "custom",
    description: entry.description,
    sourceIdentity: entry.sourceIdentity,
    executableDigest: reviewedWebToolDigest(name),
    schemaHash,
    configHash,
    hookInventory: [],
    risks: {
      headlessCompatible: true,
      localMutation: false,
      networkEgress: true,
      credentialUse: false,
      interactionRequired: false,
      blocked: false,
    },
  };
}

export function listReviewedWebCatalogDescriptors(): Array<{
  name: string;
  description: string;
  origin: "custom";
  sourceIdentity: string;
  sourcePath?: string;
  schema: unknown;
  risks: AutomationToolSnapshot["risks"];
  blocked: boolean;
  /** Pass-through fields so live intersection can rebuild an exact snapshot. */
  executableDigest: string;
  schemaHash: string;
  configHash: string;
}> {
  return (Object.keys(AUTOMATION_REVIEWED_WEB_REGISTRY) as ReviewedWebToolName[]).map((name) => {
    const snap = buildReviewedWebToolSnapshot(name);
    return {
      name: snap.name,
      description: snap.description ?? "",
      origin: "custom" as const,
      sourceIdentity: snap.sourceIdentity,
      schema: AUTOMATION_REVIEWED_WEB_REGISTRY[name].schema,
      risks: snap.risks,
      blocked: false,
      executableDigest: snap.executableDigest,
      schemaHash: snap.schemaHash,
      configHash: snap.configHash,
    };
  });
}

/**
 * Assert a live/authority snapshot still matches the immutable reviewed registry.
 */
export function assertReviewedWebSnapshot(tool: AutomationToolSnapshot): void {
  if (!isReviewedWebRegistryName(tool.name)) {
    throw new Error(`Not a reviewed web tool: ${tool.name}`);
  }
  const expected = buildReviewedWebToolSnapshot(tool.name);
  if (
    tool.sourceIdentity !== expected.sourceIdentity ||
    tool.executableDigest !== expected.executableDigest ||
    tool.schemaHash !== expected.schemaHash ||
    tool.configHash !== expected.configHash
  ) {
    throw new Error(`Reviewed web tool drift for ${tool.name}`);
  }
}

async function ddgSearch(query: string, limit: number): Promise<unknown> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await automationSafeFetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "SnailPi-Automation/1.0",
      Accept: "text/html",
    },
  });
  // Minimal HTML scrape of result links — no full browser.
  const links: Array<{ title: string; href: string }> = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(res.bodyText)) && links.length < limit) {
    const href = match[1] ?? "";
    const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    if (href.startsWith("http")) links.push({ title, href });
  }
  return { query, results: links, bytes: res.bytes, finalUrl: res.finalUrl };
}

/**
 * Build custom tool definitions for the headless runner from approved snapshots.
 * Only registry-matching tools are emitted.
 */
export function createAutomationReviewedWebTools(
  approved: AutomationToolSnapshot[],
): Array<{
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}> {
  const out: ReturnType<typeof createAutomationReviewedWebTools> = [];
  for (const tool of approved) {
    // Never silently drop requested authority — unsupported names and drift reject hard.
    if (!isReviewedWebRegistryName(tool.name)) {
      throw new Error(`Unsupported reviewed web tool (refusing silent drop): ${tool.name}`);
    }
    assertReviewedWebSnapshot(tool);
    const entry = AUTOMATION_REVIEWED_WEB_REGISTRY[tool.name];
    if (tool.name === "web_fetch") {
      out.push({
        name: "web_fetch",
        label: "Web Fetch",
        description: entry.description,
        parameters: entry.schema,
        async execute(_id, params) {
          const url = String(params.url ?? "");
          const res = await automationSafeFetch(url, {
            maxResponseBytes: (entry.config as { maxResponseBytes: number }).maxResponseBytes,
            timeoutMs: (entry.config as { timeoutMs: number }).timeoutMs,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    url: res.url,
                    finalUrl: res.finalUrl,
                    status: res.status,
                    contentType: res.contentType,
                    bytes: res.bytes,
                    bodyText: res.bodyText.slice(0, 100_000),
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { status: res.status, bytes: res.bytes },
          };
        },
      });
    } else if (tool.name === "web_search") {
      out.push({
        name: "web_search",
        label: "Web Search",
        description: entry.description,
        parameters: entry.schema,
        async execute(_id, params) {
          const query = String(params.query ?? "");
          const limit = Math.min(
            10,
            Math.max(1, typeof params.limit === "number" ? params.limit : 5),
          );
          const result = await ddgSearch(query, limit);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        },
      });
    }
  }
  return out;
}
