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
import { isDndSuppressiblePresentation } from "../main/dnd-policy";
import snailClassicManifestDocument from "../assets/pets/snail-classic/manifest.json";
import snailDefaultManifestDocument from "../assets/pets/snail-default/manifest.json";
import snailSpriteManifestDocument from "../assets/pets/snail-sprite/manifest.json";
import { TASK_OBSERVER_PRESENTATION_PRIORITY } from "../../lib/task-observer-types";
import {
  type BuiltinPetId,
  type PetManifestV2,
  type PetRenderMode,
  type RendererPetCatalogEntry,
  validatePetManifestDocument,
} from "./pet-assets";
import { validateCodexPetDocument } from "./codex-pet-assets";
import { buildPetKey, parsePetKey, petCssToken, resolvePetKey } from "./pet-key";
import {
  profileFromCodexMetadata,
  profileFromSnailManifest,
  type PetRuntimeProfile,
} from "./pet-runtime-profile";

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
  /** Spritesheet timing/frame-range (present only for spritesheet pets). */
  firstFrame?: number;
  frameCount?: number;
  durationMs?: number;
  staticFrameIndex?: number;
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
  buildDefaultPetManifest("snail-sprite", "Pixel Snail"),
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
  resolvePetManifestDocument(CSS_FALLBACK_MANIFESTS[2], snailSpriteManifestDocument),
];

export function getBuiltinPetManifest(petId: string): PetManifest {
  return (
    BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId) ?? BUILTIN_PET_MANIFESTS[0]
  );
}

// ---------------------------------------------------------------------------
// Runtime custom pet manifests (U6 slice 1)
//
// Main scans the user folder, validates each document, and pushes sanitized
// assets over the narrow bridge. The renderer re-validates here before any
// id/manifest is trusted for class names or presentation.
// ---------------------------------------------------------------------------

const customPetManifests = new Map<string, PetManifest>();

export function clearCustomPetManifests(): void {
  customPetManifests.clear();
}

export function registerCustomPetManifest(manifest: PetManifest): void {
  customPetManifests.set(manifest.id, manifest);
}

export function getCustomPetManifest(petId: string): PetManifest | null {
  return customPetManifests.get(petId) ?? null;
}

/**
 * Combined builtin + runtime custom resolution. Unknown ids fall back to the
 * first builtin so a stale selectedPetId never renders blank.
 */
export function getPetManifest(petId: string): PetManifest {
  const key = resolvePetKey({ selectedPetKey: petId, selectedPetId: petId });
  const parsed = parsePetKey(key);
  if (parsed?.format === "snail") {
    const builtin = BUILTIN_PET_MANIFESTS.find((pet) => pet.id === parsed.id);
    if (builtin) return builtin;
  }
  const catalog = catalogPets.get(key);
  if (catalog) return catalog.manifest;
  const builtin = BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId);
  if (builtin) return builtin;
  return customPetManifests.get(petId) ?? BUILTIN_PET_MANIFESTS[0];
}

type CatalogPetRecord = {
  entry: RendererPetCatalogEntry;
  manifest: PetManifest;
  profile: PetRuntimeProfile;
};

const catalogPets = new Map<string, CatalogPetRecord>();

export function clearCatalogPets(): void {
  catalogPets.clear();
}

