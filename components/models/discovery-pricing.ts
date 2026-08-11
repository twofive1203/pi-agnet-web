import type {
  CachedPricingCandidate,
  CachedPricingEntry,
  CachedPricingLookup,
  CachedPricingLookupResponse,
  DiscoveredModelCandidate,
  DiscoveredModelGroup,
  ModelEntry,
} from "./types";
import { discoveredModelCollator } from "./api-headers";

export function getDiscoveredModelOwner(candidate: DiscoveredModelCandidate): string {
  const owner = candidate.ownedBy?.trim();
  return owner || "unknown";
}

export function filterDiscoveredModels(models: DiscoveredModelCandidate[], query: string): DiscoveredModelCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((candidate) => {
    const owner = getDiscoveredModelOwner(candidate).toLowerCase();
    return candidate.id.toLowerCase().includes(normalized)
      || owner.includes(normalized)
      || (candidate.name?.toLowerCase().includes(normalized) ?? false);
  });
}

export function groupDiscoveredModels(models: DiscoveredModelCandidate[]): DiscoveredModelGroup[] {
  const groups = new Map<string, DiscoveredModelCandidate[]>();
  for (const candidate of models) {
    const owner = getDiscoveredModelOwner(candidate);
    groups.set(owner, [...(groups.get(owner) ?? []), candidate]);
  }
  return [...groups.entries()]
    .map(([owner, items]) => ({
      owner,
      models: items.sort((a, b) => discoveredModelCollator.compare(a.id, b.id)),
    }))
    .sort((a, b) => discoveredModelCollator.compare(a.owner, b.owner));
}

export async function lookupCachedPricing(providerName: string, modelId: string): Promise<CachedPricingLookup | null> {
  const res = await fetch(`/api/model-pricing?provider=${encodeURIComponent(providerName)}&model=${encodeURIComponent(modelId)}`);
  const data = await res.json() as CachedPricingLookupResponse;
  return res.ok && data.ok && data.lookup ? data.lookup : null;
}

export function getMissingPricingFields(model: ModelEntry, entry: CachedPricingEntry): Partial<CachedPricingEntry> {
  const currentCost = model.cost ?? {};
  const fields: Partial<CachedPricingEntry> = {};
  if (currentCost.input === undefined) fields.input = entry.input;
  if (currentCost.output === undefined) fields.output = entry.output;
  if (currentCost.cacheRead === undefined) fields.cacheRead = entry.cacheRead;
  if (currentCost.cacheWrite === undefined) fields.cacheWrite = entry.cacheWrite;
  if (model.contextWindow === undefined && entry.contextWindow !== undefined) fields.contextWindow = entry.contextWindow;
  return fields;
}

export function mergeMissingPricing(model: ModelEntry, entry: CachedPricingEntry): ModelEntry {
  const missingFields = getMissingPricingFields(model, entry);
  const { contextWindow, ...missingCostFields } = missingFields;
  return {
    ...model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    cost: { ...(model.cost ?? {}), ...missingCostFields },
  };
}

export interface AutoAppliedPricing {
  provider: string;
  modelId: string;
  fields: Partial<CachedPricingEntry>;
}

export type PricingLookupState =
  | { phase: "idle" | "loading" | "no-match" }
  | { phase: "matched"; match: "exact" | "unique-id" | "manual" }
  | { phase: "ambiguous"; candidates: CachedPricingCandidate[] };

export const PRICING_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const PRICING_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "contextWindow"] as const;

export function formatPricingCandidateValue(field: typeof PRICING_FIELDS[number], entry: CachedPricingEntry): string {
  if (field === "contextWindow") return entry.contextWindow?.toLocaleString() ?? "—";
  return `$${entry[field]}`;
}
