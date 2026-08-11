/**
 * Client-safe helpers for WebUI-only model primary-candidate (favorite) flags.
 * Disk I/O lives in `lib/model-primary-candidates-server.ts` so ChatInput can import this file.
 */

/** Model-level models.json flag recognized by WebUI (ignored by Pi schema extras). */
export const PRIMARY_CANDIDATE_MODEL_FLAG = "primaryCandidate" as const;

export interface PrimaryCandidateModelConfig {
  [PRIMARY_CANDIDATE_MODEL_FLAG]?: unknown;
}

export function modelPrimaryCandidateKey(provider: string, modelId: string): string {
  return `${provider.trim()}\0${modelId.trim()}`;
}

export function isPrimaryCandidateModel(
  modelConfig: PrimaryCandidateModelConfig | null | undefined,
): boolean {
  return modelConfig?.[PRIMARY_CANDIDATE_MODEL_FLAG] === true;
}

/** Collect provider+id keys marked as primary candidates from a models.json object. */
export function readPrimaryCandidateKeysFromModelsJson(modelsJson: unknown): Set<string> {
  const enabled = new Set<string>();
  if (!modelsJson || typeof modelsJson !== "object" || Array.isArray(modelsJson)) {
    return enabled;
  }
  const providers = (modelsJson as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return enabled;
  }
  for (const [providerId, config] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerId.trim()) continue;
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const models = (config as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (!model || typeof model !== "object" || Array.isArray(model)) continue;
      const id = typeof (model as { id?: unknown }).id === "string"
        ? (model as { id: string }).id.trim()
        : "";
      if (!id) continue;
      if (isPrimaryCandidateModel(model as PrimaryCandidateModelConfig)) {
        enabled.add(modelPrimaryCandidateKey(providerId, id));
      }
    }
  }
  return enabled;
}

export interface ModelPickerOption {
  provider: string;
  modelId: string;
  name: string;
  primaryCandidate?: boolean;
}

export interface ModelPickerGroup {
  provider: string;
  options: ModelPickerOption[];
}

/** Group picker options by provider while preserving first-seen order. */
export function groupModelOptionsByProvider(options: ModelPickerOption[]): ModelPickerGroup[] {
  const groups: ModelPickerGroup[] = [];
  for (const opt of options) {
    const group = groups.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else groups.push({ provider: opt.provider, options: [opt] });
  }
  return groups;
}

/**
 * Default chat model picker projection:
 * - no candidates marked → full list
 * - otherwise → candidates first (plus current selection if missing)
 */
export function buildDefaultModelPickerOptions(
  options: ModelPickerOption[],
  selected?: { provider: string; modelId: string } | null,
): {
  hasPrimaryCandidates: boolean;
  defaultOptions: ModelPickerOption[];
} {
  const candidates = options.filter((opt) => opt.primaryCandidate);
  if (candidates.length === 0) {
    return { hasPrimaryCandidates: false, defaultOptions: options };
  }

  const defaultOptions = [...candidates];
  if (selected?.provider && selected.modelId) {
    const selectedKey = modelPrimaryCandidateKey(selected.provider, selected.modelId);
    const alreadyIncluded = defaultOptions.some(
      (opt) => modelPrimaryCandidateKey(opt.provider, opt.modelId) === selectedKey,
    );
    if (!alreadyIncluded) {
      const selectedOpt = options.find(
        (opt) => modelPrimaryCandidateKey(opt.provider, opt.modelId) === selectedKey,
      );
      if (selectedOpt) defaultOptions.unshift(selectedOpt);
    }
  }

  return { hasPrimaryCandidates: true, defaultOptions };
}
