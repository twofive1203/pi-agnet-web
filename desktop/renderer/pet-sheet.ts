/**
 * Spritesheet runtime style computation (P3).
 *
 * Pure and DOM-free: the desktop-contract smoke asserts frame math without a
 * browser. The renderer injects the generated CSS once per sprite pet and
 * falls back to the CSS snail whenever the manifest is not a valid spritesheet
 * descriptor or the bitmap data URL is unavailable / failed to decode.
 */

import type { PetManifest, PetVisualState } from "./pet-state";
import type { PetRuntimeClip, PetRuntimeProfile, PetRuntimeSheet } from "./pet-runtime-profile";

/** CSS render box of `.pet-avatar`. Bitmaps contain into this box. */
export const PET_SPRITE_AVATAR_WIDTH = 108;
export const PET_SPRITE_AVATAR_HEIGHT = 92;

/** Uniform contain scale so a source cell is never stretched. */
export function spriteContainScale(sheet: SpriteSheet): number {
  return Math.min(
    PET_SPRITE_AVATAR_WIDTH / sheet.frameWidth,
    PET_SPRITE_AVATAR_HEIGHT / sheet.frameHeight,
  );
}

/** Inner `.pet-bitmap` box after contain. Snail 108×92 stays 108×92; Codex 192×208 becomes ~85×92. */
export function spriteBitmapSize(sheet: SpriteSheet): { width: number; height: number } {
  const scale = spriteContainScale(sheet);
  return {
    width: sheet.frameWidth * scale,
    height: sheet.frameHeight * scale,
  };
}

/** On-screen size after `.pet-stage { transform: scale(petScale) }`. */
export function spriteVisualSize(
  sheet: SpriteSheet,
  petScale: number,
): { width: number; height: number } {
  const box = spriteBitmapSize(sheet);
  return {
    width: box.width * petScale,
    height: box.height * petScale,
  };
}

export function spriteBitmapBaseSelector(token: string): string {
  return `.pet-avatar.pet-sprite-${token} > .pet-bitmap`;
}

export function spriteBitmapClipSelector(
  token: string,
  clipName: string,
  animated = false,
): string {
  return `.pet-avatar.pet-sprite-${token}[data-clip="${clipName}"]${animated ? ".is-animated" : ""} > .pet-bitmap`;
}

export function spriteBitmapStateSelector(
  token: string,
  state: string,
  animated = false,
): string {
  return `.pet-avatar.pet-sprite-${token}[data-state="${state}"]${animated ? ".is-animated" : ""} > .pet-bitmap`;
}

function formatCssPx(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return "0px";
  const rounded = Math.round(value * 1e6) / 1e6;
  return `${rounded}px`;
}

type SpriteSheet = {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
};

export type SpriteCell = { x: number; y: number };

/** Negative background-position offsets for a zero-based sheet cell index. */
export function spriteCellPosition(sheet: SpriteSheet, frameIndex: number): SpriteCell {
  const col = frameIndex % sheet.columns;
  const row = Math.floor(frameIndex / sheet.columns);
  const scale = spriteContainScale(sheet);
  return {
    x: -col * sheet.frameWidth * scale,
    y: -row * sheet.frameHeight * scale,
  };
}

export function spriteSheetBackgroundSize(sheet: SpriteSheet): string {
  const scale = spriteContainScale(sheet);
  return `${formatCssPx(sheet.frameWidth * sheet.columns * scale)} ${formatCssPx(sheet.frameHeight * sheet.rows * scale)}`;
}

export type SpriteSheetStyle = {
  backgroundSize: string;
  /** Static (reduced-motion / single-frame) background-position. */
  staticPosition: string;
  /** Animated background-position start; null when the state has one frame. */
  animatedPosition: string | null;
  /** Animation shorthand; null when the state has one frame. */
  animation: string | null;
  /** Reduced-motion cell offset inside the state's frame run. */
  staticFrameIndex: number;
};

export function positionCss(cell: SpriteCell): string {
  return `${formatCssPx(cell.x)} ${formatCssPx(cell.y)}`;
}

export function animationName(manifestId: string, state: PetVisualState): string {
  return `pet-sprite-${manifestId}-${state}`;
}

export type SpriteStylesheetSource =
  | { kind: "profile"; imageUrl: string }
  | { kind: "manifest"; imageUrl: string }
  | { kind: "none" };

/**
 * Choose which injected stylesheet builder to use once a bitmap URL is known.
 *
 * Custom Snail packs and Codex atlases load as blob URLs keyed by petKey.
 * The legacy manifest stylesheet only looks up builtin data URLs; using it
 * after a lazy load marks the avatar as `pet-sprite` with no background-image.
 */
