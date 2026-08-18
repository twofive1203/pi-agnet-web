/**
 * Pet window lifecycle helpers (U7).
 *
 * Security defaults: no nodeIntegration, contextIsolation, sandbox.
 * Close hides to tray rather than quitting (R13).
 * Geometry comes from one layout spec so scale / DPI / display recovery stay aligned.
 */

import {
  DESKTOP_PET_SCALE_FACTORS,
  type DesktopPetScale,
} from "./settings-store";

export type PetWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PetWindowHost = {
  createWindow(options: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    preloadPath: string;
    indexHtmlPath: string;
    alwaysOnTop: boolean;
  }): PetWindowHandle;
};

export type PetWindowRevealReason =
  | "startup"
  | "passive-snapshot"
  | "passive-connection"
  | "passive-notification"
  | "user-show"
  | "second-instance"
  | "user-disable-click-through";

export type PetWindowReveal = "keep" | "show-inactive" | "activate";

export type PetWindowHandle = {
  show(): void;
  /** Show without activating the current app or switching virtual desktops. */
  showInactive(): void;
  hide(): void;
  close(): void;
  destroy(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  focus(): void;
  setAlwaysOnTop(flag: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  getBounds(): PetWindowBounds;
  setBounds(bounds: Partial<PetWindowBounds>): void;
  send(channel: string, payload: unknown): void;
  /** Top-level pet renderer webContents id; used to reject foreign IPC senders. */
  webContentsId?(): number | null;
  onClose(handler: (event: { preventDefault(): void }) => void): void;
  onMoved(handler: (bounds: PetWindowBounds) => void): void;
  onBlur(handler: () => void): void;
  onFocus(handler: () => void): void;
};

/** Medium-size DIP metrics. Small/large multiply these through resolvePetLayoutSpec. */
export const PET_LAYOUT_BASE = {
  rootPad: 6,
  chromeHeight: 18,
  stackGap: 6,
  surfaceSize: 112,
  /** Empty band above the sprite so the speech balloon does not cover the face. */
  bubbleReserve: 40,
  /** chrome 18 + gap 6 + surface 112 + bubble 40 */
  stackWidth: 112,
  stackHeight: 176,
  /** Collapsed chrome + bubble band + avatar + root padding — must fit without clipping. */
  collapsedWidth: 140,
  collapsedHeight: 196,
  trayWidth: 360,
  trayHeight: 480,
} as const;

export const PET_WINDOW_DEFAULTS = {
  width: PET_LAYOUT_BASE.trayWidth,
  height: PET_LAYOUT_BASE.trayHeight,
  petOnlyWidth: PET_LAYOUT_BASE.collapsedWidth,
  petOnlyHeight: PET_LAYOUT_BASE.collapsedHeight,
  trayWidth: PET_LAYOUT_BASE.trayWidth,
  trayHeight: PET_LAYOUT_BASE.trayHeight,
} as const;

/**
 * Where the pet stack (chrome + avatar) sits inside the window while the tray is open.
 * Collapsed windows always use top-left. Must stay in sync with renderer CSS/HTML.
 */
export type TrayLayoutAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Pixel metrics shared with desktop/renderer/pet.css (padding / chrome / avatar). */
export const PET_LAYOUT = {
  rootPad: PET_LAYOUT_BASE.rootPad,
  stackWidth: PET_LAYOUT_BASE.stackWidth,
  stackHeight: PET_LAYOUT_BASE.stackHeight,
} as const;

export type PetLayoutSpec = {
  scale: DesktopPetScale;
  factor: number;
  rootPad: number;
  chromeHeight: number;
  surfaceSize: number;
  bubbleReserve: number;
  stackWidth: number;
  stackHeight: number;
  clickTargetWidth: number;
  clickTargetHeight: number;
  collapsedWidth: number;
  collapsedHeight: number;
  trayWidth: number;
  trayHeight: number;
};

function scaleLayoutPx(value: number, factor: number): number {
  return Math.max(1, Math.round(value * factor));
}

/** Single source for collapsed/tray/pet stack/click target sizes at a scale token. */
export function resolvePetLayoutSpec(scale: DesktopPetScale = "medium"): PetLayoutSpec {
  const factor = DESKTOP_PET_SCALE_FACTORS[scale] ?? DESKTOP_PET_SCALE_FACTORS.medium;
  const rootPad = scaleLayoutPx(PET_LAYOUT_BASE.rootPad, factor);
  const chromeHeight = scaleLayoutPx(PET_LAYOUT_BASE.chromeHeight, factor);
  const stackGap = scaleLayoutPx(PET_LAYOUT_BASE.stackGap, factor);
  const surfaceSize = scaleLayoutPx(PET_LAYOUT_BASE.surfaceSize, factor);
  const bubbleReserve = scaleLayoutPx(PET_LAYOUT_BASE.bubbleReserve, factor);
  const stackWidth = surfaceSize;
  const stackHeight = chromeHeight + stackGap + surfaceSize + bubbleReserve;
  return {
    scale,
    factor,
    rootPad,
    chromeHeight,
    surfaceSize,
    bubbleReserve,
    stackWidth,
    stackHeight,
    clickTargetWidth: surfaceSize,
    clickTargetHeight: surfaceSize,
    collapsedWidth: Math.max(
      scaleLayoutPx(PET_LAYOUT_BASE.collapsedWidth, factor),
      rootPad * 2 + stackWidth,
    ),
    collapsedHeight: Math.max(
      scaleLayoutPx(PET_LAYOUT_BASE.collapsedHeight, factor),
      rootPad * 2 + stackHeight,
    ),
    trayWidth: Math.max(
      scaleLayoutPx(PET_LAYOUT_BASE.trayWidth, factor),
      rootPad * 2 + stackWidth,
    ),
    trayHeight: Math.max(
      scaleLayoutPx(PET_LAYOUT_BASE.trayHeight, factor),
      rootPad * 2 + stackHeight,
    ),
  };
}

export function windowSizeForLayout(
  spec: PetLayoutSpec,
  trayExpanded: boolean,
): { width: number; height: number } {
  return trayExpanded
    ? { width: spec.trayWidth, height: spec.trayHeight }
    : { width: spec.collapsedWidth, height: spec.collapsedHeight };
}

export type WindowManagerState = {
  visible: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  trayExpanded: boolean;
  /** Active only while trayExpanded; collapsed layout is always top-left. */
  trayAnchor: TrayLayoutAnchor;
  petScale: DesktopPetScale;
  bounds: PetWindowBounds | null;
};

export function createInitialWindowManagerState(input?: {
  position?: { x: number; y: number } | null;
  alwaysOnTop?: boolean;
  clickThrough?: boolean;
  trayOpen?: boolean;
  petScale?: DesktopPetScale;
  /** Used only when no saved position (typically primary work-area bottom-right). */
  defaultPosition?: { x: number; y: number } | null;
}): WindowManagerState {
  const trayExpanded = input?.trayOpen === true;
  const petScale = input?.petScale ?? "medium";
  const spec = resolvePetLayoutSpec(petScale);
  const size = windowSizeForLayout(spec, trayExpanded);
  const position = input?.position ?? input?.defaultPosition ?? null;
  return {
    visible: true,
    clickThrough: input?.clickThrough === true,
    alwaysOnTop: input?.alwaysOnTop !== false,
    trayExpanded,
    // Restored expanded sessions default to top-left; first toggle re-picks from work area.
    trayAnchor: "top-left",
    petScale,
    bounds: position
      ? { x: position.x, y: position.y, width: size.width, height: size.height }
      : { x: 40, y: 40, width: size.width, height: size.height },
  };
}

/** Place the collapsed pet near the bottom-right of a work area (with padding). */
export function defaultPetWindowPosition(
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
  scale: DesktopPetScale = "medium",
): { x: number; y: number } {
  const spec = resolvePetLayoutSpec(scale);
  const pad = 24;
  return {
    x: Math.round(workArea.x + workArea.width - spec.collapsedWidth - pad),
    y: Math.round(workArea.y + workArea.height - spec.collapsedHeight - pad),
  };
}

/** Close button: hide instead of destroy (R13). */
export function handlePetWindowCloseRequest(
  state: WindowManagerState,
): WindowManagerState {
  return { ...state, visible: false };
}

/** Tray "Show pet" recovery. */
export function handleShowPet(state: WindowManagerState): WindowManagerState {
  return { ...state, visible: true, clickThrough: false };
}

/** Disable click-through from tray recovery menu (R13). */
export function handleDisableClickThrough(state: WindowManagerState): WindowManagerState {
  return { ...state, clickThrough: false, visible: true };
}

export type WorkAreaRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Keep the window fully inside a display work area when possible. */
export function clampWindowBounds(
  bounds: PetWindowBounds,
  workArea: WorkAreaRect,
): PetWindowBounds {
  const maxX = workArea.x + workArea.width - bounds.width;
  const maxY = workArea.y + workArea.height - bounds.height;
  const minX = workArea.x;
  const minY = workArea.y;
  return {
    ...bounds,
    x: Math.round(
      maxX < minX ? minX : Math.min(Math.max(bounds.x, minX), maxX),
    ),
    y: Math.round(
      maxY < minY ? minY : Math.min(Math.max(bounds.y, minY), maxY),
    ),
  };
}

function boundsFitWorkArea(bounds: PetWindowBounds, workArea: WorkAreaRect): boolean {
  return (
    bounds.x >= workArea.x &&
    bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height
  );
}

export function layoutSpecFromState(state: Pick<WindowManagerState, "petScale">): PetLayoutSpec {
  return resolvePetLayoutSpec(state.petScale ?? "medium");
}

/** Screen rect of the pet stack (chrome + avatar) for the current layout anchor. */
export function petStackScreenRect(
  bounds: PetWindowBounds,
  anchor: TrayLayoutAnchor,
  spec: PetLayoutSpec = resolvePetLayoutSpec("medium"),
): { x: number; y: number; width: number; height: number } {
  const { rootPad, stackWidth, stackHeight } = spec;
  const alignRight = anchor === "top-right" || anchor === "bottom-right";
  const alignBottom = anchor === "bottom-left" || anchor === "bottom-right";
  return {
    x: alignRight ? bounds.x + bounds.width - rootPad - stackWidth : bounds.x + rootPad,
    y: alignBottom ? bounds.y + bounds.height - rootPad - stackHeight : bounds.y + rootPad,
    width: stackWidth,
    height: stackHeight,
  };
}

/** Place a window of the given size so the pet stack stays at `stack` under `anchor`. */
export function windowBoundsForPetStack(input: {
  stack: { x: number; y: number; width: number; height: number };
  anchor: TrayLayoutAnchor;
  width: number;
  height: number;
  spec?: PetLayoutSpec;
}): PetWindowBounds {
  const rootPad = (input.spec ?? resolvePetLayoutSpec("medium")).rootPad;
  const alignRight = input.anchor === "top-right" || input.anchor === "bottom-right";
  const alignBottom = input.anchor === "bottom-left" || input.anchor === "bottom-right";
  const x = alignRight
    ? input.stack.x + input.stack.width + rootPad - input.width
    : input.stack.x - rootPad;
  const y = alignBottom
    ? input.stack.y + input.stack.height + rootPad - input.height
    : input.stack.y - rootPad;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: input.width,
    height: input.height,
  };
}

/** Prefer tray below/right of the pet; flip up/left only when needed to stay on-screen. */
const TRAY_ANCHOR_PREFERENCE: readonly TrayLayoutAnchor[] = [
  "top-left", // tray grows down + right
  "top-right", // tray grows down + left
  "bottom-left", // tray grows up + right
  "bottom-right", // tray grows up + left
];

export function pickTrayLayoutAnchor(
  stack: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  workArea?: WorkAreaRect | null,
  spec: PetLayoutSpec = resolvePetLayoutSpec("medium"),
): TrayLayoutAnchor {
  if (!workArea) return "top-left";
  for (const anchor of TRAY_ANCHOR_PREFERENCE) {
    const bounds = windowBoundsForPetStack({
      stack,
      anchor,
      width: size.width,
      height: size.height,
      spec,
    });
    if (boundsFitWorkArea(bounds, workArea)) return anchor;
  }
  // Nothing fits fully: pick the anchor that keeps the pet closest after clamp.
  let best: TrayLayoutAnchor = "top-left";
  let bestScore = Number.POSITIVE_INFINITY;
  for (const anchor of TRAY_ANCHOR_PREFERENCE) {
    const raw = windowBoundsForPetStack({
      stack,
      anchor,
      width: size.width,
      height: size.height,
      spec,
    });
    const clamped = clampWindowBounds(raw, workArea);
    const placed = petStackScreenRect(clamped, anchor, spec);
    const dx = placed.x - stack.x;
    const dy = placed.y - stack.y;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = anchor;
    }
  }
  return best;
}

