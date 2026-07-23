#!/usr/bin/env npx tsx
/**
 * Focused smoke check for the SnFlow CLI in-process Pi host.
 * Exercises the same tsx -> dynamic import -> workflow host path as the CLI.
 * Run: npx tsx scripts/smoke-workflow-host.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadRunManager(): Promise<typeof import("../lib/workflow-run-manager")> {
  return import("../lib/workflow-run-manager");
}

function test(label: string, ok: boolean, detail?: string): void {
  if (!ok) {
    const msg = detail ? `${label}: ${detail}` : label;
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  OK  ${label}${detail ? ` (${detail})` : ""}`);
  }
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "wf-host-smoke-"));
  let hostCreated = false;

  try {
    console.log("Phase 1: Loading workflow-run-manager through npx tsx...");
    let rm: typeof import("../lib/workflow-run-manager");
    try {
      rm = await loadRunManager();
      test("Module loads without error", true);
    } catch (error) {
      test(
        "Module loads without error",
        false,
        error instanceof Error ? error.message : String(error),
      );
      process.exitCode = 1;
      return;
    }

    console.log("Phase 2: Creating workflow host...");
    let host: Awaited<ReturnType<typeof rm.getWorkflowHost>> | null = null;
    try {
      host = await rm.getWorkflowHost(tmpRoot);
      hostCreated = true;

      test("Host RPC ready", host.rpcReady === true);
      test(
        "Host cwd matches tmp root",
        host.cwd === tmpRoot,
        `${host.cwd} vs ${tmpRoot}`,
      );
      test(
        "Host sessionId format correct",
        host.hostSessionId.startsWith("workflow-host-"),
        host.hostSessionId,
      );

      const cached = await rm.getWorkflowHost(tmpRoot);
      test("Cached host is same instance", cached === host);

      console.log("Phase 2b: Host dispose...");
      rm.disposeWorkflowHost(tmpRoot);
      hostCreated = false;
      test("Host disposed cleanly", true);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      test("Host creates with pi-subagents RPC ready", false, msg);
    }
  } finally {
    if (hostCreated) {
      try {
        const rm = await loadRunManager();
        rm.disposeWorkflowHost(tmpRoot);
      } catch {
        // best effort
      }
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  if (process.exitCode) {
    console.log(`\nsmoke-workflow-host: FAILED (exit code ${process.exitCode})`);
  } else {
    console.log("\nOK smoke-workflow-host");
  }
}

main().catch((error) => {
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
