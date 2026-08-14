/**
 * Finite sound cue vocabulary shared by main policy, IPC and the renderer (U4a).
 *
 * This is a leaf module on purpose: the preload imports it without pulling the
 * policy/settings tree, and the renderer bundles it without any main code.
 *
 * The cue kind is the ONLY payload crossing the sound IPC boundary — the
 * renderer can never receive file paths, URLs, or arbitrary audio parameters.
 */

export type SoundCueKind = "attention" | "completion";

export const SOUND_CUE_KINDS = ["attention", "completion"] as const;

/** Narrow allowlist guard reused by preload and renderer for incoming cues. */
export function isSoundCueKind(value: unknown): value is SoundCueKind {
  return value === "attention" || value === "completion";
}
