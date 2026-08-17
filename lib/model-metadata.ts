/**
 * Shared model metadata + default-selection helpers for WebUI and desktop
 * quick sessions. `/api/models` keeps the same cache, sorting, and response
 * envelope; desktop reuses the configured-default-or-first-available rule.
 */

import { stat } from "fs/promises";
import { canonicalizeCwd } from "./cwd";
import { readModelFavoriteKeys } from "./model-favorites";
import { modelPrimaryCandidateKey } from "./model-primary-candidates";

export interface ModelListItem {
  id: string;
  name: string;
  provider: string;
  supportsImage: boolean;
  primaryCandidate: boolean;
}

export interface ModelMetadata {
  models: Record<string, string>;
  modelList: ModelListItem[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}

interface ModelMetadataCacheEntry {
  expiresAt: number;
  promise: Promise<ModelMetadata>;
}

export const MODEL_METADATA_CACHE_TTL_MS = 30_000;
export const MODEL_METADATA_CACHE_LIMIT = 8;
const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

declare global {
  var __piModelMetadataCache: Map<string, ModelMetadataCacheEntry> | undefined;
}

function getModelMetadataCache(): Map<string, ModelMetadataCacheEntry> {
  if (!globalThis.__piModelMetadataCache) globalThis.__piModelMetadataCache = new Map();
  return globalThis.__piModelMetadataCache;
}

export function compareModelEntries(a: ModelListItem, b: ModelListItem): number {
  // Primary candidates float first so chat pickers and settings lists stay scannable.
  if (a.primaryCandidate !== b.primaryCandidate) return a.primaryCandidate ? -1 : 1;
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

export async function buildModelMetadata(cwd: string): Promise<ModelMetadata> {
  const nameMap = new Map<string, string>();
  let modelList: ModelListItem[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  try {
    const [{ getAgentDir }, { getSupportedThinkingLevels }, { createSessionServicesWithRegistry }] =
      await Promise.all([
        import("@earendil-works/pi-coding-agent"),
        import("@earendil-works/pi-ai"),
        import("./pi-auth"),
      ]);
    const { services, registry } = await createSessionServicesWithRegistry(cwd, getAgentDir());
    const available = registry.getAvailable();
    let primaryCandidates = new Set<string>();
    try {
      primaryCandidates = readModelFavoriteKeys();
    } catch {
      // A malformed WebUI sidecar must not hide otherwise usable Pi models.
    }
    modelList = available.map((model: { id: string; name: string; provider: string; input?: readonly string[] }) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      supportsImage: model.input?.includes("image") ?? false,
      primaryCandidate: primaryCandidates.has(modelPrimaryCandidateKey(model.provider, model.id)),
    })).sort(compareModelEntries);

    for (const model of available) {
      const key = `${model.provider}:${model.id}`;
      nameMap.set(key, model.name);
      thinkingLevels[key] = getSupportedThinkingLevels(model);
      if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    }

    const settings = services.settingsManager;
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

export function loadModelMetadata(cwd: string, forceRefresh = false): Promise<ModelMetadata> {
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

export async function resolveModelMetadataCwd(rawCwd: string | null | undefined): Promise<
  { ok: true; cwd: string } | { ok: false; status: 400; error: string }
> {
  const cwd = canonicalizeCwd(rawCwd || process.cwd());
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { ok: false, status: 400, error: `Directory does not exist: ${cwd}` };
  }
  if (!cwdStat.isDirectory()) {
    return { ok: false, status: 400, error: `Not a directory: ${cwd}` };
  }
  return { ok: true, cwd };
}

/** WebUI new-session rule: configured default when available, else first listed model. */
export function selectDefaultNewSessionModel(
  metadata: Pick<ModelMetadata, "modelList" | "defaultModel">,
): { provider: string; modelId: string } | null {
  if (metadata.modelList.length === 0) return null;
  const match = metadata.defaultModel
    && metadata.modelList.find(
      (model) =>
        model.id === metadata.defaultModel?.modelId
        && model.provider === metadata.defaultModel.provider,
    );
  if (match) return { provider: match.provider, modelId: match.id };
  const first = metadata.modelList[0];
  return { provider: first.provider, modelId: first.id };
}

/** Test helper. */
export function resetModelMetadataCacheForTests(): void {
  getModelMetadataCache().clear();
}
