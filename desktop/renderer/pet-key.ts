/**
 * Namespaced desktop-pet identity.
 *
 * Runtime selection uses `snail:<id>` / `codex:<id>` so a Snail pack and a
 * Codex pack can share an external id without colliding. CSS tokens are a
 * separate safe alphabet — colons never enter selectors or keyframe names.
 */

import { BUILTIN_PET_IDS, isBuiltinPetId, isCustomPetId } from "./pet-assets";

export const PET_KEY_FORMATS = ["snail", "codex"] as const;
export type PetKeyFormat = (typeof PET_KEY_FORMATS)[number];

export const DEFAULT_PET_ID = "snail-default";
export const DEFAULT_PET_KEY = "snail:snail-default";

export const PET_KEY_PATTERN = /^(snail|codex):[a-z0-9][a-z0-9_-]{0,63}$/;

export type ParsedPetKey = {
  format: PetKeyFormat;
  id: string;
};

export function isPetKey(value: string): boolean {
  return PET_KEY_PATTERN.test(value);
}

export function buildPetKey(format: PetKeyFormat, id: string): string {
  return `${format}:${id}`;
}

export function parsePetKey(value: string): ParsedPetKey | null {
  if (typeof value !== "string" || !PET_KEY_PATTERN.test(value)) return null;
  const sep = value.indexOf(":");
  return {
    format: value.slice(0, sep) as PetKeyFormat,
    id: value.slice(sep + 1),
  };
}

/**
 * CSS / keyframe token. Builtins keep their historical ids so existing
 * stylesheet class names (`pet-sprite-snail-sprite`) stay stable.
 */
export function petCssToken(format: PetKeyFormat, id: string): string {
  if (format === "snail" && isBuiltinPetId(id)) return id;
  const raw = `${format}-${id}`;
  const safe = raw.replace(/[^a-z0-9_-]/g, "");
  return safe.slice(0, 80) || `${format}-pet`;
}

export function isBuiltinPetKey(value: string): boolean {
  const parsed = parsePetKey(value);
  return parsed?.format === "snail" && isBuiltinPetId(parsed.id);
}

export function builtinPetKey(id: (typeof BUILTIN_PET_IDS)[number]): string {
  return buildPetKey("snail", id);
}

/**
 * Recover a namespaced key from mixed legacy/current settings or view fields.
 * Unknown values collapse to the built-in default — never blank, never a path.
 */
export function resolvePetKey(input: {
  selectedPetKey?: unknown;
  selectedPetId?: unknown;
}): string {
  if (typeof input.selectedPetKey === "string" && isPetKey(input.selectedPetKey)) {
    return input.selectedPetKey;
  }
  if (typeof input.selectedPetId === "string") {
    if (isPetKey(input.selectedPetId)) return input.selectedPetId;
    if (isBuiltinPetId(input.selectedPetId) || isCustomPetId(input.selectedPetId)) {
      return buildPetKey("snail", input.selectedPetId);
    }
  }
  return DEFAULT_PET_KEY;
}

export function petIdFromKey(petKey: string): string {
  return parsePetKey(petKey)?.id ?? DEFAULT_PET_ID;
}
