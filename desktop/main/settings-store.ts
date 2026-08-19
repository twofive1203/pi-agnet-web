/**
 * Desktop pet settings validation + defaults (U6).
 *
 * Persists only presentation/connection preferences — never observer tokens,
 * PIDs, prompts, output, cwd lists, or credentials.
 */

import {
  DESKTOP_DEFAULT_PORT,
  DESKTOP_START_COMMAND,
} from "./connection-state";
import { DEFAULT_PET_ID, DEFAULT_PET_KEY, petIdFromKey, resolvePetKey } from "../renderer/pet-key";

export const DESKTOP_SETTINGS_VERSION = 1 as const;

export const DESKTOP_PET_SCALES = ["small", "medium", "large"] as const;
export type DesktopPetScale = (typeof DESKTOP_PET_SCALES)[number];

export const DESKTOP_PET_BUBBLE_THEMES = [
  "cream",
  "peach",
  "night",
  "ember",
  "plum",
  "moss",
] as const;
export type DesktopPetBubbleTheme = (typeof DESKTOP_PET_BUBBLE_THEMES)[number];

/** Discrete size factors shared with the window layout spec. */
export const DESKTOP_PET_SCALE_FACTORS: Record<DesktopPetScale, number> = {
  small: 1,
  medium: 1.2,
  large: 1.5,
};

export type DesktopNotificationCompletionPolicy = "never" | "background-only" | "always";

export type DesktopPetSettings = {
  version: typeof DESKTOP_SETTINGS_VERSION;
  /** IPv4 loopback port only; origin is always http://127.0.0.1:<port>. */
  port: number;
  selectedPetId: string;
  /** Namespaced selection (`snail:<id>` / `codex:<id>`). Source of truth. */
  selectedPetKey: string;
  /** Collapsed/tray layout size token; missing v1 files migrate to medium. */
  petScale: DesktopPetScale;
  /** Comic-bubble chrome palette; missing v1 files migrate to cream. */
  bubbleTheme: DesktopPetBubbleTheme;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  launchAtLogin: boolean;
  activityTrayOpen: boolean;
  /** Compact pet-side context ring; missing v1 files migrate to on. */
  showContextMeter: boolean;
  /**
   * Manual Do Not Disturb: suppresses proactive notifications/bubbles/sounds
   * while observation keeps running. Missing v1 files migrate to off.
   */
  dndEnabled: boolean;
  windowPosition: { x: number; y: number } | null;
  notification: {
    needsInput: boolean;
    blocked: boolean;
    completion: DesktopNotificationCompletionPolicy;
  };
  /**
   * Desktop sound cues (U4a). Master defaults OFF so upgrades never suddenly
   * beep; per-event switches default ON and are preserved while master is off.
   */
  sound: {
    masterEnabled: boolean;
    needsInput: boolean;
    completion: boolean;
  };
  /** Bounded transition ids acknowledged locally (presentation only). */
  acknowledgedTransitionIds: string[];
  /** Bounded transition ids already notified (dedupe). */
  notifiedTransitionIds: string[];
  /** Bounded transition ids already sounded (dedupe, independent of notifications). */
  soundedTransitionIds: string[];
};

export const DESKTOP_SETTINGS_DEFAULTS: DesktopPetSettings = {
  version: DESKTOP_SETTINGS_VERSION,
  port: DESKTOP_DEFAULT_PORT,
  selectedPetId: DEFAULT_PET_ID,
  selectedPetKey: DEFAULT_PET_KEY,
  petScale: "medium",
  bubbleTheme: "cream",
  alwaysOnTop: true,
  clickThrough: false,
  launchAtLogin: false,
  activityTrayOpen: false,
  showContextMeter: true,
  dndEnabled: false,
  windowPosition: null,
  notification: {
    needsInput: true,
    blocked: true,
    completion: "background-only",
  },
  sound: {
    masterEnabled: false,
    needsInput: true,
    completion: true,
  },
  acknowledgedTransitionIds: [],
  notifiedTransitionIds: [],
  soundedTransitionIds: [],
};

const MAX_TRANSITION_LRU = 500;

export function createDefaultDesktopSettings(
  overrides?: Partial<Pick<DesktopPetSettings, "port" | "selectedPetId" | "selectedPetKey">>,
): DesktopPetSettings {
  return normalizeDesktopSettings({
    ...DESKTOP_SETTINGS_DEFAULTS,
    ...overrides,
  });
}

/** Normalize unknown JSON into a safe settings object. */
export function normalizeDesktopSettings(input: unknown): DesktopPetSettings {
  const raw = isRecord(input) ? input : {};
  const port = clampPort(raw.port);
  const selectedPetKey = resolvePetKey({
    selectedPetKey: raw.selectedPetKey,
    selectedPetId: raw.selectedPetId,
  });
  const selectedPetId = petIdFromKey(selectedPetKey);

  const notificationRaw = isRecord(raw.notification) ? raw.notification : {};
  const completion = normalizeCompletion(notificationRaw.completion);
  const soundRaw = isRecord(raw.sound) ? raw.sound : {};

  const windowPosition = normalizeWindowPosition(raw.windowPosition);
  const petScale = normalizePetScale(raw.petScale);
  const bubbleTheme = normalizeBubbleTheme(raw.bubbleTheme);

  return {
    version: DESKTOP_SETTINGS_VERSION,
    port,
    selectedPetId,
    selectedPetKey,
    petScale,
    bubbleTheme,
    alwaysOnTop: raw.alwaysOnTop !== false,
    clickThrough: raw.clickThrough === true,
    launchAtLogin: raw.launchAtLogin === true,
    activityTrayOpen: raw.activityTrayOpen === true,
    showContextMeter: raw.showContextMeter !== false,
    dndEnabled: raw.dndEnabled === true,
    windowPosition,
    notification: {
      needsInput: notificationRaw.needsInput !== false,
      blocked: notificationRaw.blocked !== false,
      completion,
    },
    sound: {
      masterEnabled: soundRaw.masterEnabled === true,
      needsInput: soundRaw.needsInput !== false,
      completion: soundRaw.completion !== false,
    },
    acknowledgedTransitionIds: normalizeIdList(raw.acknowledgedTransitionIds),
    notifiedTransitionIds: normalizeIdList(raw.notifiedTransitionIds),
    soundedTransitionIds: normalizeIdList(raw.soundedTransitionIds),
  };
}

