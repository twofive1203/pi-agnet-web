/**
 * Narrow main ↔ preload IPC channel contract (U7).
 *
 * Renderer never receives tokens, absolute open-URL capabilities, or Node APIs.
 */

export const PET_IPC_CHANNELS = {
  getState: "pet:get-state",
  stateChanged: "pet:state-changed",
  toggleTray: "pet:toggle-tray",
  /** Hide pet window to tray (close affordance on frameless window). */
  hideToTray: "pet:hide-to-tray",
  /** Renderer-driven window move delta (pet body click-vs-drag). */
  moveBy: "pet:move-by",
  selectActivity: "pet:select-activity",
  markRead: "pet:mark-read",
  markAllRead: "pet:mark-all-read",
  openActivity: "pet:open-activity",
  /** Rejected if absolute — kept only to assert denial in tests/host. */
  openExternalUrl: "pet:open-external-url",
  retry: "pet:retry",
  copyStartCommand: "pet:copy-start-command",
  setPrefs: "pet:set-prefs",
  /** User recovery: restore medium size and the nearest work-area default dock. */
  restoreDefaultPosition: "pet:restore-default-position",
  setReducedMotion: "pet:set-reduced-motion",
  /** Main-only: set/clear server access key (never echoed back). */
  setAccessKey: "pet:set-access-key",
  clearAccessKey: "pet:clear-access-key",
  /** Main→renderer push: finite sound cue vocabulary (U4a). Renderer can never send this. */
  soundCue: "pet:sound-cue",
  /** Renderer invoke: sanitized custom-pet assets discovered by main. */
  getCustomPets: "pet:get-custom-pets",
  /** Main→renderer push: custom-pet payload after a rescan. Renderer can never send this. */
  customPetsChanged: "pet:custom-pets-changed",
  /** Open the main-owned custom pets folder (path constructed in main only). */
  openCustomPetsDir: "pet:open-custom-pets-dir",
  /** Re-scan the custom pets folder (user added/removed pets on disk). */
  rescanCustomPets: "pet:rescan-custom-pets",
  /** Load the selected catalog pet bitmap by namespaced key (never a path). */
  getPetAsset: "pet:get-pet-asset",
  /** List path-free projects for the in-tray quick-session composer. */
  listQuickSessionProjects: "pet:list-quick-session-projects",
  /** List path-free models for the selected project. */
  listQuickSessionModels: "pet:list-quick-session-models",
  /** Start one Agent session with the first text message. */
  createQuickSession: "pet:create-quick-session",
} as const;

export type PetIpcChannel = (typeof PET_IPC_CHANNELS)[keyof typeof PET_IPC_CHANNELS];

/** Channels the renderer may invoke/send. */
export const PET_RENDERER_ALLOWED_CHANNELS: readonly string[] = [
  PET_IPC_CHANNELS.getState,
  PET_IPC_CHANNELS.toggleTray,
  PET_IPC_CHANNELS.hideToTray,
  PET_IPC_CHANNELS.moveBy,
  PET_IPC_CHANNELS.selectActivity,
  PET_IPC_CHANNELS.markRead,
  PET_IPC_CHANNELS.markAllRead,
  PET_IPC_CHANNELS.openActivity,
  PET_IPC_CHANNELS.openExternalUrl,
  PET_IPC_CHANNELS.retry,
  PET_IPC_CHANNELS.copyStartCommand,
  PET_IPC_CHANNELS.setPrefs,
  PET_IPC_CHANNELS.restoreDefaultPosition,
  PET_IPC_CHANNELS.setReducedMotion,
  PET_IPC_CHANNELS.setAccessKey,
  PET_IPC_CHANNELS.clearAccessKey,
  PET_IPC_CHANNELS.getCustomPets,
  PET_IPC_CHANNELS.openCustomPetsDir,
  PET_IPC_CHANNELS.rescanCustomPets,
  PET_IPC_CHANNELS.getPetAsset,
  PET_IPC_CHANNELS.listQuickSessionProjects,
  PET_IPC_CHANNELS.listQuickSessionModels,
  PET_IPC_CHANNELS.createQuickSession,
];

/** Channels main may push to renderer. */
export const PET_MAIN_PUSH_CHANNELS: readonly string[] = [
  PET_IPC_CHANNELS.stateChanged,
  PET_IPC_CHANNELS.soundCue,
  PET_IPC_CHANNELS.customPetsChanged,
];

export type PetPrefsPatch = Partial<{
  selectedPetId: string;
  selectedPetKey: string;
  petScale: "small" | "medium" | "large";
  bubbleTheme: "cream" | "peach" | "night" | "ember" | "plum" | "moss";
  alwaysOnTop: boolean;
  clickThrough: boolean;
  launchAtLogin: boolean;
  activityTrayOpen: boolean;
  showContextMeter: boolean;
  dndEnabled: boolean;
  notification: Partial<{
    needsInput: boolean;
    blocked: boolean;
    completion: "never" | "background-only" | "always";
  }>;
  sound: Partial<{
    masterEnabled: boolean;
    needsInput: boolean;
    completion: boolean;
  }>;
  port: number;
}>;

/** Renderer never receives the key — only whether one is configured. */
export type PetAccessKeyPatch = {
  accessKey: string;
};

/** Static allowlist check used by smoke + preload hardening. */
export function isRendererIpcChannel(channel: string): boolean {
  return PET_RENDERER_ALLOWED_CHANNELS.includes(channel);
}
