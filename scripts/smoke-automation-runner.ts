import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  runAutomationOnce,
  AutomationInteractionRequiredError,
  withHardDeadline,
} from "../lib/automation-runner";
import { buildAuthorityConfig } from "../lib/automation-tool-policy";
import { buildToolSnapshot, classifyBuiltinTool } from "../lib/automation-resource-catalog";
import { AUTOMATION_DEFAULT_MAX_RUNTIME_MS, defaultScheduleConfig } from "../lib/automation-types";
import { redactSecrets, assertNoSecretLeak } from "../lib/automation-secret-policy";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "auto-runner-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "auto-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AUTOMATION_CANARY_SECRET = "CANARY_SECRET_VALUE_12345";

  const read = buildToolSnapshot({
    name: "read",
    origin: "builtin",
    schema: { name: "read" },
    risks: classifyBuiltinTool("read"),
  });
  const authority = buildAuthorityConfig({ tools: [read] });
  const effective = {
    tools: authority.tools,
    extensions: [],
    blocked: false,
    blockedReason: null,
    blockMessage: null,
    policyHash: authority.policyHash,
  };
  const config = {
    name: "t",
    description: "",
    schedule: defaultScheduleConfig("0 8 * * *", "UTC"),
    target: { cwd, cwdSource: "project" as const },
    agent: {
      provider: "test",
      modelId: "fake",
      thinking: "low" as string | null,
      prompt: "hello world",
      maxRuntimeMs: AUTOMATION_DEFAULT_MAX_RUNTIME_MS,
    },
    authority,
  };

  const markers: string[] = [];

  try {
    const ok = await runAutomationOnce({
      taskId: "task1",
      runId: "run1",
      config,
      effective,
      agentDir,
      deps: {
        createSession: async ({ sessionDir, model }) => {
          mkdirSync(sessionDir, { recursive: true });
          const sessionFile = path.join(sessionDir, "sess.jsonl");
          writeFileSync(
            sessionFile,
            JSON.stringify({
              type: "session",
              version: 3,
              id: "sess-1",
              timestamp: new Date().toISOString(),
              cwd: sessionDir,
            }) +
              "\n" +
              JSON.stringify({
                type: "message",
                id: "e1",
                parentId: null,
                timestamp: new Date().toISOString(),
                message: { role: "assistant", content: "done" },
              }) +
              "\n",
          );
          assert(model.provider === "test" && model.modelId === "fake", "model applied to create");
          return {
            sessionDir,
            appliedModel: {
              provider: model.provider,
              modelId: model.modelId,
              thinking: model.thinking ?? null,
            },
            session: {
              sessionId: "sess-1",
              sessionFile,
              prompt: async () => ({ text: "done" }),
              abort: () => {},
              dispose: () => {},
            },
          };
        },
      },
    });
    assert(ok.status === "succeeded", "success status");
    assert(ok.session.sealed, "sealed after dispose");
    assert(ok.session.availability === "available", "available");
    assert(ok.actualModel?.provider === "test", "actual provider reported");
    assert(ok.actualModel?.modelId === "fake", "actual model reported");
    markers.push("SUCCESS_OK");

    // Hard deadline must win even when prompt ignores abort forever.
    const timed = await runAutomationOnce({
      taskId: "task1",
      runId: "run2",
      config: { ...config, agent: { ...config.agent, maxRuntimeMs: 80 } },
      effective,
      agentDir,
      deps: {
        createSession: async ({ sessionDir, model }) => ({
          sessionDir,
          appliedModel: {
            provider: model.provider,
            modelId: model.modelId,
            thinking: model.thinking ?? null,
          },
          session: {
            sessionId: "s2",
            sessionFile: undefined,
            // Abort-ignoring prompt: never settles.
            prompt: async () => new Promise(() => {}),
            abort: () => {
              /* intentionally ignore abort */
            },
            dispose: () => {},
          },
        }),
      },
    });
    // Abort-ignoring prompt remains unsealed/ambiguous; authority retained for caller.
    assert(
      timed.status === "ambiguous" || timed.status === "timed_out",
      `timeout/abort-ignore got ${timed.status}`,
    );
    assert(!timed.session.sealed, "abort-ignoring session must not be sealed");
    assert(timed.executionMayContinue === true, "executionMayContinue retained");
    markers.push("TIMEOUT_OK");
    markers.push("UNSEALED_ABORT_OK");
    markers.push("ABORT_RETAIN_OK");

    // Unit-level hard deadline helper
    const raced = await withHardDeadline(new Promise(() => {}), 50, () => {});
    assert(raced.timedOut === true, "withHardDeadline times out");
    markers.push("HARD_DEADLINE_OK");

    const blocked = await runAutomationOnce({
      taskId: "task1",
      runId: "run3",
      config,
      effective,
      agentDir,
      deps: {
        createSession: async ({ sessionDir, model }) => ({
          sessionDir,
          appliedModel: {
            provider: model.provider,
            modelId: model.modelId,
            thinking: model.thinking ?? null,
          },
          session: {
            sessionId: "s3",
            prompt: async () => {
              throw new AutomationInteractionRequiredError("confirm");
            },
            abort: () => {},
            dispose: () => {},
          },
        }),
      },
    });
    assert(blocked.status === "blocked", "interaction blocked");
    markers.push("BLOCKED_OK");

    const empty = await runAutomationOnce({
      taskId: "task1",
      runId: "run4",
      config: { ...config, agent: { ...config.agent, prompt: "  " } },
      effective,
      agentDir,
    });
    assert(empty.status === "failed", "empty prompt fails");
    markers.push("EMPTY_OK");

    const red = redactSecrets(`token ${process.env.AUTOMATION_CANARY_SECRET}`);
    assert(!red.includes("CANARY_SECRET_VALUE_12345"), "redact canary");
    assertNoSecretLeak(red, ["CANARY_SECRET_VALUE_12345"]);
    markers.push("REDACT_OK");

    // Require explicit success markers so early exit cannot silently pass.
    for (const m of [
      "SUCCESS_OK",
      "TIMEOUT_OK",
      "UNSEALED_ABORT_OK",
      "ABORT_RETAIN_OK",
      "HARD_DEADLINE_OK",
      "BLOCKED_OK",
      "EMPTY_OK",
      "REDACT_OK",
    ]) {
      assert(markers.includes(m), `missing marker ${m}`);
    }
    console.log("smoke-automation-runner: ok", markers.join(","));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
