/**
 * Dual-format pet catalog (Snail manifest + Codex pet.json).
 *
 * Scan returns renderer-safe metadata only. Bitmap bytes stay in main and are
 * read later by namespaced petKey. Paths never leave this module.
 */

import {
  PET_ASSET_LIMITS,
  isCustomPetId,
  type PetManifestV2,
} from "../renderer/pet-assets";
import {
  CODEX_PET_MAX_COUNT,
  CODEX_PET_MAX_FILE_BYTES,
  CODEX_PET_MAX_MANIFEST_BYTES,
  validateCodexPetDocument,
  type CodexPetMetadata,
} from "../renderer/codex-pet-assets";
import { buildPetKey, petCssToken, type PetKeyFormat } from "../renderer/pet-key";
import { profileFromCodexMetadata, profileFromSnailManifest } from "../renderer/pet-runtime-profile";
import {
  CUSTOM_PET_MAX_COUNT,
  customPetSheetMime,
  isStrictChildPath,
  sameRealPath,
  scanCustomPets,
  type CustomPetsIo,
  type CustomPetScanError,
} from "./custom-pets";

export const CODEX_PETS_ENV_HOME = "CODEX_HOME";

export type PetCatalogSource = "snail-custom" | "codex-home";
export type PetCatalogFormat = PetKeyFormat;

export type PetCatalogCapabilities = {
  look: boolean;
  directionalRun: boolean;
  waving: boolean;
};

export type PetCatalogEntry = {
  petKey: string;
  format: PetCatalogFormat;
  source: PetCatalogSource;
  id: string;
  name: string;
  description: string | null;
  cssToken: string;
  spriteVersion: 1 | 2 | null;
  capabilities: PetCatalogCapabilities;
  snailManifest: PetManifestV2 | null;
};

export type PetCatalogDiagnostic = {
  petId: string | null;
  petKey: string | null;
  source: PetCatalogSource | null;
  reason: string;
};

export type PetAssetLocator = {
  petKey: string;
  format: PetCatalogFormat;
  source: PetCatalogSource;
  folderPath: string;
  sheetPath: string;
  mime: "image/png" | "image/webp";
  size: number;
  mtimeMs: number;
  expectedWidth: number;
  expectedHeight: number;
};

export type PetCatalogState = {
  revision: number;
  entries: PetCatalogEntry[];
  locators: Map<string, PetAssetLocator>;
  diagnostics: PetCatalogDiagnostic[];
  snailRoot: string;
  codexRoot: string;
};

export type PetCatalogIo = CustomPetsIo & {
  realpath: (filePath: string) => string;
  statMtimeMs: (filePath: string) => number;
};

export type PetAssetReadResult =
  | {
      ok: true;
      petKey: string;
      mime: "image/png" | "image/webp";
      bytes: Uint8Array;
      fingerprint: string;
      expectedWidth: number;
      expectedHeight: number;
    }
  | {
      ok: false;
      reason: "invalid_key" | "not_found" | "changed" | "read_failed" | "type" | "size";
    };

let catalogRevision = 0;

export function resolveCodexPetsRoot(input: {
  env: Record<string, string | undefined>;
  homedir: string;
}): string {
  const override = input.env[CODEX_PETS_ENV_HOME]?.trim();
  const home = (override || `${input.homedir.replace(/[\\/]+$/, "")}/.codex`).replace(/[\\/]+$/, "");
  return `${home}/pets`;
}

function pathCompareOptions(): { ignoreCase: boolean } {
  return { ignoreCase: process.platform === "win32" };
}

function realpathOrNull(io: PetCatalogIo, filePath: string): string | null {
  try {
    return io.realpath(filePath);
  } catch {
    return null;
  }
}

function listDirNames(io: PetCatalogIo, root: string): { names: string[] | null; missing: boolean } {
  if (!io.exists(root)) return { names: [], missing: true };
  try {
    return { names: io.listDirs(root), missing: false };
  } catch {
    return { names: null, missing: false };
  }
}

