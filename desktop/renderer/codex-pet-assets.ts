/**
 * Codex pet.json parser (v1 / v2).
 *
 * Independent of the Snail manifest v2 validator. Only known display fields
 * are projected; unknown keys and command/URL-like capability fields are
 * dropped and never become runtime capabilities. Dangerous path/URL/version
 * combinations reject the document.
 */

import { collectForbiddenPetCapabilityKeys, isCustomPetId, isSafePetAssetPath } from "./pet-assets";

export const CODEX_PET_CELL_WIDTH = 192;
export const CODEX_PET_CELL_HEIGHT = 208;
export const CODEX_PET_COLUMNS = 8;
export const CODEX_PET_V1_ROWS = 9;
export const CODEX_PET_V2_ROWS = 11;
export const CODEX_PET_V1_WIDTH = CODEX_PET_CELL_WIDTH * CODEX_PET_COLUMNS;
export const CODEX_PET_V1_HEIGHT = CODEX_PET_CELL_HEIGHT * CODEX_PET_V1_ROWS;
export const CODEX_PET_V2_WIDTH = CODEX_PET_CELL_WIDTH * CODEX_PET_COLUMNS;
export const CODEX_PET_V2_HEIGHT = CODEX_PET_CELL_HEIGHT * CODEX_PET_V2_ROWS;

/**
 * Hard cap for one Codex atlas. Local v2 samples are 2.30 MiB and 2.74 MiB
 * (1536×2288 WebP). Public hatch-pet output uses the same atlas. 6 MiB is
 * ~2× the larger sample — enough headroom, still bounded. Not 256 KB and
 * not unbounded.
 */
export const CODEX_PET_MAX_FILE_BYTES = 6 * 1024 * 1024;
export const CODEX_PET_MAX_MANIFEST_BYTES = 16 * 1024;
export const CODEX_PET_MAX_COUNT = 24;
export const CODEX_PET_MAX_NAME_CHARS = 64;
export const CODEX_PET_MAX_DESCRIPTION_CHARS = 200;

export type CodexSpriteVersion = 1 | 2;

export type CodexPetMetadata = {
  id: string;
  displayName: string;
  description: string | null;
  spritesheetPath: string;
  spriteVersionNumber: CodexSpriteVersion;
};

export type CodexPetValidation =
  | { ok: true; metadata: CodexPetMetadata }
  | { ok: false; reason: string };

const PROJECTED_KEYS = new Set([
  "id",
  "displayName",
  "description",
  "spritesheetPath",
  "spriteVersionNumber",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativeSheetPath(value: string): boolean {
  if (!isSafePetAssetPath(value)) return false;
  return /\.(?:png|webp)$/i.test(value);
}

function readSpriteVersion(raw: unknown): CodexSpriteVersion | null {
  if (raw === undefined || raw === 1) return 1;
  if (raw === 2) return 2;
  return null;
}

/**
 * Parse one Codex pet.json document. `expectedId` is the folder name and must
 * match `id` exactly — the same containment rule as Snail custom packs.
 */
export function validateCodexPetDocument(
  raw: unknown,
  expectedId?: string,
): CodexPetValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };

  const id = raw.id;
  if (typeof id !== "string" || !isCustomPetId(id)) return { ok: false, reason: "id" };
  if (expectedId !== undefined && id !== expectedId) return { ok: false, reason: "id" };

  const version = readSpriteVersion(raw.spriteVersionNumber);
  if (version == null) return { ok: false, reason: "sprite_version" };

  const spritesheetPath = raw.spritesheetPath;
  if (typeof spritesheetPath !== "string" || spritesheetPath.length === 0) {
    return { ok: false, reason: "spritesheet_missing" };
  }
  if (!isSafeRelativeSheetPath(spritesheetPath)) {
    return { ok: false, reason: "spritesheet_path" };
  }

  let displayName = id;
  if (raw.displayName !== undefined) {
    if (typeof raw.displayName !== "string" || raw.displayName.length === 0) {
      return { ok: false, reason: "displayName" };
    }
    if (raw.displayName.length > CODEX_PET_MAX_NAME_CHARS) {
      return { ok: false, reason: "displayName" };
    }
    displayName = raw.displayName;
  }

  let description: string | null = null;
  if (raw.description !== undefined) {
    if (typeof raw.description !== "string") return { ok: false, reason: "description" };
    if (raw.description.length > CODEX_PET_MAX_DESCRIPTION_CHARS) {
      return { ok: false, reason: "description" };
    }
    description = raw.description;
  }

  // Capability-like keys are discarded, never copied. They do not reject a
  // community document unless a known path field is itself dangerous.
  collectForbiddenPetCapabilityKeys(raw);

  const metadata: CodexPetMetadata = {
    id,
    displayName,
    description,
    spritesheetPath,
    spriteVersionNumber: version,
  };
  for (const key of Object.keys(metadata) as (keyof CodexPetMetadata)[]) {
    if (!PROJECTED_KEYS.has(key)) {
      return { ok: false, reason: "projection" };
    }
  }
  return { ok: true, metadata };
}

export function codexAtlasSpec(version: CodexSpriteVersion): {
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  width: number;
  height: number;
} {
  const rows = version === 2 ? CODEX_PET_V2_ROWS : CODEX_PET_V1_ROWS;
  const height = version === 2 ? CODEX_PET_V2_HEIGHT : CODEX_PET_V1_HEIGHT;
  return {
    columns: CODEX_PET_COLUMNS,
    rows,
    frameWidth: CODEX_PET_CELL_WIDTH,
    frameHeight: CODEX_PET_CELL_HEIGHT,
    width: CODEX_PET_V1_WIDTH,
    height,
  };
}

export function isCodexAtlasSize(
  version: CodexSpriteVersion,
  width: number,
  height: number,
): boolean {
  const spec = codexAtlasSpec(version);
  return width === spec.width && height === spec.height;
}
