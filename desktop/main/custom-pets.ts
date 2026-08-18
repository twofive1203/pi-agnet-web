/**
 * Custom desktop pets (folder drop-in, U6 slice 1).
 *
 * Main-owned Snail-format scan: enumerate <root>/<pet-id>/manifest.json +
 * spritesheet, validate with the shared manifest contract, and return
 * renderer-safe metadata only. Bitmaps are loaded later by pet-catalog via
 * namespaced keys. The renderer never touches the filesystem.
 *
 * Pure module: filesystem access is injectable so contract smokes run without
 * disk fixtures. Custom pets are spritesheet-only (PNG/WebP) in this slice;
 * CSS manifests would render as the built-in snail anatomy, so they are
 * rejected instead of silently confusing users.
 */

import {
  BUILTIN_PET_IDS,
  PET_ASSET_LIMITS,
  isCustomPetId,
  validatePetManifestDocument,
  type PetManifestV2,
} from "../renderer/pet-assets";

export const CUSTOM_PET_MAX_COUNT = 16;

/** Renderer-safe Snail pack metadata (never raw paths or bitmap bytes). */
export type CustomPetAsset = {
  id: string;
  manifest: PetManifestV2;
  sheetMime: "image/png" | "image/webp";
  sheetSize: number;
};

export type CustomPetScanError = {
  /** Folder name when it parsed as a candidate id, otherwise null. */
  petId: string | null;
  reason: string;
};

export type CustomPetScanResult = {
  pets: CustomPetAsset[];
  errors: CustomPetScanError[];
};

export type CustomPetsIo = {
  /** Directory entry names directly under root (folders only). */
  listDirs: (root: string) => string[];
  readText: (filePath: string) => string;
  readBinary: (filePath: string) => Uint8Array;
  exists: (filePath: string) => boolean;
  size: (filePath: string) => number;
  encodeBase64: (bytes: Uint8Array) => string;
  join: (...parts: string[]) => string;
  realpath?: (filePath: string) => string;
  statMtimeMs?: (filePath: string) => number;
};

export function normalizeComparePath(value: string, ignoreCase = false): string {
  const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return ignoreCase ? trimmed.toLowerCase() : trimmed;
}

export function sameRealPath(
  left: string,
  right: string,
  options?: { ignoreCase?: boolean },
): boolean {
  const ignoreCase = options?.ignoreCase ?? false;
  return normalizeComparePath(left, ignoreCase) === normalizeComparePath(right, ignoreCase);
}

export function isContainedPath(
  root: string,
  candidate: string,
  options?: { ignoreCase?: boolean },
): boolean {
  const ignoreCase = options?.ignoreCase ?? false;
  const normalize = (value: string) => {
    const trimmed = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return ignoreCase ? trimmed.toLowerCase() : trimmed;
  };
  const rootNorm = normalize(root);
  const candidateNorm = normalize(candidate);
  return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}/`);
}

export function isStrictChildPath(
  root: string,
  candidate: string,
  options?: { ignoreCase?: boolean },
): boolean {
  if (!isContainedPath(root, candidate, options)) return false;
  const ignoreCase = options?.ignoreCase ?? false;
  const left = ignoreCase ? root.toLowerCase() : root;
  const right = ignoreCase ? candidate.toLowerCase() : candidate;
  return left.replace(/\\/g, "/").replace(/\/+$/, "") !== right.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function customPetSheetMime(sheetSrc: string): "image/png" | "image/webp" | null {
  if (/\.png$/i.test(sheetSrc)) return "image/png";
  if (/\.webp$/i.test(sheetSrc)) return "image/webp";
  return null;
}

/**
 * Scan the custom pets root. Invalid candidates are reported as errors and
 * skipped; they never break the scan or leak into the renderer payload.
 */
export function scanCustomPets(root: string, io: CustomPetsIo): CustomPetScanResult {
  const pets: CustomPetAsset[] = [];
  const errors: CustomPetScanError[] = [];
  let names: string[];
  try {
    names = io.listDirs(root);
  } catch {
    return { pets, errors: [{ petId: null, reason: "root_unreadable" }] };
  }
  names.sort();
  for (const name of names) {
    if (pets.length >= CUSTOM_PET_MAX_COUNT) {
      errors.push({ petId: name, reason: "too_many_pets" });
      continue;
    }
    if (!isCustomPetId(name)) {
      errors.push({ petId: name, reason: "bad_id" });
      continue;
    }
    if ((BUILTIN_PET_IDS as readonly string[]).includes(name)) {
      errors.push({ petId: name, reason: "builtin_id_collision" });
      continue;
    }
    const folder = io.join(root, name);
    const manifestPath = io.join(folder, "manifest.json");
    try {
      if (!io.exists(manifestPath)) {
        errors.push({ petId: name, reason: "manifest_missing" });
        continue;
      }
      const manifestBytes = io.size(manifestPath);
      if (manifestBytes <= 0 || manifestBytes > PET_ASSET_LIMITS.maxManifestBytes) {
        errors.push({ petId: name, reason: "manifest_size" });
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(io.readText(manifestPath));
      } catch {
        errors.push({ petId: name, reason: "manifest_json" });
        continue;
      }
      const validated = validatePetManifestDocument(raw, name);
      if (!validated.ok) {
        errors.push({ petId: name, reason: validated.reason });
        continue;
      }
      const manifest = validated.manifest;
      if (manifest.renderMode !== "spritesheet" || !manifest.sheet) {
        errors.push({ petId: name, reason: "custom_render_mode" });
        continue;
      }
      const mime = customPetSheetMime(manifest.sheet.src);
      if (!mime) {
        errors.push({ petId: name, reason: "sheet_type" });
        continue;
      }
      const sheetPath = io.join(folder, manifest.sheet.src);
      if (!io.exists(sheetPath)) {
        errors.push({ petId: name, reason: "sheet_missing" });
        continue;
      }
      const sheetSize = io.size(sheetPath);
      if (sheetSize <= 0 || sheetSize > PET_ASSET_LIMITS.maxFileBytes) {
        errors.push({ petId: name, reason: "sheet_size" });
        continue;
      }
      const pet: CustomPetAsset = {
        id: name,
        manifest,
        sheetMime: mime,
        sheetSize,
      };
      // The renderer view gate rejects non-loopback absolute URLs anywhere in a
      // payload; filter such content at scan time so one hostile name/label
      // never breaks the whole custom-pets push.
      if (/https?:\/\/[^"\s]+/i.test(JSON.stringify(pet))) {
        errors.push({ petId: name, reason: "unsafe_content" });
        continue;
      }
      pets.push(pet);
    } catch {
      errors.push({ petId: name, reason: "scan_failed" });
    }
  }
  return { pets, errors };
}

export const CUSTOM_PETS_ENV_DIR = "SNAIL_PET_CUSTOM_PETS_DIR";

/**
 * Resolve the custom pets root: explicit pet override, then the shared agent
 * data dir convention, then the home default. Pure so smokes can pin it.
 */
export function resolveCustomPetsRoot(input: {
  env: Record<string, string | undefined>;
  homedir: string;
}): string {
  const override = input.env[CUSTOM_PETS_ENV_DIR]?.trim();
  if (override) return override.replace(/[\\/]+$/, "");
  const agentDir = input.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return `${agentDir.replace(/[\\/]+$/, "")}/desktop-pets`;
  return `${input.homedir.replace(/[\\/]+$/, "")}/.pi/agent/desktop-pets`;
}
