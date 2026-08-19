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
/** Resume idle if look is not refreshed. Transparent windows often skip pointerleave. */
export const CODEX_LOOK_RELEASE_MS = 1600;

/** Snail business state → Codex standard clip. Glyphs/labels stay Snail. */
export const SNAIL_STATE_TO_CODEX_CLIP: Record<PetRequiredState, PetStateClipBinding> = {
  idle: { clipName: "idle", staticOnly: false },
  running: { clipName: "running", staticOnly: false },
  // Retrying is still work. `review` is Codex's completed/inspect pose and must
  // not be reused here; the ↻ glyph already distinguishes retry from running.
  retrying: { clipName: "running", staticOnly: false },
  needs_input: { clipName: "waiting", staticOnly: false },
  // `jumping` is a hop/attack cycle. Looping it as Ready looks like jumping in
  // place (hatch-pet combat poses especially). Wave is the looping "I finished"
  // pose; confetti already covers the one-shot celebration.
  ready: { clipName: "waving", staticOnly: false },
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
  // `failed` is a sag/deflate reaction. Frame 0 is often still mid-action
  // (combat pets still holding a charge). Reduced-motion and disconnected
  // freeze on the settled last pose instead of that start frame.
  return {
    name,
    frames,
    staticFrameIndex: name === "failed" ? Math.max(0, frames.length - 1) : 0,
  };
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

/** Greeting wave is decorative and never covers attention / terminal / connection. */
export function canApplyWaveOverlay(state: PetRequiredState): boolean {
  return state === "idle" || state === "running" || state === "retrying";
}

/** One-shot hop is decorative and never covers attention / terminal / connection. */
export function canApplyJumpOverlay(state: PetRequiredState): boolean {
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
  waveActive?: boolean;
  jumpActive?: boolean;
  /** Debounced Running cue. Only `thinking` may select `review`. */
  runningCue?: string | null;
}): ActivePetClip {
  const binding = input.profile.stateClips[input.state] ?? input.profile.stateClips.idle;
  const reviewClip =
    input.state === "running" &&
    input.runningCue === "thinking" &&
    input.profile.clips.review
      ? input.profile.clips.review
      : null;
  const fallback: ActivePetClip = reviewClip
    ? {
        clipName: "review",
        staticOnly: binding.staticOnly || input.reducedMotion,
        clip: reviewClip,
      }
    : {
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
    input.jumpActive &&
    canApplyJumpOverlay(input.state) &&
    input.profile.clips.jumping
  ) {
    return {
      clipName: "jumping",
      staticOnly: false,
      clip: input.profile.clips.jumping,
    };
  }

  if (
    input.waveActive &&
    canApplyWaveOverlay(input.state) &&
    input.profile.capabilities.waving &&
    input.profile.clips.waving
  ) {
    return {
      clipName: "waving",
      staticOnly: false,
      clip: input.profile.clips.waving,
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

/** Look only while the pointer stays over the avatar box. */
export function isCodexLookPointerInBounds(
  pointerX: number,
  pointerY: number,
  bounds: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    pointerX >= bounds.left &&
    pointerX <= bounds.right &&
    pointerY >= bounds.top &&
    pointerY <= bounds.bottom
  );
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

/**
 * Every official hatch-pet clip must have a business state or explicit
 * interaction path. `via: "exception"` is allowed only with a comment in
 * `detail` explaining why the clip stays unused.
 */
export type CodexClipReachability =
  | {
      clipName: string;
      via: "state" | "overlay";
      detail: string;
    }
  | {
      clipName: string;
      via: "exception";
      detail: string;
    };

export const CODEX_STANDARD_CLIP_REACHABILITY: readonly CodexClipReachability[] = [
  { clipName: "idle", via: "state", detail: "idle|service_not_running" },
  { clipName: "running-right", via: "overlay", detail: "drag:right" },
  { clipName: "running-left", via: "overlay", detail: "drag:left" },
  { clipName: "waving", via: "state", detail: "ready" },
  { clipName: "jumping", via: "overlay", detail: "interact:click|dblclick" },
  { clipName: "failed", via: "state", detail: "blocked|disconnected" },
  { clipName: "waiting", via: "state", detail: "needs_input" },
  { clipName: "running", via: "state", detail: "running|retrying" },
  { clipName: "review", via: "overlay", detail: "runningCue:thinking" },
];

export const CODEX_ATLAS_OCCUPIED_ALPHA = 8;

export type CodexAtlasCellFinding = {
  row: number;
  col: number;
  cellIndex: number;
  clipName: string | null;
  kind: "used_empty" | "reserved_occupied" | "invalid_size";
  code: "used_empty" | "reserved_occupied" | "idle_extra_frame" | "invalid_size";
  occupancy: number;
};

export type CodexAtlasCellAudit = {
  ok: boolean;
  findings: CodexAtlasCellFinding[];
};

function cellOccupancy(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  col: number,
  row: number,
  frameWidth: number,
  frameHeight: number,
): number {
  const x0 = col * frameWidth;
  const y0 = row * frameHeight;
  let occupied = 0;
  const total = frameWidth * frameHeight;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const alpha = rgba[((y0 + y) * width + (x0 + x)) * 4 + 3] ?? 0;
      if (alpha > CODEX_ATLAS_OCCUPIED_ALPHA) occupied += 1;
    }
  }
  return total === 0 ? 0 : occupied / total;
}

/**
 * Protocol pixel audit. Runtime still plays the official used-frame counts
 * (idle=6); extra content in reserved cells is reported, not adopted.
 */
export function auditCodexAtlasCells(input: {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  spriteVersion: CodexSpriteVersion;
}): CodexAtlasCellAudit {
  const spec = codexAtlasSpec(input.spriteVersion);
  const expectedBytes = spec.width * spec.height * 4;
  if (
    input.width !== spec.width ||
    input.height !== spec.height ||
    input.rgba.length < expectedBytes
  ) {
    return {
      ok: false,
      findings: [
        {
          row: -1,
          col: -1,
          cellIndex: -1,
          clipName: null,
          kind: "invalid_size",
          code: "invalid_size",
          occupancy: 0,
        },
      ],
    };
  }

  const findings: CodexAtlasCellFinding[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const standard = CODEX_STANDARD_ROWS[row];
    const lookRow = input.spriteVersion === 2 && row >= CODEX_STANDARD_ROWS.length;
    for (let col = 0; col < spec.columns; col += 1) {
      const used = standard ? col < standard.used : lookRow;
      const clipName = standard
        ? standard.name
        : lookRow
          ? `look-${(row - CODEX_STANDARD_ROWS.length) * spec.columns + col}`
          : null;
      const occupancy = cellOccupancy(
        input.rgba,
        input.width,
        col,
        row,
        spec.frameWidth,
        spec.frameHeight,
      );
      if (used && occupancy === 0) {
        findings.push({
          row,
          col,
          cellIndex: row * spec.columns + col,
          clipName,
          kind: "used_empty",
          code: "used_empty",
          occupancy,
        });
        continue;
      }
      if (!used && occupancy > 0) {
        findings.push({
          row,
          col,
          cellIndex: row * spec.columns + col,
          clipName,
          kind: "reserved_occupied",
          code: row === 0 && col === 6 ? "idle_extra_frame" : "reserved_occupied",
          occupancy,
        });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}