export function parseDesktopSettingsJson(text: string): DesktopPetSettings {
  try {
    return normalizeDesktopSettings(JSON.parse(text) as unknown);
  } catch {
    return createDefaultDesktopSettings();
  }
}

export function serializeDesktopSettings(settings: DesktopPetSettings): string {
  const normalized = normalizeDesktopSettings(settings);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/** Merge a partial update without allowing forbidden keys to sneak in. */
export function updateDesktopSettings(
  current: DesktopPetSettings,
  patch: Partial<{
    port: number;
    selectedPetId: string;
    selectedPetKey: string;
    petScale: DesktopPetScale;
    bubbleTheme: DesktopPetBubbleTheme;
    alwaysOnTop: boolean;
    clickThrough: boolean;
    launchAtLogin: boolean;
    activityTrayOpen: boolean;
    showContextMeter: boolean;
    dndEnabled: boolean;
    windowPosition: { x: number; y: number } | null;
    notification: Partial<DesktopPetSettings["notification"]>;
    sound: Partial<DesktopPetSettings["sound"]>;
    acknowledgedTransitionIds: string[];
    notifiedTransitionIds: string[];
    soundedTransitionIds: string[];
  }>,
): DesktopPetSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return normalizeDesktopSettings({
    ...next,
    notification: {
      ...current.notification,
      ...(patch.notification ?? {}),
    },
    sound: {
      ...current.sound,
      ...(patch.sound ?? {}),
    },
  });
}

export function pushTransitionLru(ids: readonly string[], nextId: string): string[] {
  const id = nextId.trim();
  if (!id) return normalizeIdList(ids);
  const without = ids.filter((item) => item !== id);
  without.push(id);
  if (without.length > MAX_TRANSITION_LRU) {
    return without.slice(without.length - MAX_TRANSITION_LRU);
  }
  return without;
}

/** Settings must never carry these keys (tokens/secrets/service ownership). */
export const DESKTOP_SETTINGS_FORBIDDEN_KEYS = [
  "token",
  "observerToken",
  "accessKey",
  "password",
  "pid",
  "servicePid",
  "childPid",
  "cwd",
  "cwds",
  "prompt",
  "firstMessage",
  "command",
  "output",
  "startCommand",
] as const;

export function assertDesktopSettingsSafe(settings: unknown): void {
  const json = JSON.stringify(settings);
  for (const key of DESKTOP_SETTINGS_FORBIDDEN_KEYS) {
    // startCommand is intentionally not stored; copy text comes from connection-state.
    if (key === "startCommand") continue;
    if (new RegExp(`"${key}"\\s*:`).test(json)) {
      throw new Error(`forbidden settings key: ${key}`);
    }
  }
  // Ensure start command constant is not persisted either.
  if (json.includes(DESKTOP_START_COMMAND) && json.includes("startCommand")) {
    throw new Error("forbidden settings key: startCommand");
  }
}

function clampPort(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DESKTOP_DEFAULT_PORT;
  const port = Math.floor(n);
  if (port < 1 || port > 65535) return DESKTOP_DEFAULT_PORT;
  return port;
}

function normalizeCompletion(value: unknown): DesktopNotificationCompletionPolicy {
  if (value === "never" || value === "background-only" || value === "always") return value;
  return DESKTOP_SETTINGS_DEFAULTS.notification.completion;
}

/** Accept size tokens or the documented 1/1.2/1.5 factors; 0.85 still maps to small from older drafts. */
export function normalizePetScale(value: unknown): DesktopPetScale {
  if (value === "small" || value === "medium" || value === "large") return value;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (Number.isFinite(numeric)) {
    if (numeric === DESKTOP_PET_SCALE_FACTORS.small) return "small";
    if (numeric === DESKTOP_PET_SCALE_FACTORS.medium) return "medium";
    if (numeric === DESKTOP_PET_SCALE_FACTORS.large) return "large";
    if (numeric === 0.85) return "small";
  }
  return DESKTOP_SETTINGS_DEFAULTS.petScale;
}

export function isDesktopPetBubbleTheme(value: unknown): value is DesktopPetBubbleTheme {
  return (
    value === "cream" ||
    value === "peach" ||
    value === "night" ||
    value === "ember" ||
    value === "plum" ||
    value === "moss"
  );
}

export function normalizeBubbleTheme(value: unknown): DesktopPetBubbleTheme {
  return isDesktopPetBubbleTheme(value) ? value : DESKTOP_SETTINGS_DEFAULTS.bubbleTheme;
}

function normalizeWindowPosition(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value)) return null;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_TRANSITION_LRU) break;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
