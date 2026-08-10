import { stat } from "fs/promises";
import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { canonicalizeCwd } from "@/lib/cwd";
import { createSessionServicesWithRegistry } from "@/lib/pi-auth";

export const dynamic = "force-dynamic";

interface ModelMetadata {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; supportsImage: boolean }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}

interface ModelMetadataCacheEntry {
  expiresAt: number;
  promise: Promise<ModelMetadata>;
}

const MODEL_METADATA_CACHE_TTL_MS = 30_000;
const MODEL_METADATA_CACHE_LIMIT = 8;
const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

declare global {
  var __piModelMetadataCache: Map<string, ModelMetadataCacheEntry> | undefined;
}

function getModelMetadataCache(): Map<string, ModelMetadataCacheEntry> {
  if (!globalThis.__piModelMetadataCache) globalThis.__piModelMetadataCache = new Map();
  return globalThis.__piModelMetadataCache;
}

function compareModelEntries(
  a: { id: string; name: string; provider: string; supportsImage: boolean },
  b: { id: string; name: string; provider: string; supportsImage: boolean },
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

async function buildModelMetadata(cwd: string): Promise<ModelMetadata> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string; supportsImage: boolean }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  try {
    const { services, registry } = await createSessionServicesWithRegistry(cwd, getAgentDir());
    const available = registry.getAvailable();
    modelList = available.map((model: { id: string; name: string; provider: string; input?: readonly string[] }) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      supportsImage: model.input?.includes("image") ?? false,
    })).sort(compareModelEntries);

    for (const model of available) {
      const key = `${model.provider}:${model.id}`;
      nameMap.set(key, model.name);
      thinkingLevels[key] = getSupportedThinkingLevels(model);
      if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    }

    const settings: SettingsManager = services.settingsManager;
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    if (provider && modelId && available.some((model) => model.provider === provider && model.id === modelId)) {
      defaultModel = { provider, modelId };
    }
  } catch {
    // Preserve the existing empty-list fallback when SDK resource loading fails.
  }

  return {
    models: Object.fromEntries(nameMap),
    modelList,
    defaultModel,
    thinkingLevels,
    thinkingLevelMaps,
  };
}

function loadModelMetadata(cwd: string, forceRefresh: boolean): Promise<ModelMetadata> {
  const cache = getModelMetadataCache();
  if (forceRefresh) cache.delete(cwd);

  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > now) {
    cache.delete(cwd);
    cache.set(cwd, cached);
    return cached.promise;
  }
  if (cached) cache.delete(cwd);

  const promise = buildModelMetadata(cwd);
  const entry = { expiresAt: now + MODEL_METADATA_CACHE_TTL_MS, promise };
  cache.set(cwd, entry);
  while (cache.size > MODEL_METADATA_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  void promise.catch(() => {
    if (cache.get(cwd) === entry) cache.delete(cwd);
  });
  return promise;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = canonicalizeCwd(url.searchParams.get("cwd") || process.cwd());

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }

  const metadata = await loadModelMetadata(cwd, url.searchParams.get("refresh") === "1");
  return Response.json(metadata, { headers: { "Cache-Control": "no-store" } });
}
