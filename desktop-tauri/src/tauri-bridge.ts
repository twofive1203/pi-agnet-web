import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PetPrefsPatch } from "../../desktop/main/ipc-contract";
import { isSoundCueKind, type SoundCueKind } from "../../desktop/main/sound-cue";

const STATE_CHANGED = "pet:state-changed";
const SOUND_CUE = "pet:sound-cue";
const CUSTOM_PETS_CHANGED = "pet:custom-pets-changed";
const NATIVE_WINDOW_MOVED = "pet:native-window-moved";

type SnailPetBridge = {
  getState: () => Promise<unknown>;
  onStateChanged: (handler: (view: unknown) => void) => () => void;
  toggleTray: () => void;
  hideToTray: () => void;
  startDragging: () => void;
  onNativeWindowMoved: (handler: (position: { x: number; y: number }) => void) => () => void;
  moveBy: (dx: number, dy: number) => void;
  selectActivity: (activityId: string) => void;
  markRead: (activityId: string) => void;
  markAllRead: () => void;
  openActivity: (activityId: string) => Promise<unknown>;
  openExternalUrl: (href: string) => Promise<unknown>;
  retry: () => void;
  copyStartCommand: () => Promise<unknown>;
  setPrefs: (patch: PetPrefsPatch) => void;
  restoreDefaultPosition: () => void;
  setReducedMotion: (value: boolean) => void;
  setAccessKey: (accessKey: string) => Promise<unknown>;
  clearAccessKey: () => Promise<unknown>;
  onSoundCue: (handler: (cue: SoundCueKind) => void) => () => void;
  getCustomPets: () => Promise<unknown>;
  onCustomPetsChanged: (handler: (payload: unknown) => void) => () => void;
  openCustomPetsDir: () => Promise<unknown>;
  rescanCustomPets: () => void;
  getPetAsset: (petKey: string) => Promise<unknown>;
  listQuickSessionProjects: () => Promise<unknown>;
  listQuickSessionModels: (projectRef: string) => Promise<unknown>;
  createQuickSession: (input: {
    projectRef: string;
    message: string;
    requestId: string;
    provider?: string;
    modelId?: string;
  }) => Promise<unknown>;
};

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const unlistens: UnlistenFn[] = [];

function subscribe(eventName: string, handler: (payload: unknown) => void): () => void {
  let bucket = listeners.get(eventName);
  if (!bucket) {
    bucket = new Set();
    listeners.set(eventName, bucket);
    void listen(eventName, (event) => {
      const current = listeners.get(eventName);
      if (!current) return;
      for (const listener of current) listener(event.payload);
    }).then((unlisten) => {
      unlistens.push(unlisten);
    });
  }
  bucket.add(handler);
  return () => {
    bucket?.delete(handler);
  };
}

const bridge: SnailPetBridge = {
  getState: () => invoke("get_state"),
  onStateChanged: (handler) => subscribe(STATE_CHANGED, handler),
  toggleTray: () => {
    void invoke("toggle_tray");
  },
  hideToTray: () => {
    void invoke("hide_to_tray");
  },
  startDragging: () => {
    void invoke("start_dragging");
  },
  onNativeWindowMoved: (handler) =>
    subscribe(NATIVE_WINDOW_MOVED, (payload) => {
      if (!payload || typeof payload !== "object") return;
      const { x, y } = payload as { x?: unknown; y?: unknown };
      if (typeof x !== "number" || !Number.isFinite(x)) return;
      if (typeof y !== "number" || !Number.isFinite(y)) return;
      handler({ x, y });
    }),
  moveBy: (dx, dy) => {
    void invoke("move_by", { dx, dy });
  },
  selectActivity: (activityId) => {
    void invoke("select_activity", { activityId });
  },
  markRead: (activityId) => {
    void invoke("mark_read", { activityId });
  },
  markAllRead: () => {
    void invoke("mark_all_read");
  },
  openActivity: (activityId) => invoke("open_activity", { activityId }),
  openExternalUrl: (href) => invoke("open_external_url", { href }),
  retry: () => {
    void invoke("retry");
  },
  copyStartCommand: () => invoke("copy_start_command"),
  setPrefs: (patch) => {
    void invoke("set_prefs", { patch });
  },
  restoreDefaultPosition: () => {
    void invoke("restore_default_position");
  },
  setReducedMotion: (value) => {
    void invoke("set_reduced_motion", { value });
  },
  setAccessKey: (accessKey) => invoke("set_access_key", { accessKey }),
  clearAccessKey: () => invoke("clear_access_key"),
  onSoundCue: (handler) =>
    subscribe(SOUND_CUE, (payload) => {
      const kind =
        Boolean(payload) &&
        typeof payload === "object" &&
        (payload as { kind?: unknown }).kind;
      if (!isSoundCueKind(kind)) return;
      handler(kind);
    }),
  getCustomPets: () => invoke("get_custom_pets"),
  onCustomPetsChanged: (handler) => subscribe(CUSTOM_PETS_CHANGED, handler),
  openCustomPetsDir: () => invoke("open_custom_pets_dir"),
  rescanCustomPets: () => {
    void invoke("rescan_custom_pets");
  },
  getPetAsset: (petKey) => invoke("get_pet_asset", { petKey }),
  listQuickSessionProjects: () => invoke("list_quick_session_projects"),
  listQuickSessionModels: (projectRef) => invoke("list_quick_session_models", { projectRef }),
  createQuickSession: (input) => invoke("create_quick_session", { ...input }),
};

Object.defineProperty(window, "snailPet", {
  value: Object.freeze(bridge),
  configurable: false,
  enumerable: true,
  writable: false,
});
void "window.snailPet";