/**
 * Expand/collapse the activity tray while keeping the pet icon fixed on screen.
 *
 * The tray grows out from the pet (prefer down/right; flip up/left near edges).
 * Renderer mirrors `trayAnchor` via flex direction so chrome+avatar stay put.
 */
export function handleToggleTray(
  state: WindowManagerState,
  workArea?: WorkAreaRect | null,
): WindowManagerState {
  const spec = layoutSpecFromState(state);
  const trayExpanded = !state.trayExpanded;
  const size = windowSizeForLayout(spec, trayExpanded);

  if (!state.bounds) {
    return {
      ...state,
      trayExpanded,
      trayAnchor: "top-left",
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
    };
  }

  // Pet stack screen position is the stable anchor across expand/collapse.
  const currentAnchor: TrayLayoutAnchor = state.trayExpanded ? state.trayAnchor : "top-left";
  const stack = petStackScreenRect(state.bounds, currentAnchor, spec);

  if (trayExpanded) {
    const anchor = pickTrayLayoutAnchor(stack, size, workArea, spec);
    let bounds = windowBoundsForPetStack({
      stack,
      anchor,
      width: size.width,
      height: size.height,
      spec,
    });
    if (workArea) bounds = clampWindowBounds(bounds, workArea);
    return { ...state, trayExpanded: true, trayAnchor: anchor, bounds };
  }

  // Collapse always uses top-left content layout; reposition window so the stack stays put.
  let bounds = windowBoundsForPetStack({
    stack,
    anchor: "top-left",
    width: size.width,
    height: size.height,
    spec,
  });
  if (workArea) bounds = clampWindowBounds(bounds, workArea);
  return {
    ...state,
    trayExpanded: false,
    trayAnchor: "top-left",
    bounds,
  };
}

