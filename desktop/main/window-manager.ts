/**
 * Pet window lifecycle helpers (U7).
 *
 * Security defaults: no nodeIntegration, contextIsolation, sandbox.
 * Close hides to tray rather than quitting (R13).
 */

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

export type PetWindowHandle = {
  show(): void;
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
  onClose(handler: (event: { preventDefault(): void }) => void): void;
  onMoved(handler: (bounds: PetWindowBounds) => void): void;
  onBlur(handler: () => void): void;
  onFocus(handler: () => void): void;
};

export const PET_WINDOW_DEFAULTS = {
  width: 360,
  height: 480,
  /** Collapsed chrome (18) + avatar (112) + root padding/gap — must fit without clipping. */
  petOnlyWidth: 140,
  petOnlyHeight: 160,
  trayWidth: 360,
  trayHeight: 480,
} as const;

/**
 * Where the pet stack (chrome + avatar) sits inside the window while the tray is open.
 * Collapsed windows always use top-left. Must stay in sync with renderer CSS/HTML.
 */
export type TrayLayoutAnchor = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Pixel metrics shared with desktop/renderer/pet.css (padding / chrome / avatar). */
export const PET_LAYOUT = {
  rootPad: 6,
  stackWidth: 112,
  /** chrome 18 + gap 6 + surface 112 */
  stackHeight: 136,
} as const;

export type WindowManagerState = {
  visible: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  trayExpanded: boolean;
  /** Active only while trayExpanded; collapsed layout is always top-left. */
  trayAnchor: TrayLayoutAnchor;
  bounds: PetWindowBounds | null;
};

export function createInitialWindowManagerState(input?: {
  position?: { x: number; y: number } | null;
  alwaysOnTop?: boolean;
  clickThrough?: boolean;
  trayOpen?: boolean;
  /** Used only when no saved position (typically primary work-area bottom-right). */
  defaultPosition?: { x: number; y: number } | null;
}): WindowManagerState {
  const trayExpanded = input?.trayOpen === true;
  const width = trayExpanded ? PET_WINDOW_DEFAULTS.trayWidth : PET_WINDOW_DEFAULTS.petOnlyWidth;
  const height = trayExpanded ? PET_WINDOW_DEFAULTS.trayHeight : PET_WINDOW_DEFAULTS.petOnlyHeight;
  const position = input?.position ?? input?.defaultPosition ?? null;
  return {
    visible: true,
    clickThrough: input?.clickThrough === true,
    alwaysOnTop: input?.alwaysOnTop !== false,
    trayExpanded,
    // Restored expanded sessions default to top-left; first toggle re-picks from work area.
    trayAnchor: "top-left",
    bounds: position
      ? { x: position.x, y: position.y, width, height }
      : { x: 40, y: 40, width, height },
  };
}

/** Place the collapsed pet near the bottom-right of a work area (with padding). */
export function defaultPetWindowPosition(workArea: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  const pad = 24;
  return {
    x: Math.round(workArea.x + workArea.width - PET_WINDOW_DEFAULTS.petOnlyWidth - pad),
    y: Math.round(workArea.y + workArea.height - PET_WINDOW_DEFAULTS.petOnlyHeight - pad),
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

/** Screen rect of the pet stack (chrome + avatar) for the current layout anchor. */
export function petStackScreenRect(
  bounds: PetWindowBounds,
  anchor: TrayLayoutAnchor,
): { x: number; y: number; width: number; height: number } {
  const { rootPad, stackWidth, stackHeight } = PET_LAYOUT;
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
}): PetWindowBounds {
  const { rootPad } = PET_LAYOUT;
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
): TrayLayoutAnchor {
  if (!workArea) return "top-left";
  for (const anchor of TRAY_ANCHOR_PREFERENCE) {
    const bounds = windowBoundsForPetStack({
      stack,
      anchor,
      width: size.width,
      height: size.height,
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
    });
    const clamped = clampWindowBounds(raw, workArea);
    const placed = petStackScreenRect(clamped, anchor);
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
  const trayExpanded = !state.trayExpanded;
  const width = trayExpanded ? PET_WINDOW_DEFAULTS.trayWidth : PET_WINDOW_DEFAULTS.petOnlyWidth;
  const height = trayExpanded ? PET_WINDOW_DEFAULTS.trayHeight : PET_WINDOW_DEFAULTS.petOnlyHeight;

  if (!state.bounds) {
    return {
      ...state,
      trayExpanded,
      trayAnchor: trayExpanded ? "top-left" : "top-left",
      bounds: { x: 0, y: 0, width, height },
      visible: true,
    };
  }

  // Pet stack screen position is the stable anchor across expand/collapse.
  const currentAnchor: TrayLayoutAnchor = state.trayExpanded ? state.trayAnchor : "top-left";
  const stack = petStackScreenRect(state.bounds, currentAnchor);

  if (trayExpanded) {
    const anchor = pickTrayLayoutAnchor(stack, { width, height }, workArea);
    let bounds = windowBoundsForPetStack({ stack, anchor, width, height });
    if (workArea) bounds = clampWindowBounds(bounds, workArea);
    return { ...state, trayExpanded: true, trayAnchor: anchor, bounds, visible: true };
  }

  // Collapse always uses top-left content layout; reposition window so the stack stays put.
  let bounds = windowBoundsForPetStack({
    stack,
    anchor: "top-left",
    width,
    height,
  });
  if (workArea) bounds = clampWindowBounds(bounds, workArea);
  return {
    ...state,
    trayExpanded: false,
    trayAnchor: "top-left",
    bounds,
    visible: true,
  };
}

/** Apply a renderer-driven drag delta (click-vs-drag on the pet body). */
export function handleMoveBy(
  state: WindowManagerState,
  delta: { dx: number; dy: number },
  workArea?: WorkAreaRect | null,
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
  if (workArea) {
    // Soft clamp: allow partial overhang of at most half the window so drag feels free
    // near edges, but never lose the window completely.
    const soft: WorkAreaRect = {
      x: workArea.x - Math.floor(bounds.width / 2),
      y: workArea.y - Math.floor(bounds.height / 2),
      width: workArea.width + bounds.width,
      height: workArea.height + bounds.height,
    };
    bounds = clampWindowBounds(bounds, soft);
  }
  return { ...state, bounds, visible: true };
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

/**
 * Apply window-manager state to a live handle.
 * Click-through uses forward so tray recovery still receives events where supported.
 */
export function applyWindowManagerState(
  handle: PetWindowHandle,
  state: WindowManagerState,
): void {
  if (handle.isDestroyed()) return;
  handle.setAlwaysOnTop(state.alwaysOnTop);
  handle.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  if (state.bounds) {
    handle.setBounds(state.bounds);
  }
  if (state.visible) {
    handle.show();
  } else {
    handle.hide();
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
