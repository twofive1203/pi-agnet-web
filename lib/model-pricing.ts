// Model pricing: manual sync, validation, atomic persistence, and lookup.
//
// Upstream: https://pi.dev/api/models returns { [providerId]: { [modelId]: { ... cost } } }
// The cache is stored at ~/.pi/agent/model-pricing.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ModelPricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Per-provider pricing map: provider slug → model id → pricing entry.
 */
export type ModelPricingIndex = Record<string, Record<string, ModelPricingEntry>>;

export interface ModelPricingCache {
  version: 1;
  sourceUrl: string;
  syncedAt: number; // unix ms
  providerCount: number;
  modelCount: number;
  pricing: ModelPricingIndex;
}

export interface ModelPricingSummary {
  sourceUrl: string;
  syncedAt: number | null;
  providerCount: number;
  modelCount: number;
}

export interface ModelPricingCatalogItem extends ModelPricingEntry {
  provider: string;
  model: string;
}

export interface ModelPricingCandidate {
  provider: string;
  model: string;
  entry: ModelPricingEntry;
}

export type PricingLookupResult =
  | { match: "exact"; entry: ModelPricingEntry }
  | { match: "unique-id"; entry: ModelPricingEntry }
  | { match: "ambiguous"; candidates: ModelPricingCandidate[] }
  | { match: "no-match" };

// ── Path ──────────────────────────────────────────────────────────────────────

function getCachePath(): string {
  return join(getAgentDir(), "model-pricing.json");
}

// ── Validation ─────────────────────────────────────────────────────────────────

export const SOURCE_URL = "https://pi.dev/api/models";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const UNSAFE_INDEX_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeIndexKey(value: string): string | null {
  const normalized = value.trim();
  return normalized && !UNSAFE_INDEX_KEYS.has(normalized) ? normalized : null;
}

function createIndex<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Validate an untrusted upstream model entry and extract the four cost fields.
 * Accepts object-shaped entries with optional cost sub-object containing
 * finite, non-negative numeric values for input/output/cacheRead/cacheWrite.
 */
