/**
 * Built-in pet manifest v2 contract (U4).
 *
 * Validates package-relative role resources. Any failure falls back to the
 * current CSS snail — never blank, never arbitrary filesystem/URL loads.
 * Renderer must not fetch or concatenate untrusted paths.
 */

export const BUILTIN_PET_IDS = ["snail-default", "snail-classic"] as const;
export type BuiltinPetId = (typeof BUILTIN_PET_IDS)[number];

export const PET_MANIFEST_VERSION = 2;
export const PET_REQUIRED_STATES = [
  "idle",
  "running",
  "retrying",
  "needs_input",
  "ready",
  "blocked",
  "disconnected",
  "service_not_running",
] as const;
export type PetRequiredState = (typeof PET_REQUIRED_STATES)[number];

export const PET_ASSET_LIMITS = {
  maxManifestBytes: 16 * 1024,
  maxPathLength: 80,
  maxFileBytes: 256 * 1024,
  maxFrames: 16,
  minDurationMs: 50,
  maxDurationMs: 5000,
  maxSheetWidth: 2048,
  maxSheetHeight: 2048,
} as const;

export type PetRenderMode = "css" | "spritesheet";

export type PetManifestFrameV2 = {
  frame: string;
  staticFrame: string;
  label: string;
  glyph: string;
  frameCount?: number;
  durationMs?: number;
  staticFrameIndex?: number;
};

export type PetManifestSheetV2 = {
  src: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
};

export type PetManifestV2 = {
  id: BuiltinPetId;
  name: string;
  version: typeof PET_MANIFEST_VERSION;
  renderMode: PetRenderMode;
  states: Record<PetRequiredState, PetManifestFrameV2>;
  sheet?: PetManifestSheetV2;
};

export type PetManifestValidation =
  | { ok: true; manifest: PetManifestV2 }
  | { ok: false; reason: string };

const ALLOWED_TOP_LEVEL = new Set(["id", "name", "version", "renderMode", "states", "sheet"]);
const ALLOWED_FRAME_KEYS = new Set([
  "frame",
  "staticFrame",
  "label",
  "glyph",
  "frameCount",
  "durationMs",
  "staticFrameIndex",
]);
const ALLOWED_SHEET_KEYS = new Set(["src", "frameWidth", "frameHeight", "columns", "rows"]);
const FORBIDDEN_CAPABILITY_KEYS = new Set([
  "command",
  "commands",
  "url",
  "href",
  "skill",
  "skills",
  "tools",
  "execute",
  "prompt",
  "cwd",
  "token",
  "observerToken",
  "accessKey",
]);

const PREVIEW_FORBIDDEN_KEY = /"(token|observerToken|accessKey|password|pid|servicePid|cwd|firstMessage|prompt|command|output|child_process)"\s*:/;

export function isBuiltinPetId(value: string): value is BuiltinPetId {
  return (BUILTIN_PET_IDS as readonly string[]).includes(value);
}

/** CSS class tokens and package-relative asset paths. No traversal or schemes. */
export function isSafePetAssetPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > PET_ASSET_LIMITS.maxPathLength) {
    return false;
  }
  if (value.includes("\\") || value.includes("..")) return false;
  if (value.startsWith("/") || value.startsWith("~")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

export function collectForbiddenPetCapabilityKeys(raw: unknown, found = new Set<string>()): string[] {
  if (!raw || typeof raw !== "object") return [...found];
  if (Array.isArray(raw)) {
    for (const item of raw) collectForbiddenPetCapabilityKeys(item, found);
    return [...found];
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_CAPABILITY_KEYS.has(key)) found.add(key);
    collectForbiddenPetCapabilityKeys(value, found);
  }
  return [...found];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPositiveInt(value: unknown, label: string, max: number): number | string {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    return `${label}_invalid`;
  }
  return value;
}