function unsafeDisplayText(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => typeof value === "string" && /https?:\/\/[^"\s]+/i.test(value));
}

function pushDiagnostic(
  diagnostics: PetCatalogDiagnostic[],
  input: Partial<PetCatalogDiagnostic> & { reason: string },
): void {
  diagnostics.push({
    petId: input.petId ?? null,
    petKey: input.petKey ?? null,
    source: input.source ?? null,
    reason: input.reason,
  });
}

function inspectCodexFolder(
  io: PetCatalogIo,
  rootReal: string,
  folderName: string,
  source: PetCatalogSource,
):
  | { ok: true; metadata: CodexPetMetadata; locator: Omit<PetAssetLocator, "petKey"> }
  | { ok: false; reason: string } {
  if (!isCustomPetId(folderName)) return { ok: false, reason: "bad_id" };
  const folder = io.join(rootReal, folderName);
  const folderReal = realpathOrNull(io, folder);
  if (!folderReal || !isStrictChildPath(rootReal, folderReal, pathCompareOptions())) {
    return { ok: false, reason: "symlink_escape" };
  }
  const manifestPath = io.join(folderReal, "pet.json");
  if (!io.exists(manifestPath)) return { ok: false, reason: "manifest_missing" };
  const manifestBytes = io.size(manifestPath);
  if (manifestBytes <= 0 || manifestBytes > CODEX_PET_MAX_MANIFEST_BYTES) {
    return { ok: false, reason: "manifest_size" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(io.readText(manifestPath));
  } catch {
    return { ok: false, reason: "manifest_json" };
  }
  const validated = validateCodexPetDocument(raw, folderName);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  const metadata = validated.metadata;
  if (unsafeDisplayText(metadata.displayName, metadata.description, metadata.id)) {
    return { ok: false, reason: "unsafe_content" };
  }
  const mime = customPetSheetMime(metadata.spritesheetPath);
  if (!mime) return { ok: false, reason: "sheet_type" };
  const sheetPath = io.join(folderReal, metadata.spritesheetPath);
  if (!io.exists(sheetPath)) return { ok: false, reason: "sheet_missing" };
  const sheetReal = realpathOrNull(io, sheetPath);
  if (!sheetReal || !isStrictChildPath(folderReal, sheetReal, pathCompareOptions())) {
    return { ok: false, reason: "symlink_escape" };
  }
  const size = io.size(sheetReal);
  if (size <= 0 || size > CODEX_PET_MAX_FILE_BYTES) {
    return { ok: false, reason: "sheet_size" };
  }
  const spec = profileFromCodexMetadata(metadata).sheet;
  if (!spec) return { ok: false, reason: "sheet_missing" };
  let mtimeMs = 0;
  try {
    mtimeMs = io.statMtimeMs(sheetReal);
  } catch {
    return { ok: false, reason: "sheet_read" };
  }
  return {
    ok: true,
    metadata,
    locator: {
      format: "codex",
      source,
      folderPath: folderReal,
      sheetPath: sheetReal,
      mime,
      size,
      mtimeMs,
      expectedWidth: spec.expectedWidth,
      expectedHeight: spec.expectedHeight,
    },
  };
}

function acceptCodex(
  state: {
    entries: PetCatalogEntry[];
    locators: Map<string, PetAssetLocator>;
    diagnostics: PetCatalogDiagnostic[];
    seenCodexIds: Map<string, PetCatalogSource>;
    codexCount: number;
  },
  io: PetCatalogIo,
  rootReal: string,
  folderName: string,
  source: PetCatalogSource,
): void {
  if (state.codexCount >= CODEX_PET_MAX_COUNT) {
    pushDiagnostic(state.diagnostics, { petId: folderName, source, reason: "too_many_pets" });
    return;
  }
  const inspected = inspectCodexFolder(io, rootReal, folderName, source);
  if (!inspected.ok) {
    pushDiagnostic(state.diagnostics, { petId: folderName, source, reason: inspected.reason });
    return;
  }
  const prior = state.seenCodexIds.get(inspected.metadata.id);
  if (prior) {
    pushDiagnostic(state.diagnostics, {
      petId: inspected.metadata.id,
      petKey: buildPetKey("codex", inspected.metadata.id),
      source,
      reason: "duplicate_codex_id",
    });
    return;
  }
  const profile = profileFromCodexMetadata(inspected.metadata);
  const entry: PetCatalogEntry = {
    petKey: profile.petKey,
    format: "codex",
    source,
    id: inspected.metadata.id,
    name: inspected.metadata.displayName,
    description: inspected.metadata.description,
    cssToken: profile.cssToken,
    spriteVersion: inspected.metadata.spriteVersionNumber,
    capabilities: profile.capabilities,
    snailManifest: null,
  };
  state.entries.push(entry);
  state.locators.set(entry.petKey, { ...inspected.locator, petKey: entry.petKey });
  state.seenCodexIds.set(inspected.metadata.id, source);
  state.codexCount += 1;
}

function acceptSnailScan(
  state: {
    entries: PetCatalogEntry[];
    locators: Map<string, PetAssetLocator>;
    diagnostics: PetCatalogDiagnostic[];
  },
  io: PetCatalogIo,
  rootReal: string,
  pets: ReturnType<typeof scanCustomPets>["pets"],
  errors: CustomPetScanError[],
): void {
  for (const error of errors) {
    pushDiagnostic(state.diagnostics, {
      petId: error.petId,
      source: "snail-custom",
      reason: error.reason,
    });
  }
  for (const pet of pets) {
    const folder = io.join(rootReal, pet.id);
    const folderReal = realpathOrNull(io, folder);
    if (!folderReal || !isStrictChildPath(rootReal, folderReal, pathCompareOptions())) {
      pushDiagnostic(state.diagnostics, {
        petId: pet.id,
        source: "snail-custom",
        reason: "symlink_escape",
      });
      continue;
    }
    if (!pet.manifest.sheet) {
      pushDiagnostic(state.diagnostics, {
        petId: pet.id,
        source: "snail-custom",
        reason: "sheet_missing",
      });
      continue;
    }
    const sheetPath = io.join(folderReal, pet.manifest.sheet.src);
    const sheetReal = realpathOrNull(io, sheetPath);
    if (!sheetReal || !isStrictChildPath(folderReal, sheetReal, pathCompareOptions())) {
      pushDiagnostic(state.diagnostics, {
        petId: pet.id,
        source: "snail-custom",
        reason: "symlink_escape",
      });
      continue;
    }
    const profile = profileFromSnailManifest(pet.manifest, buildPetKey("snail", pet.id));
    const entry: PetCatalogEntry = {
      petKey: profile.petKey,
      format: "snail",
      source: "snail-custom",
      id: pet.id,
      name: pet.manifest.name,
      description: null,
      cssToken: petCssToken("snail", pet.id),
      spriteVersion: null,
      capabilities: profile.capabilities,
      snailManifest: pet.manifest,
    };
    let mtimeMs = 0;
    try {
      mtimeMs = io.statMtimeMs(sheetReal);
    } catch {
      pushDiagnostic(state.diagnostics, {
        petId: pet.id,
        source: "snail-custom",
        reason: "sheet_read",
      });
      continue;
    }
    state.entries.push(entry);
    state.locators.set(entry.petKey, {
      petKey: entry.petKey,
      format: "snail",
      source: "snail-custom",
      folderPath: folderReal,
      sheetPath: sheetReal,
      mime: pet.sheetMime,
      size: pet.sheetSize,
      mtimeMs,
      expectedWidth: profile.sheet?.expectedWidth ?? 0,
      expectedHeight: profile.sheet?.expectedHeight ?? 0,
    });
  }
}

export function scanPetCatalog(input: {
  snailRoot: string;
  codexRoot: string;
  io: PetCatalogIo;
}): PetCatalogState {
  catalogRevision += 1;
  const diagnostics: PetCatalogDiagnostic[] = [];
  const entries: PetCatalogEntry[] = [];
  const locators = new Map<string, PetAssetLocator>();
  const seenCodexIds = new Map<string, PetCatalogSource>();
  const acc = { entries, locators, diagnostics, seenCodexIds, codexCount: 0 };

  const snailListed = listDirNames(input.io, input.snailRoot);
  const snailRootReal = snailListed.missing ? input.snailRoot : realpathOrNull(input.io, input.snailRoot);
  if (!snailListed.missing && (snailListed.names == null || !snailRootReal)) {
    pushDiagnostic(diagnostics, { source: "snail-custom", reason: "root_unreadable" });
  } else if (snailRootReal && snailListed.names) {
    const names = [...snailListed.names].sort();
    const snailNames: string[] = [];
    const snailCodexNames: string[] = [];
    for (const name of names) {
      const folder = input.io.join(snailRootReal, name);
      const hasManifest = input.io.exists(input.io.join(folder, "manifest.json"));
      const hasPetJson = input.io.exists(input.io.join(folder, "pet.json"));
      if (hasManifest) snailNames.push(name);
      else if (hasPetJson) snailCodexNames.push(name);
      else {
        pushDiagnostic(diagnostics, {
          petId: name,
          source: "snail-custom",
          reason: isCustomPetId(name) ? "manifest_missing" : "bad_id",
        });
      }
    }
    const snailIo: CustomPetsIo = {
      ...input.io,
      listDirs: () => snailNames,
    };
    const scanned = scanCustomPets(snailRootReal, snailIo);
    acceptSnailScan(acc, input.io, snailRootReal, scanned.pets, scanned.errors);
    for (const name of snailCodexNames) {
      acceptCodex(acc, input.io, snailRootReal, name, "snail-custom");
    }
  }

  const codexListed = listDirNames(input.io, input.codexRoot);
  if (codexListed.missing) {
    // Official hatch-pet root is optional. Missing is not an error.
  } else if (codexListed.names == null) {
    pushDiagnostic(diagnostics, { source: "codex-home", reason: "root_unreadable" });
  } else {
    const codexRootReal = realpathOrNull(input.io, input.codexRoot);
    if (!codexRootReal) {
      pushDiagnostic(diagnostics, { source: "codex-home", reason: "root_unreadable" });
    } else {
      for (const name of [...codexListed.names].sort()) {
        acceptCodex(acc, input.io, codexRootReal, name, "codex-home");
      }
    }
  }

  entries.sort((a, b) => {
    if (a.format !== b.format) return a.format === "snail" ? -1 : 1;
    if (a.source !== b.source) return a.source === "snail-custom" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return {
    revision: catalogRevision,
    entries,
    locators,
    diagnostics: diagnostics.slice(0, CUSTOM_PET_MAX_COUNT + CODEX_PET_MAX_COUNT + 8),
    snailRoot: input.snailRoot,
    codexRoot: input.codexRoot,
  };
}

export function catalogFingerprint(locator: PetAssetLocator): string {
  return `${locator.size}:${Math.round(locator.mtimeMs)}`;
}

export function readCatalogPetAsset(
  state: PetCatalogState,
  petKey: string,
  io: PetCatalogIo,
): PetAssetReadResult {
  const locator = state.locators.get(petKey);
  if (!locator) return { ok: false, reason: "not_found" };
  const maxBytes = locator.format === "codex" ? CODEX_PET_MAX_FILE_BYTES : PET_ASSET_LIMITS.maxFileBytes;
  try {
    if (!io.exists(locator.sheetPath)) return { ok: false, reason: "changed" };
    const sheetReal = realpathOrNull(io, locator.sheetPath);
    if (!sheetReal || !sameRealPath(sheetReal, locator.sheetPath, pathCompareOptions())) {
      return { ok: false, reason: "changed" };
    }
    const size = io.size(sheetReal);
    const mtimeMs = io.statMtimeMs(sheetReal);
    if (size !== locator.size || Math.round(mtimeMs) !== Math.round(locator.mtimeMs)) {
      return { ok: false, reason: "changed" };
    }
    if (size <= 0 || size > maxBytes) return { ok: false, reason: "size" };
    const bytes = io.readBinary(sheetReal);
    if (bytes.length !== size) return { ok: false, reason: "changed" };
    return {
      ok: true,
      petKey,
      mime: locator.mime,
      bytes,
      fingerprint: catalogFingerprint(locator),
      expectedWidth: locator.expectedWidth,
      expectedHeight: locator.expectedHeight,
    };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

export function toRendererCatalogPayload(state: PetCatalogState): {
  revision: number;
  pets: PetCatalogEntry[];
  diagnostics: PetCatalogDiagnostic[];
  snailRoot: string;
  codexRoot: string;
  root: string;
} {
  return {
    revision: state.revision,
    pets: state.entries,
    diagnostics: state.diagnostics,
    snailRoot: state.snailRoot,
    codexRoot: state.codexRoot,
    // Legacy display field used by the existing settings path label.
    root: state.snailRoot,
  };
}
