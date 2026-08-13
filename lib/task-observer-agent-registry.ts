/**
 * SDK-free read adapter for live ordinary-Agent task observations.
 *
 * Next production bundles rpc-manager as an async module because it imports the
 * Pi SDK. The desktop observer must therefore read the process-global wrapper
 * registry without synchronously requiring rpc-manager from an App Route.
 */

import type { TaskObserverActivityInput } from "./task-observer-types";

export interface LiveAgentTaskObservationSource {
  readonly cwd: string;
  isAlive(): boolean;
  getTaskObservation(): TaskObserverActivityInput | null;
  destroy(): void;
}

declare global {
  var __piSessions: Map<string, LiveAgentTaskObservationSource> | undefined;
}

/** Live ordinary-Agent activities without touching SSE ownership or idle timers. */
export function listLiveAgentTaskObservations(): TaskObserverActivityInput[] {
  const observations: TaskObserverActivityInput[] = [];
  for (const wrapper of globalThis.__piSessions?.values() ?? []) {
    if (!wrapper.isAlive()) continue;
    try {
      const activity = wrapper.getTaskObservation();
      if (activity) observations.push(activity);
    } catch {
      // Isolate malformed observation from a single wrapper.
    }
  }
  return observations;
}

/** Distinct live wrapper cwds for SnFlow multi-project collection. */
export function listLiveAgentObserverCwds(): string[] {
  const cwds = new Set<string>();
  for (const wrapper of globalThis.__piSessions?.values() ?? []) {
    if (!wrapper.isAlive()) continue;
    if (wrapper.cwd) cwds.add(wrapper.cwd);
  }
  return [...cwds];
}
