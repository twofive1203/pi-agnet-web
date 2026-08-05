/**
 * Workbench skin runtime: local wallpaper / preset gradients + glass / bg blur /
 * vignette on top of curated themes. Preferences stay browser-local and only
 * mutate documented CSS custom properties / data attributes.
 */

export const WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY = "pi-theme-wallpaper";
export const WORKBENCH_SKIN_GLASS_STORAGE_KEY = "pi-theme-glass";
export const WORKBENCH_SKIN_GRADIENT_STORAGE_KEY = "pi-theme-gradient";
export const WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY = "pi-theme-bg-blur";
export const WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY = "pi-theme-frost-clarity";
export const WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY = "pi-theme-vignette";
/** Active background mode: none | image | gradient id. Legacy installs without this key are inferred. */
export const WORKBENCH_SKIN_BG_MODE_STORAGE_KEY = "pi-theme-bg-mode";

export const WORKBENCH_SKIN_LEVEL_MIN = 0;
export const WORKBENCH_SKIN_LEVEL_MAX = 100;
export const WORKBENCH_SKIN_GLASS_MIN = WORKBENCH_SKIN_LEVEL_MIN;
export const WORKBENCH_SKIN_GLASS_MAX = WORKBENCH_SKIN_LEVEL_MAX;
export const WORKBENCH_SKIN_GLASS_DEFAULT = 0;
export const WORKBENCH_SKIN_BG_BLUR_DEFAULT = 0;
/** 0 = keep the glass-derived frost blur; 100 = remove panel blur entirely. */
export const WORKBENCH_SKIN_FROST_CLARITY_DEFAULT = 0;
export const WORKBENCH_SKIN_VIGNETTE_DEFAULT = 0;
/** Defaults applied the first time a background becomes active while extras are still off. */
export const WORKBENCH_SKIN_GLASS_ON_BACKGROUND = 48;
export const WORKBENCH_SKIN_BG_BLUR_ON_BACKGROUND = 18;
export const WORKBENCH_SKIN_VIGNETTE_ON_BACKGROUND = 36;
/** @deprecated Use WORKBENCH_SKIN_GLASS_ON_BACKGROUND */
export const WORKBENCH_SKIN_GLASS_ON_WALLPAPER = WORKBENCH_SKIN_GLASS_ON_BACKGROUND;

export const WORKBENCH_SKIN_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const WORKBENCH_SKIN_ENCODED_MAX_CHARS = 2_600_000;
const WALLPAPER_MAX_EDGE = 1920;
const WALLPAPER_JPEG_QUALITY = 0.84;

export const WORKBENCH_SKIN_BG_MODES = ["none", "image", "gradient"] as const;
export type WorkbenchSkinBgMode = (typeof WORKBENCH_SKIN_BG_MODES)[number];

export const WORKBENCH_GRADIENT_IDS = [
  "dusk-aurora",
  "coastal-mist",
  "ember-glow",
  "forest-canopy",
  "midnight-ink",
  "paper-dawn",
  "sakura-haze",
  "arctic-light",
] as const;

export type WorkbenchGradientId = (typeof WORKBENCH_GRADIENT_IDS)[number];

export interface WorkbenchGradientMeta {
  id: WorkbenchGradientId;
  labelKey: `app.${string}`;
  /** CSS background-image value (gradient only). */
  css: string;
  preview: readonly [string, string, string];
}

