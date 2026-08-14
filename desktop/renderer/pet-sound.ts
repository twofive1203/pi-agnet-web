/**
 * Local synthesized sound playback for the desktop pet (U4a).
 *
 * Web Audio only: no files, no network access, no remote URLs, no arbitrary
 * parameters. Frequencies, durations and the master gain are fixed constants
 * below — the cue vocabulary arrives from main as `attention | completion`.
 *
 * Every failure path is silent by design: sounds are an auxiliary cue and must
 * never break the Activity tray, bubbles or the observer. AudioContext missing,
 * suspended, no audio device, or a throwing node simply yields no sound.
 *
 * There is no playback queue: each cue schedules at most two short oscillator
 * tones, and a per-kind defensive gap drops duplicate IPC replays. Main's 10s
 * per-kind cooldown is the authoritative rate limit.
 */

import type { SoundCueKind } from "../main/sound-cue";

/** Hard volume cap: peak gain never exceeds this anywhere in a cue. */
export const SOUND_MASTER_GAIN = 0.06;
/** Hard duration cap: no cue may extend past this many milliseconds. */
export const SOUND_MAX_CUE_MS = 300;
/** Renderer-side defensive per-kind replay gap (main enforces 10s). */
export const SOUND_MIN_KIND_GAP_MS = 320;

/**
 * Fixed tone pattern per cue kind. startMs/durationMs are relative to the cue
 * start; all patterns stay inside SOUND_MAX_CUE_MS.
 */
export const SOUND_CUE_PATTERNS: Readonly<
  Record<SoundCueKind, ReadonlyArray<{ freq: number; startMs: number; durationMs: number }>>
> = {
  // Two quick rising blips — short attention poke.
  attention: [
    { freq: 880, startMs: 0, durationMs: 70 },
    { freq: 1174.66, startMs: 95, durationMs: 110 },
  ],
  // Two rising notes — small completion chime.
  completion: [
    { freq: 659.25, startMs: 0, durationMs: 80 },
    { freq: 880, startMs: 100, durationMs: 160 },
  ],
};

/** Minimal structural surface of Web Audio objects the player drives. */
export type PetAudioParamLike = {
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
};

export type PetOscillatorLike = {
  type: string;
  frequency: PetAudioParamLike;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
};

export type PetGainLike = {
  gain: PetAudioParamLike;
  connect(destination: unknown): unknown;
};

export type PetAudioContextLike = {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<unknown>;
  close(): Promise<unknown>;
  createOscillator(): PetOscillatorLike;
  createGain(): PetGainLike;
};

export type SoundAudioContextFactory = () => PetAudioContextLike | null;

function defaultAudioContextFactory(): PetAudioContextLike | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof window.AudioContext })
      .webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  try {
    return new Ctor() as PetAudioContextLike;
  } catch {
    return null;
  }
}

const ATTACK_S = 0.008;
const RELEASE_S = 0.02;

/** Schedule one enveloped sine tone; throws never escape the caller's catch. */
function playTone(ctx: PetAudioContextLike, tone: { freq: number; startMs: number; durationMs: number }): void {
  const durationS = Math.max(0.01, tone.durationMs / 1000);
  const startS = ctx.currentTime + tone.startMs / 1000;
  const endS = startS + durationS;

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(tone.freq, startS);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, startS);
  gain.gain.linearRampToValueAtTime(SOUND_MASTER_GAIN, startS + ATTACK_S);
  gain.gain.setValueAtTime(SOUND_MASTER_GAIN, Math.max(startS + ATTACK_S, endS - RELEASE_S));
  gain.gain.linearRampToValueAtTime(0.0001, endS);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startS);
  osc.stop(endS + 0.01);
}

/**
 * Bounded local sound player. Construct once per renderer app; call destroy()
 * when the renderer is torn down. Every public method is failure-silent.
 */
export class PetSoundPlayer {
  private factory: SoundAudioContextFactory;
  private context: PetAudioContextLike | null = null;
  private contextFailed = false;
  private disposed = false;
  private lastPlayedAt: Partial<Record<SoundCueKind, number>> = {};

  constructor(factory?: SoundAudioContextFactory) {
    this.factory = factory ?? defaultAudioContextFactory;
  }

  /** Play a cue; suppressed/no-op paths return false (still "handled"). */
  play(kind: SoundCueKind): boolean {
    if (this.disposed) return false;
    try {
      const now = Date.now();
      if ((this.lastPlayedAt[kind] ?? Number.NEGATIVE_INFINITY) + SOUND_MIN_KIND_GAP_MS > now) {
        return false;
      }
      this.lastPlayedAt[kind] = now;

      if (!this.context && !this.contextFailed) {
        this.context = this.factory();
        if (!this.context) {
          this.contextFailed = true;
          return false;
        }
      }
      const ctx = this.context;
      if (!ctx) return false;

      // Chromium may start suspended without a user gesture; best effort resume,
      // but never block or throw on failure.
      if (ctx.state === "suspended") {
        try {
          const resuming = ctx.resume();
          if (resuming && typeof (resuming as Promise<unknown>).catch === "function") {
            (resuming as Promise<unknown>).catch(() => undefined);
          }
        } catch {
          // resume unsupported — the scheduled tones simply stay silent
        }
      }

      const pattern = SOUND_CUE_PATTERNS[kind];
      for (const tone of pattern) {
        playTone(ctx, tone);
      }
      return true;
    } catch {
      // No audio device, detached context, hostile environment — stay silent.
      return false;
    }
  }

  /** Release the AudioContext and stop accepting cues (renderer teardown). */
  destroy(): void {
    this.disposed = true;
    const ctx = this.context;
    this.context = null;
    if (!ctx) return;
    try {
      const closing = ctx.close();
      if (closing && typeof (closing as Promise<unknown>).catch === "function") {
        (closing as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // already closed / detached — ignore
    }
  }
}
