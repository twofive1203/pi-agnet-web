import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createModelRegistry } from "@/lib/pi-auth";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 15_000;
const DISCOVERY_MODEL_ID = "__pi_model_discovery__";
const MAX_DISCOVERED_MODELS = 500;
const RESPONSE_EXCERPT_CHARS = 500;
const SUPPORTED_APIS = new Set(["openai-completions", "openai-responses"]);

interface DiscoveredModelCandidate {
  id: string;
  name?: string;
  ownedBy?: string;
}

interface ParseModelsResult {
  ok: boolean;
  models?: DiscoveredModelCandidate[];
  error?: string;
}

interface DiscoveryFailure {
  error: string;
  status?: number;
  responseText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseExcerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, RESPONSE_EXCERPT_CHARS);
}

function appendPath(baseUrl: URL, suffix: string): string {
  const next = new URL(baseUrl.toString());
  const basePath = next.pathname.replace(/\/+$/, "");
  const cleanSuffix = suffix.replace(/^\/+/, "");
  next.pathname = `${basePath || ""}/${cleanSuffix}`;
  next.search = "";
  next.hash = "";
  return next.toString();
}

function buildCandidateUrls(baseUrl: URL): string[] {
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, "").toLowerCase();
  const candidates = normalizedPath.endsWith("/v1") || normalizedPath.endsWith("/api/v1")
    ? [appendPath(baseUrl, "models")]
    : [appendPath(baseUrl, "v1/models"), appendPath(baseUrl, "models")];
  return [...new Set(candidates)];
}

function parseOpenAIModels(payload: unknown): ParseModelsResult {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return { ok: false, error: "Response JSON does not contain an OpenAI-compatible data[] model list" };
  }

  const models: DiscoveredModelCandidate[] = [];
  const seen = new Set<string>();

  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
    const ownedBy = typeof item.owned_by === "string" && item.owned_by.trim() ? item.owned_by.trim() : undefined;
    models.push({ id, ...(name ? { name } : {}), ...(ownedBy ? { ownedBy } : {}) });
    if (models.length >= MAX_DISCOVERED_MODELS) break;
  }

  if (payload.data.length > 0 && models.length === 0) {
    return { ok: false, error: "No usable string model ids found in response data[]" };
  }

  return { ok: true, models };
}

async function fetchModels(url: string, headers: Headers): Promise<{ ok: true; models: DiscoveredModelCandidate[] } | ({ ok: false } & DiscoveryFailure)> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    const excerpt = responseExcerpt(text);

    if (!response.ok) {
      return {
        ok: false,
        error: `Remote model list returned HTTP ${response.status}`,
        status: response.status,
        ...(excerpt ? { responseText: excerpt } : {}),
      };
    }

    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (error) {
      return {
        ok: false,
        error: `Remote model list did not return valid JSON: ${errorMessage(error)}`,
        status: response.status,
        ...(excerpt ? { responseText: excerpt } : {}),
      };
    }

    const parsed = parseOpenAIModels(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error ?? "Remote model list response was not recognized",
        status: response.status,
        ...(excerpt ? { responseText: excerpt } : {}),
      };
    }

    return { ok: true, models: parsed.models ?? [] };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Remote model list request timed out after ${Math.round(DISCOVERY_TIMEOUT_MS / 1000)}s`
        : errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  let tempDir: string | undefined;

  try {
    const body = await req.json() as unknown;
    if (!isRecord(body)) return NextResponse.json({ ok: false, error: "JSON body is required" }, { status: 400 });

    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });

    const providerApi = typeof body.provider.api === "string" ? body.provider.api.trim() : "";
    if (!SUPPORTED_APIS.has(providerApi)) {
      return NextResponse.json({ ok: false, error: `Model discovery is only supported for OpenAI-compatible provider APIs: ${[...SUPPORTED_APIS].join(", ")}` }, { status: 400 });
    }

    const baseUrlText = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    if (!baseUrlText) return NextResponse.json({ ok: false, error: "Provider baseUrl is required" }, { status: 400 });

    let baseUrl: URL;
    try {
      baseUrl = new URL(baseUrlText);
    } catch {
      return NextResponse.json({ ok: false, error: "Provider baseUrl must be a valid URL" }, { status: 400 });
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      return NextResponse.json({ ok: false, error: "Provider baseUrl must use http or https" }, { status: 400 });
    }

    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-discover-"));
    const modelsPath = join(tempDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...body.provider,
          baseUrl: baseUrlText,
          api: providerApi,
          models: [{ id: DISCOVERY_MODEL_ID }],
        },
      },
    }, null, 2), "utf8");

    const { registry } = await createModelRegistry({ modelsPath });
    const loadError = registry.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = registry.find(providerName, DISCOVERY_MODEL_ID);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${DISCOVERY_MODEL_ID}` });

    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error });
    if (!auth.apiKey) return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });

    const requestHeaders = new Headers(auth.headers);
    requestHeaders.set("Accept", "application/json");
    if (!requestHeaders.has("Authorization")) {
      requestHeaders.set("Authorization", `Bearer ${auth.apiKey}`);
    }

    const triedUrls = buildCandidateUrls(baseUrl);
    let lastFailure: DiscoveryFailure | undefined;

    for (const url of triedUrls) {
      const result = await fetchModels(url, requestHeaders);
      if (result.ok) {
        return NextResponse.json({ ok: true, url, triedUrls, models: result.models });
      }
      lastFailure = result;
    }

    return NextResponse.json({
      ok: false,
      error: lastFailure?.error ?? "Failed to discover models",
      triedUrls,
      ...(lastFailure?.status !== undefined ? { status: lastFailure.status } : {}),
      ...(lastFailure?.responseText ? { responseText: lastFailure.responseText } : {}),
    }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