export const WORKBENCH_GRADIENT_META = {
  "dusk-aurora": {
    id: "dusk-aurora",
    labelKey: "app.themeGradientDuskAurora",
    css: "linear-gradient(152deg, #17122b 0%, #2b3d72 46%, #7a4f8d 74%, #c27b6a 100%)",
    preview: ["#17122b", "#2b3d72", "#c27b6a"],
  },
  "coastal-mist": {
    id: "coastal-mist",
    labelKey: "app.themeGradientCoastalMist",
    css: "linear-gradient(160deg, #0f2430 0%, #1d4f5f 42%, #4f8f9a 70%, #d7e7df 100%)",
    preview: ["#0f2430", "#1d4f5f", "#d7e7df"],
  },
  "ember-glow": {
    id: "ember-glow",
    labelKey: "app.themeGradientEmberGlow",
    css: "linear-gradient(148deg, #2a1210 0%, #7a2e1f 38%, #c45b2d 68%, #f0c08a 100%)",
    preview: ["#2a1210", "#7a2e1f", "#f0c08a"],
  },
  "forest-canopy": {
    id: "forest-canopy",
    labelKey: "app.themeGradientForestCanopy",
    css: "linear-gradient(155deg, #0f1c14 0%, #1f3d2a 40%, #3f6b45 72%, #c5d7a8 100%)",
    preview: ["#0f1c14", "#1f3d2a", "#c5d7a8"],
  },
  "midnight-ink": {
    id: "midnight-ink",
    labelKey: "app.themeGradientMidnightInk",
    css: "linear-gradient(150deg, #070a12 0%, #121a2e 45%, #243756 78%, #6d86b3 100%)",
    preview: ["#070a12", "#121a2e", "#6d86b3"],
  },
  "paper-dawn": {
    id: "paper-dawn",
    labelKey: "app.themeGradientPaperDawn",
    css: "linear-gradient(148deg, #efe4d2 0%, #f4ebe0 38%, #d7e0ea 72%, #b7c7d8 100%)",
    preview: ["#efe4d2", "#f4ebe0", "#b7c7d8"],
  },
  "sakura-haze": {
    id: "sakura-haze",
    labelKey: "app.themeGradientSakuraHaze",
    css: "linear-gradient(152deg, #2a1620 0%, #6d3a4d 40%, #d38aa4 72%, #f3d6df 100%)",
    preview: ["#2a1620", "#6d3a4d", "#f3d6df"],
  },
  "arctic-light": {
    id: "arctic-light",
    labelKey: "app.themeGradientArcticLight",
    css: "linear-gradient(155deg, #d9e4ef 0%, #edf3f8 36%, #c9d8e8 70%, #8ea8c4 100%)",
    preview: ["#d9e4ef", "#edf3f8", "#8ea8c4"],
  },
} as const satisfies Record<WorkbenchGradientId, WorkbenchGradientMeta>;

export interface WorkbenchSkinSettings {
  mode: WorkbenchSkinBgMode;
  wallpaperDataUrl: string | null;
  gradientId: WorkbenchGradientId | null;
  glass: number;
  bgBlur: number;
  vignette: number;
  frostClarity: number;
}

export const DEFAULT_WORKBENCH_SKIN: WorkbenchSkinSettings = {
  mode: "none",
  wallpaperDataUrl: null,
  gradientId: null,
  glass: WORKBENCH_SKIN_GLASS_DEFAULT,
  bgBlur: WORKBENCH_SKIN_BG_BLUR_DEFAULT,
  vignette: WORKBENCH_SKIN_VIGNETTE_DEFAULT,
  frostClarity: WORKBENCH_SKIN_FROST_CLARITY_DEFAULT,
};

const DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i;

export function clampWorkbenchLevel(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    WORKBENCH_SKIN_LEVEL_MAX,
    Math.max(WORKBENCH_SKIN_LEVEL_MIN, Math.round(value)),
  );
}

export function clampWorkbenchGlass(value: number): number {
  return clampWorkbenchLevel(value, WORKBENCH_SKIN_GLASS_DEFAULT);
}

export function isWorkbenchGradientId(value: string | null | undefined): value is WorkbenchGradientId {
  return value != null && (WORKBENCH_GRADIENT_IDS as readonly string[]).includes(value);
}

export function isWorkbenchWallpaperDataUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  if (value.length > WORKBENCH_SKIN_ENCODED_MAX_CHARS) return false;
  return DATA_URL_PATTERN.test(value.trim());
}

export function parseWorkbenchLevel(
  raw: string | null | undefined,
  fallback = 0,
): number {
  if (raw == null || raw === "") return fallback;
  return clampWorkbenchLevel(Number.parseInt(raw, 10), fallback);
}

export function parseWorkbenchGlass(raw: string | null | undefined): number {
  return parseWorkbenchLevel(raw, WORKBENCH_SKIN_GLASS_DEFAULT);
}