export function registerCatalogPet(entry: RendererPetCatalogEntry): PetRuntimeProfile | null {
  if (entry.format === "snail") {
    if (!entry.snailManifest) return null;
    const manifest: PetManifest = {
      id: entry.cssToken,
      name: entry.name,
      version: entry.snailManifest.version,
      renderMode: entry.snailManifest.renderMode,
      states: entry.snailManifest.states,
      sheet: entry.snailManifest.sheet,
    };
    const profile = profileFromSnailManifest(entry.snailManifest, entry.petKey);
    catalogPets.set(entry.petKey, { entry, manifest, profile });
    registerCustomPetManifest(manifest);
    return profile;
  }
  const synthetic = validateCodexPetDocument(
    {
      id: entry.id,
      displayName: entry.name,
      description: entry.description ?? undefined,
      spritesheetPath: "spritesheet.webp",
      spriteVersionNumber: entry.spriteVersion ?? 2,
    },
    entry.id,
  );
  const profile = synthetic.ok
    ? profileFromCodexMetadata(synthetic.metadata)
    : profileFromCodexMetadata({
        id: entry.id,
        displayName: entry.name,
        description: entry.description,
        spritesheetPath: "spritesheet.webp",
        spriteVersionNumber: entry.spriteVersion === 1 ? 1 : 2,
      });
  const spec = profile.sheet;
  const manifest: PetManifest = {
    id: entry.cssToken,
    name: entry.name,
    version: 2,
    renderMode: "spritesheet",
    states: { ...DEFAULT_FRAMES },
    sheet: spec
      ? {
          src: "spritesheet.webp",
          frameWidth: spec.frameWidth,
          frameHeight: spec.frameHeight,
          columns: spec.columns,
          rows: spec.rows,
        }
      : undefined,
  };
  catalogPets.set(entry.petKey, { entry, manifest, profile });
  return profile;
}

export function getCatalogPet(petKey: string): CatalogPetRecord | null {
  return catalogPets.get(petKey) ?? null;
}

export function listCatalogPets(): CatalogPetRecord[] {
  return [...catalogPets.values()];
}

export function getPetRuntimeProfile(petIdOrKey: string): PetRuntimeProfile {
  const key = resolvePetKey({ selectedPetKey: petIdOrKey, selectedPetId: petIdOrKey });
  const catalog = catalogPets.get(key);
  if (catalog) return catalog.profile;
  const manifest = getPetManifest(petIdOrKey);
  return profileFromSnailManifest(manifest, buildPetKey("snail", manifest.id));
}

export { petCssToken, resolvePetKey };

/**
 * Renderer gate for a custom pet manifest document. Spritesheet-only: CSS
 * custom manifests would render as the built-in snail anatomy and are
 * rejected to avoid false expectations.
 */
export function resolveCustomPetManifest(petId: string, raw: unknown): PetManifest | null {
  const validated = validatePetManifestDocument(raw, petId);
  if (!validated.ok) return null;
  if (validated.manifest.renderMode !== "spritesheet" || !validated.manifest.sheet) {
    return null;
  }
  const manifest = validated.manifest;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    renderMode: manifest.renderMode,
    states: manifest.states,
    sheet: manifest.sheet,
  };
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

function isPrimaryActivityActive(activity: DesktopActivityRow): boolean {
  return (
    activity.executionState === "queued" ||
    activity.executionState === "running" ||
    activity.executionState === "retrying"
  );
}

function comparePrimaryActivity(a: DesktopActivityRow, b: DesktopActivityRow): number {
  const rankDiff = PET_STATE_ORDER.indexOf(a.presentation) - PET_STATE_ORDER.indexOf(b.presentation);
  if (rankDiff !== 0) return rankDiff;
  const activeDiff = Number(isPrimaryActivityActive(b)) - Number(isPrimaryActivityActive(a));
  if (activeDiff !== 0) return activeDiff;
  const aUpdated = Date.parse(a.updatedAt ?? "") || 0;
  const bUpdated = Date.parse(b.updatedAt ?? "") || 0;
  if (aUpdated !== bUpdated) return bUpdated - aUpdated;
  return a.activityId.localeCompare(b.activityId);
}

/**
 * Pick the one activity that drives the pet, caption, and contextual action.
 * Project display-name ordering is intentionally excluded from this decision.
 */
export function selectPrimaryActivity(
  groups: readonly DesktopProjectGroup[],
): DesktopActivityRow | null {
  let primary: DesktopActivityRow | null = null;
  for (const group of groups) {
    for (const activity of group.activities) {
      if (primary == null || comparePrimaryActivity(activity, primary) < 0) {
        primary = activity;
      }
    }
  }
  return primary;
}

export type PrimaryContextMeter = {
  /** Bounded 0–100 value used only as ring geometry, never as a class/key. */
  percent: number;
  /** Rounded whole-number display value. */
  displayPercent: number;
  /** Visible text, e.g. 上下文 72%. */
  label: string;
  title: string;
  ariaLabel: string;
  level: "ok" | "warn" | "high";
};

