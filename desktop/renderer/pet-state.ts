/**
 * Renderer-side pure presentation helpers (U7).
 *
 * No Node, no token, no absolute URL execution — presentation only.
 */

import type {
  TaskObserverOutcome,
  TaskObserverPresentationState,
  TaskObserverProgress,
  TaskObserverSource,
} from "../../lib/task-observer-types";
import type { DesktopActivityRow, DesktopProjectGroup } from "../main/activity-store";
import snailClassicManifestDocument from "../assets/pets/snail-classic/manifest.json";
import snailDefaultManifestDocument from "../assets/pets/snail-default/manifest.json";
import { TASK_OBSERVER_PRESENTATION_PRIORITY } from "../../lib/task-observer-types";
import {
  type BuiltinPetId,
  type PetManifestV2,
  type PetRenderMode,
  validatePetManifestDocument,
} from "./pet-assets";

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
  renderMode: PetRenderMode;
  states: Record<PetVisualState, PetManifestStateFrame>;
  sheet?: PetManifestV2["sheet"];
};

export const PET_STATE_ORDER: readonly PetVisualState[] = TASK_OBSERVER_PRESENTATION_PRIORITY;

const DEFAULT_FRAMES: Record<PetVisualState, PetManifestStateFrame> = {
  service_not_running: {
    frame: "service-not-running",
    staticFrame: "service-not-running",
    // Short zh labels fit the collapsed avatar without clipping.
    label: "未启动",
    glyph: "⏻",
  },
  disconnected: {
    frame: "disconnected",
    staticFrame: "disconnected",
    label: "未连接",
    glyph: "⚠",
  },
  needs_input: {
    frame: "needs-input",
    staticFrame: "needs-input",
    label: "待输入",
    glyph: "?",
  },
  blocked: {
    frame: "blocked",
    staticFrame: "blocked",
    label: "受阻",
    glyph: "!",
  },
  ready: {
    frame: "ready",
    staticFrame: "ready",
    label: "已完成",
    glyph: "✓",
  },
  retrying: {
    frame: "retrying",
    staticFrame: "retrying-static",
    label: "重试中",
    glyph: "↻",
  },
  running: {
    frame: "running",
    staticFrame: "running-static",
    label: "运行中",
    glyph: "›",
  },
  idle: {
    frame: "idle",
    staticFrame: "idle",
    label: "空闲",
    glyph: "·",
  },
};

export function buildDefaultPetManifest(
  id: BuiltinPetId,
  name: string,
): PetManifest {
  return {
    id,
    name,
    version: 2,
    renderMode: "css",
    states: { ...DEFAULT_FRAMES },
  };
}

const CSS_FALLBACK_MANIFESTS: readonly PetManifest[] = [
  buildDefaultPetManifest("snail-default", "Snail"),
  buildDefaultPetManifest("snail-classic", "Classic Snail"),
];

function resolvePetManifestDocument(fallback: PetManifest, raw: unknown): PetManifest {
  const validated = validatePetManifestDocument(raw);
  if (!validated.ok || validated.manifest.id !== fallback.id) return fallback;
  return {
    id: validated.manifest.id,
    name: validated.manifest.name,
    version: validated.manifest.version,
    renderMode: validated.manifest.renderMode,
    states: validated.manifest.states,
    sheet: validated.manifest.sheet,
  };
}

/** Built-in documents are bundled, validated, and replaced by CSS fallbacks on failure. */
export const BUILTIN_PET_MANIFESTS: readonly PetManifest[] = [
  resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[0], snailDefaultManifestDocument),
  resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[1], snailClassicManifestDocument),
];

export function getBuiltinPetManifest(petId: string): PetManifest {
  return (
    BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId) ?? BUILTIN_PET_MANIFESTS[0]
  );
}

/**
 * Runtime load: accept a validated v2 document or fall back to CSS defaults.
 * Unknown ids, illegal versions, capability fields, or path traversal never throw.
 */
export function resolveBuiltinPetManifest(petId: string, raw?: unknown): PetManifest {
  const fallback =
    CSS_FALLBACK_MANIFESTS.find((pet) => pet.id === petId) ?? CSS_FALLBACK_MANIFESTS[0];
  if (raw === undefined) return getBuiltinPetManifest(fallback.id);
  return resolvePetManifestDocument(fallback, raw);
}