function validateFrame(state: string, raw: unknown): PetManifestFrameV2 | string {
  if (!isPlainObject(raw)) return `${state}_frame_missing`;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FRAME_KEYS.has(key)) return `${state}_unknown_field`;
  }
  if (typeof raw.frame !== "string" || !isSafePetAssetPath(raw.frame)) return `${state}_frame_path`;
  if (typeof raw.staticFrame !== "string" || !isSafePetAssetPath(raw.staticFrame)) {
    return `${state}_static_frame_path`;
  }
  if (typeof raw.label !== "string" || raw.label.length === 0 || raw.label.length > 16) {
    return `${state}_label`;
  }
  if (typeof raw.glyph !== "string" || raw.glyph.length === 0 || raw.glyph.length > 4) {
    return `${state}_glyph`;
  }
  const frame: PetManifestFrameV2 = {
    frame: raw.frame,
    staticFrame: raw.staticFrame,
    label: raw.label,
    glyph: raw.glyph,
  };
  if (raw.frameCount !== undefined) {
    const count = readPositiveInt(raw.frameCount, `${state}_frameCount`, PET_ASSET_LIMITS.maxFrames);
    if (typeof count === "string") return count;
    frame.frameCount = count;
  }
  if (raw.durationMs !== undefined) {
    if (
      typeof raw.durationMs !== "number" ||
      !Number.isFinite(raw.durationMs) ||
      raw.durationMs < PET_ASSET_LIMITS.minDurationMs ||
      raw.durationMs > PET_ASSET_LIMITS.maxDurationMs
    ) {
      return `${state}_duration`;
    }
    frame.durationMs = raw.durationMs;
  }
  if (raw.staticFrameIndex !== undefined) {
    if (typeof raw.staticFrameIndex !== "number" || !Number.isInteger(raw.staticFrameIndex) || raw.staticFrameIndex < 0) {
      return `${state}_static_index`;
    }
    const count = frame.frameCount ?? 1;
    if (raw.staticFrameIndex >= count) return `${state}_static_index`;
    frame.staticFrameIndex = raw.staticFrameIndex;
  }
  return frame;
}

export function validatePetManifestDocument(raw: unknown): PetManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) return { ok: false, reason: `unknown_field:${key}` };
  }
  const forbidden = collectForbiddenPetCapabilityKeys(raw);
  if (forbidden.length > 0) return { ok: false, reason: `capability:${forbidden[0]}` };
  if (typeof raw.id !== "string" || !isBuiltinPetId(raw.id)) return { ok: false, reason: "id" };
  if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 32) {
    return { ok: false, reason: "name" };
  }
  if (raw.version !== PET_MANIFEST_VERSION) return { ok: false, reason: "version" };
  if (raw.renderMode !== "css" && raw.renderMode !== "spritesheet") {
    return { ok: false, reason: "renderMode" };
  }
  if (!isPlainObject(raw.states)) return { ok: false, reason: "states" };

  const states = {} as Record<PetRequiredState, PetManifestFrameV2>;
  for (const state of PET_REQUIRED_STATES) {
    if (!(state in raw.states)) return { ok: false, reason: `missing_state:${state}` };
    const frame = validateFrame(state, raw.states[state]);
    if (typeof frame === "string") return { ok: false, reason: frame };
    states[state] = frame;
  }
  for (const state of Object.keys(raw.states)) {
    if (!(PET_REQUIRED_STATES as readonly string[]).includes(state)) {
      return { ok: false, reason: `unknown_state:${state}` };
    }
  }

  let sheet: PetManifestSheetV2 | undefined;
  if (raw.renderMode === "css") {
    if (raw.sheet !== undefined) return { ok: false, reason: "css_sheet_not_allowed" };
  } else {
    if (!isPlainObject(raw.sheet)) return { ok: false, reason: "sheet_missing" };
    for (const key of Object.keys(raw.sheet)) {
      if (!ALLOWED_SHEET_KEYS.has(key)) return { ok: false, reason: `sheet_unknown_field:${key}` };
    }
    if (typeof raw.sheet.src !== "string" || !isSafePetAssetPath(raw.sheet.src)) {
      return { ok: false, reason: "sheet_src" };
    }
    const frameWidth = readPositiveInt(raw.sheet.frameWidth, "sheet_frameWidth", PET_ASSET_LIMITS.maxSheetWidth);
    const frameHeight = readPositiveInt(raw.sheet.frameHeight, "sheet_frameHeight", PET_ASSET_LIMITS.maxSheetHeight);
    const columns = readPositiveInt(raw.sheet.columns, "sheet_columns", PET_ASSET_LIMITS.maxFrames);
    const rows = readPositiveInt(raw.sheet.rows, "sheet_rows", PET_ASSET_LIMITS.maxFrames);
    if (typeof frameWidth === "string") return { ok: false, reason: frameWidth };
    if (typeof frameHeight === "string") return { ok: false, reason: frameHeight };
    if (typeof columns === "string") return { ok: false, reason: columns };
    if (typeof rows === "string") return { ok: false, reason: rows };
    if (frameWidth * columns > PET_ASSET_LIMITS.maxSheetWidth) return { ok: false, reason: "sheet_width" };
    if (frameHeight * rows > PET_ASSET_LIMITS.maxSheetHeight) return { ok: false, reason: "sheet_height" };
    sheet = {
      src: raw.sheet.src,
      frameWidth,
      frameHeight,
      columns,
      rows,
    };
  }

  return {
    ok: true,
    manifest: {
      id: raw.id,
      name: raw.name,
      version: PET_MANIFEST_VERSION,
      renderMode: raw.renderMode,
      states,
      ...(sheet ? { sheet } : {}),
    },
  };
}