function validateCost(raw: unknown): ModelPricingEntry | null {
  if (!isRecord(raw)) return null;
  const cost = isRecord(raw.cost) ? raw.cost : raw;
  const input = cost.input;
  const output = cost.output;
  const cacheRead = cost.cacheRead;
  const cacheWrite = cost.cacheWrite;
  if (
    !isFiniteNonNegativeNumber(input) ||
    !isFiniteNonNegativeNumber(output) ||
    !isFiniteNonNegativeNumber(cacheRead) ||
    !isFiniteNonNegativeNumber(cacheWrite)
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

function normalizePricingIndex(raw: unknown): ModelPricingIndex {
  const index = createIndex<Record<string, ModelPricingEntry>>();
  if (!isRecord(raw)) return index;

  for (const [rawProviderId, providerRaw] of Object.entries(raw)) {
    const providerId = normalizeIndexKey(rawProviderId);
    if (!providerId || !isRecord(providerRaw)) continue;

    const models = createIndex<ModelPricingEntry>();
    for (const [rawModelId, modelRaw] of Object.entries(providerRaw)) {
      const modelId = normalizeIndexKey(rawModelId);
      if (!modelId) continue;
      const entry = validateCost(modelRaw);
      if (entry) models[modelId] = entry;
    }
    if (Object.keys(models).length > 0) index[providerId] = models;
  }

  return index;
}

/**
 * Validate the full upstream response body.
 * Expects { [provider]: { [modelId]: { ... } } } where each model entry
 * has a cost sub-object with the four fields.
 */
export function validateUpstreamPayload(payload: unknown): ModelPricingIndex {
  if (!isRecord(payload)) return {};

  const normalized = createIndex<unknown>();
  for (const [providerId, providerRaw] of Object.entries(payload)) {
    if (!isRecord(providerRaw)) continue;
    normalized[providerId] = Object.fromEntries(
      Object.entries(providerRaw).map(([modelId, modelRaw]) => [
        modelId,
        isRecord(modelRaw) && isRecord(modelRaw.cost) ? modelRaw.cost : null,
      ]),
    );
  }
  return normalizePricingIndex(normalized);
}

// ── Cache read/write ──────────────────────────────────────────────────────────

function countModels(index: ModelPricingIndex): number {
  let count = 0;
  for (const models of Object.values(index)) {
    count += Object.keys(models).length;
  }
  return count;
}

export function readPricingCache(): ModelPricingCache | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw)) return null;
    if (raw.version !== 1) return null;
    const sourceUrl = typeof raw.sourceUrl === "string" && raw.sourceUrl.trim() ? raw.sourceUrl : SOURCE_URL;
    const syncedAt = isFiniteNonNegativeNumber(raw.syncedAt) ? raw.syncedAt : 0;
    const pricing = normalizePricingIndex(raw.pricing);
    if (Object.keys(pricing).length === 0) return null;
    return {
      version: 1,
      sourceUrl,
      syncedAt,
      providerCount: Object.keys(pricing).length,
      modelCount: countModels(pricing),
      pricing,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically write the cache. Writes to a temp file in the same directory first,
 * then renames over the target so a crash cannot corrupt the existing cache.
 */
export function writePricingCache(index: ModelPricingIndex, sourceUrl: string): ModelPricingCache {
  const cache: ModelPricingCache = {
    version: 1,
    sourceUrl,
    syncedAt: Date.now(),
    providerCount: Object.keys(index).length,
    modelCount: countModels(index),
    pricing: index,
  };

  const targetPath = getCachePath();
  const dir = dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `model-pricing.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmpPath, targetPath);

  return cache;
}

export function getPricingSummary(): ModelPricingSummary {
  const cache = readPricingCache();
  if (!cache) {
    return { sourceUrl: SOURCE_URL, syncedAt: null, providerCount: 0, modelCount: 0 };
  }
  return {
    sourceUrl: cache.sourceUrl,
    syncedAt: cache.syncedAt,
    providerCount: cache.providerCount,
    modelCount: cache.modelCount,
  };
}

export function getPricingCatalog(): ModelPricingCatalogItem[] {
  const cache = readPricingCache();
  if (!cache) return [];

  const items: ModelPricingCatalogItem[] = [];
  for (const [provider, models] of Object.entries(cache.pricing)) {
    for (const [model, entry] of Object.entries(models)) {
      items.push({ provider, model, ...entry });
    }
  }
  return items.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

// ── Lookup ─────────────────────────────────────────────────────────────────────

/**
 * Look up cached pricing for a (provider, modelId) pair.
 *
 * Resolution order:
 * 1. Exact match on both provider and model id → "exact"
 * 2. No exact match, but model id alone matches exactly one pricing entry across
 *    all providers → "unique-id"
 * 3. Model id matches multiple providers → "ambiguous" with candidate count
 * 4. No match at all → "no-match"
 */
export function lookupCachedPricing(provider: string, modelId: string): PricingLookupResult {
  const cache = readPricingCache();
  if (!cache) return { match: "no-match" };

  const providerIndex = cache.pricing[provider];
  if (providerIndex) {
    const entry = providerIndex[modelId];
    if (entry) {
      return { match: "exact", entry };
    }
  }

  const candidates: ModelPricingCandidate[] = [];
  for (const [candidateProvider, models] of Object.entries(cache.pricing)) {
    const entry = models[modelId];
    if (entry) {
      candidates.push({ provider: candidateProvider, model: modelId, entry });
    }
  }

  if (candidates.length === 1) {
    return { match: "unique-id", entry: candidates[0].entry };
  }
  if (candidates.length > 1) {
    return { match: "ambiguous", candidates };
  }
  return { match: "no-match" };
}
