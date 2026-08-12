/**
 * Renderer-side pure presentation helpers (U7).
 *
 * No Node, no token, no absolute URL execution — presentation only.
 */

import type { TaskObserverPresentationState } from "../../lib/task-observer-types";
import { TASK_OBSERVER_PRESENTATION_PRIORITY } from "../../lib/task-observer-types";

export type PetVisualState = TaskObserverPresentationState;

export type PetManifestStateFrame = {
  /** CSS class / asset key for animated (or default) expression. */
  frame: string;
  /** Static fallback when reduced motion is on (R11 / AE12). */
  staticFrame: string;
  /** Non-color text cue. */
  label: string;
  /** Non-color glyph/symbol cue. */
  glyph: string;
};

export type PetManifest = {
  id: string;
  name: string;
  version: number;
  states: Record<PetVisualState, PetManifestStateFrame>;
};

export const PET_STATE_ORDER: readonly PetVisualState[] = TASK_OBSERVER_PRESENTATION_PRIORITY;

const DEFAULT_FRAMES: Record<PetVisualState, PetManifestStateFrame> = {
  service_not_running: {
    frame: "service-not-running",
    staticFrame: "service-not-running",
    label: "Service not running",
    glyph: "⏻",
  },
  disconnected: {
    frame: "disconnected",
    staticFrame: "disconnected",
    label: "Disconnected",
    glyph: "⚠",
  },
  needs_input: {
    frame: "needs-input",
    staticFrame: "needs-input",
    label: "Needs input",
    glyph: "?",
  },
  blocked: {
    frame: "blocked",
    staticFrame: "blocked",
    label: "Blocked",
    glyph: "!",
  },
  ready: {
    frame: "ready",
    staticFrame: "ready",
    label: "Ready",
    glyph: "✓",
  },
  retrying: {
    frame: "retrying",
    staticFrame: "retrying-static",
    label: "Retrying",
    glyph: "↻",
  },
  running: {
    frame: "running",
    staticFrame: "running-static",
    label: "Running",
    glyph: "›",
  },
  idle: {
    frame: "idle",
    staticFrame: "idle",
    label: "Idle",
    glyph: "·",
  },
};

export function buildDefaultPetManifest(
  id: string,
  name: string,
  version = 1,
): PetManifest {
  return {
    id,
    name,
    version,
    states: { ...DEFAULT_FRAMES },
  };
}

export const BUILTIN_PET_MANIFESTS: readonly PetManifest[] = [
  buildDefaultPetManifest("snail-default", "Snail"),
  buildDefaultPetManifest("snail-classic", "Classic Snail"),
];

export function getBuiltinPetManifest(petId: string): PetManifest {
  return (
    BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId) ?? BUILTIN_PET_MANIFESTS[0]
  );
}

export function resolvePetFrame(
  manifest: PetManifest,
  state: PetVisualState,
  reducedMotion: boolean,
): { frame: string; label: string; glyph: string; animated: boolean } {
  const entry = manifest.states[state] ?? DEFAULT_FRAMES[state] ?? DEFAULT_FRAMES.idle;
  const frame = reducedMotion ? entry.staticFrame : entry.frame;
  const animated = !reducedMotion && entry.frame !== entry.staticFrame;
  return {
    frame,
    label: entry.label,
    glyph: entry.glyph,
    animated,
  };
}

export function petStateLabel(state: PetVisualState): string {
  return DEFAULT_FRAMES[state]?.label ?? state;
}

export function petStateGlyph(state: PetVisualState): string {
  return DEFAULT_FRAMES[state]?.glyph ?? "·";
}

/** Format elapsed duration for tray rows (client-side only). */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

/**
 * Keyboard selection within a flat activity id list (R11 accessibility).
 * Returns the next selected id; wraps at ends.
 */
export function moveActivitySelection(
  activityIds: readonly string[],
  currentId: string | null,
  direction: "next" | "prev",
): string | null {
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

export function connectionBannerText(input: {
  connectionStatus: string;
  canCopyStartCommand: boolean;
  startCommand: string;
  reasonCode?: string | null;
}): string | null {
  if (input.connectionStatus === "service-not-running") {
    return `蜗牛派服务未启动 — 复制 \`${input.startCommand}\` 后在终端启动，然后重试`;
  }
  if (input.connectionStatus === "incompatible") {
    if (input.reasonCode === "auth_required") {
      return "服务已开启访问密钥 — 请在下方粘贴密钥后连接";
    }
    if (input.reasonCode === "auth_invalid") {
      return "访问密钥无效 — 请重新粘贴正确的密钥";
    }
    return `不兼容的服务${input.reasonCode ? ` (${input.reasonCode})` : ""} — 请检查端口后重试`;
  }
  if (input.connectionStatus === "reconnecting" || input.connectionStatus === "probing") {
    return input.connectionStatus === "probing" ? "正在连接本地服务…" : "连接中断，正在重连…";
  }
  return null;
}
