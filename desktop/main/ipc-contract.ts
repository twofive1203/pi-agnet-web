/**
 * Narrow main ↔ preload IPC channel contract (U7).
 *
 * Renderer never receives tokens, absolute open-URL capabilities, or Node APIs.
 */

export const PET_IPC_CHANNELS = {
  getState: "pet:get-state",
  stateChanged: "pet:state-changed",
  toggleTray: "pet:toggle-tray",
  selectActivity: "pet:select-activity",
  markRead: "pet:mark-read",
  markAllRead: "pet:mark-all-read",
  openActivity: "pet:open-activity",
  /** Rejected if absolute — kept only to assert denial in tests/host. */
  openExternalUrl: "pet:open-external-url",
  retry: "pet:retry",
  copyStartCommand: "pet:copy-start-command",
  setPrefs: "pet:set-prefs",
  setReducedMotion: "pet:set-reduced-motion",
} as const;

export type PetIpcChannel = (typeof PET_IPC_CHANNELS)[keyof typeof PET_IPC_CHANNELS];

/** Channels the renderer may invoke/send. */
export const PET_RENDERER_ALLOWED_CHANNELS: readonly string[] = [
  PET_IPC_CHANNELS.getState,
  PET_IPC_CHANNELS.toggleTray,
  PET_IPC_CHANNELS.selectActivity,
  PET_IPC_CHANNELS.markRead,
  PET_IPC_CHANNELS.markAllRead,
  PET_IPC_CHANNELS.openActivity,
  PET_IPC_CHANNELS.openExternalUrl,
  PET_IPC_CHANNELS.retry,
  PET_IPC_CHANNELS.copyStartCommand,
  PET_IPC_CHANNELS.setPrefs,
  PET_IPC_CHANNELS.setReducedMotion,
];

/** Channels main may push to renderer. */
export const PET_MAIN_PUSH_CHANNELS: readonly string[] = [PET_IPC_CHANNELS.stateChanged];

export type PetPrefsPatch = Partial<{
  selectedPetId: string;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  launchAtLogin: boolean;
  activityTrayOpen: boolean;
  notification: Partial<{
    needsInput: boolean;
    blocked: boolean;
    completion: "never" | "background-only" | "always";
  }>;
  port: number;
}>;

/** Static allowlist check used by smoke + preload hardening. */
export function isRendererIpcChannel(channel: string): boolean {
  return PET_RENDERER_ALLOWED_CHANNELS.includes(channel);
}
