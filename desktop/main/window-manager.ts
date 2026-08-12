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
  petOnlyWidth: 128,
  petOnlyHeight: 128,
  trayWidth: 360,
  trayHeight: 480,
} as const;

export type WindowManagerState = {
  visible: boolean;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  trayExpanded: boolean;
  bounds: PetWindowBounds | null;
};

export function createInitialWindowManagerState(input?: {
  position?: { x: number; y: number } | null;
  alwaysOnTop?: boolean;
  clickThrough?: boolean;
  trayOpen?: boolean;
}): WindowManagerState {
  const trayExpanded = input?.trayOpen === true;
  const width = trayExpanded ? PET_WINDOW_DEFAULTS.trayWidth : PET_WINDOW_DEFAULTS.petOnlyWidth;
  const height = trayExpanded ? PET_WINDOW_DEFAULTS.trayHeight : PET_WINDOW_DEFAULTS.petOnlyHeight;
  const position = input?.position ?? null;
  return {
    visible: true,
    clickThrough: input?.clickThrough === true,
    alwaysOnTop: input?.alwaysOnTop !== false,
    trayExpanded,
    bounds: position
      ? { x: position.x, y: position.y, width, height }
      : { x: 0, y: 0, width, height },
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

export function handleToggleTray(state: WindowManagerState): WindowManagerState {
  const trayExpanded = !state.trayExpanded;
  const width = trayExpanded ? PET_WINDOW_DEFAULTS.trayWidth : PET_WINDOW_DEFAULTS.petOnlyWidth;
  const height = trayExpanded ? PET_WINDOW_DEFAULTS.trayHeight : PET_WINDOW_DEFAULTS.petOnlyHeight;
  const bounds = state.bounds
    ? { ...state.bounds, width, height }
    : { x: 0, y: 0, width, height };
  return { ...state, trayExpanded, bounds, visible: true };
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