/**
 * Compact pet-side context meter for the same activity that drives the pet.
 * Settled/ready Agent primaries still render when they carry a real percent;
 * missing/non-Agent/stale primaries hide the meter instead of borrowing another row.
 */
export function resolvePrimaryContextMeter(input: {
  activity: DesktopActivityRow | null;
  stale: boolean;
  enabled: boolean;
}): PrimaryContextMeter | null {
  if (!input.enabled || input.stale) return null;
  const activity = input.activity;
  if (activity == null || activity.source !== "agent") return null;
  const percent = activity.sessionResources?.context?.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const bounded = Math.max(0, Math.min(100, percent));
  const displayPercent = Math.round(bounded);
  const label = `上下文 ${displayPercent}%`;
  const title = `当前主任务上下文已使用 ${displayPercent}%`;
  return {
    percent: bounded,
    displayPercent,
    label,
    title,
    ariaLabel: title,
    level: bounded >= 90 ? "high" : bounded >= 80 ? "warn" : "ok",
  };
}

export type RunningCue =
  | "thinking"
  | "editing"
  | "command"
  | "subagent_one"
  | "subagent_many"
  | "generic";

const THINKING_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const EDITING_TOOL_NAMES = new Set(["edit", "write"]);
const COMMAND_TOOL_NAMES = new Set(["bash"]);

const RUNNING_CUE_VISUALS: Record<RunningCue, { glyph: string; label: string }> = {
  thinking: { glyph: "…", label: "思考中" },
  editing: { glyph: "✎", label: "编辑中" },
  command: { glyph: "›_", label: "命令中" },
  subagent_one: { glyph: "1", label: "协作中" },
  subagent_many: { glyph: "2+", label: "协作中" },
  generic: { glyph: "›", label: "运行中" },
};

/**
 * Classify only existing bounded observer fields. Raw tool names are matched
 * against exact local allowlists and never escape as CSS/resource identifiers.
 */
export function resolveRunningCue(activity: DesktopActivityRow | null): RunningCue {
  if (
    activity == null ||
    activity.source !== "agent" ||
    activity.presentation !== "running" ||
    (activity.executionState !== "queued" && activity.executionState !== "running")
  ) {
    return "generic";
  }

  const progress = activity.progress;
  if (progress.kind !== "counters") {
    return activity.phase === "running" && progress.kind === "indeterminate"
      ? "thinking"
      : "generic";
  }

  const activeSubagents = Math.max(0, Math.floor(progress.activeSubagents ?? 0));
  const toolName = progress.currentToolName?.trim();
  // A top-level tool and Subagent running together do not provide one reliable
  // dominant phase, so the aggregate visual stays generic.
  if (activeSubagents > 0 && toolName) return "generic";
  if (activeSubagents >= 2) return "subagent_many";
  if (activeSubagents === 1) return "subagent_one";
  if (!toolName) return activity.phase === "running" ? "thinking" : "generic";
  if (THINKING_TOOL_NAMES.has(toolName)) return "thinking";
  if (EDITING_TOOL_NAMES.has(toolName)) return "editing";
  if (COMMAND_TOOL_NAMES.has(toolName)) return "command";
  return "generic";
}

export function resolveRunningCueVisual(
  cue: RunningCue,
): { glyph: string; label: string } {
  return RUNNING_CUE_VISUALS[cue];
}

const RUNNING_TOOL_DETAIL: Readonly<Record<string, string>> = {
  read: "正在读取",
  grep: "正在搜索",
  find: "正在查找文件",
  ls: "正在浏览目录",
  edit: "正在编辑",
  write: "正在写入",
  bash: "正在运行命令",
};

