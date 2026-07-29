import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { automationTasksToolDefinition } from "../lib/automation-tools";
import { ensureAutomationLayout } from "../lib/automation-store";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-tools-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  ensureAutomationLayout(agentDir);
  try {
    const list = await automationTasksToolDefinition.execute("tc1", { action: "list" }, undefined, {});
    assert(list.content[0]?.text.includes("tasks") || list.content[0]?.text.includes("ok"), "list");

    const created = await automationTasksToolDefinition.execute(
      "tc2",
      {
        action: "create",
        name: "Tool Draft",
        cron: "0 9 * * *",
        timezone: "UTC",
        cwdSource: "default",
        provider: "anthropic",
        modelId: "claude-test",
        prompt: "do work",
        tools: [{ name: "read", origin: "builtin" }],
      },
      undefined,
      { sessionManager: { getSessionId: () => "sess-creator" } },
    );
    assert(created.content[0]?.text.includes("Tool Draft") || created.content[0]?.text.includes("ok"), "create");

    const parsed = JSON.parse(created.content[0]!.text) as { task?: { id: string; revision: string } };
    if (parsed.task) {
      const act = await automationTasksToolDefinition.execute(
        "tc3",
        {
          action: "activate",
          taskId: parsed.task.id,
          expectedRevision: parsed.task.revision,
          confirmed: true,
        },
        undefined,
        {},
      );
      assert(
        act.content[0]?.text.includes("approval_required") || act.content[0]?.text.includes("false"),
        "no ui activate blocked",
      );
    }

    const status = await automationTasksToolDefinition.execute("tc4", { action: "scheduler_status" }, undefined, {});
    assert(status.content[0]?.text.includes("scheduler") || status.content[0]?.text.includes("ok"), "scheduler status");
    console.log("smoke-automation-tools: ok");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
