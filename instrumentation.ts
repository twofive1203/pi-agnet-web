/**
 * Next.js Node instrumentation:
 * 1) Server-access auth bootstrap (fail closed in server mode)
 * 2) Automation scheduler (fail open / status-only)
 */

function envFlag(name: string): boolean {
  const v = process.env[name];
  if (v == null) return false;
  const n = String(v).trim().toLowerCase();
  return n === "1" || n === "true" || n === "yes" || n === "on";
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ── Single-instance guard (chat/SSE/auth counters are process-local) ──
  let singleInstanceOk = true;
  try {
    const {
      assertSingleInstanceOrThrow,
      logProcessRuntimeIdentity,
    } = await import("./lib/process-runtime");
    const risk = assertSingleInstanceOrThrow(process.env);
    singleInstanceOk = risk.ok;
    if (!risk.ok) {
      for (const reason of risk.reasons) {
        console.warn(`[spi] WARNING multi-instance override: ${reason}`);
      }
      console.warn(
        "[spi] WARNING: PI_WEB_ALLOW_MULTI_INSTANCE=1 is set — multi-replica remains unsupported even with sticky routing.",
      );
    }
    logProcessRuntimeIdentity(process.env, singleInstanceOk);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[spi] FATAL: single-instance check failed:", message);
    throw error instanceof Error ? error : new Error(message);
  }

  // ── Server access authentication (before Automation) ──
  const serverMode = envFlag("PI_WEB_SERVER_MODE");
  const rotate = envFlag("PI_WEB_ROTATE_ACCESS_KEY");

  if (serverMode) {
    try {
      const {
        bootstrapServerAccessAuth,
      } = await import("./lib/server-access-auth");
      const result = await bootstrapServerAccessAuth({ rotate });
      if (result.accessKeyOnce) {
        // One-time display — never logged elsewhere, never written to state.
        console.log("");
        console.log("╔════════════════════════════════════════════════════════════╗");
        console.log("║  Snail Pi — server access key (shown once)                 ║");
        console.log("╠════════════════════════════════════════════════════════════╣");
        console.log(`║  ${result.accessKeyOnce.padEnd(58, " ")}║`);
        console.log("╠════════════════════════════════════════════════════════════╣");
        if (result.rotated) {
          console.log("║  Access key rotated. All previous sessions are invalid.    ║");
        } else {
          console.log("║  Store this access key securely. It will not be shown again.║");
        }
        console.log("║  HTTP does not encrypt this key — prefer HTTPS reverse proxy.║");
        console.log("╚════════════════════════════════════════════════════════════╝");
        console.log("");
      } else if (result.rotated) {
        console.log("[server-access] Access key rotated; previous sessions invalidated.");
      } else {
        console.log("[server-access] Authentication enabled (existing access key loaded).");
      }
      {
        const { resolveAuthBypassEntries } = await import("./lib/server-access-policy");
        const bypass = resolveAuthBypassEntries();
        if (bypass.entries.length > 0) {
          console.log(
            `[server-access] Auth bypass for socket clients (${bypass.source}): ${bypass.entries.join(", ")}`,
          );
          if (bypass.source === "file") {
            console.log(`[server-access] Policy file: ${bypass.path}`);
          }
          console.log(
            "[server-access] Bypass uses socket remoteAddress only (not X-Forwarded-For).",
          );
        } else if (typeof process.env.PI_WEB_AUTH_BYPASS_CIDRS === "string") {
          console.warn(
            "[server-access] PI_WEB_AUTH_BYPASS_CIDRS is set but yielded no valid entries (world-open and loopback rules are rejected).",
          );
        }
      }
      // Clear one-shot rotate env so hot reloads do not re-rotate.
      delete process.env.PI_WEB_ROTATE_ACCESS_KEY;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[server-access] FATAL: failed to initialize authentication:", message);
      console.error(
        "[server-access] Server mode refuses to start without valid auth state.",
      );
      console.error(
        "[server-access] Recovery: run with --server --rotate-access-key after fixing permissions,",
      );
      console.error(
        "[server-access] or remove a corrupt server-access.json only if you intend to mint a new key.",
      );
      // Fail closed — do not continue to Ready.
      throw error instanceof Error ? error : new Error(message);
    }
  } else if (rotate) {
    // Launcher should already reject this; belt-and-suspenders.
    throw new Error(
      "--rotate-access-key / PI_WEB_ROTATE_ACCESS_KEY requires server mode",
    );
  }

  // ── Automation (existing fail-open behavior) ──
  try {
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
