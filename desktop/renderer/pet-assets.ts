/**
 * Built-in pet manifest v2 contract (U4).
 *
 * Validates package-relative role resources. Any failure falls back to the
 * current CSS snail — never blank, never arbitrary filesystem/URL loads.
 * Renderer must not fetch or concatenate untrusted paths.
 */

export const BUILTIN_PET_IDS = ["snail-default", "snail-classic", "snail-sprite"] as const;
export type BuiltinPetId = (typeof BUILTIN_PET_IDS)[number];

/**
 * Custom pet ids (folder drop-in) use the same safe pattern as settings
 * selectedPetId: lowercase/digit start, only [a-z0-9_-], max 64 chars.
 */
export const CUSTOM_PET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isCustomPetId(value: string): boolean {
  return CUSTOM_PET_ID_PATTERN.test(value);
}

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
  /** CSS fallback frame key. It remains required for spritesheet load failures. */
  frame: string;
  /** Reduced-motion CSS fallback frame key. */
  staticFrame: string;
  label: string;
  glyph: string;
  /** Zero-based cell offset in row-major spritesheet order. */
  firstFrame?: number;
  frameCount?: number;
  durationMs?: number;
  /** Zero-based offset inside this state's frame range. */
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
  /** Builtin id or a validated custom pet id (folder name). */
  id: string;
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
  "firstFrame",
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

