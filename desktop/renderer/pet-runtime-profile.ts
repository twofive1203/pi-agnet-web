/**
 * Unified pet runtime profile.
 *
 * Snail manifests and Codex fixed atlases both project into this shape.
 * Business presentation states stay owned by the observer; Codex actions
 * are only a mapping target and never leak into task state.
 */

import {
  CODEX_PET_COLUMNS,
  CODEX_PET_V2_ROWS,
  codexAtlasSpec,
  type CodexPetMetadata,
  type CodexSpriteVersion,
} from "./codex-pet-assets";
import { buildPetKey, petCssToken } from "./pet-key";
import {
  PET_REQUIRED_STATES,
  type PetManifestV2,
  type PetRequiredState,
} from "./pet-assets";

export type PetClipFrame = {
  cellIndex: number;
  durationMs: number;
};

export type PetRuntimeClip = {
  name: string;
  frames: PetClipFrame[];
  /** Index into `frames` used for reduced-motion / static fallback. */
  staticFrameIndex: number;
};

export type PetStateClipBinding = {
  clipName: string;
  /** Connection-like states stay on a single frame even when motion is allowed. */
  staticOnly: boolean;
};

export type PetRuntimeCapabilities = {
  look: boolean;
  directionalRun: boolean;
  waving: boolean;
};

export type PetRuntimeSheet = {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  expectedWidth: number;
  expectedHeight: number;
};

export type PetRuntimeProfile = {
  petKey: string;
  cssToken: string;
  format: "snail" | "codex";
  name: string;
  renderMode: "css" | "spritesheet";
  spriteVersion: CodexSpriteVersion | null;
  sheet: PetRuntimeSheet | null;
  clips: Record<string, PetRuntimeClip>;
  stateClips: Record<PetRequiredState, PetStateClipBinding>;
  capabilities: PetRuntimeCapabilities;
};

/**
 * Official hatch-pet standard rows. Last-frame dwell is already in the
 * published durations; we do not invent a second hold.
 */