export type PackagedPetAssetIo = {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
  size: (filePath: string) => number;
  join: (...parts: string[]) => string;
};

/**
 * Build/package check: manifests parse, stay inside the pet folder, and any
 * spritesheet file exists under the same directory. CSS mode needs no bitmaps.
 */
export function validatePackagedPetAssets(
  petsRoot: string,
  io: PackagedPetAssetIo,
): { id: BuiltinPetId; renderMode: PetRenderMode }[] {
  const accepted: { id: BuiltinPetId; renderMode: PetRenderMode }[] = [];
  for (const id of BUILTIN_PET_IDS) {
    const manifestPath = io.join(petsRoot, id, "manifest.json");
    if (!io.exists(manifestPath)) {
      throw new Error(`missing pet manifest: ${id}`);
    }
    const bytes = io.size(manifestPath);
    if (bytes <= 0 || bytes > PET_ASSET_LIMITS.maxManifestBytes) {
      throw new Error(`pet manifest size: ${id}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(io.readFile(manifestPath));
    } catch {
      throw new Error(`pet manifest json: ${id}`);
    }
    const validated = validatePetManifestDocument(raw);
    if (!validated.ok) throw new Error(`pet manifest ${id}: ${validated.reason}`);
    if (validated.manifest.id !== id) throw new Error(`pet manifest id mismatch: ${id}`);
    if (validated.manifest.renderMode === "spritesheet") {
      const sheetPath = io.join(petsRoot, id, validated.manifest.sheet!.src);
      if (!io.exists(sheetPath)) throw new Error(`missing pet sheet: ${id}`);
      const sheetSize = io.size(sheetPath);
      if (sheetSize <= 0 || sheetSize > PET_ASSET_LIMITS.maxFileBytes) {
        throw new Error(`pet sheet size: ${id}`);
      }
    }
    accepted.push({ id, renderMode: validated.manifest.renderMode });
  }
  return accepted;
}

/**
 * Preview-only static view gate. Rejects observer/token/path-like payloads.
 * Does not read disk or contact the service.
 */
export function acceptStaticPetPreview(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (PREVIEW_FORBIDDEN_KEY.test(json)) return null;
  const absoluteUrls = json.match(/https?:\/\/[^"\s]+/gi) ?? [];
  for (const url of absoluteUrls) {
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?\/?$/i.test(url)) return null;
  }
  if (typeof raw.presentation !== "string") return null;
  if (!Array.isArray(raw.projects)) return null;
  if (Object.hasOwn(raw, "__proto__") || Object.hasOwn(raw, "constructor")) return null;
  return raw;
}