export function resolvePetFrame(
  manifest: PetManifest,
  state: PetVisualState,
  reducedMotion: boolean,
): { frame: string; label: string; glyph: string; animated: boolean } {
  const entry = manifest.states[state] ?? DEFAULT_FRAMES[state] ?? DEFAULT_FRAMES.idle;
  const frame = reducedMotion ? entry.staticFrame : entry.frame;
  // CSS personalities add posture/micro-motion even when the manifest frame key is shared.
  const animated =
    !reducedMotion && state !== "service_not_running" && state !== "disconnected";
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

/**
 * Terminal-result copy, independent of local unread presentation.
 * A read (idle-presented) failed task must still read "失败", never "空闲".
 */
export function petTerminalOutcome(
  outcome: TaskObserverOutcome,
): { label: string; glyph: string } | null {
  switch (outcome) {
    case "succeeded":
      return { label: "已完成", glyph: "✓" };
    case "cancelled":
      return { label: "已取消", glyph: "×" };
    case "failed":
      return { label: "失败", glyph: "!" };
    case "interrupted":
      return { label: "已中断", glyph: "!" };
    case "ambiguous":
      return { label: "失败", glyph: "!" };
    default:
      return null;
  }
}

const SOURCE_LABELS: Record<TaskObserverSource, string> = {
  agent: "Agent",
  snflow: "SnFlow",
  automation: "自动化",
  quick_command: "快捷命令",
};

export function petSourceLabel(source: TaskObserverSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Format only verifiable observer progress; never invent a percentage. */
export function formatActivityProgress(
  progress: TaskObserverProgress,
  childCount = 0,
): string | null {
  if (progress.kind === "ratio") {
    const current = Math.max(0, Math.floor(progress.current));
    const total = Math.max(0, Math.floor(progress.total));
    if (total <= 0) return null;
    const boundedCurrent = Math.min(current, total);
    return `${boundedCurrent}/${total} · ${Math.round((boundedCurrent / total) * 100)}%`;
  }
  if (progress.kind === "counters") {
    const parts: string[] = [];
    if (progress.currentToolName) parts.push(progress.currentToolName);
    if (typeof progress.turnCount === "number") parts.push(`${progress.turnCount} 回合`);
    if (typeof progress.toolCount === "number") parts.push(`${progress.toolCount} 工具`);
    const active = progress.activeSubagents ?? 0;
    const completed = progress.completedSubagents ?? 0;
    const subagents = Math.max(childCount, active + completed);
    if (subagents > 0) parts.push(`${subagents} Subagent`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return childCount > 0 ? `${childCount} Subagent` : null;
}

/** Recompute an activity duration locally without requesting a new server snapshot. */
export function resolveActivityElapsedMs(
  activity: Pick<DesktopActivityRow, "startedAt" | "endedAt" | "elapsedMs">,
  now: number,
): number | null {
  const start = Date.parse(activity.startedAt ?? "");
  const end = activity.endedAt ? Date.parse(activity.endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return activity.elapsedMs;
  return Math.max(0, Math.floor(end - start));
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

export const PET_BUBBLE_TRANSIENT_MS = 4500;

export type PetBubbleMode = "persistent" | "transient" | null;

export type PetBubbleSignal = {
  presentation: PetVisualState;
  transitionId: string | null;
  revision: number | null;
  instanceId: string | null;
  unread: boolean;
  /** Initial/reset snapshots establish a baseline instead of replaying transient bubbles. */
  reset: boolean;
};

export type PetBubbleState = {
  signalKey: string | null;
  transitionId: string | null;
  dismissedSignalKey: string | null;
  visible: boolean;
  mode: PetBubbleMode;
  expiresAt: number | null;
};

export type PetBubbleEvent =
  | { type: "snapshot"; signal: PetBubbleSignal; now: number }
  | { type: "viewed"; transitionId: string | null }
  | { type: "tick"; now: number };

export function createInitialPetBubbleState(): PetBubbleState {
  return {
    signalKey: null,
    transitionId: null,
    dismissedSignalKey: null,
    visible: false,
    mode: null,
    expiresAt: null,
  };
}

function petBubbleSignalKey(signal: PetBubbleSignal): string {
  const transitionId = signal.transitionId?.trim();
  if (transitionId) return `${signal.presentation}:transition:${transitionId}`;
  if (signal.presentation === "service_not_running" || signal.presentation === "disconnected") {
    return `${signal.presentation}:connection:${signal.instanceId ?? "none"}`;
  }
  return `${signal.presentation}:revision:${signal.instanceId ?? "none"}:${signal.revision ?? "none"}`;
}

function petBubbleMode(signal: PetBubbleSignal): PetBubbleMode {
  if (
    signal.presentation === "needs_input" ||
    signal.presentation === "blocked" ||
    signal.presentation === "service_not_running" ||
    signal.presentation === "disconnected"
  ) {
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

/** Pure transition/revision reducer; callers inject time and own the single local timer. */
export function reducePetBubbleState(
  state: PetBubbleState,
  event: PetBubbleEvent,
): PetBubbleState {
  if (event.type === "viewed") {
    if (!event.transitionId || event.transitionId !== state.transitionId) return state;
    return {
      ...state,
      dismissedSignalKey: state.signalKey,
      visible: false,
      expiresAt: null,
    };
  }

  if (event.type === "tick") {
    if (
      state.mode !== "transient" ||
      state.expiresAt == null ||
      event.now < state.expiresAt ||
      !state.visible
    ) {
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

  const visible = mode === "persistent" || (mode === "transient" && !event.signal.reset);
  return {
    signalKey,
    transitionId: event.signal.transitionId,
    dismissedSignalKey: null,
    visible,
    mode,
    expiresAt:
      visible && mode === "transient" ? event.now + PET_BUBBLE_TRANSIENT_MS : null,
  };
}

// ---------------------------------------------------------------------------
// Completion celebration dedup (pure)
// ---------------------------------------------------------------------------

export type PetCelebrateState = {
  /** Transition id of the last ready transition that already produced a burst. */
  lastTransitionId: string | null;
};

export type PetCelebrateSignal = {
  presentation: PetVisualState;
  transitionId: string | null;
  reducedMotion: boolean;
  /** Initial/reset snapshot establishes a baseline instead of replaying a burst. */
  reset: boolean;
};

export function createInitialPetCelebrateState(): PetCelebrateState {
  return { lastTransitionId: null };
}

/**
 * Decide whether a ready transition should fire one confetti burst.
 * Same transition replay, reset/baseline, reduced-motion and non-ready states
 * never celebrate; a fresh ready transition celebrates exactly once.
 */
export function shouldCelebrateCompletion(
  state: PetCelebrateState,
  signal: PetCelebrateSignal,
): { celebrate: boolean; state: PetCelebrateState } {
  if (signal.reducedMotion) return { celebrate: false, state };
  if (signal.presentation !== "ready") return { celebrate: false, state };
  if (signal.reset) return { celebrate: false, state };
  const transitionId = signal.transitionId?.trim() || null;
  if (!transitionId) return { celebrate: false, state };
  if (transitionId === state.lastTransitionId) return { celebrate: false, state };
  return { celebrate: true, state: { lastTransitionId: transitionId } };
}

export type DesktopActivityFilter = "all" | "attention" | "running" | "completed";

export type DesktopActivityFilterCounts = Record<DesktopActivityFilter, number>;

export function activityMatchesFilter(
  activity: DesktopActivityRow,
  filter: DesktopActivityFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return activity.presentation === "needs_input" || activity.presentation === "blocked";
    case "running":
      return (
        activity.executionState === "queued" ||
        activity.executionState === "running" ||
        activity.executionState === "retrying"
      );
    case "completed":
      return activity.executionState === "settled";
    default: {
      const _exhaustive: never = filter;
      return _exhaustive;
    }
  }
}

/** Renderer-local projection only; source view and server task state remain unchanged. */
export function filterProjectGroups(
  groups: readonly DesktopProjectGroup[],
  filter: DesktopActivityFilter,
): DesktopProjectGroup[] {
  if (filter === "all") {
    return groups.map((group) => ({ ...group, activities: [...group.activities] }));
  }
  return groups.flatMap((group) => {
    const activities = group.activities.filter((activity) =>
      activityMatchesFilter(activity, filter),
    );
    return activities.length > 0 ? [{ ...group, activities }] : [];
  });
}

export function countActivitiesByFilter(
  groups: readonly DesktopProjectGroup[],
): DesktopActivityFilterCounts {
  const counts: DesktopActivityFilterCounts = {
    all: 0,
    attention: 0,
    running: 0,
    completed: 0,
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

/**
 * Reset a filtered-list cursor to the first visible item when its row disappears.
 */
export function resolveActivitySelection(
  activityIds: readonly string[],
  currentId: string | null,
): string | null {
  if (activityIds.length === 0) return null;
  return currentId != null && activityIds.includes(currentId) ? currentId : activityIds[0];
}

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
      return "服务已开启访问密钥 — 请在桌宠设置中粘贴密钥后连接";
    }
    if (input.reasonCode === "auth_invalid") {
      return "访问密钥无效 — 请在桌宠设置中重新填写";
    }
    return `不兼容的服务${input.reasonCode ? ` (${input.reasonCode})` : ""} — 请检查端口后重试`;
  }
  if (input.connectionStatus === "reconnecting" || input.connectionStatus === "probing") {
    return input.connectionStatus === "probing" ? "正在连接本地服务…" : "连接中断，正在重连…";
  }
  return null;
}
