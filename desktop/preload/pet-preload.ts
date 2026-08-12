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

export type SnailPetBridge = {
  getState: () => Promise<unknown>;
  onStateChanged: (handler: (view: unknown) => void) => () => void;
  toggleTray: () => void;
  /** Close affordance: hide window to tray (does not quit). */
  hideToTray: () => void;
  selectActivity: (activityId: string) => void;
  markRead: (activityId: string) => void;
  markAllRead: () => void;
  openActivity: (activityId: string) => Promise<unknown>;
  /** Relative allowlisted href only — absolute URLs are rejected by main. */
  openExternalUrl: (href: string) => Promise<unknown>;
  retry: () => void;
  copyStartCommand: () => Promise<unknown>;
  setPrefs: (patch: PetPrefsPatch) => void;
  setReducedMotion: (value: boolean) => void;
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
  selectActivity: (activityId) => send(PET_IPC_CHANNELS.selectActivity, activityId),
  markRead: (activityId) => send(PET_IPC_CHANNELS.markRead, activityId),
  markAllRead: () => send(PET_IPC_CHANNELS.markAllRead),
  openActivity: (activityId) => invoke(PET_IPC_CHANNELS.openActivity, activityId),
  openExternalUrl: (href) => invoke(PET_IPC_CHANNELS.openExternalUrl, href),
  retry: () => send(PET_IPC_CHANNELS.retry),
  copyStartCommand: () => invoke(PET_IPC_CHANNELS.copyStartCommand),
  setPrefs: (patch) => send(PET_IPC_CHANNELS.setPrefs, patch),
  setReducedMotion: (value) => send(PET_IPC_CHANNELS.setReducedMotion, value),
};

contextBridge.exposeInMainWorld("snailPet", bridge);

// Freeze surface for defensive hardening in the isolated world.
try {
  Object.freeze(bridge);
} catch {
  // ignore
}
