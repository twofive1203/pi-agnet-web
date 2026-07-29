import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  getAutomationSchedulerStatus,
  startAutomationScheduler,
  stopAutomationScheduler,
} from "../lib/automation-scheduler";
import { ensureAutomationLayout, setGlobalDisabled } from "../lib/automation-store";
import { acquireAutomationLock } from "../lib/automation-lock";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-sched-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    ensureAutomationLayout(agentDir);
    // Reset global scheduler state between tests by dynamic isolation via agentDir
    const started = await startAutomationScheduler({ agentDir });
    assert(started.started, "started");
    const status = getAutomationSchedulerStatus(agentDir);
    assert(status.inProcessStarted, "in process");

    const again = await startAutomationScheduler({ agentDir });
    assert(again.started, "idempotent start");

    await setGlobalDisabled(true, agentDir);
    const disabled = getAutomationSchedulerStatus(agentDir);
    assert(disabled.globalDisabled === true, "global disabled");

    const leader = await acquireAutomationLock({
      kind: "scheduler",
      agentDir,
      ownerId: "other-owner",
      ttlMs: 30_000,
      timeoutMs: 500,
      allowStaleTakeover: false,
    }).catch((e) => e as Error);
    assert(leader, "lock attempt completed");

    await stopAutomationScheduler({ drainMs: 1000 });
    console.log("smoke-automation-scheduler: ok");
  } finally {
    try {
      await stopAutomationScheduler({ drainMs: 200 });
    } catch {
      // ignore
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
