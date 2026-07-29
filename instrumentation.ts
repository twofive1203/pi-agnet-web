/**
 * Next.js Node instrumentation: start Automation scheduler once per server process.
 * Failures must not crash ordinary WebUI — Automation fails closed via status.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Capture real socket remoteAddress for Automation local-only enforcement.
    const { installAutomationConnectionCapture } = await import("./lib/automation-connection-context");
    installAutomationConnectionCapture();
  } catch (error) {
    console.warn(
      "[automation] connection capture hook failed; Automation APIs will fail closed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const { ensureAutomationProcessLifecycle } = await import("./lib/automation-process-lifecycle");
    const result = await ensureAutomationProcessLifecycle();
    if (!result.ok) {
      console.warn("[automation] scheduler unavailable:", result.error ?? "unknown");
    }
  } catch (error) {
    console.warn(
      "[automation] failed to start scheduler; WebUI continues without Automation dispatch:",
      error instanceof Error ? error.message : String(error),
    );
  }
  // Bounded retention kick on process start (scheduler also runs on a 6h cadence).
  try {
    const g = globalThis as typeof globalThis & { __piAutomationBootRetention?: boolean };
    if (!g.__piAutomationBootRetention) {
      g.__piAutomationBootRetention = true;
      const { runAutomationRetention } = await import("./lib/automation-retention");
      void runAutomationRetention().catch(() => {
        /* retention must not crash boot */
      });
    }
  } catch {
    // optional
  }
}
