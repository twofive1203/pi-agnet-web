/**
 * Process signal handlers for Automation scheduler graceful drain.
 */

import { startAutomationScheduler, stopAutomationScheduler } from "./automation-scheduler";

declare global {
  var __piAutomationProcessLifecycleInstalled: boolean | undefined;
}

export async function ensureAutomationProcessLifecycle(options?: {
  agentDir?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const result = await startAutomationScheduler({ agentDir: options?.agentDir });
  if (globalThis.__piAutomationProcessLifecycleInstalled) {
    return { ok: result.available, error: result.error };
  }
  globalThis.__piAutomationProcessLifecycleInstalled = true;

  const shutdown = (signal: string) => {
    void (async () => {
      try {
        await stopAutomationScheduler({ drainMs: 8_000 });
      } catch {
        // ignore
      } finally {
        // Do not force exit; Next/spi parent owns process lifetime.
        if (process.env.AUTOMATION_FORCE_EXIT_ON_SIGNAL === "1") {
          process.exit(0);
        }
      }
    })();
    void signal;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { ok: result.available, error: result.error };
}
