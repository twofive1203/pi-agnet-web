/**
 * Narrow preload bridge for the desktop pet renderer (U7).
 *
 * Security:
 * - contextIsolation + sandbox (set by main)
 * - no Node export, no token, no arbitrary shell, no cwd
 * - only allowlisted IPC channels
 */

import { contextBridge, ipcRenderer } from "electron";

import {
  isRendererIpcChannel,
  PET_IPC_CHANNELS,
  type PetPrefsPatch,
} from "../main/ipc-contract";
import { isSoundCueKind, type SoundCueKind } from "../main/sound-cue";

export type SnailPetBridge = {
  getState: () => Promise<unknown>;
  onStateChanged: (handler: (view: unknown) => void) => () => void;
  toggleTray: () => void;
  /** Close affordance: hide window to tray (does not quit). */
  hideToTray: () => void;
  /** Tauri-only native drag path; Electron keeps the renderer delta fallback. */
  startDragging?: () => void;
  /** Physical native-window positions emitted while Tauri owns the OS drag loop. */
  onNativeWindowMoved?: (handler: (position: { x: number; y: number }) => void) => () => void;
  /** Move frameless window by screen-pixel delta (Electron fallback). */
  moveBy: (dx: number, dy: number) => void;
  selectActivity: (activityId: string) => void;
  markRead: (activityId: string) => void;
  markAllRead: () => void;
  openActivity: (activityId: string) => Promise<unknown>;
  /** Relative allowlisted href only — absolute URLs are rejected by main. */
  openExternalUrl: (href: string) => Promise<unknown>;
  retry: () => void;
  copyStartCommand: () => Promise<unknown>;
  setPrefs: (patch: PetPrefsPatch) => void;
  /** Restore medium size and move the pet to the current display's default dock. */
  restoreDefaultPosition: () => void;
  setReducedMotion: (value: boolean) => void;
  /** Submit server access key (main never echoes it back). */
  setAccessKey: (accessKey: string) => Promise<unknown>;
  clearAccessKey: () => Promise<unknown>;
  /**
   * Read-only sound cue subscription (U4a). Main pushes only the finite cue
   * vocabulary; the renderer can never send cues or audio parameters back.
   */
  onSoundCue: (handler: (cue: SoundCueKind) => void) => () => void;
  /** Fetch sanitized custom-pet assets (validated manifests + data-URL sheets). */
  getCustomPets: () => Promise<unknown>;
  /**
   * Custom-pet payload push (U6 slice 1). Main pushes only after a rescan;
   * the renderer re-validates every entry before use.
   */
  onCustomPetsChanged: (handler: (payload: unknown) => void) => () => void;
  /** Open the main-owned custom pets folder (no renderer-supplied paths). */
  openCustomPetsDir: () => Promise<unknown>;
  /** Ask main to rescan the custom pets folder. */
  rescanCustomPets: () => void;
  /** Fetch one selected pet bitmap by namespaced catalog key. */
  getPetAsset: (petKey: string) => Promise<unknown>;
  /** Fetch the current path-free project catalog (no cwd/token). */
  listQuickSessionProjects: () => Promise<unknown>;
  /** Fetch the path-free model catalog for one projectRef. */
  listQuickSessionModels: (projectRef: string) => Promise<unknown>;
  /** Start one session; renderer supplies only projectRef + message + requestId + optional model. */
  createQuickSession: (input: {
    projectRef: string;
    message: string;
    requestId: string;
    provider?: string;
    modelId?: string;
  }) => Promise<unknown>;
};

function send(channel: string, ...args: unknown[]): void {
  if (!isRendererIpcChannel(channel)) {
    throw new Error(`blocked ipc channel: ${channel}`);
  }
  ipcRenderer.send(channel, ...args);
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!isRendererIpcChannel(channel)) {
    return Promise.reject(new Error(`blocked ipc channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

const bridge: SnailPetBridge = {
  getState: () => invoke(PET_IPC_CHANNELS.getState),
  onStateChanged: (handler) => {
    const listener = (_event: unknown, view: unknown) => {
      handler(view);
    };
    ipcRenderer.on(PET_IPC_CHANNELS.stateChanged, listener);
    return () => {
      ipcRenderer.removeAllListeners(PET_IPC_CHANNELS.stateChanged);
    };
  },
  toggleTray: () => send(PET_IPC_CHANNELS.toggleTray),
  hideToTray: () => send(PET_IPC_CHANNELS.hideToTray),
  moveBy: (dx, dy) => send(PET_IPC_CHANNELS.moveBy, { dx, dy }),
  selectActivity: (activityId) => send(PET_IPC_CHANNELS.selectActivity, activityId),
  markRead: (activityId) => send(PET_IPC_CHANNELS.markRead, activityId),
  markAllRead: () => send(PET_IPC_CHANNELS.markAllRead),
  openActivity: (activityId) => invoke(PET_IPC_CHANNELS.openActivity, activityId),
  openExternalUrl: (href) => invoke(PET_IPC_CHANNELS.openExternalUrl, href),
  retry: () => send(PET_IPC_CHANNELS.retry),
  copyStartCommand: () => invoke(PET_IPC_CHANNELS.copyStartCommand),
  setPrefs: (patch) => send(PET_IPC_CHANNELS.setPrefs, patch),
  restoreDefaultPosition: () => send(PET_IPC_CHANNELS.restoreDefaultPosition),
  setReducedMotion: (value) => send(PET_IPC_CHANNELS.setReducedMotion, value),
  setAccessKey: (accessKey) => invoke(PET_IPC_CHANNELS.setAccessKey, accessKey),
  clearAccessKey: () => invoke(PET_IPC_CHANNELS.clearAccessKey),
  onSoundCue: (handler) => {
    const listener = (_event: unknown, payload: unknown) => {
      // Defense in depth: forward only the narrow allowlisted vocabulary.
      const kind =
        Boolean(payload) &&
        typeof payload === "object" &&
        (payload as { kind?: unknown }).kind;
      if (!isSoundCueKind(kind)) return;
      handler(kind);
    };
    ipcRenderer.on(PET_IPC_CHANNELS.soundCue, listener);
    return () => {
      ipcRenderer.removeAllListeners(PET_IPC_CHANNELS.soundCue);
    };
  },
  getCustomPets: () => invoke(PET_IPC_CHANNELS.getCustomPets),
  onCustomPetsChanged: (handler) => {
    const listener = (_event: unknown, payload: unknown) => {
      handler(payload);
    };
    ipcRenderer.on(PET_IPC_CHANNELS.customPetsChanged, listener);
    return () => {
      ipcRenderer.removeAllListeners(PET_IPC_CHANNELS.customPetsChanged);
    };
  },
  openCustomPetsDir: () => invoke(PET_IPC_CHANNELS.openCustomPetsDir),
  rescanCustomPets: () => send(PET_IPC_CHANNELS.rescanCustomPets),
  getPetAsset: (petKey) => invoke(PET_IPC_CHANNELS.getPetAsset, petKey),
  listQuickSessionProjects: () => invoke(PET_IPC_CHANNELS.listQuickSessionProjects),
  listQuickSessionModels: (projectRef) => invoke(PET_IPC_CHANNELS.listQuickSessionModels, projectRef),
  createQuickSession: (input) => invoke(PET_IPC_CHANNELS.createQuickSession, input),
};

contextBridge.exposeInMainWorld("snailPet", bridge);

// Freeze surface for defensive hardening in the isolated world.
try {
  Object.freeze(bridge);
} catch {
  // ignore
}