/** Build the compact Codex-style action line from bounded observer fields only. */
export function formatPetActivityDetail(
  activity: DesktopActivityRow | null,
  presentation: PetVisualState,
  runningCue: RunningCue = "generic",
): string {
  if (presentation === "retrying") return "正在重试";
  if (presentation !== "running") return petStateLabel(presentation);

  if (activity?.progress.kind === "counters") {
    const toolName = activity.progress.currentToolName?.trim();
    if (toolName) {
      const action = RUNNING_TOOL_DETAIL[toolName];
      return action ? `${action} · ${toolName}` : `正在使用 ${toolName}`;
    }
    const activeSubagents = Math.max(
      0,
      Math.floor(activity.progress.activeSubagents ?? 0),
    );
    if (activeSubagents > 0) {
      return activeSubagents === 1
        ? "正在协作 · 1 个任务"
        : `正在协作 · ${activeSubagents} 个任务`;
    }
  }

  const cueLabel = resolveRunningCueVisual(runningCue).label;
  return cueLabel === "运行中" ? "正在执行" : cueLabel;
}

export const RUNNING_CUE_MIN_DWELL_MS = 900;
export const RUNNING_CUE_DEBOUNCE_MS = 250;

export type RunningCueState = {
  active: boolean;
  cue: RunningCue;
  shownAt: number;
  candidateCue: RunningCue | null;
  candidateSince: number | null;
};

export type RunningCueSignal = {
  presentation: PetVisualState;
  cue: RunningCue;
};

export function createInitialRunningCueState(): RunningCueState {
  return {
    active: false,
    cue: "generic",
    shownAt: 0,
    candidateCue: null,
    candidateSince: null,
  };
}

/**
 * Keep Running modifiers stable across rapid tool switches. Leaving Running is
 * always immediate so attention/terminal/connection states can preempt.
 */
