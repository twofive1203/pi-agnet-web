/**
 * Path-free model catalog for the desktop quick-session composer.
 *
 * Resolves a projectRef to cwd on the server, then projects WebUI model
 * metadata into a bounded picker list. Public payload never includes cwd,
 * thinking maps, or historical Prompt.
 */

import {
  resolveDesktopProjectRef,
  type DesktopProjectCatalogDeps,
  type DesktopProjectResolveCode,
} from "./desktop-project-catalog";
import {
  DESKTOP_QUICK_SESSION_MODEL_LIST_LIMIT,
  DESKTOP_QUICK_SESSION_MODEL_NAME_MAX_CHARS,
  DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN,
  isDesktopQuickSessionModelId,
  isDesktopQuickSessionProvider,
} from "./desktop-quick-session-limits";
import {
  loadModelMetadata,
  selectDefaultNewSessionModel,
  type ModelMetadata,
} from "./model-metadata";
import {
  buildDefaultModelPickerOptions,
  type ModelPickerOption,
} from "./model-primary-candidates";

export type DesktopQuickSessionModelItem = {
  provider: string;
  modelId: string;
  name: string;
  primaryCandidate: boolean;
};

export type DesktopQuickSessionModelRef = {
  provider: string;
  modelId: string;
};

export type DesktopQuickSessionModelCatalog = {
  projectRef: string;
  defaultModel: DesktopQuickSessionModelRef | null;
  models: DesktopQuickSessionModelItem[];
  truncated: boolean;
};

export type DesktopQuickSessionModelCatalogFailure = {
  ok: false;
  status: 400 | 422;
  code: DesktopProjectResolveCode | "bad_request";
};

export type DesktopQuickSessionModelCatalogResult =
  | { ok: true; catalog: DesktopQuickSessionModelCatalog }
  | DesktopQuickSessionModelCatalogFailure;

export type DesktopQuickSessionModelCatalogDeps = {
  catalog?: DesktopProjectCatalogDeps;
  loadModelMetadata?: (cwd: string) => Promise<ModelMetadata>;
};

const FORBIDDEN_PUBLIC_KEYS = [
  "cwd",
  "path",
  "token",
  "accessKey",
  "firstMessage",
  "prompt",
  "thinkingLevels",
  "thinkingLevelMaps",
];

export function assertDesktopQuickSessionModelCatalogSafe(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(json)) {
      throw new Error(`desktop model catalog leaked key: ${key}`);
    }
  }
}

function clipName(name: string, fallback: string): string {
  const trimmed = name.trim() || fallback.trim();
  if (trimmed.length <= DESKTOP_QUICK_SESSION_MODEL_NAME_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, DESKTOP_QUICK_SESSION_MODEL_NAME_MAX_CHARS - 1)}…`;
}

export function parseDesktopQuickSessionModelRef(
  provider: unknown,
  modelId: unknown,
): DesktopQuickSessionModelRef | null {
  if (typeof provider !== "string" || typeof modelId !== "string") return null;
  const nextProvider = provider.trim();
  const nextModelId = modelId.trim();
  if (!isDesktopQuickSessionProvider(nextProvider)) return null;
  if (!isDesktopQuickSessionModelId(nextModelId)) return null;
  return { provider: nextProvider, modelId: nextModelId };
}

export function projectDesktopQuickSessionModels(
  metadata: Pick<ModelMetadata, "modelList" | "defaultModel">,
): Pick<DesktopQuickSessionModelCatalog, "defaultModel" | "models" | "truncated"> {
  const defaultModel = selectDefaultNewSessionModel(metadata);
  const options: ModelPickerOption[] = [];
  for (const model of metadata.modelList) {
    if (!isDesktopQuickSessionProvider(model.provider)) continue;
    if (!isDesktopQuickSessionModelId(model.id)) continue;
    options.push({
      provider: model.provider,
      modelId: model.id,
      name: clipName(model.name || model.id, model.id),
      primaryCandidate: model.primaryCandidate === true,
    });
  }

  const projected = buildDefaultModelPickerOptions(options, defaultModel);
  const truncated = projected.defaultOptions.length > DESKTOP_QUICK_SESSION_MODEL_LIST_LIMIT;
  const models: DesktopQuickSessionModelItem[] = projected.defaultOptions
    .slice(0, DESKTOP_QUICK_SESSION_MODEL_LIST_LIMIT)
    .map((item) => ({
      provider: item.provider,
      modelId: item.modelId,
      name: item.name,
      primaryCandidate: item.primaryCandidate === true,
    }));
  if (
    defaultModel
    && !models.some((item) => item.provider === defaultModel.provider && item.modelId === defaultModel.modelId)
  ) {
    const fallback = options.find(
      (item) => item.provider === defaultModel.provider && item.modelId === defaultModel.modelId,
    );
    if (fallback) {
      models.unshift({
        provider: fallback.provider,
        modelId: fallback.modelId,
        name: fallback.name,
        primaryCandidate: fallback.primaryCandidate === true,
      });
    }
    if (models.length > DESKTOP_QUICK_SESSION_MODEL_LIST_LIMIT) models.pop();
  }

  return {
    defaultModel,
    models,
    truncated,
  };
}

export function resolveDesktopQuickSessionModel(
  metadata: Pick<ModelMetadata, "modelList" | "defaultModel">,
  requested: DesktopQuickSessionModelRef | null,
): DesktopQuickSessionModelRef | null {
  if (!requested) return selectDefaultNewSessionModel(metadata);
  const match = metadata.modelList.find(
    (model) => model.provider === requested.provider && model.id === requested.modelId,
  );
  return match ? { provider: match.provider, modelId: match.id } : null;
}

export async function buildDesktopQuickSessionModelCatalog(
  projectRef: unknown,
  deps: DesktopQuickSessionModelCatalogDeps = {},
): Promise<DesktopQuickSessionModelCatalogResult> {
  if (typeof projectRef !== "string" || !DESKTOP_QUICK_SESSION_PROJECT_REF_PATTERN.test(projectRef.trim())) {
    return { ok: false, status: 400, code: "bad_request" };
  }
  const resolved = await resolveDesktopProjectRef(projectRef.trim(), deps.catalog);
  if (!resolved.ok) {
    return { ok: false, status: 422, code: resolved.code };
  }

  const loadModels = deps.loadModelMetadata ?? loadModelMetadata;
  const metadata = await loadModels(resolved.cwd);
  const projected = projectDesktopQuickSessionModels(metadata);
  const catalog = {
    projectRef: resolved.projectRef,
    ...projected,
  };
  assertDesktopQuickSessionModelCatalogSafe(catalog);
  return { ok: true, catalog };
}