function readNonNegativeInt(value: unknown, label: string, max: number): number | string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
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
  if (raw.firstFrame !== undefined) {
    const firstFrame = readNonNegativeInt(
      raw.firstFrame,
      `${state}_firstFrame`,
      PET_ASSET_LIMITS.maxFrames * PET_ASSET_LIMITS.maxFrames - 1,
    );
    if (typeof firstFrame === "string") return firstFrame;
    frame.firstFrame = firstFrame;
  }
  if (raw.frameCount !== undefined) {
    const count = readPositiveInt(raw.frameCount, `${state}_frameCount`, PET_ASSET_LIMITS.maxFrames);
    if (typeof count === "string") return count;
    frame.frameCount = count;
  }
  if (raw.durationMs !== undefined) {
    if (
      typeof raw.durationMs !== "number" ||
      !Number.isInteger(raw.durationMs) ||
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

export function validatePetManifestDocument(
  raw: unknown,
  expectedId?: string,
): PetManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) return { ok: false, reason: `unknown_field:${key}` };
  }
  const forbidden = collectForbiddenPetCapabilityKeys(raw);
  if (forbidden.length > 0) return { ok: false, reason: `capability:${forbidden[0]}` };
  // With an expected id the document is a custom pet and must match its folder
  // name exactly; without one it must be one of the builtin ids.
  if (expectedId !== undefined) {
    if (typeof raw.id !== "string" || raw.id !== expectedId || !isCustomPetId(raw.id)) {
      return { ok: false, reason: "id" };
    }
  } else if (typeof raw.id !== "string" || !isBuiltinPetId(raw.id)) {
    return { ok: false, reason: "id" };
  }
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
    for (const state of PET_REQUIRED_STATES) {
      const frame = states[state];
      if (
        frame.firstFrame !== undefined ||
        frame.frameCount !== undefined ||
        frame.durationMs !== undefined ||
        frame.staticFrameIndex !== undefined
      ) {
        return { ok: false, reason: `${state}_sprite_fields_not_allowed` };
      }
    }
  } else {
    if (!isPlainObject(raw.sheet)) return { ok: false, reason: "sheet_missing" };
    for (const key of Object.keys(raw.sheet)) {
      if (!ALLOWED_SHEET_KEYS.has(key)) return { ok: false, reason: `sheet_unknown_field:${key}` };
    }
    if (
      typeof raw.sheet.src !== "string" ||
      !isSafePetAssetPath(raw.sheet.src) ||
      !/\.(?:png|webp)$/i.test(raw.sheet.src)
    ) {
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
    const sheetCapacity = columns * rows;
    for (const state of PET_REQUIRED_STATES) {
      const frame = states[state];
      if (
        frame.firstFrame === undefined ||
        frame.frameCount === undefined ||
        frame.durationMs === undefined ||
        frame.staticFrameIndex === undefined
      ) {
        return { ok: false, reason: `${state}_sprite_timing_missing` };
      }
      if (frame.firstFrame + frame.frameCount > sheetCapacity) {
        return { ok: false, reason: `${state}_frame_range` };
      }
      // The renderer animates a state by stepping background-position with a
      // single two-keyframe `steps()` animation, which only stays on integer
      // cells when the frame run does not wrap to a second sheet row.
      if (
        Math.floor(frame.firstFrame / columns) !==
        Math.floor((frame.firstFrame + frame.frameCount - 1) / columns)
      ) {
        return { ok: false, reason: `${state}_frame_wraps_row` };
      }
    }
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

const CUSTOM_PET_SHEET_MAX_DATA_URL_CHARS = 360_000;

/**
 * Runtime custom-pet sheet gate: CSP-style data URLs only, bounded length, and
 * a base64-only payload. Main owns the real byte limits; this is defense in
 * depth for payloads crossing the preload bridge.
 */
export function isSafeCustomPetSheetDataUrl(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > CUSTOM_PET_SHEET_MAX_DATA_URL_CHARS) return false;
  if (!value.startsWith("data:image/png;base64,") && !value.startsWith("data:image/webp;base64,")) {
    return false;
  }
  const payload = value.slice(value.indexOf(",") + 1);
  return /^[A-Za-z0-9+/=]+$/.test(payload);
}

export type CustomPetAssetGate =
  | { ok: true; id: string; manifest: PetManifestV2; sheetDataUrl: string }
  | { ok: false; reason: string };

/**
 * Renderer-side gate for one custom pet asset from main. Custom pets are
 * spritesheet-only in the first slice; CSS manifests would render as the
 * built-in snail anatomy and are rejected to avoid false expectations.
 */
export function validateCustomPetAsset(raw: unknown, expectedId: string): CustomPetAssetGate {
  if (!isCustomPetId(expectedId)) return { ok: false, reason: "id" };
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
  const manifestRaw = (raw as Record<string, unknown>).manifest;
  const validated = validatePetManifestDocument(manifestRaw, expectedId);
  if (!validated.ok) return { ok: false, reason: validated.reason };
  if (validated.manifest.renderMode !== "spritesheet" || !validated.manifest.sheet) {
    return { ok: false, reason: "custom_render_mode" };
  }
  const sheetDataUrl = (raw as Record<string, unknown>).sheetDataUrl;
  if (typeof sheetDataUrl !== "string" || !isSafeCustomPetSheetDataUrl(sheetDataUrl)) {
    return { ok: false, reason: "sheet_data_url" };
  }
  return {
    ok: true,
    id: expectedId,
    manifest: validated.manifest,
    sheetDataUrl,
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
export type RendererPetCatalogEntry = {
  petKey: string;
  format: "snail" | "codex";
  source: "snail-custom" | "codex-home";
  id: string;
  name: string;
  description: string | null;
  cssToken: string;
  spriteVersion: 1 | 2 | null;
  capabilities: { look: boolean; directionalRun: boolean; waving: boolean };
  snailManifest: PetManifestV2 | null;
};

export type RendererPetCatalogEntryGate =
  | { ok: true; entry: RendererPetCatalogEntry }
  | { ok: false; reason: string };

const CATALOG_SOURCES = new Set(["snail-custom", "codex-home"]);
const PET_KEY_RE = /^(snail|codex):[a-z0-9][a-z0-9_-]{0,63}$/;
const CSS_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/**
 * Renderer re-validation of one catalog row. Paths and unknown capability
 * surfaces never survive this gate.
 */
export function validateRendererCatalogEntry(raw: unknown): RendererPetCatalogEntryGate {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
  const petKey = raw.petKey;
  const format = raw.format;
  const source = raw.source;
  const id = raw.id;
  const name = raw.name;
  const cssToken = raw.cssToken;
  if (typeof petKey !== "string" || !PET_KEY_RE.test(petKey)) return { ok: false, reason: "petKey" };
  if (format !== "snail" && format !== "codex") return { ok: false, reason: "format" };
  if (typeof source !== "string" || !CATALOG_SOURCES.has(source)) return { ok: false, reason: "source" };
  if (typeof id !== "string" || !isCustomPetId(id)) return { ok: false, reason: "id" };
  if (!petKey.startsWith(`${format}:`) || petKey.slice(format.length + 1) !== id) {
    return { ok: false, reason: "petKey" };
  }
  if (typeof name !== "string" || name.length === 0 || name.length > 64) {
    return { ok: false, reason: "name" };
  }
  if (/https?:\/\//i.test(name)) return { ok: false, reason: "unsafe_content" };
  let description: string | null = null;
  if (raw.description != null) {
    if (typeof raw.description !== "string" || raw.description.length > 200) {
      return { ok: false, reason: "description" };
    }
    if (/https?:\/\//i.test(raw.description)) return { ok: false, reason: "unsafe_content" };
    description = raw.description;
  }
  if (typeof cssToken !== "string" || !CSS_TOKEN_RE.test(cssToken)) {
    return { ok: false, reason: "cssToken" };
  }
  let spriteVersion: 1 | 2 | null = null;
  if (format === "codex") {
    if (raw.spriteVersion !== 1 && raw.spriteVersion !== 2) return { ok: false, reason: "sprite_version" };
    spriteVersion = raw.spriteVersion;
  } else if (raw.spriteVersion != null) {
    return { ok: false, reason: "sprite_version" };
  }
  const capabilitiesRaw = isPlainObject(raw.capabilities) ? raw.capabilities : {};
  const capabilities = {
    look: capabilitiesRaw.look === true,
    directionalRun: capabilitiesRaw.directionalRun === true,
    waving: capabilitiesRaw.waving === true,
  };
  let snailManifest: PetManifestV2 | null = null;
  if (format === "snail") {
    const validated = validatePetManifestDocument(raw.snailManifest, id);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    if (validated.manifest.renderMode !== "spritesheet" || !validated.manifest.sheet) {
      return { ok: false, reason: "custom_render_mode" };
    }
    snailManifest = validated.manifest;
  } else if (raw.snailManifest != null) {
    return { ok: false, reason: "snail_manifest_not_allowed" };
  }
  return {
    ok: true,
    entry: {
      petKey,
      format,
      source: source as RendererPetCatalogEntry["source"],
      id,
      name,
      description,
      cssToken,
      spriteVersion,
      capabilities,
      snailManifest,
    },
  };
}

export type RendererPetAssetPayload = {
  petKey: string;
  mime: "image/png" | "image/webp";
  bytes: Uint8Array;
  fingerprint: string;
  expectedWidth: number;
  expectedHeight: number;
};

export type RendererPetAssetGate =
  | { ok: true; asset: RendererPetAssetPayload }
  | { ok: false; reason: string };

const CUSTOM_PET_SHEET_MAX_BYTES = 6 * 1024 * 1024;

export function decodeBase64PetBytes(value: string, maxBytes = CUSTOM_PET_SHEET_MAX_BYTES): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > Math.ceil((maxBytes * 4) / 3) + 16) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) return null;
  try {
    if (typeof Buffer !== "undefined") {
      const buf = Buffer.from(value, "base64");
      if (buf.length === 0 || buf.length > maxBytes) return null;
      return Uint8Array.from(buf);
    }
    const binary = atob(value);
    if (binary.length === 0 || binary.length > maxBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function readBoundedPetAssetBytes(raw: unknown, maxBytes = CUSTOM_PET_SHEET_MAX_BYTES): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw.byteLength <= maxBytes ? raw : null;
  if (ArrayBuffer.isView(raw)) {
    if (raw.byteLength > maxBytes) return null;
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.length > maxBytes) return null;
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const value = raw[i];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
        return null;
      }
      bytes[i] = value;
    }
    return bytes;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const typed = raw as { type?: unknown; data?: unknown; length?: unknown };
    if (typed.type === "Buffer" && Array.isArray(typed.data)) {
      return readBoundedPetAssetBytes(typed.data, maxBytes);
    }
    if (typeof typed.length === "number" && typed.length > 0 && typed.length <= maxBytes) {
      try {
        const copy = Uint8Array.from(raw as ArrayLike<number>);
        return copy.length > 0 && copy.length <= maxBytes ? copy : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function validateRendererPetAsset(raw: unknown): RendererPetAssetGate {
  if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
  if (raw.ok === false) return { ok: false, reason: typeof raw.reason === "string" ? raw.reason : "read_failed" };
  const petKey = raw.petKey;
  if (typeof petKey !== "string" || !PET_KEY_RE.test(petKey)) return { ok: false, reason: "petKey" };
  const mime = raw.mime;
  if (mime !== "image/png" && mime !== "image/webp") return { ok: false, reason: "mime" };
  const bytes =
    typeof raw.bytesBase64 === "string"
      ? decodeBase64PetBytes(raw.bytesBase64)
      : readBoundedPetAssetBytes(raw.bytes);
  if (!bytes || bytes.length === 0) return { ok: false, reason: "bytes" };
  if (typeof raw.fingerprint !== "string" || raw.fingerprint.length === 0 || raw.fingerprint.length > 80) {
    return { ok: false, reason: "fingerprint" };
  }
  if (
    typeof raw.expectedWidth !== "number" ||
    typeof raw.expectedHeight !== "number" ||
    !Number.isInteger(raw.expectedWidth) ||
    !Number.isInteger(raw.expectedHeight) ||
    raw.expectedWidth <= 0 ||
    raw.expectedHeight <= 0 ||
    raw.expectedWidth > 4096 ||
    raw.expectedHeight > 4096
  ) {
    return { ok: false, reason: "dimensions" };
  }
  if (typeof raw.path === "string" || typeof raw.sheetPath === "string" || typeof raw.folderPath === "string") {
    return { ok: false, reason: "path" };
  }
  return {
    ok: true,
    asset: {
      petKey,
      mime,
      bytes,
      fingerprint: raw.fingerprint,
      expectedWidth: raw.expectedWidth,
      expectedHeight: raw.expectedHeight,
    },
  };
}

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
