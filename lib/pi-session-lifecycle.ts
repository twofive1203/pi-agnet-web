import type { ExtensionRunnerLike } from "./pi-types";

export type DisposableAgentSession = {
  extensionRunner?: ExtensionRunnerLike;
  dispose?: () => void;
};

/**
 * Give loaded extensions a chance to release session-scoped resources before
 * the SDK invalidates their contexts during AgentSession.dispose().
 */
export async function disposeAgentSession(
  session: DisposableAgentSession | undefined,
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
): Promise<void> {
  if (!session) return;

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
