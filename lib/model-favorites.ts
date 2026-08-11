import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  modelPrimaryCandidateKey,
} from "./model-primary-candidates";
import {
  getModelsJsonPath,
  readPrimaryCandidateKeys,
} from "./model-primary-candidates-server";

export const MODEL_FAVORITES_SCHEMA_VERSION = 1 as const;
const MODEL_FAVORITES_FILENAME = "model-favorites.json";
const MAX_FAVORITES = 2_000;
const MAX_MODEL_REF_LENGTH = 512;

export interface ModelFavorite {
  provider: string;
  modelId: string;
}

interface ModelFavoritesFile {
  schemaVersion: typeof MODEL_FAVORITES_SCHEMA_VERSION;
  favorites: ModelFavorite[];
}

export interface ModelFavoritesState {
  favorites: ModelFavorite[];
  source: "sidecar" | "legacy" | "empty";
}

export class ModelFavoritesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelFavoritesValidationError";
  }
}

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function getModelFavoritesPath(agentDir = resolveAgentDir()): string {
  return join(agentDir, MODEL_FAVORITES_FILENAME);
}

function normalizeModelRef(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ModelFavoritesValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ModelFavoritesValidationError(`${field} must not be empty`);
  }
  if (normalized.length > MAX_MODEL_REF_LENGTH) {
    throw new ModelFavoritesValidationError(`${field} is too long`);
  }
  if (normalized.includes("\0")) {
    throw new ModelFavoritesValidationError(`${field} contains an invalid character`);
  }
  return normalized;
}

export function normalizeModelFavorite(value: unknown): ModelFavorite {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelFavoritesValidationError("favorite must be an object");
  }
  const candidate = value as { provider?: unknown; modelId?: unknown };
  return {
    provider: normalizeModelRef(candidate.provider, "provider"),
    modelId: normalizeModelRef(candidate.modelId, "modelId"),
  };
}

function compareFavorites(a: ModelFavorite, b: ModelFavorite): number {
  return a.provider.localeCompare(b.provider)
    || a.modelId.localeCompare(b.modelId);
}

function favoritesFromKeys(keys: Iterable<string>): ModelFavorite[] {
  const favorites: ModelFavorite[] = [];
  for (const key of keys) {
    const separator = key.indexOf("\0");
    if (separator <= 0 || separator === key.length - 1) continue;
    favorites.push({
      provider: key.slice(0, separator),
      modelId: key.slice(separator + 1),
    });
  }
  if (favorites.length > MAX_FAVORITES) {
    throw new ModelFavoritesValidationError(`favorites must contain at most ${MAX_FAVORITES} entries`);
  }
  return favorites.sort(compareFavorites);
}

function normalizeFavorites(values: unknown): ModelFavorite[] {
  if (!Array.isArray(values)) {
    throw new ModelFavoritesValidationError("favorites must be an array");
  }
  if (values.length > MAX_FAVORITES) {
    throw new ModelFavoritesValidationError(`favorites must contain at most ${MAX_FAVORITES} entries`);
  }

  const byKey = new Map<string, ModelFavorite>();
  for (const value of values) {
    const favorite = normalizeModelFavorite(value);
    byKey.set(modelPrimaryCandidateKey(favorite.provider, favorite.modelId), favorite);
  }
  return [...byKey.values()].sort(compareFavorites);
}

function parseFavoritesFile(raw: unknown): ModelFavoritesFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelFavoritesValidationError("model favorites file must be an object");
  }
  const candidate = raw as { schemaVersion?: unknown; favorites?: unknown };
  if (candidate.schemaVersion !== MODEL_FAVORITES_SCHEMA_VERSION) {
    throw new ModelFavoritesValidationError("unsupported model favorites schemaVersion");
  }
  return {
    schemaVersion: MODEL_FAVORITES_SCHEMA_VERSION,
    favorites: normalizeFavorites(candidate.favorites),
  };
}

/**
 * Read the WebUI-owned favorites sidecar. Before the sidecar exists, legacy
 * `models.json` flags are projected so the first write can migrate them.
 */
export function readModelFavorites(agentDir = resolveAgentDir()): ModelFavoritesState {
  const favoritesPath = getModelFavoritesPath(agentDir);
  if (existsSync(favoritesPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(favoritesPath, "utf8")) as unknown;
    } catch (error) {
      throw new ModelFavoritesValidationError(
        `failed to parse model favorites: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { favorites: parseFavoritesFile(parsed).favorites, source: "sidecar" };
  }

  const legacyKeys = readPrimaryCandidateKeys(getModelsJsonPath(agentDir));
  if (legacyKeys.size > 0) {
    return { favorites: favoritesFromKeys(legacyKeys), source: "legacy" };
  }
  return { favorites: [], source: "empty" };
}

export function readModelFavoriteKeys(agentDir = resolveAgentDir()): Set<string> {
  return new Set(
    readModelFavorites(agentDir).favorites.map((favorite) => (
      modelPrimaryCandidateKey(favorite.provider, favorite.modelId)
    )),
  );
}

const writeQueues = new Map<string, Promise<void>>();

async function atomicWriteFavorites(path: string, favorites: ModelFavorite[]): Promise<void> {
  const file: ModelFavoritesFile = {
    schemaVersion: MODEL_FAVORITES_SCHEMA_VERSION,
    favorites,
  };
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/** Atomically toggle one favorite, seeding the first sidecar write from legacy flags. */
export function setModelFavorite(
  value: unknown,
  favorite: unknown,
  agentDir = resolveAgentDir(),
): Promise<ModelFavoritesState> {
  const model = normalizeModelFavorite(value);
  if (typeof favorite !== "boolean") {
    throw new ModelFavoritesValidationError("favorite must be a boolean");
  }

  const path = getModelFavoritesPath(agentDir);
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = readModelFavorites(agentDir);
    const byKey = new Map(
      current.favorites.map((entry) => [
        modelPrimaryCandidateKey(entry.provider, entry.modelId),
        entry,
      ]),
    );
    const key = modelPrimaryCandidateKey(model.provider, model.modelId);
    if (favorite) byKey.set(key, model);
    else byKey.delete(key);
    if (byKey.size > MAX_FAVORITES) {
      throw new ModelFavoritesValidationError(`favorites must contain at most ${MAX_FAVORITES} entries`);
    }

    const favorites = [...byKey.values()].sort(compareFavorites);
    await atomicWriteFavorites(path, favorites);
    return { favorites, source: "sidecar" as const };
  });

  const settled = operation.then(() => undefined, () => undefined);
  writeQueues.set(path, settled);
  void settled.finally(() => {
    if (writeQueues.get(path) === settled) writeQueues.delete(path);
  });
  return operation;
}
