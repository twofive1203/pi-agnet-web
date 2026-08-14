/**
 * Desktop sound cue selection policy + thin emitter controller (U4a).
 *
 * Sounds are auxiliary only: they never change task state and can never be the
 * only state cue (pet visuals, tray rows and system notifications keep their
 * own paths). The policy mirrors notification-controller.ts:
 *
 * - transition classification into a finite cue vocabulary (attention | completion);
 * - initial/reset/instance-change baseline emits nothing and seeds the sounded LRU;
 * - settings gates (master + per-event), DND gate ("sound" surface) and per-kind
 *   cooldown; every suppressed transition is still consumed so enabling a toggle,
 *   disabling DND or cooling down never replays history;
 * - an independent bounded `soundedTransitionIds` LRU (never shared with
 *   `notifiedTransitionIds`, since system notifications and sounds are
 *   separately configured).
 *
 * Cooldown timestamps are in-memory controller state; the sounded LRU is the
 * only persisted piece (through settings normalize/serialize).
 */

import type {
  TaskObserverSnapshot,
  TaskObserverTransition,
} from "../../lib/task-observer-types";
import { shouldSuppressProactiveByDnd } from "./dnd-policy";
import { pushTransitionLru, type DesktopPetSettings } from "./settings-store";
import type { SoundCueKind } from "./sound-cue";

/** Per-kind cooldown: same-kind transitions within this window are merged. */
export const SOUND_COOLDOWN_MS = 10_000;

/**
 * Map a transition presentation to a sound cue kind.
 * Only needs_input and ready are soundable; blocked/running/retrying and
 * connection diagnostics intentionally return null (first release).
 */
export function soundCueForPresentation(
  presentation: string,
): SoundCueKind | null {
  if (presentation === "needs_input") return "attention";
  if (presentation === "ready") return "completion";
  return null;
}

export type SoundPolicyInput = {
  settings: DesktopPetSettings;
  /** When true, seed the sounded LRU from current transitions and emit nothing. */
  resetBaseline: boolean;
  snapshot: TaskObserverSnapshot | null;
  /** Optional explicit transitions; defaults to snapshot.recentTransitions. */
  transitions?: readonly TaskObserverTransition[];
  /** Wall clock for cooldown decisions (injectable for tests). */
  now?: number;
  /** Per-kind last-play timestamps (in-memory only). */
  lastPlayedAt?: Partial<Record<SoundCueKind, number>>;
};

export type SoundPolicyResult = {
  cues: SoundCueKind[];
  /** Updated soundedTransitionIds LRU (advanced on baseline and every consumed id). */
  soundedTransitionIds: string[];
  lastPlayedAt: Partial<Record<SoundCueKind, number>>;
  /** Whether settings.soundedTransitionIds should be persisted. */
  changed: boolean;
};

function kindAllowedBySettings(kind: SoundCueKind, settings: DesktopPetSettings): boolean {
  if (!settings.sound.masterEnabled) return false;
  if (kind === "attention") return settings.sound.needsInput;
  return settings.sound.completion;
}

/**
 * Select which transitions should emit a sound cue.
 * Baseline seeds the sounded LRU without playback (same contract as R24–R26).
 */
export function selectSoundCues(input: SoundPolicyInput): SoundPolicyResult {
  const transitions = input.transitions ?? input.snapshot?.recentTransitions ?? [];
  const sounded = new Set(input.settings.soundedTransitionIds);
  let nextSounded = input.settings.soundedTransitionIds.slice();
  const lastPlayedAt: Partial<Record<SoundCueKind, number>> = {
    ...(input.lastPlayedAt ?? {}),
  };
  const now = input.now ?? Date.now();
  let changed = false;
  const cues: SoundCueKind[] = [];

  const consume = (id: string): void => {
    if (!id || sounded.has(id)) return;
    nextSounded = pushTransitionLru(nextSounded, id);
    sounded.add(id);
    changed = true;
  };

  if (input.resetBaseline) {
    for (const transition of transitions) {
      consume(transition.transitionId.trim());
    }
    // Baseline activity lastTransitionIds too, so live rows do not immediately beep.
    if (input.snapshot) {
      for (const project of input.snapshot.projects) {
        for (const activity of project.activities) {
          consume(activity.lastTransitionId.trim());
        }
      }
    }
    return { cues: [], soundedTransitionIds: nextSounded, lastPlayedAt, changed };
  }

  for (const transition of transitions) {
    const id = transition.transitionId.trim();
    if (!id || sounded.has(id)) continue;
    const kind = soundCueForPresentation(transition.presentation);
    // blocked/running/retrying/connection presentations are never soundable.
    if (!kind) continue;

    const dndSuppressed = shouldSuppressProactiveByDnd({
      dndEnabled: input.settings.dndEnabled,
      presentation: transition.presentation,
      surface: "sound",
    });
    const settingsSuppressed = !kindAllowedBySettings(kind, input.settings);
    const cooldownSuppressed =
      (lastPlayedAt[kind] ?? Number.NEGATIVE_INFINITY) + SOUND_COOLDOWN_MS > now;

    // Every suppression path still consumes the transition locally: switching
    // the toggle on, disabling DND or cooling down must never replay history.
    if (dndSuppressed || settingsSuppressed || cooldownSuppressed) {
      consume(id);
      continue;
    }

    lastPlayedAt[kind] = now;
    consume(id);
    cues.push(kind);
  }

  return { cues, soundedTransitionIds: nextSounded, lastPlayedAt, changed };
}

export function applySoundedIds(
  settings: DesktopPetSettings,
  soundedTransitionIds: string[],
): DesktopPetSettings {
  return { ...settings, soundedTransitionIds };
}

/** Injectable cue sink — main wires the narrow IPC push here. */
export type SoundCueEmitter = {
  emit(cue: SoundCueKind): void;
};

/**
 * Controller that applies pure policy and forwards the finite cue vocabulary.
 * Emitter failures are swallowed: sounds are auxiliary and must never break
 * observation, the Activity tray or system notifications.
 */
export class DesktopSoundCueController {
  private emitter: SoundCueEmitter;
  private lastPlayedAt: Partial<Record<SoundCueKind, number>> = {};

  constructor(emitter?: SoundCueEmitter) {
    this.emitter = emitter ?? { emit: () => undefined };
  }

  setEmitter(emitter: SoundCueEmitter): void {
    this.emitter = emitter;
  }

  handleSnapshot(input: {
    settings: DesktopPetSettings;
    snapshot: TaskObserverSnapshot | null;
    resetBaseline: boolean;
  }): { settings: DesktopPetSettings; emitted: SoundCueKind[] } {
    const result = selectSoundCues({
      settings: input.settings,
      snapshot: input.snapshot,
      resetBaseline: input.resetBaseline,
      lastPlayedAt: this.lastPlayedAt,
    });
    this.lastPlayedAt = result.lastPlayedAt;

    for (const cue of result.cues) {
      try {
        this.emitter.emit(cue);
      } catch {
        // Auxiliary cue only — observation stays authoritative.
      }
    }

    const settings = result.changed
      ? applySoundedIds(input.settings, result.soundedTransitionIds)
      : input.settings;
    return { settings, emitted: result.cues };
  }
}