export const CODEX_STANDARD_ROWS = [
  { name: "idle", used: 6, durations: [280, 110, 110, 140, 140, 320] },
  { name: "running-right", used: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "running-left", used: 8, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "waving", used: 4, durations: [140, 140, 140, 280] },
  { name: "jumping", used: 5, durations: [140, 140, 140, 140, 280] },
  { name: "failed", used: 8, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { name: "waiting", used: 6, durations: [150, 150, 150, 150, 150, 260] },
  { name: "running", used: 6, durations: [120, 120, 120, 120, 120, 220] },
  { name: "review", used: 6, durations: [150, 150, 150, 150, 150, 280] },
] as const;

export const CODEX_LOOK_DIRECTION_COUNT = 16;
export const CODEX_LOOK_DEADZONE_PX = 28;

/** Snail business state → Codex standard clip. Glyphs/labels stay Snail. */
export const SNAIL_STATE_TO_CODEX_CLIP: Record<PetRequiredState, PetStateClipBinding> = {
  idle: { clipName: "idle", staticOnly: false },
  running: { clipName: "running", staticOnly: false },
  retrying: { clipName: "review", staticOnly: false },
  needs_input: { clipName: "waiting", staticOnly: false },
  ready: { clipName: "jumping", staticOnly: false },
  blocked: { clipName: "failed", staticOnly: false },
  disconnected: { clipName: "failed", staticOnly: true },
  service_not_running: { clipName: "idle", staticOnly: true },
};

export function clipTotalDurationMs(clip: PetRuntimeClip): number {
  return clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
}

function clipFromRow(
  name: string,
  row: number,
  used: number,
  durations: readonly number[],
): PetRuntimeClip {
  const frames = durations.slice(0, used).map((durationMs, index) => ({
    cellIndex: row * CODEX_PET_COLUMNS + index,
    durationMs,
  }));
  return { name, frames, staticFrameIndex: 0 };
}

function lookClip(direction: number): PetRuntimeClip {
  const row = direction < 8 ? 9 : 10;
  const col = direction % 8;
  return {
    name: `look-${direction}`,
    frames: [{ cellIndex: row * CODEX_PET_COLUMNS + col, durationMs: 1000 }],
    staticFrameIndex: 0,
  };
}

export function profileFromCodexMetadata(
  metadata: CodexPetMetadata,
  source: "snail-custom" | "codex-home" = "codex-home",
): PetRuntimeProfile {
  void source;
  const spec = codexAtlasSpec(metadata.spriteVersionNumber);
  const clips: Record<string, PetRuntimeClip> = {};
  for (const [row, def] of CODEX_STANDARD_ROWS.entries()) {
    clips[def.name] = clipFromRow(def.name, row, def.used, def.durations);
  }
  const look = metadata.spriteVersionNumber === 2;
  if (look) {
    for (let direction = 0; direction < CODEX_LOOK_DIRECTION_COUNT; direction += 1) {
      clips[`look-${direction}`] = lookClip(direction);
    }
  }
  return {
    petKey: buildPetKey("codex", metadata.id),
    cssToken: petCssToken("codex", metadata.id),
    format: "codex",
    name: metadata.displayName,
    renderMode: "spritesheet",
    spriteVersion: metadata.spriteVersionNumber,
    sheet: {
      frameWidth: spec.frameWidth,
      frameHeight: spec.frameHeight,
      columns: spec.columns,
      rows: spec.rows,
      expectedWidth: spec.width,
      expectedHeight: spec.height,
    },
    clips,
    stateClips: { ...SNAIL_STATE_TO_CODEX_CLIP },
    capabilities: {
      look,
      directionalRun: true,
      waving: true,
    },
  };
}

export function profileFromSnailManifest(
  manifest: Pick<PetManifestV2, "id" | "name" | "renderMode" | "states" | "sheet">,
  petKey = buildPetKey("snail", manifest.id),
): PetRuntimeProfile {
  const clips: Record<string, PetRuntimeClip> = {};
  const stateClips = {} as Record<PetRequiredState, PetStateClipBinding>;
  const sheet = manifest.sheet
    ? {
        frameWidth: manifest.sheet.frameWidth,
        frameHeight: manifest.sheet.frameHeight,
        columns: manifest.sheet.columns,
        rows: manifest.sheet.rows,
        expectedWidth: manifest.sheet.frameWidth * manifest.sheet.columns,
        expectedHeight: manifest.sheet.frameHeight * manifest.sheet.rows,
      }
    : null;

  for (const state of PET_REQUIRED_STATES) {
    const entry = manifest.states[state];
    const firstFrame = entry.firstFrame ?? 0;
    const frameCount = Math.max(1, entry.frameCount ?? 1);
    const durationMs = entry.durationMs ?? 240;
    const frames: PetClipFrame[] = [];
    for (let i = 0; i < frameCount; i += 1) {
      frames.push({ cellIndex: firstFrame + i, durationMs });
    }
    clips[state] = {
      name: state,
      frames,
      staticFrameIndex: entry.staticFrameIndex ?? 0,
    };
    stateClips[state] = {
      clipName: state,
      staticOnly: state === "disconnected" || state === "service_not_running",
    };
  }

  return {
    petKey,
    cssToken: petCssToken("snail", manifest.id),
    format: "snail",
    name: manifest.name,
    renderMode: manifest.renderMode,
    spriteVersion: null,
    sheet,
    clips,
    stateClips,
    capabilities: {
      look: false,
      directionalRun: false,
      waving: false,
    },
  };
}

export function resolveStateClip(
  profile: PetRuntimeProfile,
  state: PetRequiredState,
): PetRuntimeClip | null {
  const binding = profile.stateClips[state];
  if (!binding) return null;
  return profile.clips[binding.clipName] ?? null;
}

/**
 * Decorative overlays (look / drag) never apply on attention, terminal, or
 * connection states. Those states must keep their business clip.
 */
export function canApplyLookOverlay(state: PetRequiredState): boolean {
  return state === "idle";
}

export function canApplyDragOverlay(state: PetRequiredState): boolean {
  return state === "idle" || state === "running" || state === "retrying";
}

export type PetDragClipName = "running-right" | "running-left";

export type ActivePetClip = {
  clipName: string;
  staticOnly: boolean;
  clip: PetRuntimeClip | null;
};

export function resolveActivePetClip(input: {
  profile: PetRuntimeProfile;
  state: PetRequiredState;
  reducedMotion: boolean;
  lookDirection: number | null;
  dragClip: PetDragClipName | null;
}): ActivePetClip {
  const binding = input.profile.stateClips[input.state] ?? input.profile.stateClips.idle;
  const fallback: ActivePetClip = {
    clipName: binding.clipName,
    staticOnly: binding.staticOnly || input.reducedMotion,
    clip: input.profile.clips[binding.clipName] ?? null,
  };
  if (input.reducedMotion) return fallback;

  if (
    canApplyDragOverlay(input.state) &&
    input.dragClip &&
    input.profile.capabilities.directionalRun &&
    input.profile.clips[input.dragClip]
  ) {
    return {
      clipName: input.dragClip,
      staticOnly: false,
      clip: input.profile.clips[input.dragClip],
    };
  }

  if (
    canApplyLookOverlay(input.state) &&
    input.lookDirection != null &&
    input.profile.capabilities.look
  ) {
    const lookName = `look-${input.lookDirection}`;
    const look = input.profile.clips[lookName];
    if (look) {
      return { clipName: lookName, staticOnly: true, clip: look };
    }
  }

  return fallback;
}

/**
 * Screen vector (+x right, +y down) → 16 clockwise look indices.
 * Index 0 is up; 4 is right; 8 is down; 12 is left. Null inside the deadzone.
 */
export function quantizeCodexLookDirection(
  dx: number,
  dy: number,
  deadzonePx = CODEX_LOOK_DEADZONE_PX,
): number | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude === 0 || magnitude < deadzonePx) return null;
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return Math.round(deg / 22.5) % CODEX_LOOK_DIRECTION_COUNT;
}

/**
 * Horizontal drag chooses locomotion. Vertical / tiny increments keep the
 * last determined direction (or null → caller uses the business clip).
 */
export function resolveCodexDragClip(
  dx: number,
  dy: number,
  last: PetDragClipName | null,
): PetDragClipName | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return last;
  if (Math.abs(dx) <= Math.abs(dy) || Math.abs(dx) < 0.5) return last;
  return dx > 0 ? "running-right" : "running-left";
}

export function lookCellIndex(direction: number): number | null {
  if (!Number.isInteger(direction) || direction < 0 || direction >= CODEX_LOOK_DIRECTION_COUNT) {
    return null;
  }
  const row = direction < 8 ? 9 : 10;
  return row * CODEX_PET_COLUMNS + (direction % 8);
}

export function assertNoLookRows(profile: PetRuntimeProfile): boolean {
  if (profile.capabilities.look) return false;
  for (let direction = 0; direction < CODEX_LOOK_DIRECTION_COUNT; direction += 1) {
    if (profile.clips[`look-${direction}`]) return false;
  }
  if (profile.sheet && profile.sheet.rows >= CODEX_PET_V2_ROWS) return false;
  return true;
}