export function normalizeWorkbenchSkinSettings(
  partial: Partial<WorkbenchSkinSettings>,
): WorkbenchSkinSettings {
  const wallpaperDataUrl = isWorkbenchWallpaperDataUrl(partial.wallpaperDataUrl)
    ? partial.wallpaperDataUrl.trim()
    : null;
  const gradientId = isWorkbenchGradientId(partial.gradientId) ? partial.gradientId : null;
  let mode: WorkbenchSkinBgMode = partial.mode === "image" || partial.mode === "gradient" || partial.mode === "none"
    ? partial.mode
    : "none";

  if (mode === "image" && !wallpaperDataUrl) mode = gradientId ? "gradient" : "none";
  if (mode === "gradient" && !gradientId) mode = wallpaperDataUrl ? "image" : "none";

  return {
    mode,
    wallpaperDataUrl,
    gradientId,
    glass: clampWorkbenchGlass(partial.glass ?? WORKBENCH_SKIN_GLASS_DEFAULT),
    bgBlur: clampWorkbenchLevel(partial.bgBlur ?? WORKBENCH_SKIN_BG_BLUR_DEFAULT),
    vignette: clampWorkbenchLevel(partial.vignette ?? WORKBENCH_SKIN_VIGNETTE_DEFAULT),
    frostClarity: clampWorkbenchLevel(partial.frostClarity ?? WORKBENCH_SKIN_FROST_CLARITY_DEFAULT),
  };
}

function withBackgroundDefaults(settings: WorkbenchSkinSettings, enablingBackground: boolean): WorkbenchSkinSettings {
  if (!enablingBackground) return settings;
  return {
    ...settings,
    glass: settings.glass > 0 ? settings.glass : WORKBENCH_SKIN_GLASS_ON_BACKGROUND,
    bgBlur: settings.bgBlur > 0 ? settings.bgBlur : WORKBENCH_SKIN_BG_BLUR_ON_BACKGROUND,
    vignette: settings.vignette > 0 ? settings.vignette : WORKBENCH_SKIN_VIGNETTE_ON_BACKGROUND,
  };
}

export function readWorkbenchSkinFromStorage(): WorkbenchSkinSettings {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_SKIN;
  try {
    const wallpaperRaw = localStorage.getItem(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY);
    const gradientRaw = localStorage.getItem(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY);
    const modeRaw = localStorage.getItem(WORKBENCH_SKIN_BG_MODE_STORAGE_KEY);
    const wallpaperDataUrl = isWorkbenchWallpaperDataUrl(wallpaperRaw) ? wallpaperRaw.trim() : null;
    const gradientId = isWorkbenchGradientId(gradientRaw) ? gradientRaw : null;

    let mode: WorkbenchSkinBgMode = "none";
    if (modeRaw === "image" || modeRaw === "gradient" || modeRaw === "none") {
      mode = modeRaw;
    } else if (wallpaperDataUrl) {
      // Legacy installs only stored the image data-URL.
      mode = "image";
    } else if (gradientId) {
      mode = "gradient";
    }

    return normalizeWorkbenchSkinSettings({
      mode,
      wallpaperDataUrl,
      gradientId,
      glass: parseWorkbenchGlass(localStorage.getItem(WORKBENCH_SKIN_GLASS_STORAGE_KEY)),
      bgBlur: parseWorkbenchLevel(localStorage.getItem(WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY)),
      vignette: parseWorkbenchLevel(localStorage.getItem(WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY)),
      frostClarity: parseWorkbenchLevel(localStorage.getItem(WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY)),
    });
  } catch {
    return DEFAULT_WORKBENCH_SKIN;
  }
}

function writeLevel(key: string, value: number, defaultValue: number): void {
  if (value <= defaultValue) localStorage.removeItem(key);
  else localStorage.setItem(key, String(clampWorkbenchLevel(value, defaultValue)));
}

