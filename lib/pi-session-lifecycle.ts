import type { ExtensionRunnerLike } from "./pi-types";

export type DisposableAgentSession = {
  extensionRunner?: ExtensionRunnerLike;
  /** Abort active work and wait for idle when available (AgentSession.abort). */
  abort?: () => void | Promise<void>;
  abortCompaction?: () => void;
  dispose?: () => void;
};

/** Cap how long teardown waits for an aborting agent before invalidating extension ctx. */
const SESSION_DRAIN_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  // Keep the timer referenced so drain timeouts still fire while abort hangs.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Stop in-flight agent/compaction work before extension contexts are invalidated.
 * SDK dispose() aborts without awaiting listener settlement, which races extension
 * handlers and surfaces "extension ctx is stale" unhandled rejections.
 */
export async function drainAgentSession(
  session: DisposableAgentSession | undefined,
  timeoutMs = SESSION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  if (!session) return;

  try {
    session.abortCompaction?.();
  } catch {
    // Compaction abort is best-effort during teardown.
  }

  if (!session.abort) return;

  try {
    await Promise.race([Promise.resolve(session.abort()), delay(timeoutMs)]);
  } catch {
    // Drain failures must not block session_shutdown / dispose.
  }
}

/**
 * Give loaded extensions a chance to release session-scoped resources before
 * the SDK invalidates their contexts during AgentSession.dispose().
 *
 * Order matters:
 * 1. drain in-flight agent events (while ctx is still valid)
 * 2. emit session_shutdown so extensions stop timers/pollers
 * 3. dispose/invalidate extension contexts
 */
export async function disposeAgentSession(
  session: DisposableAgentSession | undefined,
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
): Promise<void> {
  if (!session) return;

  await drainAgentSession(session);

  try {
    const runner = session.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown") && runner.emit) {
      await runner.emit({ type: "session_shutdown", reason });
    }
  } catch {
    // Extension cleanup must not prevent the underlying session from closing.
  }

  try {
    session.dispose?.();
  } catch {
    // Disposal is best-effort for short-lived helper sessions and shutdown paths.
  }
}