export function reduceRunningCueState(
  state: RunningCueState,
  signal: RunningCueSignal,
  now: number,
): RunningCueState {
  if (signal.presentation !== "running") {
    return {
      active: false,
      cue: "generic",
      shownAt: now,
      candidateCue: null,
      candidateSince: null,
    };
  }
  if (!state.active) {
    return {
      active: true,
      cue: signal.cue,
      shownAt: now,
      candidateCue: null,
      candidateSince: null,
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
    state.candidateSince + RUNNING_CUE_DEBOUNCE_MS,
  );
  if (now < switchAt) return state;
  return {
    active: true,
    cue: signal.cue,
    shownAt: now,
    candidateCue: null,
    candidateSince: null,
  };
}

export function runningCueNextUpdateAt(state: RunningCueState): number | null {
  if (!state.active || state.candidateCue == null || state.candidateSince == null) {
    return null;
  }
  return Math.max(
    state.shownAt + RUNNING_CUE_MIN_DWELL_MS,
    state.candidateSince + RUNNING_CUE_DEBOUNCE_MS,
  );
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

export function formatActiveModel(
  model: DesktopActivityRow["activeModel"],
): string | null {
  return model ? `${model.provider}/${model.modelId}` : null;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/** Compact current-session context, weighted TPS, and billing for one Agent row. */
export function formatSessionResources(
  resources: DesktopActivityRow["sessionResources"],
): string | null {
  if (!resources) return null;
  const parts: string[] = [];
  if (resources.context) {
    const contextValue = resources.context.percent !== null
      ? `${resources.context.percent.toFixed(0)}%`
      : `?/${formatCompactNumber(resources.context.contextWindow)}`;
    parts.push(`上下文 ${contextValue}`);
  }
  if (resources.performance) {
    const avgTps = resources.performance.avgTps >= 100
      ? resources.performance.avgTps.toFixed(0)
      : resources.performance.avgTps.toFixed(1);
    parts.push(`${avgTps} t/s`);
  }
  if (resources.billing) {
    if (resources.billing.costUsd > 0) {
      parts.push(
        resources.billing.costUsd >= 0.01
          ? `$${resources.billing.costUsd.toFixed(2)}`
          : "<$0.01",
      );
    } else if (resources.billing.totalTokens > 0) {
      parts.push(`${formatCompactNumber(resources.billing.totalTokens)} tokens`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
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
  /** Manual DND silences task-state bubbles but never connection diagnostics. */
  dndEnabled: boolean;
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
    return "persistent";
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
  // DND silences proactive task-state bubbles; connection diagnostics
  // (service_not_running / disconnected) stay visible.
  const dndSilenced =
    event.signal.dndEnabled && isDndSuppressiblePresentation(event.signal.presentation);
  if (signalKey === state.signalKey) {
    if (mode == null) {
      return { ...state, visible: false, mode: null, expiresAt: null };
    }
    if (state.dismissedSignalKey === signalKey) {
      return { ...state, visible: false, mode, expiresAt: null };
    }
    if (dndSilenced) {
      // Enabling DND closes an active suppressible bubble immediately. The
      // transition is treated as silently handled, so disabling DND later
      // never re-opens it (no replay).
      return {
        ...state,
        dismissedSignalKey: state.dismissedSignalKey ?? signalKey,
        visible: false,
        mode,
        expiresAt: null,
      };
    }
    if (mode === "transient" && state.expiresAt != null && event.now >= state.expiresAt) {
      return { ...state, visible: false, expiresAt: null };
    }
    return { ...state, mode };
  }

  const visible =
    !dndSilenced && (mode === "persistent" || (mode === "transient" && !event.signal.reset));
  return {
    signalKey,
    transitionId: event.signal.transitionId,
    dismissedSignalKey: dndSilenced ? signalKey : null,
    visible,
    mode,
    expiresAt:
      visible && mode === "transient" ? event.now + PET_BUBBLE_TRANSIENT_MS : null,
  };
}

// ---------------------------------------------------------------------------
// Completion celebration dedup + coalescing (pure)
// ---------------------------------------------------------------------------

/** Completions landing within this window share one confetti burst (P2). */
export const PET_CELEBRATE_COALESCE_MS = 1500;

export type PetCelebrateState = {
  /** Transition id of the last ready transition already covered by a burst. */
  lastTransitionId: string | null;
  /** Wall clock of the last burst (null until one fires). */
  lastCelebratedAt: number | null;
};

export type PetCelebrateSignal = {
  presentation: PetVisualState;
  transitionId: string | null;
  reducedMotion: boolean;
  /** Initial/reset snapshot establishes a baseline instead of replaying a burst. */
  reset: boolean;
};

export function createInitialPetCelebrateState(): PetCelebrateState {
  return { lastTransitionId: null, lastCelebratedAt: null };
}

/**
 * Decide whether a ready transition should fire one confetti burst.
 * Same transition replay, reset/baseline, reduced-motion and non-ready states
 * never celebrate; a fresh ready transition celebrates once, and multiple
 * completions within the coalesce window collapse into a single burst.
 */
export function shouldCelebrateCompletion(
  state: PetCelebrateState,
  signal: PetCelebrateSignal,
  now: number,
): { celebrate: boolean; state: PetCelebrateState } {
  if (signal.reducedMotion) return { celebrate: false, state };
  if (signal.presentation !== "ready") return { celebrate: false, state };
  if (signal.reset) return { celebrate: false, state };
  const transitionId = signal.transitionId?.trim() || null;
  if (!transitionId) return { celebrate: false, state };
  if (transitionId === state.lastTransitionId) return { celebrate: false, state };
  if (
    state.lastCelebratedAt != null &&
    now - state.lastCelebratedAt < PET_CELEBRATE_COALESCE_MS
  ) {
    // Absorb the completion into the active burst instead of starting a storm.
    return { celebrate: false, state: { ...state, lastTransitionId: transitionId } };
  }
  return {
    celebrate: true,
    state: { lastTransitionId: transitionId, lastCelebratedAt: now },
  };
}

// ---------------------------------------------------------------------------
// One-shot semantic transition actions (P2)
// ---------------------------------------------------------------------------

export type PetTransitionAction = "ready-to-idle-sink" | "retrying-to-running-go";

/**
 * Map a real aggregate presentation change to a short, interruptible transition
 * action. Null means no transition action (same state, baseline, or reduced
 * motion). Frequent same-state snapshots never replay these.
 */
export function resolvePetTransitionAction(
  from: PetVisualState | null,
  to: PetVisualState,
  reducedMotion: boolean,
): PetTransitionAction | null {
  if (reducedMotion) return null;
  if (from === "ready" && to === "idle") return "ready-to-idle-sink";
  if (from === "retrying" && to === "running") return "retrying-to-running-go";
  return null;
}

// ---------------------------------------------------------------------------
// Idle-life scheduling policy (pure, P2)
// ---------------------------------------------------------------------------

export const PET_BLINK_DELAY_MIN_MS = 2600;
export const PET_BLINK_DELAY_RANGE_MS = 4600;
export const PET_ACT_DELAY_MIN_MS = 6500;
export const PET_ACT_DELAY_RANGE_MS = 7500;

/** Next random blink delay (injectable random for tests). */
export function nextBlinkDelayMs(random: () => number = Math.random): number {
  return PET_BLINK_DELAY_MIN_MS + random() * PET_BLINK_DELAY_RANGE_MS;
}

/** Next random idle-act delay (injectable random for tests). */
export function nextActDelayMs(random: () => number = Math.random): number {
  return PET_ACT_DELAY_MIN_MS + random() * PET_ACT_DELAY_RANGE_MS;
}

/**
 * Pure gate for decorative idle life (blink + random acts). Off while hidden,
 * reduced-motion, pressed, dragging, or not in the animated idle pose.
 */
export function shouldRunIdleLife(input: {
  animated: boolean;
  idle: boolean;
  hidden: boolean;
  reducedMotion: boolean;
  pressed: boolean;
  dragging: boolean;
}): boolean {
  return (
    input.animated &&
    input.idle &&
    !input.hidden &&
    !input.reducedMotion &&
    !input.pressed &&
    !input.dragging
  );
}

// ---------------------------------------------------------------------------
// Progressive idle sleep stages (renderer-local decorative, U3)
//
// The observer stays `idle` the whole time; this only grades how long the pet
// has been presented in idle so the renderer can add a drowsy/asleep posture.
// It never writes observer snapshots, the Activity tray, settings or the server.
// ---------------------------------------------------------------------------

export const PET_SLEEPY_AFTER_MS = 45_000;
export const PET_SLEEPING_AFTER_MS = 120_000;
/** Hover/pointermove wake throttle: one pointer pass never rebuilds the timer per move. */
export const PET_IDLE_POINTER_WAKE_THROTTLE_MS = 800;

export type IdleSleepStage = "awake" | "sleepy" | "sleeping";

/**
 * Map local idle duration to a decorative sleep stage. Invalid and negative
 * durations collapse to awake; the sleepy/sleeping boundaries are inclusive.
 */
export function resolveIdleSleepStage(elapsedIdleMs: number): IdleSleepStage {
  if (!Number.isFinite(elapsedIdleMs) || elapsedIdleMs < 0) return "awake";
  if (elapsedIdleMs < PET_SLEEPY_AFTER_MS) return "awake";
  if (elapsedIdleMs < PET_SLEEPING_AFTER_MS) return "sleepy";
  return "sleeping";
}

/**
 * Remaining milliseconds until the next stage boundary, or null when the
 * stage is terminal (sleeping has no further transition).
 */
export function nextIdleSleepBoundaryMs(
  stage: IdleSleepStage,
  elapsedIdleMs: number,
): number | null {
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

/**
 * Decorative idle sleep only runs while the pet is genuinely presented idle,
 * visible, motion-allowed, and free of a press/drag gesture. Any real state
 * (attention, terminal, running, connection) or interaction turns this off.
 */
export function shouldRunProgressiveSleep(input: {
  idle: boolean;
  hidden: boolean;
  reducedMotion: boolean;
  pressed: boolean;
  dragging: boolean;
}): boolean {
  return (
    input.idle &&
    !input.hidden &&
    !input.reducedMotion &&
    !input.pressed &&
    !input.dragging
  );
}

export type IdleSleepSignal = {
  presentation: PetVisualState;
  hidden: boolean;
  reducedMotion: boolean;
  pressed: boolean;
  dragging: boolean;
};

export type IdleSleepState = {
  stage: IdleSleepStage;
  /** Wall clock the idle presentation first began; never advanced by same-state snapshots. */
  idleSince: number | null;
  /** Absolute timestamp for the next boundary timer; null when no timer is needed. */
  nextBoundaryAt: number | null;
};

export function createInitialIdleSleepState(): IdleSleepState {
  return { stage: "awake", idleSince: null, nextBoundaryAt: null };
}

/**
 * Pure reducer for the renderer's single local sleep timer. Same-state
 * snapshots (revision/resource refresh) keep `idleSince` and `nextBoundaryAt`
 * stable; leaving idle, hiding, reduced-motion or a press/drag gesture resets
 * to awake with no pending timer.
 */
export function reduceIdleSleepState(
  state: IdleSleepState,
  signal: IdleSleepSignal,
  now: number,
): IdleSleepState {
  const idle = signal.presentation === "idle";
  if (
    !shouldRunProgressiveSleep({
      idle,
      hidden: signal.hidden,
      reducedMotion: signal.reducedMotion,
      pressed: signal.pressed,
      dragging: signal.dragging,
    })
  ) {
    return createInitialIdleSleepState();
  }
  const idleSince = state.idleSince ?? now;
  const elapsed = Math.max(0, now - idleSince);
  const stage = resolveIdleSleepStage(elapsed);
  const boundaryDelay = nextIdleSleepBoundaryMs(stage, elapsed);
  return {
    stage,
    idleSince,
    nextBoundaryAt: boundaryDelay == null ? null : now + boundaryDelay,
  };
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

/** Desktop-local unread count for the pet badge. Never use server aggregate.ready. */
export function countUnreadActivities(
  groups: readonly DesktopProjectGroup[],
): number {
  let count = 0;
  for (const group of groups) {
    count += group.counts.unread;
  }
  return count;
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

// ---------------------------------------------------------------------------
// Fun click reactions (U4b/U4c): idle/running/retrying single-click interacts;
// a second click in the same burst upgrades to flail. Attention, terminal and
// connection states never spend the body click on a greeting.
// ---------------------------------------------------------------------------

export type PetReaction = "poke" | "flail";

export type PetBodyClickAction = "close-tray" | "jump-primary" | "interact" | "open-tray";

export type PetIntentMenuTrigger = "hover" | "right-click";

export type PetIntentMenuPresentation = {
  trigger: PetIntentMenuTrigger;
  showChromeClose: boolean;
  showMenuHideAction: boolean;
  hoverRevealsMenu: boolean;
};

/**
 * Hover chips + chrome X stay the default. The optional right-click mode
 * hides hover chrome and folds close into the same shortcut list.
 */
export function resolvePetIntentMenuPresentation(
  rightClickAggregatedMenu: boolean,
): PetIntentMenuPresentation {
  const trigger: PetIntentMenuTrigger =
    rightClickAggregatedMenu === true ? "right-click" : "hover";
  return {
    trigger,
    showChromeClose: trigger === "hover",
    showMenuHideAction: trigger === "right-click",
    hoverRevealsMenu: trigger === "hover",
  };
}

/** Maximum gap between consecutive clicks that still extends a click sequence. */
export const PET_DOUBLE_CLICK_INTERVAL_MS = 320;
/** Total window (first → last click) a quadruple click must fit within. */
export const PET_QUAD_CLICK_WINDOW_MS = 900;
/** CSS animation duration for the poke reaction. */
export const PET_POKE_ANIMATION_MS = 380;
/** CSS animation duration for the flail reaction. */
export const PET_FLAIL_ANIMATION_MS = 750;

export type PetClickSequenceState = {
  /** Ascending timestamps of the current click sequence. */
  clickTimes: number[];
  /** Reaction deferred while waiting to see whether a flail supersedes it. */
  pendingReaction: PetReaction | null;
  /** Reaction already committed for this sequence; blocks re-toggles/re-fires. */
  committedReaction: PetReaction | null;
};

export function createInitialPetClickSequenceState(): PetClickSequenceState {
  return { clickTimes: [], pendingReaction: null, committedReaction: null };
}

export type PetClickSequenceEvent =
  | { type: "click"; now: number }
  | { type: "commit"; now: number }
  | { type: "cancel" };

export type PetClickSequenceOutcome = {
  state: PetClickSequenceState;
  /** First click of a burst: caller maps this to interact or tray/jump. */
  singleClick: boolean;
  /** Start this reaction now (flail upgrade, or a leftover poke commit). */
  startReaction: PetReaction | null;
  /** Cancel this pending reaction (flail supersedes a deferred poke). */
  cancelReaction: PetReaction | null;
};

/**
 * Map extra clicks in an interact burst to a reaction. The first click is the
 * greeting (wave / poke); a second click inside the burst upgrades to flail.
 */
export function resolvePetReaction(
  clickCount: number,
  elapsedMs: number,
): PetReaction | null {
  if (clickCount >= 2 && elapsedMs <= PET_QUAD_CLICK_WINDOW_MS) return "flail";
  return null;
}

/** Decorative greetings stay off attention, terminal, and connection states. */
export function canPlayPetInteract(
  presentation: PetVisualState,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion) return false;
  return presentation === "idle" || presentation === "running" || presentation === "retrying";
}

export function shouldAllowPetReaction(
  presentation: PetVisualState,
  reducedMotion: boolean,
): boolean {
  return canPlayPetInteract(presentation, reducedMotion);
}

/**
 * Body-click routing. Tray toggle stays on the hover 「活动」 entry and on the
 * pet itself when the tray is already open or the click is a work/attention hit.
 */
export function resolvePetBodyClick(input: {
  trayOpen: boolean;
  presentation: PetVisualState;
  reducedMotion: boolean;
  canJumpPrimary: boolean;
}): PetBodyClickAction {
  if (input.trayOpen) return "close-tray";
  if (input.canJumpPrimary) return "jump-primary";
  if (canPlayPetInteract(input.presentation, input.reducedMotion)) return "interact";
  return "open-tray";
}

function noClickOutcome(state: PetClickSequenceState): PetClickSequenceOutcome {
  return { state, singleClick: false, startReaction: null, cancelReaction: null };
}

/**
 * Pure click-sequence reducer. Callers inject wall-clock timestamps and own the
 * two short timers (the deferred-poke commit and the reaction class removal).
 * Drag, pointercancel, lost capture, hiding, state preemption and teardown all
 * feed `cancel`.
 */
export function reducePetClickSequence(
  state: PetClickSequenceState,
  event: PetClickSequenceEvent,
): PetClickSequenceOutcome {
  if (event.type === "cancel") {
    return noClickOutcome(createInitialPetClickSequenceState());
  }

  if (event.type === "commit") {
    if (state.pendingReaction !== "poke") return noClickOutcome(state);
    return {
      state: {
        clickTimes: state.clickTimes,
        pendingReaction: null,
        committedReaction: "poke",
      },
      singleClick: false,
      startReaction: "poke",
      cancelReaction: null,
    };
  }

  // type === "click"
  const last = state.clickTimes[state.clickTimes.length - 1];
  // A click beyond the double-click interval ends the prior sequence and starts
  // a fresh single click.
  if (last !== undefined && event.now - last > PET_DOUBLE_CLICK_INTERVAL_MS) {
    return {
      state: { clickTimes: [event.now], pendingReaction: null, committedReaction: null },
      singleClick: true,
      startReaction: null,
      cancelReaction: null,
    };
  }
  // A committed reaction already owns this sequence: rapid follow-ups are inert
  // so the tray never flaps and the same reaction never re-fires.
  if (state.committedReaction !== null) {
    return noClickOutcome(state);
  }

  const clickTimes = [...state.clickTimes, event.now];
  if (state.clickTimes.length === 0) {
    return {
      state: { clickTimes, pendingReaction: null, committedReaction: null },
      singleClick: true,
      startReaction: null,
      cancelReaction: null,
    };
  }

  const reaction = resolvePetReaction(clickTimes.length, event.now - clickTimes[0]);
  if (reaction === "flail") {
    return {
      state: { clickTimes, pendingReaction: null, committedReaction: "flail" },
      singleClick: false,
      startReaction: "flail",
      cancelReaction: state.pendingReaction,
    };
  }
  if (reaction === "poke") {
    return {
      state: { clickTimes, pendingReaction: "poke", committedReaction: null },
      singleClick: false,
      startReaction: null,
      cancelReaction: null,
    };
  }
  // Three clicks (or a slow quad beyond the window): keep the poke deferred.
  return {
    state: { clickTimes, pendingReaction: state.pendingReaction, committedReaction: null },
    singleClick: false,
    startReaction: null,
    cancelReaction: null,
  };
}
