/**
 * Manual Do Not Disturb policy for the desktop pet (U7a).
 *
 * One presentation-based gate shared by every proactive surface:
 * - "system-notification": main-process Electron notifications;
 * - "state-bubble": renderer attention/status bubbles over the pet;
 * - "sound": future U4a alert sounds (gate only — U4a is not implemented here).
 *
 * DND is observability-preserving: connection diagnostics
 * (service_not_running / disconnected / reconnecting) are never suppressed and
 * the pet state, glyphs, labels, Activity tray, unread projection and local
 * mark-read stay untouched. DND is local quieting only — it never approves,
 * rejects, acknowledges, or otherwise mutates server task state.
 */

import type { TaskObserverPresentationState } from "../../lib/task-observer-types";

export type DndGateSurface = "system-notification" | "state-bubble" | "sound";

const DND_SUPPRESSIBLE_PRESENTATIONS = new Set<string>([
  "needs_input",
  "blocked",
  "ready",
  "running",
  "retrying",
]);

/** Task/attention states whose proactive alerts DND silences. */
export function isDndSuppressiblePresentation(
  presentation: TaskObserverPresentationState | string,
): boolean {
  return DND_SUPPRESSIBLE_PRESENTATIONS.has(presentation);
}

/**
 * Single DND gate for all proactive surfaces. When enabled, task-state alerts
 * are suppressed; connection diagnostics remain visible on every surface.
 * U4a sound playback must call this with surface "sound" before any audio.
 */
export function shouldSuppressProactiveByDnd(input: {
  dndEnabled: boolean;
  presentation: TaskObserverPresentationState | string;
  surface: DndGateSurface;
}): boolean {
  if (!input.dndEnabled) return false;
  if (!isDndSuppressiblePresentation(input.presentation)) return false;
  return true;
}