/** Bounding rectangle of all displays, used only while dragging between screens. */
export function unionWorkAreas(
  workAreas: readonly WorkAreaRect[],
): WorkAreaRect | null {
  if (workAreas.length === 0) return null;
  const left = Math.min(...workAreas.map((area) => area.x));
  const top = Math.min(...workAreas.map((area) => area.y));
  const right = Math.max(...workAreas.map((area) => area.x + area.width));
  const bottom = Math.max(...workAreas.map((area) => area.y + area.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function isWorkAreaList(
  value: WorkAreaRect | readonly WorkAreaRect[],
): value is readonly WorkAreaRect[] {
  return Array.isArray(value);
}

/** Apply a renderer-driven drag delta (click-vs-drag on the pet body). */
export function handleMoveBy(
  state: WindowManagerState,
  delta: { dx: number; dy: number },
  workAreaOrAreas?: WorkAreaRect | readonly WorkAreaRect[] | null,
): WindowManagerState {
  if (!state.bounds) return state;
  const dx = Number.isFinite(delta.dx) ? delta.dx : 0;
  const dy = Number.isFinite(delta.dy) ? delta.dy : 0;
  if (dx === 0 && dy === 0) return state;
  let bounds: PetWindowBounds = {
    ...state.bounds,
    x: Math.round(state.bounds.x + dx),
    y: Math.round(state.bounds.y + dy),
  };
  const dragWorkArea = workAreaOrAreas
    ? isWorkAreaList(workAreaOrAreas)
      ? unionWorkAreas(workAreaOrAreas)
      : workAreaOrAreas
    : null;
  if (dragWorkArea) {
    // Clamp against the virtual desktop, not the current display. Clamping to one
    // display traps the window at that display's half-window soft edge.
    const soft: WorkAreaRect = {
      x: dragWorkArea.x - Math.floor(bounds.width / 2),
      y: dragWorkArea.y - Math.floor(bounds.height / 2),
      width: dragWorkArea.width + bounds.width,
      height: dragWorkArea.height + bounds.height,
    };
    bounds = clampWindowBounds(bounds, soft);
  }
  return { ...state, bounds };
}

export function handleSetClickThrough(
  state: WindowManagerState,
  clickThrough: boolean,
): WindowManagerState {
  return { ...state, clickThrough };
}

export function handleSetAlwaysOnTop(
  state: WindowManagerState,
  alwaysOnTop: boolean,
): WindowManagerState {
  return { ...state, alwaysOnTop };
}

export function handleBoundsChanged(
  state: WindowManagerState,
  bounds: PetWindowBounds,
): WindowManagerState {
  return { ...state, bounds };
}

function windowFullyVisible(bounds: PetWindowBounds, workArea: WorkAreaRect): boolean {
  return boundsFitWorkArea(bounds, workArea);
}

function nearestWorkArea(
  point: { x: number; y: number },
  workAreas: readonly WorkAreaRect[],
): WorkAreaRect | null {
  if (workAreas.length === 0) return null;
  let best = workAreas[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const area of workAreas) {
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    const score = dx * dx + dy * dy;
    if (score < bestScore) {
      bestScore = score;
      best = area;
    }
  }
  return best;
}

/** Keep the pet stack fixed while applying a new size token. */
export function handleSetPetScale(
  state: WindowManagerState,
  petScale: DesktopPetScale,
  workArea?: WorkAreaRect | null,
): WindowManagerState {
  if (state.petScale === petScale && state.bounds) {
    const spec = resolvePetLayoutSpec(petScale);
    const size = windowSizeForLayout(spec, state.trayExpanded);
    if (state.bounds.width === size.width && state.bounds.height === size.height) {
      return state;
    }
  }
  const nextSpec = resolvePetLayoutSpec(petScale);
  const size = windowSizeForLayout(nextSpec, state.trayExpanded);
  if (!state.bounds) {
    return {
      ...state,
      petScale,
      trayAnchor: state.trayExpanded ? state.trayAnchor : "top-left",
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
    };
  }
  const currentSpec = layoutSpecFromState(state);
  const currentAnchor: TrayLayoutAnchor = state.trayExpanded ? state.trayAnchor : "top-left";
  const stack = petStackScreenRect(state.bounds, currentAnchor, currentSpec);
  const nextAnchor = state.trayExpanded
    ? pickTrayLayoutAnchor(stack, size, workArea, nextSpec)
    : "top-left";
  let bounds = windowBoundsForPetStack({
    stack,
    anchor: nextAnchor,
    width: size.width,
    height: size.height,
    spec: nextSpec,
  });
  if (workArea) bounds = clampWindowBounds(bounds, workArea);
  return {
    ...state,
    petScale,
    trayAnchor: nextAnchor,
    bounds,
  };
}

/** Move the collapsed pet to the work-area default (typically primary bottom-right). */
export function handleRestoreDefaultPosition(
  state: WindowManagerState,
  workArea: WorkAreaRect,
): WindowManagerState {
  const spec = layoutSpecFromState(state);
  const size = windowSizeForLayout(spec, false);
  const position = defaultPetWindowPosition(workArea, state.petScale);
  return {
    ...state,
    trayExpanded: false,
    trayAnchor: "top-left",
    bounds: clampWindowBounds(
      { x: position.x, y: position.y, width: size.width, height: size.height },
      workArea,
    ),
  };
}

/**
 * After display add/remove/metrics change, keep the window inside the nearest
 * remaining work area. Hidden windows stay hidden.
 */
export function recoverWindowToNearestWorkArea(
  state: WindowManagerState,
  workAreas: readonly WorkAreaRect[],
): WindowManagerState {
  if (workAreas.length === 0) return state;
  const spec = layoutSpecFromState(state);
  const size = windowSizeForLayout(spec, state.trayExpanded);
  const current = state.bounds ?? {
    x: 40,
    y: 40,
    width: size.width,
    height: size.height,
  };
  const sized: PetWindowBounds = {
    ...current,
    width: size.width,
    height: size.height,
  };
  const containing = workAreas.find((area) => windowFullyVisible(sized, area));
  const target =
    containing ??
    nearestWorkArea({ x: sized.x + sized.width / 2, y: sized.y + sized.height / 2 }, workAreas);
  if (!target) return { ...state, bounds: sized };
  if (containing && sized.width === current.width && sized.height === current.height) {
    return state.bounds ? state : { ...state, bounds: sized };
  }
  return {
    ...state,
    bounds: clampWindowBounds(sized, target),
  };
}

const USER_ACTIVATE_REASONS = new Set<PetWindowRevealReason>([
  "user-show",
  "second-instance",
  "user-disable-click-through",
]);

/**
 * Map a visibility + trigger into a host reveal.
 * Passive updates never show or focus; startup may show without activating.
 */
export function resolvePetWindowReveal(input: {
  visible: boolean;
  reason: PetWindowRevealReason;
}): PetWindowReveal {
  if (USER_ACTIVATE_REASONS.has(input.reason)) return "activate";
  if (input.reason === "startup" && input.visible) return "show-inactive";
  return "keep";
}

/** Push renderer state without throwing if the window is gone. */
export function sendPetWindowChannel(
  handle: PetWindowHandle | null | undefined,
  channel: string,
  payload: unknown,
): boolean {
  try {
    if (!handle || handle.isDestroyed()) return false;
    handle.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply window-manager state to a live handle.
 * Click-through uses forward so tray recovery still receives events where supported.
 * Reveal is explicit: passive callers must pass keep / show-inactive, never rely on show().
 */
export function applyWindowManagerState(
  handle: PetWindowHandle,
  state: WindowManagerState,
  options?: { reveal?: PetWindowReveal },
): void {
  if (handle.isDestroyed()) return;
  handle.setAlwaysOnTop(state.alwaysOnTop);
  handle.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  if (state.bounds) {
    handle.setBounds(state.bounds);
  }
  if (!state.visible) {
    handle.hide();
    return;
  }
  const reveal = options?.reveal ?? "keep";
  if (reveal === "activate") {
    handle.show();
    handle.focus();
    return;
  }
  if (reveal === "show-inactive") {
    handle.showInactive();
  }
}

/** Security webPreferences contract for BrowserWindow construction. */
export function petWindowWebPreferences(preloadPath: string): {
  preload: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  spellcheck: false;
} {
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
  };
}