export function persistWorkbenchSkin(settings: WorkbenchSkinSettings): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeWorkbenchSkinSettings(settings);
  try {
    if (normalized.wallpaperDataUrl) {
      localStorage.setItem(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY, normalized.wallpaperDataUrl);
    } else {
      localStorage.removeItem(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY);
    }

    if (normalized.gradientId) {
      localStorage.setItem(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY, normalized.gradientId);
    } else {
      localStorage.removeItem(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY);
    }

    if (normalized.mode === "none") localStorage.removeItem(WORKBENCH_SKIN_BG_MODE_STORAGE_KEY);
    else localStorage.setItem(WORKBENCH_SKIN_BG_MODE_STORAGE_KEY, normalized.mode);

    writeLevel(WORKBENCH_SKIN_GLASS_STORAGE_KEY, normalized.glass, WORKBENCH_SKIN_GLASS_DEFAULT);
    writeLevel(WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY, normalized.bgBlur, WORKBENCH_SKIN_BG_BLUR_DEFAULT);
    writeLevel(WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY, normalized.frostClarity, WORKBENCH_SKIN_FROST_CLARITY_DEFAULT);
    writeLevel(WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY, normalized.vignette, WORKBENCH_SKIN_VIGNETTE_DEFAULT);
  } catch {
    // Ignore quota / private-mode failures; the in-memory document state still applies.
  }
}

