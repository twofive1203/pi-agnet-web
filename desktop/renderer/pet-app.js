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
  var BUILTIN_PET_IDS = ["snail-default", "snail-classic"];
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
  function validatePetManifestDocument(raw) {
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
    maxDiagnostics: 20,
    maxDiagnosticCodeChars: 64,
    maxDiagnosticMessageChars: 160,
    /** Desktop-local acknowledged/notified transition LRU capacity (presentation only). */
    maxLocalAckTransitions: 500
  };

  // desktop/renderer/pet-state.ts
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
    buildDefaultPetManifest("snail-classic", "Classic Snail")
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
    resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[1], manifest_default)
  ];
  function getBuiltinPetManifest(petId) {
    return BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId) ?? BUILTIN_PET_MANIFESTS[0];
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
  var SOURCE_LABELS = {
    agent: "Agent",
    snflow: "SnFlow",
    automation: "\u81EA\u52A8\u5316",
    quick_command: "\u5FEB\u6377\u547D\u4EE4"
  };
  function petSourceLabel(source) {
    return SOURCE_LABELS[source] ?? source;
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
    if (signalKey === state.signalKey) {
      if (mode == null) {
        return { ...state, visible: false, mode: null, expiresAt: null };
      }
      if (state.dismissedSignalKey === signalKey) {
        return { ...state, visible: false, mode, expiresAt: null };
      }
      if (mode === "transient" && state.expiresAt != null && event.now >= state.expiresAt) {
        return { ...state, visible: false, expiresAt: null };
      }
      return { ...state, mode };
    }
    const visible = mode === "persistent" || mode === "transient" && !event.signal.reset;
    return {
      signalKey,
      transitionId: event.signal.transitionId,
      dismissedSignalKey: null,
      visible,
      mode,
      expiresAt: visible && mode === "transient" ? event.now + PET_BUBBLE_TRANSIENT_MS : null
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
    const btnCopy = root.getElementById("btn-copy-cmd");
    const btnHide = root.getElementById("btn-hide");
    const btnHideTray = root.getElementById("btn-hide-tray");
    const btnSettings = root.getElementById("btn-settings");
    const settingsPanel = root.getElementById("settings-panel");
    const petPicker = root.getElementById("pet-picker");
    const petScalePicker = root.getElementById("pet-scale-picker");
    const btnRestorePosition = root.getElementById("btn-restore-position");
    const prefAlwaysOnTop = root.getElementById("pref-always-on-top");
    const prefClickThrough = root.getElementById("pref-click-through");
    const prefLaunchAtLogin = root.getElementById("pref-launch-at-login");
    const prefCompletion = root.getElementById("pref-completion");
    const prefNeedsInput = root.getElementById("pref-needs-input");
    const prefBlocked = root.getElementById("pref-blocked");
    const staleFlag = root.getElementById("stale-flag");
    const hideToTray = () => {
      bridge?.hideToTray();
    };
    const DRAG_THRESHOLD_PX = 5;
    let current = null;
    let settingsOpen = false;
    let activityFilter = "all";
    let selectedVisibleActivityId = null;
    const expandedActivityIds = /* @__PURE__ */ new Set();
    let bubbleState = createInitialPetBubbleState();
    let bubbleTimer = null;
    let elapsedTimer = null;
    let reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    function activityIds(projects) {
      const ids = [];
      for (const project of projects) {
        for (const activity of project.activities) ids.push(activity.activityId);
      }
      return ids;
    }
    function primaryActivity(view) {
      return view.projects[0]?.activities[0] ?? null;
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
    function update(view) {
      const previousView = current;
      current = view;
      const previewSettingsOpen = view.settingsOpen;
      if (!bridge && typeof previewSettingsOpen === "boolean") {
        settingsOpen = previewSettingsOpen;
      }
      const state = isPetVisualState(view.presentation) ? view.presentation : "idle";
      const manifest = getBuiltinPetManifest(view.selectedPetId);
      const frame = resolvePetFrame(manifest, state, view.reducedMotion || reducedMotion);
      if (petAvatar) {
        petAvatar.className = `pet-avatar frame-${frame.frame}${frame.animated ? " is-animated" : ""}`;
        petAvatar.setAttribute("data-state", state);
      }
      if (petRoot) petRoot.setAttribute("data-pet", manifest.id);
      if (petGlyph) petGlyph.textContent = frame.glyph || petStateGlyph(state);
      if (petLabel) petLabel.textContent = frame.label || petStateLabel(state);
      const primary = primaryActivity(view);
      const activityDrivesState = primary?.presentation === state;
      const signal = {
        presentation: state,
        transitionId: activityDrivesState ? primary.lastTransitionId : null,
        revision: view.revision,
        instanceId: view.instanceId,
        unread: activityDrivesState ? primary.unread : false,
        reset: view.reset || bridge != null && previousView == null || previousView?.instanceId != null && previousView.instanceId !== view.instanceId
      };
      const bubbleNow = Date.now();
      bubbleState = reducePetBubbleState(bubbleState, {
        type: "snapshot",
        signal,
        now: bubbleNow
      });
      if (petCaption) {
        petCaption.hidden = !bubbleState.visible;
        petCaption.dataset.bubbleMode = bubbleState.mode ?? "hidden";
      }
      if (petCaptionState) petCaptionState.textContent = frame.label || petStateLabel(state);
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
      if (tray) tray.hidden = !view.trayOpen;
      if (!view.trayOpen) settingsOpen = false;
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
        petButton.setAttribute(
          "aria-label",
          view.trayOpen ? "\u684C\u5BA0\uFF0C\u70B9\u51FB\u6536\u8D77\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8" : "\u684C\u5BA0\uFF0C\u70B9\u51FB\u5C55\u5F00\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8"
        );
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
          empty.textContent = view.projects.length > 0 ? "\u6B64\u7B5B\u9009\u4E0B\u6682\u65E0\u6D3B\u52A8" : view.connectionStatus === "connected" ? "\u5F53\u524D\u6CA1\u6709\u53EF\u89C2\u5BDF\u7684\u6D3B\u52A8" : "\u8FDE\u63A5\u672C\u5730\u8717\u725B\u6D3E\u670D\u52A1\u540E\u5373\u53EF\u89C2\u5BDF\u4EFB\u52A1";
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
      row.className = `activity-row${activity.unread ? " is-unread" : ""}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");
      row.setAttribute("aria-label", `${activity.title}\uFF0C${petStateLabel(activity.presentation)}`);
      row.tabIndex = activity.activityId === selectedId ? 0 : -1;
      row.dataset.activityId = activity.activityId;
      const summary = document.createElement("div");
      summary.className = "activity-row-summary";
      const glyph = document.createElement("span");
      glyph.className = "row-glyph";
      glyph.textContent = petStateGlyph(activity.presentation);
      glyph.title = petStateLabel(activity.presentation);
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
      meta.textContent = [petStateLabel(activity.presentation), activity.phase].filter(Boolean).join(" \xB7 ");
      main.append(heading, meta);
      const progressLabel = formatActivityProgress(activity.progress, activity.children.length);
      if (progressLabel) {
        const progress = document.createElement("span");
        progress.className = "row-progress";
        progress.textContent = progressLabel;
        main.appendChild(progress);
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
    const endPetPointer = (target, pointerId) => {
      if (petPointerId !== pointerId) return;
      try {
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
      }
      target.classList.remove("is-dragging");
      const wasDragging = petDragging;
      petPointerId = null;
      petDragging = false;
      if (!wasDragging) {
        const primary = current ? primaryActivity(current) : null;
        if (current && !current.trayOpen && (primary?.presentation === "needs_input" || primary?.presentation === "blocked")) {
          dismissActivityBubble(primary);
        }
        bridge?.toggleTray();
      }
    };
    petButton?.addEventListener("pointerdown", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (event.button !== 0) return;
      petPointerId = event.pointerId;
      petDragOriginX = event.screenX;
      petDragOriginY = event.screenY;
      petLastScreenX = event.screenX;
      petLastScreenY = event.screenY;
      petDragging = false;
      try {
        petButton.setPointerCapture(event.pointerId);
      } catch {
      }
    });
    petButton?.addEventListener("pointermove", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId !== event.pointerId) return;
      const totalDx = event.screenX - petDragOriginX;
      const totalDy = event.screenY - petDragOriginY;
      if (!petDragging && (Math.abs(totalDx) >= DRAG_THRESHOLD_PX || Math.abs(totalDy) >= DRAG_THRESHOLD_PX)) {
        petDragging = true;
        petButton.classList.add("is-dragging");
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
      endPetPointer(petButton, event.pointerId);
    });
    petButton?.addEventListener("pointercancel", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId === event.pointerId) {
        petDragging = true;
        endPetPointer(petButton, event.pointerId);
      }
    });
    petButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    btnMarkAll?.addEventListener("click", () => {
      const primary = current ? primaryActivity(current) : null;
      if (primary?.presentation === "ready" || primary?.presentation === "blocked") {
        dismissActivityBubble(primary);
      }
      bridge?.markAllRead();
    });
    btnRetry?.addEventListener("click", () => {
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
    const onKeyDown = (event) => {
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
    if (bridge) {
      unsubscribe = bridge.onStateChanged((view) => {
        update(view);
      });
      void bridge.getState().then((view) => {
        if (view) update(view);
      });
    }
    return {
      update,
      destroy: () => {
        clearBubbleTimer();
        clearElapsedTimer();
        root.removeEventListener("keydown", onKeyDown);
        unsubscribe?.();
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
