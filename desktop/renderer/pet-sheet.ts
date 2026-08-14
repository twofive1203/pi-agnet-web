/**
 * Spritesheet runtime style computation (P3).
 *
 * Pure and DOM-free: the desktop-contract smoke asserts frame math without a
 * browser. The renderer injects the generated CSS once per sprite pet and
 * falls back to the CSS snail whenever the manifest is not a valid spritesheet
 * descriptor or the bitmap data URL is unavailable / failed to decode.
 */

import type { PetManifest, PetVisualState } from "./pet-state";

/** CSS render box of `.pet-avatar`; sprites are scaled to fill it. */
export const PET_SPRITE_AVATAR_WIDTH = 108;
export const PET_SPRITE_AVATAR_HEIGHT = 92;

type SpriteSheet = NonNullable<PetManifest["sheet"]>;

export type SpriteCell = { x: number; y: number };

/** Negative background-position offsets for a zero-based sheet cell index. */
export function spriteCellPosition(sheet: SpriteSheet, frameIndex: number): SpriteCell {
  const col = frameIndex % sheet.columns;
  const row = Math.floor(frameIndex / sheet.columns);
  const scaleX = PET_SPRITE_AVATAR_WIDTH / sheet.frameWidth;
  const scaleY = PET_SPRITE_AVATAR_HEIGHT / sheet.frameHeight;
  return {
    x: -col * sheet.frameWidth * scaleX,
    y: -row * sheet.frameHeight * scaleY,
  };
}

export function spriteSheetBackgroundSize(sheet: SpriteSheet): string {
  const scaleX = PET_SPRITE_AVATAR_WIDTH / sheet.frameWidth;
  const scaleY = PET_SPRITE_AVATAR_HEIGHT / sheet.frameHeight;
  return `${sheet.frameWidth * sheet.columns * scaleX}px ${sheet.frameHeight * sheet.rows * scaleY}px`;
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
  return `${cell.x}px ${cell.y}px`;
}

export function animationName(manifestId: string, state: PetVisualState): string {
  return `pet-sprite-${manifestId}-${state}`;
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
    base: `.pet-avatar.pet-sprite-${manifestId}[data-state="${state}"]`,
    animated: `.pet-avatar.pet-sprite-${manifestId}[data-state="${state}"].is-animated`,
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
  const lines: string[] = [];
  lines.push(
    `.pet-avatar.pet-sprite-${id} {`,
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
