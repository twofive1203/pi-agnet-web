/**
 * Best-effort task-observer invalidation bus.
 *
 * Source adapters notify after successful transitions. The hub (U4) may
 * subscribe; failures in listeners must never fail the source mutation.
 */

export type TaskObserverInvalidateListener = () => void;

declare global {
  var __piTaskObserverInvalidateListeners: Set<TaskObserverInvalidateListener> | undefined;
}

function listeners(): Set<TaskObserverInvalidateListener> {
  if (!globalThis.__piTaskObserverInvalidateListeners) {
    globalThis.__piTaskObserverInvalidateListeners = new Set();
  }
  return globalThis.__piTaskObserverInvalidateListeners;
}

/** Register a hub/listener. Returns unsubscribe. */
export function subscribeTaskObserverInvalidate(
  listener: TaskObserverInvalidateListener,
): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

/** Fire-and-forget invalidate. Never throws to callers. */
export function notifyTaskObserverSourceChange(): void {
  for (const listener of listeners()) {
    try {
      listener();
    } catch {
      // Observer failure must never fail source mutation (U3).
    }
  }
}

/** Test helper. */
export function resetTaskObserverInvalidateForTests(): void {
  listeners().clear();
}
