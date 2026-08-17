"use strict";
(() => {
  // desktop/main/settings-store.ts
  var DESKTOP_PET_SCALE_FACTORS = {
    small: 0.85,
    medium: 1,
    large: 1.2
  };

  // desktop/main/window-manager.ts
  var PET_LAYOUT_BASE = {
    rootPad: 6,
    chromeHeight: 18,
    stackGap: 6,
    surfaceSize: 112,
    /** chrome 18 + gap 6 + surface 112 */
    stackWidth: 112,
    stackHeight: 136,
    /** Collapsed chrome + avatar + root padding/gap — must fit without clipping. */
    collapsedWidth: 140,
    collapsedHeight: 160,
    trayWidth: 360,
    trayHeight: 480
  };
  var PET_WINDOW_DEFAULTS = {
    width: PET_LAYOUT_BASE.trayWidth,
    height: PET_LAYOUT_BASE.trayHeight,
    petOnlyWidth: PET_LAYOUT_BASE.collapsedWidth,
    petOnlyHeight: PET_LAYOUT_BASE.collapsedHeight,
    trayWidth: PET_LAYOUT_BASE.trayWidth,
    trayHeight: PET_LAYOUT_BASE.trayHeight
  };
  var PET_LAYOUT = {
    rootPad: PET_LAYOUT_BASE.rootPad,
    stackWidth: PET_LAYOUT_BASE.stackWidth,
    stackHeight: PET_LAYOUT_BASE.stackHeight
  };
  function scaleLayoutPx(value, factor) {
    return Math.max(1, Math.round(value * factor));
  }
  function resolvePetLayoutSpec(scale = "medium") {
    const factor = DESKTOP_PET_SCALE_FACTORS[scale] ?? DESKTOP_PET_SCALE_FACTORS.medium;
    const rootPad = scaleLayoutPx(PET_LAYOUT_BASE.rootPad, factor);
    const chromeHeight = scaleLayoutPx(PET_LAYOUT_BASE.chromeHeight, factor);
    const stackGap = scaleLayoutPx(PET_LAYOUT_BASE.stackGap, factor);
    const surfaceSize = scaleLayoutPx(PET_LAYOUT_BASE.surfaceSize, factor);
    const stackWidth = surfaceSize;
    const stackHeight = chromeHeight + stackGap + surfaceSize;
    return {
      scale,
      factor,
      rootPad,
      chromeHeight,
      surfaceSize,
      stackWidth,
      stackHeight,
      clickTargetWidth: surfaceSize,
      clickTargetHeight: surfaceSize,
      collapsedWidth: Math.max(
        scaleLayoutPx(PET_LAYOUT_BASE.collapsedWidth, factor),
        rootPad * 2 + stackWidth
      ),
      collapsedHeight: Math.max(
        scaleLayoutPx(PET_LAYOUT_BASE.collapsedHeight, factor),
        rootPad * 2 + stackHeight
      ),
      trayWidth: Math.max(
        scaleLayoutPx(PET_LAYOUT_BASE.trayWidth, factor),
        rootPad * 2 + stackWidth
      ),
      trayHeight: Math.max(
        scaleLayoutPx(PET_LAYOUT_BASE.trayHeight, factor),
        rootPad * 2 + stackHeight
      )
    };
  }

  // desktop/renderer/pet-assets.ts
  var BUILTIN_PET_IDS = ["snail-default", "snail-classic", "snail-sprite"];
  var CUSTOM_PET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  function isCustomPetId(value) {
    return CUSTOM_PET_ID_PATTERN.test(value);
  }
  var PET_MANIFEST_VERSION = 2;
  var PET_REQUIRED_STATES = [
    "idle",
    "running",
    "retrying",
    "needs_input",
    "ready",
    "blocked",
    "disconnected",
    "service_not_running"
  ];
  var PET_ASSET_LIMITS = {
    maxManifestBytes: 16 * 1024,
    maxPathLength: 80,
    maxFileBytes: 256 * 1024,
    maxFrames: 16,
    minDurationMs: 50,
    maxDurationMs: 5e3,
    maxSheetWidth: 2048,
    maxSheetHeight: 2048
  };
  var ALLOWED_TOP_LEVEL = /* @__PURE__ */ new Set(["id", "name", "version", "renderMode", "states", "sheet"]);
  var ALLOWED_FRAME_KEYS = /* @__PURE__ */ new Set([
    "frame",
    "staticFrame",
    "label",
    "glyph",
    "firstFrame",
    "frameCount",
    "durationMs",
    "staticFrameIndex"
  ]);
  var ALLOWED_SHEET_KEYS = /* @__PURE__ */ new Set(["src", "frameWidth", "frameHeight", "columns", "rows"]);
  var FORBIDDEN_CAPABILITY_KEYS = /* @__PURE__ */ new Set([
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
    "accessKey"
  ]);
  var PREVIEW_FORBIDDEN_KEY = /"(token|observerToken|accessKey|password|pid|servicePid|cwd|firstMessage|prompt|command|output|child_process)"\s*:/;
  function isBuiltinPetId(value) {
    return BUILTIN_PET_IDS.includes(value);
  }
  function isSafePetAssetPath(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > PET_ASSET_LIMITS.maxPathLength) {
      return false;
    }
    if (value.includes("\\") || value.includes("..")) return false;
    if (value.startsWith("/") || value.startsWith("~")) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
    return /^[A-Za-z0-9._/-]+$/.test(value);
  }
  function collectForbiddenPetCapabilityKeys(raw, found = /* @__PURE__ */ new Set()) {
    if (!raw || typeof raw !== "object") return [...found];
    if (Array.isArray(raw)) {
      for (const item of raw) collectForbiddenPetCapabilityKeys(item, found);
      return [...found];
    }
    for (const [key, value] of Object.entries(raw)) {
      if (FORBIDDEN_CAPABILITY_KEYS.has(key)) found.add(key);
      collectForbiddenPetCapabilityKeys(value, found);
    }
    return [...found];
  }
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function readPositiveInt(value, label, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
      return `${label}_invalid`;
    }
    return value;
  }
  function readNonNegativeInt(value, label, max) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
      return `${label}_invalid`;
    }
    return value;
  }
  function validateFrame(state, raw) {
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
    const frame = {
      frame: raw.frame,
      staticFrame: raw.staticFrame,
      label: raw.label,
      glyph: raw.glyph
    };
    if (raw.firstFrame !== void 0) {
      const firstFrame = readNonNegativeInt(
        raw.firstFrame,
        `${state}_firstFrame`,
        PET_ASSET_LIMITS.maxFrames * PET_ASSET_LIMITS.maxFrames - 1
      );
      if (typeof firstFrame === "string") return firstFrame;
      frame.firstFrame = firstFrame;
    }
    if (raw.frameCount !== void 0) {
      const count = readPositiveInt(raw.frameCount, `${state}_frameCount`, PET_ASSET_LIMITS.maxFrames);
      if (typeof count === "string") return count;
      frame.frameCount = count;
    }
    if (raw.durationMs !== void 0) {
      if (typeof raw.durationMs !== "number" || !Number.isInteger(raw.durationMs) || raw.durationMs < PET_ASSET_LIMITS.minDurationMs || raw.durationMs > PET_ASSET_LIMITS.maxDurationMs) {
        return `${state}_duration`;
      }
      frame.durationMs = raw.durationMs;
    }
    if (raw.staticFrameIndex !== void 0) {
      if (typeof raw.staticFrameIndex !== "number" || !Number.isInteger(raw.staticFrameIndex) || raw.staticFrameIndex < 0) {
        return `${state}_static_index`;
      }
      const count = frame.frameCount ?? 1;
      if (raw.staticFrameIndex >= count) return `${state}_static_index`;
      frame.staticFrameIndex = raw.staticFrameIndex;
    }
    return frame;
  }
  function validatePetManifestDocument(raw, expectedId) {
    if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_TOP_LEVEL.has(key)) return { ok: false, reason: `unknown_field:${key}` };
    }
    const forbidden = collectForbiddenPetCapabilityKeys(raw);
    if (forbidden.length > 0) return { ok: false, reason: `capability:${forbidden[0]}` };
    if (expectedId !== void 0) {
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
    const states = {};
    for (const state of PET_REQUIRED_STATES) {
      if (!(state in raw.states)) return { ok: false, reason: `missing_state:${state}` };
      const frame = validateFrame(state, raw.states[state]);
      if (typeof frame === "string") return { ok: false, reason: frame };
      states[state] = frame;
    }
    for (const state of Object.keys(raw.states)) {
      if (!PET_REQUIRED_STATES.includes(state)) {
        return { ok: false, reason: `unknown_state:${state}` };
      }
    }
    let sheet;
    if (raw.renderMode === "css") {
      if (raw.sheet !== void 0) return { ok: false, reason: "css_sheet_not_allowed" };
      for (const state of PET_REQUIRED_STATES) {
        const frame = states[state];
        if (frame.firstFrame !== void 0 || frame.frameCount !== void 0 || frame.durationMs !== void 0 || frame.staticFrameIndex !== void 0) {
          return { ok: false, reason: `${state}_sprite_fields_not_allowed` };
        }
      }
    } else {
      if (!isPlainObject(raw.sheet)) return { ok: false, reason: "sheet_missing" };
      for (const key of Object.keys(raw.sheet)) {
        if (!ALLOWED_SHEET_KEYS.has(key)) return { ok: false, reason: `sheet_unknown_field:${key}` };
      }
      if (typeof raw.sheet.src !== "string" || !isSafePetAssetPath(raw.sheet.src) || !/\.(?:png|webp)$/i.test(raw.sheet.src)) {
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
        if (frame.firstFrame === void 0 || frame.frameCount === void 0 || frame.durationMs === void 0 || frame.staticFrameIndex === void 0) {
          return { ok: false, reason: `${state}_sprite_timing_missing` };
        }
        if (frame.firstFrame + frame.frameCount > sheetCapacity) {
          return { ok: false, reason: `${state}_frame_range` };
        }
        if (Math.floor(frame.firstFrame / columns) !== Math.floor((frame.firstFrame + frame.frameCount - 1) / columns)) {
          return { ok: false, reason: `${state}_frame_wraps_row` };
        }
      }
      sheet = {
        src: raw.sheet.src,
        frameWidth,
        frameHeight,
        columns,
        rows
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
        ...sheet ? { sheet } : {}
      }
    };
  }
  var CUSTOM_PET_SHEET_MAX_DATA_URL_CHARS = 36e4;
  function isSafeCustomPetSheetDataUrl(value) {
    if (typeof value !== "string" || value.length === 0) return false;
    if (value.length > CUSTOM_PET_SHEET_MAX_DATA_URL_CHARS) return false;
    if (!value.startsWith("data:image/png;base64,") && !value.startsWith("data:image/webp;base64,")) {
      return false;
    }
    const payload = value.slice(value.indexOf(",") + 1);
    return /^[A-Za-z0-9+/=]+$/.test(payload);
  }
  function validateCustomPetAsset(raw, expectedId) {
    if (!isCustomPetId(expectedId)) return { ok: false, reason: "id" };
    if (!isPlainObject(raw)) return { ok: false, reason: "not_object" };
    const manifestRaw = raw.manifest;
    const validated = validatePetManifestDocument(manifestRaw, expectedId);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    if (validated.manifest.renderMode !== "spritesheet" || !validated.manifest.sheet) {
      return { ok: false, reason: "custom_render_mode" };
    }
    const sheetDataUrl = raw.sheetDataUrl;
    if (typeof sheetDataUrl !== "string" || !isSafeCustomPetSheetDataUrl(sheetDataUrl)) {
      return { ok: false, reason: "sheet_data_url" };
    }
    return {
      ok: true,
      id: expectedId,
      manifest: validated.manifest,
      sheetDataUrl
    };
  }
  function acceptStaticPetPreview(raw) {
    if (!isPlainObject(raw)) return null;
    let json;
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

  // desktop/main/dnd-policy.ts
  var DND_SUPPRESSIBLE_PRESENTATIONS = /* @__PURE__ */ new Set([
    "needs_input",
    "blocked",
    "ready",
    "running",
    "retrying"
  ]);
  function isDndSuppressiblePresentation(presentation) {
    return DND_SUPPRESSIBLE_PRESENTATIONS.has(presentation);
  }

  // desktop/assets/pets/snail-classic/manifest.json
  var manifest_default = {
    id: "snail-classic",
    name: "Classic Snail",
    version: 2,
    renderMode: "css",
    states: {
      idle: { frame: "idle", staticFrame: "idle", label: "\u7A7A\u95F2", glyph: "\xB7" },
      running: {
        frame: "running",
        staticFrame: "running-static",
        label: "\u8FD0\u884C\u4E2D",
        glyph: "\u203A"
      },
      retrying: {
        frame: "retrying",
        staticFrame: "retrying-static",
        label: "\u91CD\u8BD5\u4E2D",
        glyph: "\u21BB"
      },
      needs_input: {
        frame: "needs-input",
        staticFrame: "needs-input",
        label: "\u5F85\u8F93\u5165",
        glyph: "?"
      },
      ready: { frame: "ready", staticFrame: "ready", label: "\u5DF2\u5B8C\u6210", glyph: "\u2713" },
      blocked: { frame: "blocked", staticFrame: "blocked", label: "\u53D7\u963B", glyph: "!" },
      disconnected: {
        frame: "disconnected",
        staticFrame: "disconnected",
        label: "\u672A\u8FDE\u63A5",
        glyph: "\u26A0"
      },
      service_not_running: {
        frame: "service-not-running",
        staticFrame: "service-not-running",
        label: "\u672A\u542F\u52A8",
        glyph: "\u23FB"
      }
    }
  };

  // desktop/assets/pets/snail-default/manifest.json
  var manifest_default2 = {
    id: "snail-default",
    name: "Snail",
    version: 2,
    renderMode: "css",
    states: {
      idle: { frame: "idle", staticFrame: "idle", label: "\u7A7A\u95F2", glyph: "\xB7" },
      running: {
        frame: "running",
        staticFrame: "running-static",
        label: "\u8FD0\u884C\u4E2D",
        glyph: "\u203A"
      },
      retrying: {
        frame: "retrying",
        staticFrame: "retrying-static",
        label: "\u91CD\u8BD5\u4E2D",
        glyph: "\u21BB"
      },
      needs_input: {
        frame: "needs-input",
        staticFrame: "needs-input",
        label: "\u5F85\u8F93\u5165",
        glyph: "?"
      },
      ready: { frame: "ready", staticFrame: "ready", label: "\u5DF2\u5B8C\u6210", glyph: "\u2713" },
      blocked: { frame: "blocked", staticFrame: "blocked", label: "\u53D7\u963B", glyph: "!" },
      disconnected: {
        frame: "disconnected",
        staticFrame: "disconnected",
        label: "\u672A\u8FDE\u63A5",
        glyph: "\u26A0"
      },
      service_not_running: {
        frame: "service-not-running",
        staticFrame: "service-not-running",
        label: "\u672A\u542F\u52A8",
        glyph: "\u23FB"
      }
    }
  };

  // desktop/assets/pets/snail-sprite/manifest.json
  var manifest_default3 = {
    id: "snail-sprite",
    name: "Pixel Snail",
    version: 2,
    renderMode: "spritesheet",
    states: {
      idle: {
        frame: "idle",
        staticFrame: "idle",
        label: "\u7A7A\u95F2",
        glyph: "\xB7",
        firstFrame: 0,
        frameCount: 3,
        durationMs: 360,
        staticFrameIndex: 1
      },
      running: {
        frame: "running",
        staticFrame: "running-static",
        label: "\u8FD0\u884C\u4E2D",
        glyph: "\u203A",
        firstFrame: 4,
        frameCount: 3,
        durationMs: 320,
        staticFrameIndex: 0
      },
      retrying: {
        frame: "retrying",
        staticFrame: "retrying-static",
        label: "\u91CD\u8BD5\u4E2D",
        glyph: "\u21BB",
        firstFrame: 8,
        frameCount: 2,
        durationMs: 220,
        staticFrameIndex: 0
      },
      needs_input: {
        frame: "needs-input",
        staticFrame: "needs-input",
        label: "\u5F85\u8F93\u5165",
        glyph: "?",
        firstFrame: 12,
        frameCount: 2,
        durationMs: 280,
        staticFrameIndex: 0
      },
      ready: {
        frame: "ready",
        staticFrame: "ready",
        label: "\u5DF2\u5B8C\u6210",
        glyph: "\u2713",
        firstFrame: 16,
        frameCount: 2,
        durationMs: 300,
        staticFrameIndex: 0
      },
      blocked: {
        frame: "blocked",
        staticFrame: "blocked",
        label: "\u53D7\u963B",
        glyph: "!",
        firstFrame: 20,
        frameCount: 2,
        durationMs: 320,
        staticFrameIndex: 0
      },
      disconnected: {
        frame: "disconnected",
        staticFrame: "disconnected",
        label: "\u672A\u8FDE\u63A5",
        glyph: "\u26A0",
        firstFrame: 24,
        frameCount: 1,
        durationMs: 1e3,
        staticFrameIndex: 0
      },
      service_not_running: {
        frame: "service-not-running",
        staticFrame: "service-not-running",
        label: "\u672A\u542F\u52A8",
        glyph: "\u23FB",
        firstFrame: 28,
        frameCount: 1,
        durationMs: 1e3,
        staticFrameIndex: 0
      }
    },
    sheet: {
      src: "snail.png",
      frameWidth: 108,
      frameHeight: 92,
      columns: 4,
      rows: 8
    }
  };

  // lib/task-observer-types.ts
  var TASK_OBSERVER_BUDGETS = {
    maxProjects: 50,
    maxActivities: 200,
    maxRecentTransitions: 20,
    maxChildrenPerActivity: 8,
    maxEncodedBytes: 256 * 1024,
    maxTitleChars: 120,
    maxProjectNameChars: 80,
    maxProjectKeyChars: 128,
    maxPhaseChars: 64,
    maxReasonCodeChars: 64,
    maxDeepLinkChars: 256,
    maxToolNameChars: 64,
    maxModelProviderChars: 64,
    maxModelIdChars: 160,
    maxDiagnostics: 20,
    maxDiagnosticCodeChars: 64,
    maxDiagnosticMessageChars: 160,
    /** Desktop-local acknowledged/notified transition LRU capacity (presentation only). */
    maxLocalAckTransitions: 500
  };
  var TASK_OBSERVER_PRESENTATION_PRIORITY = [
    "service_not_running",
    "disconnected",
    "needs_input",
    "blocked",
    "ready",
    "retrying",
    "running",
    "idle"
  ];

  // desktop/renderer/pet-state.ts
  var PET_STATE_ORDER = TASK_OBSERVER_PRESENTATION_PRIORITY;
  var DEFAULT_FRAMES = {
    service_not_running: {
      frame: "service-not-running",
      staticFrame: "service-not-running",
      // Short zh labels fit the collapsed avatar without clipping.
      label: "\u672A\u542F\u52A8",
      glyph: "\u23FB"
    },
    disconnected: {
      frame: "disconnected",
      staticFrame: "disconnected",
      label: "\u672A\u8FDE\u63A5",
      glyph: "\u26A0"
    },
    needs_input: {
      frame: "needs-input",
      staticFrame: "needs-input",
      label: "\u5F85\u8F93\u5165",
      glyph: "?"
    },
    blocked: {
      frame: "blocked",
      staticFrame: "blocked",
      label: "\u53D7\u963B",
      glyph: "!"
    },
    ready: {
      frame: "ready",
      staticFrame: "ready",
      label: "\u5DF2\u5B8C\u6210",
      glyph: "\u2713"
    },
    retrying: {
      frame: "retrying",
      staticFrame: "retrying-static",
      label: "\u91CD\u8BD5\u4E2D",
      glyph: "\u21BB"
    },
    running: {
      frame: "running",
      staticFrame: "running-static",
      label: "\u8FD0\u884C\u4E2D",
      glyph: "\u203A"
    },
    idle: {
      frame: "idle",
      staticFrame: "idle",
      label: "\u7A7A\u95F2",
      glyph: "\xB7"
    }
  };
  function buildDefaultPetManifest(id, name) {
    return {
      id,
      name,
      version: 2,
      renderMode: "css",
      states: { ...DEFAULT_FRAMES }
    };
  }
  var CSS_FALLBACK_MANIFESTS = [
    buildDefaultPetManifest("snail-default", "Snail"),
    buildDefaultPetManifest("snail-classic", "Classic Snail"),
    buildDefaultPetManifest("snail-sprite", "Pixel Snail")
  ];
  function resolvePetManifestDocument(fallback, raw) {
    const validated = validatePetManifestDocument(raw);
    if (!validated.ok || validated.manifest.id !== fallback.id) return fallback;
    return {
      id: validated.manifest.id,
      name: validated.manifest.name,
      version: validated.manifest.version,
      renderMode: validated.manifest.renderMode,
      states: validated.manifest.states,
      sheet: validated.manifest.sheet
    };
  }
  var BUILTIN_PET_MANIFESTS = [
    resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[0], manifest_default2),
    resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[1], manifest_default),
    resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[2], manifest_default3)
  ];
  var customPetManifests = /* @__PURE__ */ new Map();
  function clearCustomPetManifests() {
    customPetManifests.clear();
  }
  function registerCustomPetManifest(manifest) {
    customPetManifests.set(manifest.id, manifest);
  }
  function getCustomPetManifest(petId) {
    return customPetManifests.get(petId) ?? null;
  }
  function getPetManifest(petId) {
    const builtin = BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId);
    if (builtin) return builtin;
    return customPetManifests.get(petId) ?? BUILTIN_PET_MANIFESTS[0];
  }
  function resolvePetFrame(manifest, state, reducedMotion) {
    const entry = manifest.states[state] ?? DEFAULT_FRAMES[state] ?? DEFAULT_FRAMES.idle;
    const frame = reducedMotion ? entry.staticFrame : entry.frame;
    const animated = !reducedMotion && state !== "service_not_running" && state !== "disconnected";
    return {
      frame,
      label: entry.label,
      glyph: entry.glyph,
      animated
    };
  }
  function petStateLabel(state) {
    return DEFAULT_FRAMES[state]?.label ?? state;
  }
  function petStateGlyph(state) {
    return DEFAULT_FRAMES[state]?.glyph ?? "\xB7";
  }
  function petTerminalOutcome(outcome) {
    switch (outcome) {
      case "succeeded":
        return { label: "\u5DF2\u5B8C\u6210", glyph: "\u2713" };
      case "cancelled":
        return { label: "\u5DF2\u53D6\u6D88", glyph: "\xD7" };
      case "failed":
        return { label: "\u5931\u8D25", glyph: "!" };
      case "interrupted":
        return { label: "\u5DF2\u4E2D\u65AD", glyph: "!" };
      case "ambiguous":
        return { label: "\u5931\u8D25", glyph: "!" };
      default:
        return null;
    }
  }
  var SOURCE_LABELS = {
    agent: "Agent",
    snflow: "SnFlow",
    automation: "\u81EA\u52A8\u5316",
    quick_command: "\u5FEB\u6377\u547D\u4EE4"
  };
  function petSourceLabel(source) {
    return SOURCE_LABELS[source] ?? source;
  }
  function isPrimaryActivityActive(activity) {
    return activity.executionState === "queued" || activity.executionState === "running" || activity.executionState === "retrying";
  }
  function comparePrimaryActivity(a, b) {
    const rankDiff = PET_STATE_ORDER.indexOf(a.presentation) - PET_STATE_ORDER.indexOf(b.presentation);
    if (rankDiff !== 0) return rankDiff;
    const activeDiff = Number(isPrimaryActivityActive(b)) - Number(isPrimaryActivityActive(a));
    if (activeDiff !== 0) return activeDiff;
    const aUpdated = Date.parse(a.updatedAt ?? "") || 0;
    const bUpdated = Date.parse(b.updatedAt ?? "") || 0;
    if (aUpdated !== bUpdated) return bUpdated - aUpdated;
    return a.activityId.localeCompare(b.activityId);
  }
  function selectPrimaryActivity(groups) {
    let primary = null;
    for (const group of groups) {
      for (const activity of group.activities) {
        if (primary == null || comparePrimaryActivity(activity, primary) < 0) {
          primary = activity;
        }
      }
    }
    return primary;
  }
  function resolvePrimaryContextMeter(input) {
    if (!input.enabled || input.stale) return null;
    const activity = input.activity;
    if (activity == null || activity.source !== "agent") return null;
    const percent = activity.sessionResources?.context?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
    const bounded = Math.max(0, Math.min(100, percent));
    const displayPercent = Math.round(bounded);
    const label = `\u4E0A\u4E0B\u6587 ${displayPercent}%`;
    const title = `\u5F53\u524D\u4E3B\u4EFB\u52A1\u4E0A\u4E0B\u6587\u5DF2\u4F7F\u7528 ${displayPercent}%`;
    return {
      percent: bounded,
      displayPercent,
      label,
      title,
      ariaLabel: title,
      level: bounded >= 90 ? "high" : bounded >= 80 ? "warn" : "ok"
    };
  }
  var THINKING_TOOL_NAMES = /* @__PURE__ */ new Set(["read", "grep", "find", "ls"]);
  var EDITING_TOOL_NAMES = /* @__PURE__ */ new Set(["edit", "write"]);
  var COMMAND_TOOL_NAMES = /* @__PURE__ */ new Set(["bash"]);
  var RUNNING_CUE_VISUALS = {
    thinking: { glyph: "\u2026", label: "\u601D\u8003\u4E2D" },
    editing: { glyph: "\u270E", label: "\u7F16\u8F91\u4E2D" },
    command: { glyph: "\u203A_", label: "\u547D\u4EE4\u4E2D" },
    subagent_one: { glyph: "1", label: "\u534F\u4F5C\u4E2D" },
    subagent_many: { glyph: "2+", label: "\u534F\u4F5C\u4E2D" },
    generic: { glyph: "\u203A", label: "\u8FD0\u884C\u4E2D" }
  };
  function resolveRunningCue(activity) {
    if (activity == null || activity.source !== "agent" || activity.presentation !== "running" || activity.executionState !== "queued" && activity.executionState !== "running") {
      return "generic";
    }
    const progress = activity.progress;
    if (progress.kind !== "counters") {
      return activity.phase === "running" && progress.kind === "indeterminate" ? "thinking" : "generic";
    }
    const activeSubagents = Math.max(0, Math.floor(progress.activeSubagents ?? 0));
    const toolName = progress.currentToolName?.trim();
    if (activeSubagents > 0 && toolName) return "generic";
    if (activeSubagents >= 2) return "subagent_many";
    if (activeSubagents === 1) return "subagent_one";
    if (!toolName) return activity.phase === "running" ? "thinking" : "generic";
    if (THINKING_TOOL_NAMES.has(toolName)) return "thinking";
    if (EDITING_TOOL_NAMES.has(toolName)) return "editing";
    if (COMMAND_TOOL_NAMES.has(toolName)) return "command";
    return "generic";
  }
  function resolveRunningCueVisual(cue) {
    return RUNNING_CUE_VISUALS[cue];
  }
  var RUNNING_CUE_MIN_DWELL_MS = 900;
  var RUNNING_CUE_DEBOUNCE_MS = 250;
  function createInitialRunningCueState() {
    return {
      active: false,
      cue: "generic",
      shownAt: 0,
      candidateCue: null,
      candidateSince: null
    };
  }
  function reduceRunningCueState(state, signal, now) {
    if (signal.presentation !== "running") {
      return {
        active: false,
        cue: "generic",
        shownAt: now,
        candidateCue: null,
        candidateSince: null
      };
    }
    if (!state.active) {
      return {
        active: true,
        cue: signal.cue,
        shownAt: now,
        candidateCue: null,
        candidateSince: null
      };
    }
    if (signal.cue === state.cue) {
      return { ...state, candidateCue: null, candidateSince: null };
    }
    if (signal.cue !== state.candidateCue || state.candidateSince == null) {
      return { ...state, candidateCue: signal.cue, candidateSince: now };
    }
    const switchAt = Math.max(
      state.shownAt + RUNNING_CUE_MIN_DWELL_MS,
      state.candidateSince + RUNNING_CUE_DEBOUNCE_MS
    );
    if (now < switchAt) return state;
    return {
      active: true,
      cue: signal.cue,
      shownAt: now,
      candidateCue: null,
      candidateSince: null
    };
  }
  function runningCueNextUpdateAt(state) {
    if (!state.active || state.candidateCue == null || state.candidateSince == null) {
      return null;
    }
    return Math.max(
      state.shownAt + RUNNING_CUE_MIN_DWELL_MS,
      state.candidateSince + RUNNING_CUE_DEBOUNCE_MS
    );
  }
  function formatActivityProgress(progress, childCount = 0) {
    if (progress.kind === "ratio") {
      const current = Math.max(0, Math.floor(progress.current));
      const total = Math.max(0, Math.floor(progress.total));
      if (total <= 0) return null;
      const boundedCurrent = Math.min(current, total);
      return `${boundedCurrent}/${total} \xB7 ${Math.round(boundedCurrent / total * 100)}%`;
    }
    if (progress.kind === "counters") {
      const parts = [];
      if (progress.currentToolName) parts.push(progress.currentToolName);
      if (typeof progress.turnCount === "number") parts.push(`${progress.turnCount} \u56DE\u5408`);
      if (typeof progress.toolCount === "number") parts.push(`${progress.toolCount} \u5DE5\u5177`);
      const active = progress.activeSubagents ?? 0;
      const completed = progress.completedSubagents ?? 0;
      const subagents = Math.max(childCount, active + completed);
      if (subagents > 0) parts.push(`${subagents} Subagent`);
      return parts.length > 0 ? parts.join(" \xB7 ") : null;
    }
    return childCount > 0 ? `${childCount} Subagent` : null;
  }
  function formatActiveModel(model) {
    return model ? `${model.provider}/${model.modelId}` : null;
  }
  function formatCompactNumber(value) {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
    return String(Math.round(value));
  }
  function formatSessionResources(resources) {
    if (!resources) return null;
    const parts = [];
    if (resources.context) {
      const contextValue = resources.context.percent !== null ? `${resources.context.percent.toFixed(0)}%` : `?/${formatCompactNumber(resources.context.contextWindow)}`;
      parts.push(`\u4E0A\u4E0B\u6587 ${contextValue}`);
    }
    if (resources.performance) {
      const avgTps = resources.performance.avgTps >= 100 ? resources.performance.avgTps.toFixed(0) : resources.performance.avgTps.toFixed(1);
      parts.push(`${avgTps} t/s`);
    }
    if (resources.billing) {
      if (resources.billing.costUsd > 0) {
        parts.push(
          resources.billing.costUsd >= 0.01 ? `$${resources.billing.costUsd.toFixed(2)}` : "<$0.01"
        );
      } else if (resources.billing.totalTokens > 0) {
        parts.push(`${formatCompactNumber(resources.billing.totalTokens)} tokens`);
      }
    }
    return parts.length > 0 ? parts.join(" \xB7 ") : null;
  }
  function resolveActivityElapsedMs(activity, now) {
    const start = Date.parse(activity.startedAt ?? "");
    const end = activity.endedAt ? Date.parse(activity.endedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return activity.elapsedMs;
    return Math.max(0, Math.floor(end - start));
  }
  function formatElapsed(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "\u2014";
    const totalSec = Math.floor(ms / 1e3);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m ${sec}s`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h ${remMin}m`;
  }
  var PET_BUBBLE_TRANSIENT_MS = 4500;
  function createInitialPetBubbleState() {
    return {
      signalKey: null,
      transitionId: null,
      dismissedSignalKey: null,
      visible: false,
      mode: null,
      expiresAt: null
    };
  }
  function petBubbleSignalKey(signal) {
    const transitionId = signal.transitionId?.trim();
    if (transitionId) return `${signal.presentation}:transition:${transitionId}`;
    if (signal.presentation === "service_not_running" || signal.presentation === "disconnected") {
      return `${signal.presentation}:connection:${signal.instanceId ?? "none"}`;
    }
    return `${signal.presentation}:revision:${signal.instanceId ?? "none"}:${signal.revision ?? "none"}`;
  }
  function petBubbleMode(signal) {
    if (signal.presentation === "needs_input" || signal.presentation === "blocked" || signal.presentation === "service_not_running" || signal.presentation === "disconnected") {
      return "persistent";
    }
    if (signal.presentation === "ready") {
      return signal.unread ? "persistent" : null;
    }
    if (signal.presentation === "running" || signal.presentation === "retrying") {
      return "transient";
    }
    return null;
  }
  function reducePetBubbleState(state, event) {
    if (event.type === "viewed") {
      if (!event.transitionId || event.transitionId !== state.transitionId) return state;
      return {
        ...state,
        dismissedSignalKey: state.signalKey,
        visible: false,
        expiresAt: null
      };
    }
    if (event.type === "tick") {
      if (state.mode !== "transient" || state.expiresAt == null || event.now < state.expiresAt || !state.visible) {
        return state;
      }
      return { ...state, visible: false, expiresAt: null };
    }
    const signalKey = petBubbleSignalKey(event.signal);
    const mode = petBubbleMode(event.signal);
    const dndSilenced = event.signal.dndEnabled && isDndSuppressiblePresentation(event.signal.presentation);
    if (signalKey === state.signalKey) {
      if (mode == null) {
        return { ...state, visible: false, mode: null, expiresAt: null };
      }
      if (state.dismissedSignalKey === signalKey) {
        return { ...state, visible: false, mode, expiresAt: null };
      }
      if (dndSilenced) {
        return {
          ...state,
          dismissedSignalKey: state.dismissedSignalKey ?? signalKey,
          visible: false,
          mode,
          expiresAt: null
        };
      }
      if (mode === "transient" && state.expiresAt != null && event.now >= state.expiresAt) {
        return { ...state, visible: false, expiresAt: null };
      }
      return { ...state, mode };
    }
    const visible = !dndSilenced && (mode === "persistent" || mode === "transient" && !event.signal.reset);
    return {
      signalKey,
      transitionId: event.signal.transitionId,
      dismissedSignalKey: dndSilenced ? signalKey : null,
      visible,
      mode,
      expiresAt: visible && mode === "transient" ? event.now + PET_BUBBLE_TRANSIENT_MS : null
    };
  }
  var PET_CELEBRATE_COALESCE_MS = 1500;
  function createInitialPetCelebrateState() {
    return { lastTransitionId: null, lastCelebratedAt: null };
  }
  function shouldCelebrateCompletion(state, signal, now) {
    if (signal.reducedMotion) return { celebrate: false, state };
    if (signal.presentation !== "ready") return { celebrate: false, state };
    if (signal.reset) return { celebrate: false, state };
    const transitionId = signal.transitionId?.trim() || null;
    if (!transitionId) return { celebrate: false, state };
    if (transitionId === state.lastTransitionId) return { celebrate: false, state };
    if (state.lastCelebratedAt != null && now - state.lastCelebratedAt < PET_CELEBRATE_COALESCE_MS) {
      return { celebrate: false, state: { ...state, lastTransitionId: transitionId } };
    }
    return {
      celebrate: true,
      state: { lastTransitionId: transitionId, lastCelebratedAt: now }
    };
  }
  function resolvePetTransitionAction(from, to, reducedMotion) {
    if (reducedMotion) return null;
    if (from === "ready" && to === "idle") return "ready-to-idle-sink";
    if (from === "retrying" && to === "running") return "retrying-to-running-go";
    return null;
  }
  var PET_BLINK_DELAY_MIN_MS = 2600;
  var PET_BLINK_DELAY_RANGE_MS = 4600;
  var PET_ACT_DELAY_MIN_MS = 6500;
  var PET_ACT_DELAY_RANGE_MS = 7500;
  function nextBlinkDelayMs(random = Math.random) {
    return PET_BLINK_DELAY_MIN_MS + random() * PET_BLINK_DELAY_RANGE_MS;
  }
  function nextActDelayMs(random = Math.random) {
    return PET_ACT_DELAY_MIN_MS + random() * PET_ACT_DELAY_RANGE_MS;
  }
  function shouldRunIdleLife(input) {
    return input.animated && input.idle && !input.hidden && !input.reducedMotion && !input.pressed && !input.dragging;
  }
  var PET_SLEEPY_AFTER_MS = 45e3;
  var PET_SLEEPING_AFTER_MS = 12e4;
  var PET_IDLE_POINTER_WAKE_THROTTLE_MS = 800;
  function resolveIdleSleepStage(elapsedIdleMs) {
    if (!Number.isFinite(elapsedIdleMs) || elapsedIdleMs < 0) return "awake";
    if (elapsedIdleMs < PET_SLEEPY_AFTER_MS) return "awake";
    if (elapsedIdleMs < PET_SLEEPING_AFTER_MS) return "sleepy";
    return "sleeping";
  }
  function nextIdleSleepBoundaryMs(stage, elapsedIdleMs) {
    const invalid = !Number.isFinite(elapsedIdleMs) || elapsedIdleMs < 0;
    if (stage === "awake") {
      if (invalid) return PET_SLEEPY_AFTER_MS;
      return Math.max(0, PET_SLEEPY_AFTER_MS - elapsedIdleMs);
    }
    if (stage === "sleepy") {
      if (invalid) return PET_SLEEPING_AFTER_MS - PET_SLEEPY_AFTER_MS;
      return Math.max(0, PET_SLEEPING_AFTER_MS - elapsedIdleMs);
    }
    return null;
  }
  function shouldRunProgressiveSleep(input) {
    return input.idle && !input.hidden && !input.reducedMotion && !input.pressed && !input.dragging;
  }
  function createInitialIdleSleepState() {
    return { stage: "awake", idleSince: null, nextBoundaryAt: null };
  }
  function reduceIdleSleepState(state, signal, now) {
    const idle = signal.presentation === "idle";
    if (!shouldRunProgressiveSleep({
      idle,
      hidden: signal.hidden,
      reducedMotion: signal.reducedMotion,
      pressed: signal.pressed,
      dragging: signal.dragging
    })) {
      return createInitialIdleSleepState();
    }
    const idleSince = state.idleSince ?? now;
    const elapsed = Math.max(0, now - idleSince);
    const stage = resolveIdleSleepStage(elapsed);
    const boundaryDelay = nextIdleSleepBoundaryMs(stage, elapsed);
    return {
      stage,
      idleSince,
      nextBoundaryAt: boundaryDelay == null ? null : now + boundaryDelay
    };
  }
  function activityMatchesFilter(activity, filter) {
    switch (filter) {
      case "all":
        return true;
      case "attention":
        return activity.presentation === "needs_input" || activity.presentation === "blocked";
      case "running":
        return activity.executionState === "queued" || activity.executionState === "running" || activity.executionState === "retrying";
      case "completed":
        return activity.executionState === "settled";
      default: {
        const _exhaustive = filter;
        return _exhaustive;
      }
    }
  }
  function filterProjectGroups(groups, filter) {
    if (filter === "all") {
      return groups.map((group) => ({ ...group, activities: [...group.activities] }));
    }
    return groups.flatMap((group) => {
      const activities = group.activities.filter(
        (activity) => activityMatchesFilter(activity, filter)
      );
      return activities.length > 0 ? [{ ...group, activities }] : [];
    });
  }
  function countActivitiesByFilter(groups) {
    const counts = {
      all: 0,
      attention: 0,
      running: 0,
      completed: 0
    };
    for (const group of groups) {
      for (const activity of group.activities) {
        counts.all += 1;
        if (activityMatchesFilter(activity, "attention")) counts.attention += 1;
        if (activityMatchesFilter(activity, "running")) counts.running += 1;
        if (activityMatchesFilter(activity, "completed")) counts.completed += 1;
      }
    }
    return counts;
  }
  function resolveActivitySelection(activityIds, currentId) {
    if (activityIds.length === 0) return null;
    return currentId != null && activityIds.includes(currentId) ? currentId : activityIds[0];
  }
  function moveActivitySelection(activityIds, currentId, direction) {
    if (activityIds.length === 0) return null;
    if (currentId == null) {
      return direction === "next" ? activityIds[0] : activityIds[activityIds.length - 1];
    }
    const index = activityIds.indexOf(currentId);
    if (index === -1) {
      return direction === "next" ? activityIds[0] : activityIds[activityIds.length - 1];
    }
    if (direction === "next") {
      return activityIds[(index + 1) % activityIds.length];
    }
    return activityIds[(index - 1 + activityIds.length) % activityIds.length];
  }
  function connectionBannerText(input) {
    if (input.connectionStatus === "service-not-running") {
      return `\u8717\u725B\u6D3E\u670D\u52A1\u672A\u542F\u52A8 \u2014 \u590D\u5236 \`${input.startCommand}\` \u540E\u5728\u7EC8\u7AEF\u542F\u52A8\uFF0C\u7136\u540E\u91CD\u8BD5`;
    }
    if (input.connectionStatus === "incompatible") {
      if (input.reasonCode === "auth_required") {
        return "\u670D\u52A1\u5DF2\u5F00\u542F\u8BBF\u95EE\u5BC6\u94A5 \u2014 \u8BF7\u5728\u684C\u5BA0\u8BBE\u7F6E\u4E2D\u7C98\u8D34\u5BC6\u94A5\u540E\u8FDE\u63A5";
      }
      if (input.reasonCode === "auth_invalid") {
        return "\u8BBF\u95EE\u5BC6\u94A5\u65E0\u6548 \u2014 \u8BF7\u5728\u684C\u5BA0\u8BBE\u7F6E\u4E2D\u91CD\u65B0\u586B\u5199";
      }
      return `\u4E0D\u517C\u5BB9\u7684\u670D\u52A1${input.reasonCode ? ` (${input.reasonCode})` : ""} \u2014 \u8BF7\u68C0\u67E5\u7AEF\u53E3\u540E\u91CD\u8BD5`;
    }
    if (input.connectionStatus === "reconnecting" || input.connectionStatus === "probing") {
      return input.connectionStatus === "probing" ? "\u6B63\u5728\u8FDE\u63A5\u672C\u5730\u670D\u52A1\u2026" : "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE\u2026";
    }
    return null;
  }
  var PET_DOUBLE_CLICK_INTERVAL_MS = 320;
  var PET_QUAD_CLICK_WINDOW_MS = 900;
  var PET_POKE_ANIMATION_MS = 380;
  var PET_FLAIL_ANIMATION_MS = 750;
  function createInitialPetClickSequenceState() {
    return { clickTimes: [], pendingReaction: null, committedReaction: null };
  }
  function resolvePetReaction(clickCount, elapsedMs) {
    if (clickCount >= 4 && elapsedMs <= PET_QUAD_CLICK_WINDOW_MS) return "flail";
    if (clickCount === 2 && elapsedMs <= PET_DOUBLE_CLICK_INTERVAL_MS) return "poke";
    return null;
  }
  function shouldAllowPetReaction(presentation, reducedMotion) {
    if (reducedMotion) return false;
    return presentation === "idle";
  }
  function noClickOutcome(state) {
    return { state, singleClick: false, startReaction: null, cancelReaction: null };
  }
  function reducePetClickSequence(state, event) {
    if (event.type === "cancel") {
      return noClickOutcome(createInitialPetClickSequenceState());
    }
    if (event.type === "commit") {
      if (state.pendingReaction !== "poke") return noClickOutcome(state);
      return {
        state: {
          clickTimes: state.clickTimes,
          pendingReaction: null,
          committedReaction: "poke"
        },
        singleClick: false,
        startReaction: "poke",
        cancelReaction: null
      };
    }
    const last = state.clickTimes[state.clickTimes.length - 1];
    if (last !== void 0 && event.now - last > PET_DOUBLE_CLICK_INTERVAL_MS) {
      return {
        state: { clickTimes: [event.now], pendingReaction: null, committedReaction: null },
        singleClick: true,
        startReaction: null,
        cancelReaction: null
      };
    }
    if (state.committedReaction !== null) {
      return noClickOutcome(state);
    }
    const clickTimes = [...state.clickTimes, event.now];
    if (state.clickTimes.length === 0) {
      return {
        state: { clickTimes, pendingReaction: null, committedReaction: null },
        singleClick: true,
        startReaction: null,
        cancelReaction: null
      };
    }
    const reaction = resolvePetReaction(clickTimes.length, event.now - clickTimes[0]);
    if (reaction === "flail") {
      return {
        state: { clickTimes, pendingReaction: null, committedReaction: "flail" },
        singleClick: false,
        startReaction: "flail",
        cancelReaction: state.pendingReaction
      };
    }
    if (reaction === "poke") {
      return {
        state: { clickTimes, pendingReaction: "poke", committedReaction: null },
        singleClick: false,
        startReaction: null,
        cancelReaction: null
      };
    }
    return {
      state: { clickTimes, pendingReaction: state.pendingReaction, committedReaction: null },
      singleClick: false,
      startReaction: null,
      cancelReaction: null
    };
  }

  // desktop/renderer/pet-sheet.ts
  var PET_SPRITE_AVATAR_WIDTH = 108;
  var PET_SPRITE_AVATAR_HEIGHT = 92;
  function spriteCellPosition(sheet, frameIndex) {
    const col = frameIndex % sheet.columns;
    const row = Math.floor(frameIndex / sheet.columns);
    const scaleX = PET_SPRITE_AVATAR_WIDTH / sheet.frameWidth;
    const scaleY = PET_SPRITE_AVATAR_HEIGHT / sheet.frameHeight;
    return {
      x: -col * sheet.frameWidth * scaleX,
      y: -row * sheet.frameHeight * scaleY
    };
  }
  function spriteSheetBackgroundSize(sheet) {
    const scaleX = PET_SPRITE_AVATAR_WIDTH / sheet.frameWidth;
    const scaleY = PET_SPRITE_AVATAR_HEIGHT / sheet.frameHeight;
    return `${sheet.frameWidth * sheet.columns * scaleX}px ${sheet.frameHeight * sheet.rows * scaleY}px`;
  }
  function positionCss(cell) {
    return `${cell.x}px ${cell.y}px`;
  }
  function animationName(manifestId, state) {
    return `pet-sprite-${manifestId}-${state}`;
  }
  function resolveSpriteSheetStyle(manifest, state, imageUrl) {
    if (manifest.renderMode !== "spritesheet" || !manifest.sheet) return null;
    if (!imageUrl) return null;
    const entry = manifest.states[state];
    if (entry == null || entry.firstFrame === void 0 || entry.frameCount === void 0 || entry.durationMs === void 0 || entry.staticFrameIndex === void 0) {
      return null;
    }
    const sheet = manifest.sheet;
    const staticIndex = entry.firstFrame + entry.staticFrameIndex;
    const backgroundSize = spriteSheetBackgroundSize(sheet);
    const staticPosition = positionCss(spriteCellPosition(sheet, staticIndex));
    if (entry.frameCount <= 1) {
      return {
        backgroundSize,
        staticPosition,
        animatedPosition: null,
        animation: null,
        staticFrameIndex: entry.staticFrameIndex
      };
    }
    const name = animationName(manifest.id, state);
    const animatedPosition = positionCss(spriteCellPosition(sheet, entry.firstFrame));
    const totalMs = entry.durationMs * entry.frameCount;
    return {
      backgroundSize,
      staticPosition,
      animatedPosition,
      animation: `${name} ${totalMs}ms steps(${entry.frameCount}, end) infinite`,
      staticFrameIndex: entry.staticFrameIndex
    };
  }
  function frameSelectors(manifestId, state) {
    return {
      base: `.pet-avatar.pet-sprite-${manifestId}[data-state="${state}"]`,
      animated: `.pet-avatar.pet-sprite-${manifestId}[data-state="${state}"].is-animated`
    };
  }
  function buildSpriteSheetStyleText(manifest, imageUrl) {
    if (manifest.renderMode !== "spritesheet" || !manifest.sheet || !imageUrl) return "";
    const id = manifest.id;
    const sheet = manifest.sheet;
    const lines = [];
    lines.push(
      `.pet-avatar.pet-sprite-${id} {`,
      `  background-image: url("${imageUrl}");`,
      `  background-size: ${spriteSheetBackgroundSize(sheet)};`,
      "  background-repeat: no-repeat;",
      "}"
    );
    for (const state of Object.keys(manifest.states)) {
      const plan = resolveSpriteSheetStyle(manifest, state, imageUrl);
      if (!plan) continue;
      const entry = manifest.states[state];
      const { base, animated } = frameSelectors(id, state);
      lines.push(`${base} { background-position: ${plan.staticPosition}; }`);
      if (plan.animatedPosition && plan.animation) {
        lines.push(`${animated} { background-position: ${plan.animatedPosition}; animation: ${plan.animation}; }`);
        const toPosition = positionCss(
          spriteCellPosition(sheet, entry.firstFrame + entry.frameCount)
        );
        lines.push(
          `@keyframes ${animationName(id, state)} {`,
          `  from { background-position: ${plan.animatedPosition}; }`,
          `  to { background-position: ${toPosition}; }`,
          "}"
        );
      }
    }
    return lines.join("\n");
  }

  // desktop/assets/pets/snail-sprite/snail.png
  var snail_default = "data:image/png;base64,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";

  // desktop/renderer/pet-sheet-assets.ts
  var snailSpriteSheet = snail_default;
  var PET_SHEET_DATA_URLS = {
    "snail-sprite": snailSpriteSheet
  };
  var customPetSheetDataUrls = /* @__PURE__ */ new Map();
  function setCustomPetSheetDataUrl(petId, dataUrl) {
    customPetSheetDataUrls.set(petId, dataUrl);
  }
  function clearCustomPetSheetDataUrls() {
    customPetSheetDataUrls.clear();
  }
  function petSheetDataUrl(petId) {
    return PET_SHEET_DATA_URLS[petId] ?? customPetSheetDataUrls.get(petId) ?? null;
  }

  // desktop/renderer/pet-sound.ts
  var SOUND_MASTER_GAIN = 0.06;
  var SOUND_MIN_KIND_GAP_MS = 320;
  var SOUND_CUE_PATTERNS = {
    // Two quick rising blips — short attention poke.
    attention: [
      { freq: 880, startMs: 0, durationMs: 70 },
      { freq: 1174.66, startMs: 95, durationMs: 110 }
    ],
    // Two rising notes — small completion chime.
    completion: [
      { freq: 659.25, startMs: 0, durationMs: 80 },
      { freq: 880, startMs: 100, durationMs: 160 }
    ]
  };
  function defaultAudioContextFactory() {
    if (typeof window === "undefined") return null;
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (typeof Ctor !== "function") return null;
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
  var ATTACK_S = 8e-3;
  var RELEASE_S = 0.02;
  function playTone(ctx, tone) {
    const durationS = Math.max(0.01, tone.durationMs / 1e3);
    const startS = ctx.currentTime + tone.startMs / 1e3;
    const endS = startS + durationS;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(tone.freq, startS);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1e-4, startS);
    gain.gain.linearRampToValueAtTime(SOUND_MASTER_GAIN, startS + ATTACK_S);
    gain.gain.setValueAtTime(SOUND_MASTER_GAIN, Math.max(startS + ATTACK_S, endS - RELEASE_S));
    gain.gain.linearRampToValueAtTime(1e-4, endS);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startS);
    osc.stop(endS + 0.01);
  }
  var PetSoundPlayer = class {
    constructor(factory) {
      this.context = null;
      this.contextFailed = false;
      this.disposed = false;
      this.lastPlayedAt = {};
      this.factory = factory ?? defaultAudioContextFactory;
    }
    /** Play a cue; suppressed/no-op paths return false (still "handled"). */
    play(kind) {
      if (this.disposed) return false;
      try {
        const now = Date.now();
        if ((this.lastPlayedAt[kind] ?? Number.NEGATIVE_INFINITY) + SOUND_MIN_KIND_GAP_MS > now) {
          return false;
        }
        this.lastPlayedAt[kind] = now;
        if (!this.context && !this.contextFailed) {
          this.context = this.factory();
          if (!this.context) {
            this.contextFailed = true;
            return false;
          }
        }
        const ctx = this.context;
        if (!ctx) return false;
        if (ctx.state === "suspended") {
          try {
            const resuming = ctx.resume();
            if (resuming && typeof resuming.catch === "function") {
              resuming.catch(() => void 0);
            }
          } catch {
          }
        }
        const pattern = SOUND_CUE_PATTERNS[kind];
        for (const tone of pattern) {
          playTone(ctx, tone);
        }
        return true;
      } catch {
        return false;
      }
    }
    /** Release the AudioContext and stop accepting cues (renderer teardown). */
    destroy() {
      this.disposed = true;
      const ctx = this.context;
      this.context = null;
      if (!ctx) return;
      try {
        const closing = ctx.close();
        if (closing && typeof closing.catch === "function") {
          closing.catch(() => void 0);
        }
      } catch {
      }
    }
  };

  // desktop/renderer/pet-app.tsx
  function isPetVisualState(value) {
    return value === "service_not_running" || value === "disconnected" || value === "needs_input" || value === "blocked" || value === "ready" || value === "retrying" || value === "running" || value === "idle";
  }
  function renderPetApp(root = document) {
    const bridge = window.snailPet;
    const petRoot = root.getElementById("root");
    const petButton = root.getElementById("pet-button");
    const petAvatar = root.getElementById("pet-avatar");
    const petGlyph = root.getElementById("pet-glyph");
    const petLabel = root.getElementById("pet-label");
    const petBadge = root.getElementById("pet-badge");
    const petContextMeter = root.getElementById("pet-context-meter");
    const petContextMeterLabel = root.getElementById("pet-context-meter-label");
    const petCaption = root.getElementById("pet-caption");
    const petCaptionState = root.getElementById("pet-caption-state");
    const petCaptionTitle = root.getElementById("pet-caption-title");
    const tray = root.getElementById("activity-tray");
    const projectList = root.getElementById("project-list");
    const trayCounts = root.getElementById("tray-counts");
    const banner = root.getElementById("connection-banner");
    const authPanel = root.getElementById("auth-panel");
    const activityFilters = root.getElementById("activity-filters");
    const accessKeyInput = root.getElementById("access-key-input");
    const btnSaveKey = root.getElementById("btn-save-key");
    const btnClearKey = root.getElementById("btn-clear-key");
    const btnMarkAll = root.getElementById("btn-mark-all");
    const btnRetry = root.getElementById("btn-retry");
    const btnTrayMore = root.getElementById("btn-tray-more");
    const trayMoreMenu = root.getElementById("tray-more-menu");
    const btnCopy = root.getElementById("btn-copy-cmd");
    const btnHide = root.getElementById("btn-hide");
    const btnHideTray = root.getElementById("btn-hide-tray");
    const btnSettings = root.getElementById("btn-settings");
    const settingsPanel = root.getElementById("settings-panel");
    const petPicker = root.getElementById("pet-picker");
    const customPetOptions = root.getElementById("custom-pet-options");
    const customPetsPath = root.getElementById("custom-pets-path");
    const btnOpenCustomPets = root.getElementById("btn-open-custom-pets");
    const btnRescanCustomPets = root.getElementById("btn-rescan-custom-pets");
    const petScalePicker = root.getElementById("pet-scale-picker");
    const btnRestorePosition = root.getElementById("btn-restore-position");
    const prefAlwaysOnTop = root.getElementById("pref-always-on-top");
    const prefClickThrough = root.getElementById("pref-click-through");
    const prefLaunchAtLogin = root.getElementById("pref-launch-at-login");
    const prefCompletion = root.getElementById("pref-completion");
    const prefNeedsInput = root.getElementById("pref-needs-input");
    const prefBlocked = root.getElementById("pref-blocked");
    const prefShowContextMeter = root.getElementById("pref-show-context-meter");
    const prefDnd = root.getElementById("pref-dnd");
    const prefSoundMaster = root.getElementById("pref-sound-master");
    const prefSoundNeedsInput = root.getElementById("pref-sound-needs-input");
    const prefSoundCompletion = root.getElementById("pref-sound-completion");
    const soundDndNote = root.getElementById("sound-dnd-note");
    const staleFlag = root.getElementById("stale-flag");
    const hideToTray = () => {
      bridge?.hideToTray();
    };
    const DRAG_THRESHOLD_PX = 5;
    const TRANSITION_CLASS = {
      "ready-to-idle-sink": "transition-ready-sink",
      "retrying-to-running-go": "transition-retry-go"
    };
    const TRANSITION_ACTION_MS = 620;
    let current = null;
    let settingsOpen = false;
    let trayMoreOpen = false;
    let idleBlinkTimer = null;
    let idleActTimer = null;
    let idleActRemoveTimer = null;
    let petDropPopTimer = null;
    let transitionClass = null;
    let transitionTimer = null;
    let actActive = false;
    let documentHidden = typeof document !== "undefined" && document.hidden === true;
    let idleLifeKey = null;
    let activityFilter = "all";
    let selectedVisibleActivityId = null;
    const expandedActivityIds = /* @__PURE__ */ new Set();
    let bubbleState = createInitialPetBubbleState();
    let celebrateState = createInitialPetCelebrateState();
    let runningCueState = createInitialRunningCueState();
    let idleSleepState = createInitialIdleSleepState();
    let bubbleTimer = null;
    let runningCueTimer = null;
    let idleSleepTimer = null;
    let idleSleepTimerTargetMs = null;
    let lastIdlePointerWakeAt = 0;
    let sleepPresentation = "idle";
    let elapsedTimer = null;
    let clickSequenceState = createInitialPetClickSequenceState();
    let pokeCommitTimer = null;
    let reactionClass = null;
    let reactionTimer = null;
    let reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spriteStyleSheets = /* @__PURE__ */ new Map();
    const spriteVerified = /* @__PURE__ */ new Set();
    const spriteFailed = /* @__PURE__ */ new Set();
    const registeredCustomPetIds = /* @__PURE__ */ new Set();
    const soundPlayer = new PetSoundPlayer();
    bridge?.setReducedMotion(reducedMotion);
    if (typeof window.matchMedia === "function") {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onMotion = () => {
        reducedMotion = mq.matches;
        bridge?.setReducedMotion(reducedMotion);
        if (current) update(current);
      };
      mq.addEventListener?.("change", onMotion);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    function activityIds(projects) {
      const ids = [];
      for (const project of projects) {
        for (const activity of project.activities) ids.push(activity.activityId);
      }
      return ids;
    }
    function clearElapsedTimer() {
      if (elapsedTimer != null) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    }
    function visibleActivities() {
      if (!current) return [];
      return filterProjectGroups(current.projects, activityFilter).flatMap(
        (project) => project.activities
      );
    }
    function refreshElapsedLabels(now = Date.now()) {
      if (!projectList || !current) return;
      const activities = new Map(
        visibleActivities().map((activity) => [activity.activityId, activity])
      );
      for (const label of projectList.querySelectorAll(".row-elapsed[data-activity-id]")) {
        const activityId = label.dataset.activityId;
        const activity = activityId ? activities.get(activityId) : void 0;
        if (activity) {
          label.textContent = formatElapsed(resolveActivityElapsedMs(activity, now));
        }
      }
    }
    function syncElapsedTimer() {
      const shouldTick = current?.trayOpen === true && !settingsOpen && visibleActivities().some(
        (activity) => !activity.endedAt && Number.isFinite(Date.parse(activity.startedAt ?? ""))
      );
      if (!shouldTick) {
        clearElapsedTimer();
        return;
      }
      refreshElapsedLabels();
      if (elapsedTimer == null) {
        elapsedTimer = setInterval(refreshElapsedLabels, 1e3);
      }
    }
    function clearBubbleTimer() {
      if (bubbleTimer != null) {
        clearTimeout(bubbleTimer);
        bubbleTimer = null;
      }
    }
    function scheduleBubbleExpiry(now) {
      clearBubbleTimer();
      if (!bubbleState.visible || bubbleState.mode !== "transient" || bubbleState.expiresAt == null) {
        return;
      }
      bubbleTimer = setTimeout(() => {
        bubbleState = reducePetBubbleState(bubbleState, { type: "tick", now: Date.now() });
        if (!bubbleState.visible && petCaption) petCaption.hidden = true;
        bubbleTimer = null;
      }, Math.max(0, bubbleState.expiresAt - now));
    }
    function scheduleRunningCueUpdate(now) {
      if (runningCueTimer != null) {
        clearTimeout(runningCueTimer);
        runningCueTimer = null;
      }
      const updateAt = runningCueNextUpdateAt(runningCueState);
      if (updateAt == null) return;
      runningCueTimer = setTimeout(() => {
        runningCueTimer = null;
        if (current) update(current);
      }, Math.max(0, updateAt - now));
    }
    function clearIdleSleepTimer() {
      if (idleSleepTimer != null) {
        clearTimeout(idleSleepTimer);
        idleSleepTimer = null;
      }
      idleSleepTimerTargetMs = null;
    }
    function applySleepClassToAvatar(stage, stageChanged) {
      const avatar = petAvatar instanceof HTMLElement ? petAvatar : null;
      if (avatar) {
        avatar.classList.remove("pet-sleepy", "pet-sleeping");
        if (stage === "sleepy") avatar.classList.add("pet-sleepy");
        else if (stage === "sleeping") avatar.classList.add("pet-sleeping");
        if (stage === "awake") avatar.removeAttribute("data-idle-sleep");
        else avatar.setAttribute("data-idle-sleep", stage);
      }
      if (!stageChanged) return;
      if (stage === "awake") {
        scheduleIdleBlink(avatar);
        scheduleIdleActs(avatar);
      } else {
        if (idleBlinkTimer) {
          clearTimeout(idleBlinkTimer);
          idleBlinkTimer = null;
        }
        clearIdleAct(avatar);
      }
    }
    function syncIdleSleep(now) {
      const avatar = petAvatar instanceof HTMLElement ? petAvatar : null;
      const prevStage = idleSleepState.stage;
      const next = reduceIdleSleepState(
        idleSleepState,
        {
          presentation: sleepPresentation,
          hidden: documentHidden,
          reducedMotion,
          pressed: avatar?.classList.contains("is-pressed") ?? false,
          dragging: avatar?.classList.contains("is-dragging") ?? false
        },
        now
      );
      idleSleepState = next;
      applySleepClassToAvatar(next.stage, next.stage !== prevStage);
      if (next.nextBoundaryAt == null) {
        clearIdleSleepTimer();
        return;
      }
      if (idleSleepTimer != null && idleSleepTimerTargetMs === next.nextBoundaryAt) return;
      clearIdleSleepTimer();
      idleSleepTimerTargetMs = next.nextBoundaryAt;
      idleSleepTimer = setTimeout(() => {
        idleSleepTimer = null;
        idleSleepTimerTargetMs = null;
        if (current) syncIdleSleep(Date.now());
      }, Math.max(0, next.nextBoundaryAt - now));
    }
    function wakeIdleSleep() {
      idleSleepState = { ...idleSleepState, idleSince: null, nextBoundaryAt: null };
      syncIdleSleep(Date.now());
    }
    function maybeWakeOnHover() {
      if (idleSleepState.stage === "awake") return;
      const now = Date.now();
      if (now - lastIdlePointerWakeAt < PET_IDLE_POINTER_WAKE_THROTTLE_MS) return;
      lastIdlePointerWakeAt = now;
      wakeIdleSleep();
    }
    function dismissActivityBubble(activity) {
      if (!activity) return;
      bubbleState = reducePetBubbleState(bubbleState, {
        type: "viewed",
        transitionId: activity.lastTransitionId
      });
      if (!bubbleState.visible && petCaption) petCaption.hidden = true;
      clearBubbleTimer();
    }
    function findVisibleActivity(activityId) {
      if (!current || !activityId) return null;
      for (const project of filterProjectGroups(current.projects, activityFilter)) {
        const activity = project.activities.find((candidate) => candidate.activityId === activityId);
        if (activity) return activity;
      }
      return null;
    }
    function focusActivityRow(activityId) {
      if (!activityId || !projectList) return;
      for (const row of projectList.querySelectorAll("[data-activity-id]")) {
        if (row.dataset.activityId === activityId) {
          row.focus();
          return;
        }
      }
    }
    function selectVisibleActivity(activityId, focus) {
      selectedVisibleActivityId = activityId;
      bridge?.selectActivity(activityId);
      if (current) update(current);
      if (focus) focusActivityRow(activityId);
    }
    function actEnabled(avatar) {
      if (avatar?.classList.contains("pet-sprite")) return false;
      if (idleSleepState.stage !== "awake") return false;
      return shouldRunIdleLife({
        animated: !!avatar && avatar.classList.contains("is-animated"),
        idle: !!avatar && avatar.classList.contains("frame-idle"),
        hidden: documentHidden,
        reducedMotion,
        pressed: !!avatar && avatar.classList.contains("is-pressed"),
        dragging: !!avatar && avatar.classList.contains("is-dragging")
      });
    }
    function blinkEnabled(avatar) {
      if (avatar?.classList.contains("pet-sprite")) return false;
      if (idleSleepState.stage !== "awake") return false;
      return !!avatar && avatar.classList.contains("is-animated") && !documentHidden && !reducedMotion && !actActive && !avatar.classList.contains("is-pressed") && !avatar.classList.contains("is-dragging");
    }
    function scheduleIdleBlink(avatar) {
      if (idleBlinkTimer) {
        clearTimeout(idleBlinkTimer);
        idleBlinkTimer = null;
      }
      if (!blinkEnabled(avatar)) return;
      idleBlinkTimer = setTimeout(() => {
        idleBlinkTimer = null;
        if (!avatar?.isConnected || !blinkEnabled(avatar)) return;
        const eyes = avatar.querySelectorAll(".pet-eye");
        eyes.forEach((eye) => {
          if (eye instanceof HTMLElement) eye.style.animation = "none";
        });
        void avatar.offsetWidth;
        eyes.forEach((eye) => {
          if (eye instanceof HTMLElement) eye.style.animation = "";
        });
        scheduleIdleBlink(avatar);
      }, nextBlinkDelayMs());
    }
    const IDLE_ACTS = [
      { className: "idle-act-look", durationMs: 2400 },
      { className: "idle-act-sleepy", durationMs: 3400 },
      { className: "idle-act-stretch", durationMs: 1800 }
    ];
    function clearIdleAct(avatar) {
      if (idleActTimer) {
        clearTimeout(idleActTimer);
        idleActTimer = null;
      }
      if (idleActRemoveTimer) {
        clearTimeout(idleActRemoveTimer);
        idleActRemoveTimer = null;
      }
      actActive = false;
      avatar?.classList.remove("idle-act-look", "idle-act-sleepy", "idle-act-stretch");
    }
    function scheduleIdleActs(avatar) {
      clearIdleAct(avatar);
      if (!avatar || !actEnabled(avatar)) return;
      const queueNext = () => {
        idleActTimer = setTimeout(() => {
          idleActTimer = null;
          if (!avatar.isConnected || !actEnabled(avatar) || actActive) return;
          const act = IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)];
          actActive = true;
          if (idleBlinkTimer) {
            clearTimeout(idleBlinkTimer);
            idleBlinkTimer = null;
          }
          avatar.classList.add(act.className);
          idleActRemoveTimer = setTimeout(() => {
            idleActRemoveTimer = null;
            actActive = false;
            avatar.classList.remove(act.className);
            scheduleIdleBlink(avatar);
          }, act.durationMs + 80);
          queueNext();
        }, nextActDelayMs());
      };
      queueNext();
    }
    function onVisibilityChange() {
      documentHidden = document.hidden === true;
      syncIdleSleep(Date.now());
      if (documentHidden) {
        if (idleBlinkTimer) {
          clearTimeout(idleBlinkTimer);
          idleBlinkTimer = null;
        }
        clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
        cancelClickSequence();
      } else if (petAvatar instanceof HTMLElement) {
        scheduleIdleBlink(petAvatar);
        scheduleIdleActs(petAvatar);
      }
    }
    function launchConfetti() {
      const host = petButton instanceof HTMLElement ? petButton.querySelector(".pet-stage") : null;
      if (!(host instanceof HTMLElement)) return;
      const colors = ["#77dbc6", "#f3b95f", "#9bd875", "#8bb8ff", "#f47c83"];
      const burst = root.createElement("div");
      burst.className = "confetti-burst";
      burst.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 14; index += 1) {
        const piece = root.createElement("i");
        const angle = Math.random() * Math.PI * 2;
        const distance = 26 + Math.random() * 32;
        piece.style.setProperty("--cx", `${(Math.cos(angle) * distance).toFixed(1)}px`);
        piece.style.setProperty("--cy", `${(Math.sin(angle) * distance - 16).toFixed(1)}px`);
        piece.style.setProperty("--cr", `${Math.round(Math.random() * 260 - 130)}deg`);
        piece.style.setProperty("--cc", colors[index % colors.length]);
        piece.style.animationDelay = `${Math.round(Math.random() * 90)}ms`;
        burst.appendChild(piece);
      }
      host.appendChild(burst);
      setTimeout(() => burst.remove(), 1500);
    }
    function setTrayMoreOpen(open) {
      trayMoreOpen = open;
      if (trayMoreMenu) trayMoreMenu.hidden = !open;
      btnTrayMore?.setAttribute("aria-expanded", open ? "true" : "false");
    }
    function startTransition(className) {
      if (transitionTimer) {
        clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (transitionClass && petAvatar instanceof HTMLElement) {
        petAvatar.classList.remove(transitionClass);
      }
      transitionClass = className;
      transitionTimer = setTimeout(() => {
        transitionTimer = null;
        transitionClass = null;
        if (petAvatar instanceof HTMLElement) {
          petAvatar.classList.remove(className);
        }
      }, TRANSITION_ACTION_MS);
    }
    function clearTransition() {
      if (transitionTimer) {
        clearTimeout(transitionTimer);
        transitionTimer = null;
      }
      if (transitionClass && petAvatar instanceof HTMLElement) {
        petAvatar.classList.remove(transitionClass);
      }
      transitionClass = null;
    }
    function currentPresentation() {
      return current && isPetVisualState(current.presentation) ? current.presentation : "idle";
    }
    function clearReaction() {
      if (reactionTimer) {
        clearTimeout(reactionTimer);
        reactionTimer = null;
      }
      if (reactionClass && petAvatar instanceof HTMLElement) {
        petAvatar.classList.remove("reaction-poke", "reaction-flail");
      }
      reactionClass = null;
    }
    function playReaction(reaction) {
      clearReaction();
      reactionClass = reaction === "flail" ? "reaction-flail" : "reaction-poke";
      if (petAvatar instanceof HTMLElement) {
        petAvatar.classList.add(reactionClass);
      }
      reactionTimer = setTimeout(() => {
        reactionTimer = null;
        clearReaction();
      }, reaction === "flail" ? PET_FLAIL_ANIMATION_MS : PET_POKE_ANIMATION_MS);
    }
    function cancelClickSequence() {
      clickSequenceState = createInitialPetClickSequenceState();
      if (pokeCommitTimer) {
        clearTimeout(pokeCommitTimer);
        pokeCommitTimer = null;
      }
      clearReaction();
    }
    function schedulePokeCommit() {
      if (pokeCommitTimer) {
        clearTimeout(pokeCommitTimer);
        pokeCommitTimer = null;
      }
      if (clickSequenceState.pendingReaction !== "poke") return;
      pokeCommitTimer = setTimeout(() => {
        pokeCommitTimer = null;
        const outcome = reducePetClickSequence(clickSequenceState, {
          type: "commit",
          now: Date.now()
        });
        clickSequenceState = outcome.state;
        if (outcome.startReaction) playReaction(outcome.startReaction);
      }, PET_DOUBLE_CLICK_INTERVAL_MS);
    }
    function handlePetClick() {
      const motionReduced = reducedMotion || current?.reducedMotion === true;
      if (!shouldAllowPetReaction(currentPresentation(), motionReduced)) {
        cancelClickSequence();
        activatePet();
        return;
      }
      const outcome = reducePetClickSequence(clickSequenceState, {
        type: "click",
        now: Date.now()
      });
      clickSequenceState = outcome.state;
      if (outcome.cancelReaction) clearReaction();
      if (outcome.startReaction) playReaction(outcome.startReaction);
      if (outcome.singleClick) activatePet();
      schedulePokeCommit();
    }
    function ensureSpriteStylesheet(manifest) {
      if (spriteStyleSheets.has(manifest.id)) return;
      const text = buildSpriteSheetStyleText(manifest, petSheetDataUrl(manifest.id));
      if (!text) return;
      const style = root.createElement("style");
      style.setAttribute("data-pet-sprite", manifest.id);
      style.textContent = text;
      root.head?.appendChild(style);
      spriteStyleSheets.set(manifest.id, style);
    }
    function verifySpriteImage(petId, url) {
      if (spriteVerified.has(petId) || spriteFailed.has(petId)) return;
      const img = root.createElement("img");
      img.addEventListener("error", () => {
        spriteFailed.add(petId);
        if (current) update(current);
      });
      img.addEventListener("load", () => {
        if (typeof img.decode !== "function") {
          spriteVerified.add(petId);
          return;
        }
        void img.decode().then(
          () => spriteVerified.add(petId),
          () => {
            spriteFailed.add(petId);
            if (current) update(current);
          }
        );
      });
      img.src = url;
    }
    function clearCustomPetRegistrations() {
      for (const petId of registeredCustomPetIds) {
        const style = spriteStyleSheets.get(petId);
        style?.remove();
        spriteStyleSheets.delete(petId);
        spriteVerified.delete(petId);
        spriteFailed.delete(petId);
      }
      registeredCustomPetIds.clear();
      clearCustomPetManifests();
      clearCustomPetSheetDataUrls();
    }
    function registerCustomPetAsset(candidate) {
      if (!candidate || typeof candidate !== "object") return;
      const id = candidate.id;
      if (typeof id !== "string") return;
      const gate = validateCustomPetAsset(candidate, id);
      if (!gate.ok) return;
      const manifest = gate.manifest;
      if (manifest.renderMode !== "spritesheet" || !manifest.sheet) return;
      registerCustomPetManifest({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        renderMode: manifest.renderMode,
        states: manifest.states,
        sheet: manifest.sheet
      });
      setCustomPetSheetDataUrl(id, gate.sheetDataUrl);
      registeredCustomPetIds.add(id);
    }
    function renderCustomPetOptions() {
      if (!customPetOptions) return;
      customPetOptions.replaceChildren();
      for (const petId of registeredCustomPetIds) {
        const manifest = getCustomPetManifest(petId);
        if (!manifest) continue;
        const btn = root.createElement("button");
        btn.type = "button";
        btn.className = "pet-option";
        btn.setAttribute("role", "radio");
        btn.dataset.petId = petId;
        const preview = root.createElement("span");
        preview.className = "pet-option-preview preview-custom";
        preview.setAttribute("aria-hidden", "true");
        preview.textContent = "\u25C9";
        const sheetUrl = petSheetDataUrl(petId);
        if (sheetUrl && manifest.sheet) {
          preview.style.backgroundImage = `url("${sheetUrl}")`;
          preview.style.backgroundSize = `${manifest.sheet.columns * 100}% ${manifest.sheet.rows * 100}%`;
        }
        const label = root.createElement("span");
        label.textContent = manifest.name;
        btn.append(preview, label);
        customPetOptions.appendChild(btn);
      }
      const empty = registeredCustomPetIds.size === 0;
      customPetOptions.hidden = empty;
    }
    function syncCustomPetsPayload(payload) {
      clearCustomPetRegistrations();
      if (!payload || typeof payload !== "object") {
        renderCustomPetOptions();
        return;
      }
      const pets = payload.pets;
      if (Array.isArray(pets)) {
        for (const candidate of pets) registerCustomPetAsset(candidate);
      }
      const rootPath = payload.root;
      if (customPetsPath && typeof rootPath === "string" && rootPath.length <= 512) {
        customPetsPath.textContent = rootPath;
      }
      renderCustomPetOptions();
      if (current) update(current);
    }
    function update(view) {
      const previousView = current;
      current = view;
      const previewSettingsOpen = view.settingsOpen;
      if (!bridge && typeof previewSettingsOpen === "boolean") {
        settingsOpen = previewSettingsOpen;
      }
      const state = isPetVisualState(view.presentation) ? view.presentation : "idle";
      const primary = selectPrimaryActivity(view.projects);
      const updateNow = Date.now();
      sleepPresentation = state;
      if (!shouldAllowPetReaction(state, view.reducedMotion || reducedMotion)) {
        cancelClickSequence();
      }
      syncIdleSleep(updateNow);
      runningCueState = reduceRunningCueState(
        runningCueState,
        { presentation: state, cue: resolveRunningCue(primary) },
        updateNow
      );
      scheduleRunningCueUpdate(updateNow);
      const runningCue = runningCueState.active ? runningCueState.cue : "generic";
      const cueVisual = resolveRunningCueVisual(runningCue);
      const manifest = getPetManifest(view.selectedPetId);
      const motionReduced = view.reducedMotion || reducedMotion;
      const frame = resolvePetFrame(manifest, state, motionReduced);
      const displayGlyph = state === "running" ? cueVisual.glyph : frame.glyph || petStateGlyph(state);
      const displayLabel = state === "running" ? cueVisual.label : frame.label || petStateLabel(state);
      const spriteImageUrl = petSheetDataUrl(manifest.id);
      const spriteStyle = resolveSpriteSheetStyle(manifest, state, spriteImageUrl);
      const spriteActive = spriteStyle != null && !spriteFailed.has(manifest.id);
      if (spriteActive && spriteImageUrl) {
        ensureSpriteStylesheet(manifest);
        verifySpriteImage(manifest.id, spriteImageUrl);
      }
      if (petAvatar) {
        const transitionAction = resolvePetTransitionAction(
          previousView?.presentation ?? null,
          state,
          motionReduced
        );
        if (transitionAction) {
          startTransition(TRANSITION_CLASS[transitionAction]);
        } else if (motionReduced) {
          clearTransition();
        }
        const spriteClass = spriteActive ? ` pet-sprite pet-sprite-${manifest.id}` : "";
        const sleepClass = idleSleepState.stage !== "awake" ? ` pet-${idleSleepState.stage}` : "";
        petAvatar.className = `pet-avatar${spriteClass} frame-${frame.frame}${frame.animated ? " is-animated" : ""}${transitionClass ? ` ${transitionClass}` : ""}${sleepClass}${reactionClass ? ` ${reactionClass}` : ""}`;
        petAvatar.setAttribute("data-state", state);
        if (state === "running") {
          petAvatar.setAttribute("data-running-cue", runningCue);
        } else {
          petAvatar.removeAttribute("data-running-cue");
        }
        const lifeKey = `${frame.frame}:${frame.animated ? "1" : "0"}`;
        if (lifeKey !== idleLifeKey) {
          idleLifeKey = lifeKey;
          scheduleIdleBlink(petAvatar);
          scheduleIdleActs(petAvatar);
        }
      }
      if (petRoot) petRoot.setAttribute("data-pet", manifest.id);
      if (petGlyph) petGlyph.textContent = displayGlyph;
      if (petLabel) petLabel.textContent = displayLabel;
      const activityDrivesState = primary?.presentation === state;
      const signal = {
        presentation: state,
        transitionId: activityDrivesState ? primary.lastTransitionId : null,
        revision: view.revision,
        instanceId: view.instanceId,
        unread: activityDrivesState ? primary.unread : false,
        dndEnabled: view.dndEnabled === true,
        reset: view.reset || bridge != null && previousView == null || previousView?.instanceId != null && previousView.instanceId !== view.instanceId
      };
      const bubbleNow = updateNow;
      bubbleState = reducePetBubbleState(bubbleState, {
        type: "snapshot",
        signal,
        now: bubbleNow
      });
      const celebrateDecision = shouldCelebrateCompletion(
        celebrateState,
        {
          presentation: state,
          transitionId: signal.transitionId,
          reducedMotion: motionReduced,
          reset: signal.reset
        },
        bubbleNow
      );
      celebrateState = celebrateDecision.state;
      if (celebrateDecision.celebrate) {
        launchConfetti();
      }
      if (petCaption) {
        petCaption.hidden = !bubbleState.visible;
        petCaption.dataset.bubbleMode = bubbleState.mode ?? "hidden";
      }
      if (petCaptionState) petCaptionState.textContent = displayLabel;
      if (petCaptionTitle) {
        petCaptionTitle.textContent = primary?.title ?? connectionBannerText({
          connectionStatus: view.connectionStatus,
          canCopyStartCommand: view.canCopyStartCommand,
          startCommand: view.startCommand,
          reasonCode: view.connectionReasonCode
        }) ?? "";
      }
      scheduleBubbleExpiry(bubbleNow);
      if (petBadge) {
        const count = view.attentionCount + (view.aggregate?.ready ?? 0);
        if (count > 0) {
          petBadge.hidden = false;
          petBadge.textContent = String(count > 99 ? "99+" : count);
        } else {
          petBadge.hidden = true;
        }
      }
      const contextMeter = resolvePrimaryContextMeter({
        activity: primary,
        stale: view.stale,
        enabled: view.showContextMeter
      });
      if (petContextMeter) {
        if (contextMeter) {
          petContextMeter.hidden = false;
          petContextMeter.dataset.level = contextMeter.level;
          petContextMeter.style.setProperty("--context-percent", String(contextMeter.percent));
          petContextMeter.title = contextMeter.title;
          petContextMeter.setAttribute("aria-label", contextMeter.ariaLabel);
          petContextMeter.setAttribute("role", "img");
        } else {
          petContextMeter.hidden = true;
          petContextMeter.removeAttribute("data-level");
          petContextMeter.style.removeProperty("--context-percent");
          petContextMeter.removeAttribute("title");
          petContextMeter.removeAttribute("aria-label");
          petContextMeter.removeAttribute("role");
        }
      }
      if (petContextMeterLabel) {
        petContextMeterLabel.textContent = contextMeter?.label ?? "";
      }
      if (tray) tray.hidden = !view.trayOpen;
      if (!view.trayOpen) {
        settingsOpen = false;
        setTrayMoreOpen(false);
      }
      if (settingsPanel) settingsPanel.hidden = !settingsOpen;
      if (activityFilters) activityFilters.hidden = settingsOpen;
      if (projectList) projectList.hidden = settingsOpen;
      if (btnSettings) {
        btnSettings.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
      }
      if (petRoot) {
        petRoot.classList.toggle("is-collapsed", !view.trayOpen);
        petRoot.classList.toggle("is-expanded", view.trayOpen);
        const anchor = view.trayAnchor === "top-right" || view.trayAnchor === "bottom-left" || view.trayAnchor === "bottom-right" ? view.trayAnchor : "top-left";
        petRoot.setAttribute("data-tray-anchor", view.trayOpen ? anchor : "top-left");
        const scale = view.petScale === "small" || view.petScale === "large" ? view.petScale : "medium";
        const spec = resolvePetLayoutSpec(scale);
        petRoot.setAttribute("data-pet-scale", scale);
        petRoot.style.setProperty("--pet-scale", String(spec.factor));
        petRoot.style.setProperty("--pet-root-pad", `${spec.rootPad}px`);
        petRoot.style.setProperty("--pet-stack-gap", `${Math.max(1, spec.stackHeight - spec.chromeHeight - spec.surfaceSize)}px`);
        petRoot.style.setProperty("--pet-stack-width", `${spec.stackWidth}px`);
        petRoot.style.setProperty("--pet-chrome-height", `${spec.chromeHeight}px`);
        petRoot.style.setProperty("--pet-surface-size", `${spec.surfaceSize}px`);
      }
      if (petButton) {
        petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
        const attentionJump = canJumpToPrimary(view);
        const keyboardHint = "\u805A\u7126\u540E\uFF1AP \u8F7B\u6233 \xB7 Shift+P \u6446\u52A8";
        petButton.setAttribute(
          "aria-label",
          view.trayOpen ? `\u684C\u5BA0\uFF0C\u70B9\u51FB\u6536\u8D77\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8\u3002${keyboardHint}` : attentionJump ? `\u684C\u5BA0\uFF0C\u70B9\u51FB\u76F4\u8FBE\u5F85\u5904\u7406\u4EFB\u52A1\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8\u3002${keyboardHint}` : `\u684C\u5BA0\uFF0C\u70B9\u51FB\u5C55\u5F00\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8\u3002${keyboardHint}`
        );
        petButton.title = keyboardHint;
      }
      if (trayCounts) {
        const active = view.activeCount;
        const attention = view.attentionCount;
        trayCounts.textContent = `\u6D3B\u52A8 ${active} \xB7 \u5173\u6CE8 ${attention}`;
      }
      const filterCounts = countActivitiesByFilter(view.projects);
      activityFilters?.querySelectorAll("[data-activity-filter]").forEach((button) => {
        const filter = button.dataset.activityFilter;
        if (!filter || !(filter in filterCounts)) return;
        const selected = filter === activityFilter;
        button.setAttribute("aria-pressed", selected ? "true" : "false");
        const count = button.querySelector("[data-filter-count]");
        if (count) count.textContent = String(filterCounts[filter]);
      });
      const bannerText = connectionBannerText({
        connectionStatus: view.connectionStatus,
        canCopyStartCommand: view.canCopyStartCommand,
        startCommand: view.startCommand,
        reasonCode: view.connectionReasonCode
      });
      if (banner) {
        if (bannerText) {
          banner.hidden = false;
          banner.textContent = bannerText;
        } else {
          banner.hidden = true;
          banner.textContent = "";
        }
      }
      if (authPanel) {
        const showAuth = view.needsAccessKey === true || view.hasAccessKey === true;
        authPanel.hidden = !showAuth;
      }
      if (btnClearKey) {
        btnClearKey.hidden = view.hasAccessKey !== true;
      }
      if (btnCopy) {
        btnCopy.hidden = !view.canCopyStartCommand;
      }
      if (staleFlag) {
        staleFlag.hidden = !view.stale;
      }
      if (prefAlwaysOnTop) prefAlwaysOnTop.checked = view.alwaysOnTop;
      if (prefClickThrough) prefClickThrough.checked = view.clickThrough;
      if (prefLaunchAtLogin) prefLaunchAtLogin.checked = view.launchAtLogin;
      if (prefCompletion) prefCompletion.value = view.notification.completion;
      if (prefNeedsInput) prefNeedsInput.checked = view.notification.needsInput;
      if (prefBlocked) prefBlocked.checked = view.notification.blocked;
      if (prefShowContextMeter) prefShowContextMeter.checked = view.showContextMeter;
      if (prefDnd) prefDnd.checked = view.dndEnabled === true;
      if (prefSoundMaster) prefSoundMaster.checked = view.sound.masterEnabled === true;
      if (prefSoundNeedsInput) prefSoundNeedsInput.checked = view.sound.needsInput !== false;
      if (prefSoundCompletion) prefSoundCompletion.checked = view.sound.completion !== false;
      if (soundDndNote) {
        soundDndNote.hidden = !(view.dndEnabled === true && view.sound.masterEnabled === true);
      }
      petPicker?.querySelectorAll("[data-pet-id]").forEach((option) => {
        const selected = option.dataset.petId === view.selectedPetId;
        option.setAttribute("aria-checked", selected ? "true" : "false");
      });
      petScalePicker?.querySelectorAll("[data-pet-scale]").forEach((option) => {
        const selected = option.dataset.petScale === view.petScale;
        option.setAttribute("aria-checked", selected ? "true" : "false");
      });
      if (projectList) {
        const filteredProjects = filterProjectGroups(view.projects, activityFilter);
        const visibleIds = activityIds(filteredProjects);
        selectedVisibleActivityId = resolveActivitySelection(
          visibleIds,
          selectedVisibleActivityId ?? view.selectedActivityId
        );
        const liveIds = new Set(activityIds(view.projects));
        for (const activityId of expandedActivityIds) {
          if (!liveIds.has(activityId)) expandedActivityIds.delete(activityId);
        }
        projectList.replaceChildren();
        if (filteredProjects.length === 0) {
          const empty = root.createElement("div");
          empty.className = "empty-tray";
          const emptyPet = root.createElement("div");
          emptyPet.className = "empty-pet";
          emptyPet.setAttribute("aria-hidden", "true");
          const emptyAvatar = root.createElement("span");
          emptyAvatar.className = "pet-avatar frame-idle is-animated empty-pet-avatar";
          emptyAvatar.innerHTML = '<span class="pet-shadow"></span><span class="pet-tail"></span><span class="pet-body"></span><span class="pet-head"><span class="pet-antenna pet-antenna-left"></span><span class="pet-antenna pet-antenna-right"></span><span class="pet-eye pet-eye-left"></span><span class="pet-eye pet-eye-right"></span><span class="pet-mouth"></span></span><span class="pet-shell"><span class="pet-shell-spiral"></span></span>';
          emptyPet.appendChild(emptyAvatar);
          const emptyTitle = root.createElement("div");
          emptyTitle.className = "empty-tray-title";
          emptyTitle.textContent = view.projects.length > 0 ? "\u6B64\u7B5B\u9009\u4E0B\u6682\u65E0\u6D3B\u52A8" : view.connectionStatus === "connected" ? "\u76EE\u524D\u6CA1\u6709\u4EFB\u52A1\u6D3B\u52A8" : "\u5C1A\u672A\u8FDE\u63A5";
          const emptyHint = root.createElement("div");
          emptyHint.className = "empty-tray-hint";
          emptyHint.textContent = view.projects.length > 0 ? "\u6362\u4E2A\u7B5B\u9009\u770B\u770B\u5176\u4ED6\u72B6\u6001\u7684\u4EFB\u52A1" : view.connectionStatus === "connected" ? "\u4EFB\u52A1\u5F00\u59CB\u8FD0\u884C\u540E\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC" : "\u8FDE\u63A5\u672C\u5730\u8717\u725B\u6D3E\u670D\u52A1\u540E\u5373\u53EF\u89C2\u5BDF\u4EFB\u52A1";
          empty.append(emptyPet, emptyTitle, emptyHint);
          projectList.appendChild(empty);
        } else {
          for (const project of filteredProjects) {
            const group = root.createElement("div");
            group.className = "project-group";
            group.setAttribute("role", "group");
            const name = root.createElement("div");
            name.className = "project-name";
            name.textContent = project.displayName;
            group.appendChild(name);
            for (const activity of project.activities) {
              group.appendChild(renderRow(activity, selectedVisibleActivityId));
            }
            projectList.appendChild(group);
          }
        }
      }
      syncElapsedTimer();
    }
    function childStatusText(child) {
      if (child.attention === "needs_input") return "\u5F85\u8F93\u5165";
      if (child.attention === "blocked") return "\u53D7\u963B";
      if (child.executionState === "retrying") return "\u91CD\u8BD5\u4E2D";
      if (child.executionState === "queued") return "\u6392\u961F\u4E2D";
      if (child.executionState === "running") return "\u8FD0\u884C\u4E2D";
      if (child.outcome === "succeeded") return "\u5DF2\u5B8C\u6210";
      if (child.outcome === "cancelled") return "\u5DF2\u53D6\u6D88";
      if (child.outcome === "failed" || child.outcome === "interrupted" || child.outcome === "ambiguous") {
        return "\u5931\u8D25";
      }
      return "\u5DF2\u7ED3\u675F";
    }
    function childUpdatedText(updatedAt) {
      if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;
      return `\u66F4\u65B0 ${updatedAt.slice(0, 16).replace("T", " ")}`;
    }
    function renderRow(activity, selectedId) {
      const row = document.createElement("div");
      const terminalOutcome = activity.executionState === "settled" ? petTerminalOutcome(activity.outcome) : null;
      const statusLabel = terminalOutcome?.label ?? petStateLabel(activity.presentation);
      const statusGlyph = terminalOutcome?.glyph ?? petStateGlyph(activity.presentation);
      row.className = `activity-row${activity.unread ? " is-unread" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");
      row.setAttribute("aria-label", `${activity.title}\uFF0C${statusLabel}`);
      row.tabIndex = activity.activityId === selectedId ? 0 : -1;
      row.dataset.activityId = activity.activityId;
      row.dataset.presentation = activity.presentation;
      if (terminalOutcome) row.dataset.outcome = activity.outcome ?? "";
      const summary = document.createElement("div");
      summary.className = "activity-row-summary";
      const glyph = document.createElement("span");
      glyph.className = "row-glyph";
      glyph.textContent = statusGlyph;
      glyph.title = statusLabel;
      const main = document.createElement("span");
      main.className = "row-main";
      const heading = document.createElement("span");
      heading.className = "row-heading";
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = activity.title;
      const source = document.createElement("span");
      source.className = "row-source";
      source.textContent = petSourceLabel(activity.source);
      heading.append(title, source);
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = [statusLabel, activity.phase].filter(Boolean).join(" \xB7 ");
      main.append(heading, meta);
      const progressLabel = formatActivityProgress(activity.progress, activity.children.length);
      if (progressLabel) {
        const progress = document.createElement("span");
        progress.className = "row-progress";
        progress.textContent = progressLabel;
        main.appendChild(progress);
      }
      const resourceLabel = [
        formatActiveModel(activity.executionState === "settled" ? void 0 : activity.activeModel),
        formatSessionResources(activity.sessionResources)
      ].filter((part) => Boolean(part)).join(" \xB7 ");
      if (resourceLabel) {
        const resources = document.createElement("span");
        resources.className = "row-resources";
        resources.textContent = resourceLabel;
        resources.title = "\u5F53\u524D\u6A21\u578B\u4E0E\u4F1A\u8BDD\u8D44\u6E90\uFF1A\u4E0A\u4E0B\u6587\u3001\u4F1A\u8BDD\u52A0\u6743\u5E73\u5747 TPS\u3001\u7D2F\u8BA1\u8D39\u7528\u6216 Token";
        main.appendChild(resources);
      }
      if (activity.progress.kind === "ratio" && activity.progress.total > 0) {
        const track = document.createElement("span");
        track.className = "row-progress-track";
        const bar = document.createElement("span");
        bar.className = "row-progress-bar";
        const ratio = Math.max(0, Math.min(1, activity.progress.current / activity.progress.total));
        bar.style.width = `${Math.round(ratio * 100)}%`;
        track.appendChild(bar);
        main.appendChild(track);
      }
      const elapsed = document.createElement("span");
      elapsed.className = "row-elapsed";
      elapsed.dataset.activityId = activity.activityId;
      elapsed.textContent = formatElapsed(resolveActivityElapsedMs(activity, Date.now()));
      summary.append(glyph, main, elapsed);
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "row-action row-open-action";
      openButton.textContent = "\u6253\u5F00\u4EFB\u52A1";
      openButton.addEventListener("click", () => {
        dismissActivityBubble(activity);
        selectedVisibleActivityId = activity.activityId;
        bridge?.selectActivity(activity.activityId);
        void bridge?.openActivity(activity.activityId);
      });
      actions.appendChild(openButton);
      const readButton = document.createElement("button");
      readButton.type = "button";
      readButton.className = "row-action";
      readButton.textContent = activity.unread ? "\u6807\u8BB0\u5DF2\u8BFB" : "\u5DF2\u8BFB";
      readButton.disabled = !activity.unread;
      readButton.addEventListener("click", () => {
        dismissActivityBubble(activity);
        bridge?.markRead(activity.activityId);
      });
      actions.appendChild(readButton);
      if (activity.children.length > 0) {
        const expanded = expandedActivityIds.has(activity.activityId);
        const expandButton = document.createElement("button");
        expandButton.type = "button";
        expandButton.className = "row-action row-child-toggle";
        expandButton.textContent = `${expanded ? "\u6536\u8D77" : "\u5C55\u5F00"} Subagent ${activity.children.length}`;
        expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
        expandButton.addEventListener("click", () => {
          if (expandedActivityIds.has(activity.activityId)) {
            expandedActivityIds.delete(activity.activityId);
          } else {
            expandedActivityIds.add(activity.activityId);
          }
          if (current) update(current);
          focusActivityRow(activity.activityId);
        });
        actions.appendChild(expandButton);
      }
      row.append(summary, actions);
      if (activity.children.length > 0 && expandedActivityIds.has(activity.activityId)) {
        const children = document.createElement("div");
        children.className = "row-children";
        children.setAttribute("role", "list");
        children.setAttribute("aria-label", "Subagent \u5B89\u5168\u6458\u8981");
        for (const child of activity.children) {
          const childRow = document.createElement("div");
          childRow.className = "row-child";
          childRow.setAttribute("role", "listitem");
          const childTitle = document.createElement("span");
          childTitle.className = "row-child-title";
          childTitle.textContent = child.title;
          const childMeta = document.createElement("span");
          childMeta.className = "row-child-meta";
          childMeta.textContent = [
            childStatusText(child),
            child.phase,
            childUpdatedText(child.updatedAt)
          ].filter(Boolean).join(" \xB7 ");
          childRow.append(childTitle, childMeta);
          children.appendChild(childRow);
        }
        row.appendChild(children);
      }
      row.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest("button")) return;
        selectVisibleActivity(activity.activityId, false);
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          dismissActivityBubble(activity);
          void bridge?.openActivity(activity.activityId);
        }
        if ((event.key === "m" || event.key === "M") && activity.unread) {
          event.preventDefault();
          event.stopPropagation();
          dismissActivityBubble(activity);
          bridge?.markRead(activity.activityId);
        }
      });
      return row;
    }
    let petPointerId = null;
    let petDragOriginX = 0;
    let petDragOriginY = 0;
    let petLastScreenX = 0;
    let petLastScreenY = 0;
    let petDragging = false;
    const resetEyeFollow = () => {
      if (!(petAvatar instanceof HTMLElement)) return;
      petAvatar.style.removeProperty("--eye-shift-x");
      petAvatar.style.removeProperty("--eye-shift-y");
      petAvatar.style.removeProperty("--head-tilt");
    };
    const applyEyeFollow = (event) => {
      if (!(petAvatar instanceof HTMLElement) || !(petButton instanceof HTMLElement)) return;
      if (!petAvatar.classList.contains("is-animated")) return;
      if (petAvatar.classList.contains("pet-sprite")) return;
      const stage = petButton.querySelector(".pet-stage");
      const rect = stage?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const headX = rect.left + rect.width * 0.78;
      const headY = rect.top + rect.height * 0.68;
      const dx = event.clientX - headX;
      const dy = event.clientY - headY;
      const clamp = (value, max) => Math.max(-max, Math.min(max, value));
      petAvatar.style.setProperty("--eye-shift-x", `${clamp(dx / 24, 1.7).toFixed(2)}px`);
      petAvatar.style.setProperty("--eye-shift-y", `${clamp(dy / 24, 1.3).toFixed(2)}px`);
      petAvatar.style.setProperty("--head-tilt", `${clamp(dx / 40, 4).toFixed(2)}deg`);
    };
    function canJumpToPrimary(view) {
      if (!view || view.trayOpen) return false;
      const primary = selectPrimaryActivity(view.projects);
      return (view.presentation === "needs_input" || view.presentation === "blocked") && (primary?.presentation === "needs_input" || primary?.presentation === "blocked");
    }
    function activatePet() {
      wakeIdleSleep();
      if (!current) {
        bridge?.toggleTray();
        return;
      }
      const primary = selectPrimaryActivity(current.projects);
      if (canJumpToPrimary(current) && primary) {
        dismissActivityBubble(primary);
        selectedVisibleActivityId = primary.activityId;
        bridge?.selectActivity(primary.activityId);
        void bridge?.openActivity(primary.activityId);
        return;
      }
      bridge?.toggleTray();
    }
    const endPetPointer = (target, pointerId, playDrop = true) => {
      if (petPointerId !== pointerId) return;
      const wasDragging = petDragging;
      petPointerId = null;
      petDragging = false;
      try {
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
      }
      target.classList.remove("is-dragging");
      petAvatar?.classList.remove("is-pressed", "is-dragging");
      if (!wasDragging) {
        handlePetClick();
        return;
      }
      if (playDrop && petAvatar instanceof HTMLElement && !reducedMotion && petAvatar.classList.contains("is-animated")) {
        petAvatar.classList.add("pop-out");
        if (petDropPopTimer) clearTimeout(petDropPopTimer);
        petDropPopTimer = setTimeout(() => {
          petAvatar.classList.remove("pop-out");
          petDropPopTimer = null;
        }, 460);
      }
    };
    petButton?.addEventListener("pointerdown", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (event.button !== 0) return;
      wakeIdleSleep();
      petPointerId = event.pointerId;
      petDragOriginX = event.screenX;
      petDragOriginY = event.screenY;
      petLastScreenX = event.screenX;
      petLastScreenY = event.screenY;
      petDragging = false;
      resetEyeFollow();
      petAvatar?.classList.remove("idle-act-look", "idle-act-sleepy", "idle-act-stretch");
      petAvatar?.classList.add("is-pressed");
      try {
        petButton.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    petButton?.addEventListener("pointermove", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId === null) {
        applyEyeFollow(event);
        maybeWakeOnHover();
        return;
      }
      if (petPointerId !== event.pointerId) return;
      const totalDx = event.screenX - petDragOriginX;
      const totalDy = event.screenY - petDragOriginY;
      if (!petDragging && (Math.abs(totalDx) >= DRAG_THRESHOLD_PX || Math.abs(totalDy) >= DRAG_THRESHOLD_PX)) {
        petDragging = true;
        cancelClickSequence();
        petButton.classList.add("is-dragging");
        petAvatar?.classList.remove("is-pressed");
        petAvatar?.classList.add("is-dragging");
      }
      if (!petDragging) return;
      const dx = event.screenX - petLastScreenX;
      const dy = event.screenY - petLastScreenY;
      petLastScreenX = event.screenX;
      petLastScreenY = event.screenY;
      if (dx !== 0 || dy !== 0) {
        bridge?.moveBy(dx, dy);
      }
    });
    petButton?.addEventListener("pointerup", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      endPetPointer(petButton, event.pointerId, true);
    });
    petButton?.addEventListener("pointercancel", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId === event.pointerId) {
        cancelClickSequence();
        petDragging = true;
        endPetPointer(petButton, event.pointerId, false);
      }
    });
    petButton?.addEventListener("lostpointercapture", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId !== event.pointerId) return;
      petPointerId = null;
      petDragging = false;
      petButton.classList.remove("is-dragging");
      petAvatar?.classList.remove("is-pressed", "is-dragging");
      cancelClickSequence();
    });
    petButton?.addEventListener("pointerleave", () => {
      if (petPointerId === null) resetEyeFollow();
    });
    petButton?.addEventListener("keydown", (event) => {
      if (event.key === "p" || event.key === "P") {
        const motionReduced = reducedMotion || current?.reducedMotion === true;
        if (!shouldAllowPetReaction(currentPresentation(), motionReduced)) return;
        event.preventDefault();
        event.stopPropagation();
        cancelClickSequence();
        playReaction(event.shiftKey ? "flail" : "poke");
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      activatePet();
    });
    petButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    btnTrayMore?.addEventListener("click", (event) => {
      event.stopPropagation();
      setTrayMoreOpen(!trayMoreOpen);
    });
    trayMoreMenu?.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    const onRootClick = () => {
      if (trayMoreOpen) setTrayMoreOpen(false);
    };
    root.addEventListener("click", onRootClick);
    btnMarkAll?.addEventListener("click", () => {
      setTrayMoreOpen(false);
      const primary = current ? selectPrimaryActivity(current.projects) : null;
      if (primary?.presentation === "ready" || primary?.presentation === "blocked") {
        dismissActivityBubble(primary);
      }
      bridge?.markAllRead();
    });
    btnRetry?.addEventListener("click", () => {
      setTrayMoreOpen(false);
      bridge?.retry();
    });
    const submitAccessKey = () => {
      const value = accessKeyInput?.value?.trim() ?? "";
      if (!value) return;
      void bridge?.setAccessKey(value).then(() => {
        if (accessKeyInput) accessKeyInput.value = "";
      });
    };
    btnSaveKey?.addEventListener("click", () => {
      submitAccessKey();
    });
    accessKeyInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitAccessKey();
      }
    });
    btnClearKey?.addEventListener("click", () => {
      void bridge?.clearAccessKey();
    });
    btnCopy?.addEventListener("click", () => {
      void bridge?.copyStartCommand();
    });
    btnHide?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideToTray();
    });
    btnHideTray?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      bridge?.toggleTray();
    });
    btnSettings?.addEventListener("click", () => {
      wakeIdleSleep();
      setTrayMoreOpen(false);
      settingsOpen = !settingsOpen;
      if (current) update(current);
    });
    activityFilters?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-activity-filter]") : null;
      const nextFilter = target?.dataset.activityFilter;
      if (nextFilter !== "all" && nextFilter !== "attention" && nextFilter !== "running" && nextFilter !== "completed") {
        return;
      }
      activityFilter = nextFilter;
      if (current) {
        const visibleIds = activityIds(filterProjectGroups(current.projects, activityFilter));
        selectedVisibleActivityId = resolveActivitySelection(
          visibleIds,
          selectedVisibleActivityId ?? current.selectedActivityId
        );
        if (selectedVisibleActivityId) bridge?.selectActivity(selectedVisibleActivityId);
        update(current);
      }
    });
    petPicker?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-pet-id]") : null;
      const selectedPetId = target?.dataset.petId;
      if (!selectedPetId) return;
      bridge?.setPrefs({ selectedPetId });
    });
    petScalePicker?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-pet-scale]") : null;
      const petScale = target?.dataset.petScale;
      if (petScale !== "small" && petScale !== "medium" && petScale !== "large") return;
      bridge?.setPrefs({ petScale });
    });
    btnRestorePosition?.addEventListener("click", () => {
      bridge?.restoreDefaultPosition();
    });
    btnOpenCustomPets?.addEventListener("click", () => {
      void bridge?.openCustomPetsDir();
    });
    btnRescanCustomPets?.addEventListener("click", () => {
      bridge?.rescanCustomPets();
    });
    prefAlwaysOnTop?.addEventListener("change", () => {
      bridge?.setPrefs({ alwaysOnTop: prefAlwaysOnTop.checked });
    });
    prefClickThrough?.addEventListener("change", () => {
      bridge?.setPrefs({ clickThrough: prefClickThrough.checked });
    });
    prefLaunchAtLogin?.addEventListener("change", () => {
      bridge?.setPrefs({ launchAtLogin: prefLaunchAtLogin.checked });
    });
    prefCompletion?.addEventListener("change", () => {
      const completion = prefCompletion.value;
      if (completion === "never" || completion === "background-only" || completion === "always") {
        bridge?.setPrefs({ notification: { completion } });
      }
    });
    prefNeedsInput?.addEventListener("change", () => {
      bridge?.setPrefs({ notification: { needsInput: prefNeedsInput.checked } });
    });
    prefBlocked?.addEventListener("change", () => {
      bridge?.setPrefs({ notification: { blocked: prefBlocked.checked } });
    });
    prefShowContextMeter?.addEventListener("change", () => {
      bridge?.setPrefs({ showContextMeter: prefShowContextMeter.checked });
    });
    prefDnd?.addEventListener("change", () => {
      bridge?.setPrefs({ dndEnabled: prefDnd.checked });
    });
    prefSoundMaster?.addEventListener("change", () => {
      bridge?.setPrefs({ sound: { masterEnabled: prefSoundMaster.checked } });
    });
    prefSoundNeedsInput?.addEventListener("change", () => {
      bridge?.setPrefs({ sound: { needsInput: prefSoundNeedsInput.checked } });
    });
    prefSoundCompletion?.addEventListener("change", () => {
      bridge?.setPrefs({ sound: { completion: prefSoundCompletion.checked } });
    });
    const onKeyDown = (event) => {
      if (event.key === "Escape" && trayMoreOpen) {
        setTrayMoreOpen(false);
        btnTrayMore?.focus();
        return;
      }
      if (!current?.trayOpen) return;
      const target = event.target instanceof Element ? event.target : null;
      const inFormControl = target?.matches("input, select, option") === true;
      const inFilterBar = target?.closest("#activity-filters") != null;
      if (!inFormControl && !inFilterBar && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        const ids = activityIds(filterProjectGroups(current.projects, activityFilter));
        const next = moveActivitySelection(
          ids,
          selectedVisibleActivityId,
          event.key === "ArrowDown" ? "next" : "prev"
        );
        if (next) selectVisibleActivity(next, true);
        return;
      }
      if (!inFormControl && target?.closest("button") == null && event.key === "Enter" && selectedVisibleActivityId) {
        event.preventDefault();
        dismissActivityBubble(findVisibleActivity(selectedVisibleActivityId));
        void bridge?.openActivity(selectedVisibleActivityId);
        return;
      }
      if (!inFormControl && target?.closest("button") == null && (event.key === "m" || event.key === "M")) {
        const selected = findVisibleActivity(selectedVisibleActivityId);
        if (selected?.unread) {
          event.preventDefault();
          dismissActivityBubble(selected);
          bridge?.markRead(selected.activityId);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (selectedVisibleActivityId && expandedActivityIds.has(selectedVisibleActivityId)) {
          expandedActivityIds.delete(selectedVisibleActivityId);
          update(current);
          focusActivityRow(selectedVisibleActivityId);
        } else if (settingsOpen) {
          settingsOpen = false;
          update(current);
        } else if (current.trayOpen) {
          bridge?.toggleTray();
        }
      }
    };
    root.addEventListener("keydown", onKeyDown);
    let unsubscribe;
    let unsubscribeSoundCue;
    let unsubscribeCustomPets;
    if (bridge) {
      unsubscribe = bridge.onStateChanged((view) => {
        update(view);
      });
      unsubscribeSoundCue = bridge.onSoundCue((cue) => {
        soundPlayer.play(cue);
      });
      unsubscribeCustomPets = bridge.onCustomPetsChanged((payload) => {
        syncCustomPetsPayload(payload);
      });
      void bridge.getState().then((view) => {
        if (view) update(view);
      });
      void bridge.getCustomPets().then((payload) => {
        syncCustomPetsPayload(payload);
      });
    }
    return {
      update,
      destroy: () => {
        clearBubbleTimer();
        clearElapsedTimer();
        clearIdleSleepTimer();
        if (runningCueTimer != null) {
          clearTimeout(runningCueTimer);
          runningCueTimer = null;
        }
        if (idleBlinkTimer) {
          clearTimeout(idleBlinkTimer);
          idleBlinkTimer = null;
        }
        if (petDropPopTimer) {
          clearTimeout(petDropPopTimer);
          petDropPopTimer = null;
        }
        clearTransition();
        cancelClickSequence();
        clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibilityChange);
        }
        root.removeEventListener("keydown", onKeyDown);
        root.removeEventListener("click", onRootClick);
        for (const style of spriteStyleSheets.values()) style.remove();
        spriteStyleSheets.clear();
        clearCustomPetRegistrations();
        unsubscribe?.();
        unsubscribeSoundCue?.();
        unsubscribeCustomPets?.();
        soundPlayer.destroy();
      }
    };
  }
  function readPreviewFixture() {
    if (typeof window === "undefined") return null;
    const accepted = acceptStaticPetPreview(window.__SNAIL_PET_PREVIEW__);
    return accepted ? accepted : null;
  }
  function boot() {
    if (typeof document === "undefined") return;
    if (!document.getElementById("root")) return;
    const app = renderPetApp(document);
    const preview = readPreviewFixture();
    if (preview) app.update(preview);
  }
  boot();
})();