function wallpaperCssValue(dataUrl: string | null): string {
  if (!dataUrl) return "none";
  return `url("${dataUrl.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

export function resolveWorkbenchBackgroundLayer(settings: WorkbenchSkinSettings): string {
  const normalized = normalizeWorkbenchSkinSettings(settings);
  if (normalized.mode === "image" && normalized.wallpaperDataUrl) {
    return wallpaperCssValue(normalized.wallpaperDataUrl);
  }
  if (normalized.mode === "gradient" && normalized.gradientId) {
    return WORKBENCH_GRADIENT_META[normalized.gradientId].css;
  }
  return "none";
}

/** Map 0–100 glass to panel opacity/blur used by the CSS skin layer.
 * 0 = fully opaque workbench cards; 100 = fully transparent cards (frosted via blur only). */
export function resolveWorkbenchGlassTokens(glass: number, frostClarity = WORKBENCH_SKIN_FROST_CLARITY_DEFAULT): {
  unit: number;
  panelAlpha: number;
  blurPx: number;
  /** @deprecated Scrim is driven by vignette; kept for callers that still read it. */
  scrim: number;
} {
  const unit = clampWorkbenchGlass(glass) / WORKBENCH_SKIN_LEVEL_MAX;
  const clarityUnit = clampWorkbenchLevel(frostClarity, WORKBENCH_SKIN_FROST_CLARITY_DEFAULT) / WORKBENCH_SKIN_LEVEL_MAX;
  return {
    unit,
    // Linear to full clear at 100 so the slider matches user expectation.
    panelAlpha: 1 - unit,
    // Stronger frost as panels go clear so chrome edges stay legible; clarity scales it down to zero.
    blurPx: unit * 28 * (1 - clarityUnit),
    scrim: 0.18,
  };
}

/** Map background blur + vignette to CSS custom property payloads. */
export function resolveWorkbenchAtmosphereTokens(bgBlur: number, vignette: number): {
  bgBlurPx: number;
  vignette: number;
  scrim: number;
} {
  const blurUnit = clampWorkbenchLevel(bgBlur) / WORKBENCH_SKIN_LEVEL_MAX;
  const vignetteUnit = clampWorkbenchLevel(vignette) / WORKBENCH_SKIN_LEVEL_MAX;
  return {
    bgBlurPx: blurUnit * 30,
    // Edge darkening strength for the radial vignette overlay.
    vignette: vignetteUnit * 0.78,
    // Mild flat wash so bright wallpapers stay calm under cards.
    scrim: 0.1 + vignetteUnit * 0.22,
  };
}

export function hasWorkbenchBackground(settings: WorkbenchSkinSettings): boolean {
  const normalized = normalizeWorkbenchSkinSettings(settings);
  return normalized.mode === "image" || normalized.mode === "gradient";
}

export function isWorkbenchSkinCustomized(settings: WorkbenchSkinSettings): boolean {
  const normalized = normalizeWorkbenchSkinSettings(settings);
  return (
    hasWorkbenchBackground(normalized)
    || normalized.glass > 0
    || normalized.bgBlur > 0
    || normalized.vignette > 0
    || normalized.frostClarity > 0
    || Boolean(normalized.wallpaperDataUrl)
    || Boolean(normalized.gradientId)
  );
}

export function applyWorkbenchSkinToDocument(settings: WorkbenchSkinSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const normalized = normalizeWorkbenchSkinSettings(settings);
  const glassTokens = resolveWorkbenchGlassTokens(normalized.glass, normalized.frostClarity);
  const atmosphere = resolveWorkbenchAtmosphereTokens(normalized.bgBlur, normalized.vignette);
  const backgroundLayer = resolveWorkbenchBackgroundLayer(normalized);
  const activeBackground = hasWorkbenchBackground(normalized);

  if (normalized.mode === "image") root.dataset.wallpaper = "image";
  else if (normalized.mode === "gradient") root.dataset.wallpaper = "gradient";
  else delete root.dataset.wallpaper;

  // Keep legacy "on" consumers working via CSS selectors that accept image|gradient|on.
  if (activeBackground) root.dataset.skinBg = normalized.mode;
  else delete root.dataset.skinBg;

  if (normalized.glass > 0) root.dataset.glass = "on";
  else delete root.dataset.glass;

  if (normalized.gradientId) root.dataset.skinGradient = normalized.gradientId;
  else delete root.dataset.skinGradient;

  root.style.setProperty("--skin-wallpaper-image", backgroundLayer);
  root.style.setProperty("--skin-bg-image", backgroundLayer);
  root.style.setProperty("--skin-glass", glassTokens.unit.toFixed(3));
  root.style.setProperty("--skin-panel-alpha", glassTokens.panelAlpha.toFixed(3));
  root.style.setProperty("--skin-blur", `${glassTokens.blurPx.toFixed(1)}px`);
  root.style.setProperty("--skin-panel-blur", `${glassTokens.blurPx.toFixed(1)}px`);
  root.style.setProperty("--skin-bg-blur", `${atmosphere.bgBlurPx.toFixed(1)}px`);
  root.style.setProperty("--skin-vignette", atmosphere.vignette.toFixed(3));
  root.style.setProperty("--skin-scrim", atmosphere.scrim.toFixed(3));
}

export function clearWorkbenchSkinFromDocument(): void {
  applyWorkbenchSkinToDocument(DEFAULT_WORKBENCH_SKIN);
}

export function buildWallpaperSettings(
  current: WorkbenchSkinSettings,
  wallpaperDataUrl: string | null,
): WorkbenchSkinSettings {
  const enabling = Boolean(wallpaperDataUrl);
  const next = normalizeWorkbenchSkinSettings({
    ...current,
    wallpaperDataUrl,
    mode: enabling ? "image" : current.mode === "gradient" && current.gradientId ? "gradient" : "none",
  });
  return withBackgroundDefaults(next, enabling && !hasWorkbenchBackground(current));
}

export function buildGradientSettings(
  current: WorkbenchSkinSettings,
  gradientId: WorkbenchGradientId | null,
): WorkbenchSkinSettings {
  const enabling = Boolean(gradientId);
  const next = normalizeWorkbenchSkinSettings({
    ...current,
    gradientId,
    mode: enabling ? "gradient" : current.mode === "image" && current.wallpaperDataUrl ? "image" : "none",
  });
  return withBackgroundDefaults(next, enabling && !hasWorkbenchBackground(current));
}

export function buildClearBackgroundSettings(current: WorkbenchSkinSettings): WorkbenchSkinSettings {
  return normalizeWorkbenchSkinSettings({
    ...current,
    mode: "none",
    // Keep stored assets so the user can re-select without re-uploading.
  });
}

function loadImageElement(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode wallpaper image"));
    image.src = source;
  });
}

/**
 * Compress a local image into a JPEG data URL suitable for localStorage wallpaper use.
 * Rejects unsupported types and oversize payloads instead of silently truncating.
 */
export async function encodeWorkbenchWallpaperFile(file: File): Promise<string> {
  if (typeof window === "undefined") {
    throw new Error("Wallpaper encoding requires a browser");
  }
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    throw new Error("Unsupported image type");
  }
  if (file.size > WORKBENCH_SKIN_SOURCE_MAX_BYTES) {
    throw new Error("Image is too large");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageElement(objectUrl);
    const longest = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
    const scale = longest > WALLPAPER_MAX_EDGE ? WALLPAPER_MAX_EDGE / longest : 1;
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.drawImage(image, 0, 0, width, height);

    let quality = WALLPAPER_JPEG_QUALITY;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > WORKBENCH_SKIN_ENCODED_MAX_CHARS && quality > 0.55) {
      quality -= 0.08;
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > WORKBENCH_SKIN_ENCODED_MAX_CHARS) {
      throw new Error("Encoded wallpaper exceeds storage budget");
    }
    if (!isWorkbenchWallpaperDataUrl(dataUrl)) {
      throw new Error("Encoded wallpaper failed validation");
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Inline boot fragment that restores wallpaper/gradient/glass/atmosphere before paint.
 * Consumed by `app/layout.tsx` next to the curated-theme boot script.
 */
export function buildWorkbenchSkinBootFragment(): string {
  const gradientMap = Object.fromEntries(
    WORKBENCH_GRADIENT_IDS.map((id) => [id, WORKBENCH_GRADIENT_META[id].css]),
  );
  return [
    `var wg=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_GLASS_STORAGE_KEY)});`,
    `var ww=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY)});`,
    `var wgr=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY)});`,
    `var wm=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_BG_MODE_STORAGE_KEY)});`,
    `var wb=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY)});`,
    `var wv=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY)});`,
    `var wfc=localStorage.getItem(${JSON.stringify(WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY)});`,
    `var gmap=${JSON.stringify(gradientMap)};`,
    "function lv(v){var n=parseInt(v||'0',10);if(!isFinite(n))n=0;if(n<0)n=0;if(n>100)n=100;return n;}",
    "var g=lv(wg),bb=lv(wb),vn=lv(wv),fc=lv(wfc);",
    "var hasW=typeof ww==='string'&&/^data:image\\/(png|jpe?g|webp|gif);base64,/i.test(ww)&&ww.length<=2600000;",
    "var hasG=typeof wgr==='string'&&Object.prototype.hasOwnProperty.call(gmap,wgr);",
    "var mode=wm==='image'||wm==='gradient'||wm==='none'?wm:(hasW?'image':(hasG?'gradient':'none'));",
    "if(mode==='image'&&!hasW)mode=hasG?'gradient':'none';",
    "if(mode==='gradient'&&!hasG)mode=hasW?'image':'none';",
    "var layer='none';",
    "if(mode==='image'&&hasW){layer='url(\"'+ww.replace(/\\\\/g,'\\\\\\\\').replace(/\"/g,'\\\\\"')+'\")';r.dataset.wallpaper='image';r.dataset.skinBg='image';}",
    "else if(mode==='gradient'&&hasG){layer=gmap[wgr];r.dataset.wallpaper='gradient';r.dataset.skinBg='gradient';r.dataset.skinGradient=wgr;}",
    "else{delete r.dataset.wallpaper;delete r.dataset.skinBg;delete r.dataset.skinGradient;}",
    "if(g>0){r.dataset.glass='on';}else{delete r.dataset.glass;}",
    "var u=g/100,pa=1-u,pbl=u*28*(1-fc/100),bbl=(bb/100)*30,vig=(vn/100)*0.78,sc=0.1+(vn/100)*0.22;",
    "r.style.setProperty('--skin-wallpaper-image',layer);",
    "r.style.setProperty('--skin-bg-image',layer);",
    "r.style.setProperty('--skin-glass',u.toFixed(3));",
    "r.style.setProperty('--skin-panel-alpha',pa.toFixed(3));",
    "r.style.setProperty('--skin-blur',pbl.toFixed(1)+'px');",
    "r.style.setProperty('--skin-panel-blur',pbl.toFixed(1)+'px');",
    "r.style.setProperty('--skin-bg-blur',bbl.toFixed(1)+'px');",
    "r.style.setProperty('--skin-vignette',vig.toFixed(3));",
    "r.style.setProperty('--skin-scrim',sc.toFixed(3));",
  ].join("");
}