export function resolveSpriteStylesheetSource(input: {
  format: "snail" | "codex";
  spriteImageUrl: string | null;
  builtinDataUrl: string | null;
}): SpriteStylesheetSource {
  if (!input.spriteImageUrl) return { kind: "none" };
  if (input.format === "codex" || input.spriteImageUrl !== input.builtinDataUrl) {
    return { kind: "profile", imageUrl: input.spriteImageUrl };
  }
  return { kind: "manifest", imageUrl: input.spriteImageUrl };
}

/**
 * Per-state sprite render plan. Returns null (→ CSS fallback) when the pet is
 * not a valid spritesheet descriptor or no bitmap URL is available.
 */
export function resolveSpriteSheetStyle(
  manifest: PetManifest,
  state: PetVisualState,
  imageUrl: string | null,
): SpriteSheetStyle | null {
  if (manifest.renderMode !== "spritesheet" || !manifest.sheet) return null;
  if (!imageUrl) return null;
  const entry = manifest.states[state];
  if (
    entry == null ||
    entry.firstFrame === undefined ||
    entry.frameCount === undefined ||
    entry.durationMs === undefined ||
    entry.staticFrameIndex === undefined
  ) {
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
      staticFrameIndex: entry.staticFrameIndex,
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
    staticFrameIndex: entry.staticFrameIndex,
  };
}

function frameSelectors(manifestId: string, state: PetVisualState): { base: string; animated: string } {
  return {
    base: spriteBitmapStateSelector(manifestId, state),
    animated: spriteBitmapStateSelector(manifestId, state, true),
  };
}

/**
 * Full stylesheet for a sprite pet: base bitmap + per-state static/animated
 * rules and `steps()` keyframes. Animated rules only exist for multi-frame
 * states. Returns "" when the pet is not a renderable spritesheet.
 */
export function buildSpriteSheetStyleText(manifest: PetManifest, imageUrl: string | null): string {
  if (manifest.renderMode !== "spritesheet" || !manifest.sheet || !imageUrl) return "";
  const id = manifest.id;
  const sheet = manifest.sheet;
  const box = spriteBitmapSize(sheet);
  const lines: string[] = [];
  lines.push(
    `${spriteBitmapBaseSelector(id)} {`,
    `  width: ${formatCssPx(box.width)};`,
    `  height: ${formatCssPx(box.height)};`,
    `  background-image: url("${imageUrl}");`,
    `  background-size: ${spriteSheetBackgroundSize(sheet)};`,
    "  background-repeat: no-repeat;",
    "}",
  );
  for (const state of Object.keys(manifest.states) as PetVisualState[]) {
    const plan = resolveSpriteSheetStyle(manifest, state, imageUrl);
    if (!plan) continue;
    const entry = manifest.states[state];
    const { base, animated } = frameSelectors(id, state);
    lines.push(`${base} { background-position: ${plan.staticPosition}; }`);
    if (plan.animatedPosition && plan.animation) {
      lines.push(`${animated} { background-position: ${plan.animatedPosition}; animation: ${plan.animation}; }`);
      const toPosition = positionCss(
        spriteCellPosition(sheet, entry.firstFrame! + entry.frameCount!),
      );
      lines.push(
        `@keyframes ${animationName(id, state)} {`,
        `  from { background-position: ${plan.animatedPosition}; }`,
        `  to { background-position: ${toPosition}; }`,
        "}",
      );
    }
  }
  return lines.join("\n");
}

export function clipAnimationName(cssToken: string, clipName: string): string {
  const safeClip = clipName.replace(/[^a-z0-9_-]/gi, "");
  return `pet-sprite-${cssToken}-${safeClip}`;
}

export function isUniformClip(clip: PetRuntimeClip): boolean {
  if (clip.frames.length <= 1) return true;
  const first = clip.frames[0]?.durationMs;
  if (first == null) return true;
  return clip.frames.every((frame, index) => {
    if (frame.durationMs !== first) return false;
    if (index === 0) return true;
    return frame.cellIndex === clip.frames[index - 1].cellIndex + 1;
  });
}

function formatKeyframePercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${clamped.toFixed(4).replace(/\.?0+$/, "")}%`;
}

export function resolveClipSheetStyle(
  sheet: PetRuntimeSheet | SpriteSheet,
  clip: PetRuntimeClip,
  cssToken: string,
): SpriteSheetStyle | null {
  if (clip.frames.length === 0) return null;
  const staticIndex = Math.min(clip.staticFrameIndex, clip.frames.length - 1);
  const staticCell = clip.frames[staticIndex]?.cellIndex;
  if (staticCell == null) return null;
  const backgroundSize = spriteSheetBackgroundSize(sheet);
  const staticPosition = positionCss(spriteCellPosition(sheet, staticCell));
  if (clip.frames.length <= 1) {
    return {
      backgroundSize,
      staticPosition,
      animatedPosition: null,
      animation: null,
      staticFrameIndex: staticIndex,
    };
  }
  const name = clipAnimationName(cssToken, clip.name);
  const firstCell = clip.frames[0].cellIndex;
  const animatedPosition = positionCss(spriteCellPosition(sheet, firstCell));
  const totalMs = clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
  if (isUniformClip(clip)) {
    return {
      backgroundSize,
      staticPosition,
      animatedPosition,
      animation: `${name} ${totalMs}ms steps(${clip.frames.length}, end) infinite`,
      staticFrameIndex: staticIndex,
    };
  }
  return {
    backgroundSize,
    staticPosition,
    animatedPosition,
    // step-end holds each keyframe until the next one. `linear` would tween
    // background-position across neighboring cells and slide the atlas.
    animation: `${name} ${totalMs}ms step-end infinite`,
    staticFrameIndex: staticIndex,
  };
}

function buildUnevenKeyframes(
  name: string,
  sheet: SpriteSheet,
  clip: PetRuntimeClip,
): string {
  const total = clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0) || 1;
  let elapsed = 0;
  const lines = [`@keyframes ${name} {`];
  // One keyframe per cell start. Shared `start, end` percentages collapse in CSS
  // (later rule wins) and turn a hold into a linear slide between cells.
  for (const frame of clip.frames) {
    const start = (elapsed / total) * 100;
    const pos = positionCss(spriteCellPosition(sheet, frame.cellIndex));
    lines.push(`  ${formatKeyframePercent(start)} { background-position: ${pos}; }`);
    elapsed += frame.durationMs;
  }
  const last = clip.frames[clip.frames.length - 1];
  if (last) {
    lines.push(
      `  100% { background-position: ${positionCss(spriteCellPosition(sheet, last.cellIndex))}; }`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

/**
 * Profile-driven stylesheet. Selectors key off `data-clip` so decorative look
 * / drag clips can change without rewriting the business `data-state`.
 */
export function buildSpriteSheetStyleTextFromProfile(
  profile: PetRuntimeProfile,
  imageUrl: string | null,
): string {
  if (profile.renderMode !== "spritesheet" || !profile.sheet || !imageUrl) return "";
  const sheet = profile.sheet;
  const token = profile.cssToken;
  const box = spriteBitmapSize(sheet);
  const lines: string[] = [];
  lines.push(
    `${spriteBitmapBaseSelector(token)} {`,
    `  width: ${formatCssPx(box.width)};`,
    `  height: ${formatCssPx(box.height)};`,
    `  background-image: url("${imageUrl}");`,
    `  background-size: ${spriteSheetBackgroundSize(sheet)};`,
    "  background-repeat: no-repeat;",
    "}",
  );
  for (const clip of Object.values(profile.clips)) {
    const plan = resolveClipSheetStyle(sheet, clip, token);
    if (!plan) continue;
    const base = spriteBitmapClipSelector(token, clip.name);
    const animated = spriteBitmapClipSelector(token, clip.name, true);
    lines.push(`${base} { background-position: ${plan.staticPosition}; }`);
    if (plan.animatedPosition && plan.animation) {
      lines.push(
        `${animated} { background-position: ${plan.animatedPosition}; animation: ${plan.animation}; }`,
      );
      const name = clipAnimationName(token, clip.name);
      if (isUniformClip(clip) && clip.frames.length > 1) {
        const toPosition = positionCss(
          spriteCellPosition(sheet, clip.frames[0].cellIndex + clip.frames.length),
        );
        lines.push(
          `@keyframes ${name} {`,
          `  from { background-position: ${plan.animatedPosition}; }`,
          `  to { background-position: ${toPosition}; }`,
          "}",
        );
      } else if (clip.frames.length > 1) {
        lines.push(buildUnevenKeyframes(name, sheet, clip));
      }
    }
  }
  return lines.join("\n");
}

export function expectedSheetPixelSize(sheet: SpriteSheet): { width: number; height: number } {
  return {
    width: sheet.frameWidth * sheet.columns,
    height: sheet.frameHeight * sheet.rows,
  };
}
