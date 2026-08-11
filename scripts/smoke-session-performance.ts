/**
 * Smoke checks for durable session performance metrics.
 * Run: npx --yes tsx@4.23.1 scripts/smoke-session-performance.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main() {
const root = await mkdtemp(path.join(os.tmpdir(), "pi-session-perf-"));
const agentDir = path.join(root, "agent");
await mkdir(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  SessionPerformanceRecorder,
  buildPerformanceSample,
  deleteSessionPerformanceSidecar,
  emptySessionPerformanceSummary,
  flushSessionPerformance,
  getSessionPerformancePath,
  isFirstEffectiveOutputDelta,
  projectSessionPerformanceSummary,
  readSessionPerformanceSummary,
  recordPerformanceSample,
} = await import("../lib/session-performance");

function assistantMessage(overrides: {
  provider?: string;
  model?: string;
  output?: number;
  stopReason?: string;
} = {}) {
  return {
    role: "assistant" as const,
    provider: overrides.provider ?? "openai",
    model: overrides.model ?? "gpt-test",
    stopReason: overrides.stopReason ?? "stop",
    usage: {
      input: 10,
      output: overrides.output ?? 120,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

try {
  // --- Pure eligibility / weighted projection ---
  assert.equal(isFirstEffectiveOutputDelta({ type: "text_delta", delta: "" }), false);
  assert.equal(isFirstEffectiveOutputDelta({ type: "text_start" }), false);
  assert.equal(isFirstEffectiveOutputDelta({ type: "text_delta", delta: "hi" }), true);
  assert.equal(isFirstEffectiveOutputDelta({ type: "thinking_delta", delta: "x" }), true);
  assert.equal(isFirstEffectiveOutputDelta({ type: "toolcall_delta", delta: "{" }), true);

  // AE1: 120 tokens / 4s stream after 3s TTFT → 30 TPS, 3000 ms TTFT
  const sampleAe1 = buildPerformanceSample({
    message: assistantMessage({ output: 120 }),
    callStartedAtMs: 0,
    firstOutputAtMs: 3_000,
    completedAtMs: 7_000,
  });
  assert.deepEqual(sampleAe1, {
    provider: "openai",
    model: "gpt-test",
    outputTokens: 120,
    streamDurationMs: 4_000,
    ttftMs: 3_000,
  });

  // Invalid samples are excluded
  assert.equal(buildPerformanceSample({
    message: assistantMessage({ stopReason: "error" }),
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 200,
  }), null);
  assert.equal(buildPerformanceSample({
    message: assistantMessage({ stopReason: "aborted" }),
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 200,
  }), null);
  assert.equal(buildPerformanceSample({
    message: assistantMessage({ output: 0 }),
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 200,
  }), null);
  assert.equal(buildPerformanceSample({
    message: assistantMessage({ provider: "" }),
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 200,
  }), null);
  assert.equal(buildPerformanceSample({
    message: assistantMessage(),
    callStartedAtMs: 0,
    firstOutputAtMs: null,
    completedAtMs: 200,
  }), null);
  assert.equal(buildPerformanceSample({
    message: assistantMessage(),
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 100, // zero stream duration
  }), null);
  assert.equal(buildPerformanceSample({
    message: { role: "user" },
    callStartedAtMs: 0,
    firstOutputAtMs: 100,
    completedAtMs: 200,
  }), null);

  // AE2: weighted 200 tokens / 10s = 20 TPS, not arithmetic mean 31.25
  const projected = projectSessionPerformanceSummary(
    {
      sampleCount: 2,
      totalOutputTokens: 200,
      totalStreamDurationMs: 10_000,
      totalTtftMs: 5_000,
    },
    {
      "openai\u0000a": {
        provider: "openai",
        model: "a",
        sampleCount: 1,
        totalOutputTokens: 100,
        totalStreamDurationMs: 2_000,
        totalTtftMs: 2_000,
      },
      "openai\u0000b": {
        provider: "openai",
        model: "b",
        sampleCount: 1,
        totalOutputTokens: 100,
        totalStreamDurationMs: 8_000,
        totalTtftMs: 3_000,
      },
    },
  );
  assert.equal(projected.avgTps, 20);
  assert.equal(projected.avgTtftMs, 2_500);
  assert.equal(projected.mixedModels, true);
  assert.equal(projected.byModel.length, 2);
  assert.equal(projected.byModel[0].avgTps, 50);
  assert.equal(projected.byModel[1].avgTps, 12.5);
  assert.deepEqual(emptySessionPerformanceSummary().sampleCount, 0);
  assert.equal(emptySessionPerformanceSummary().avgTps, null);

  // --- Persistence + recorder lifecycle ---
  const sessionId = "perf-session-main";
  const cwd = path.join(root, "workspace");
  await mkdir(cwd, { recursive: true });

  let clock = 0;
  const now = () => clock;
  const summaries: Array<ReturnType<typeof emptySessionPerformanceSummary>> = [];

  const recorder = new SessionPerformanceRecorder({
    sessionId,
    cwd,
    sessionFile: path.join(cwd, "s.jsonl"),
    now,
    onSummary: (summary) => { summaries.push(summary); },
  });

  // Happy path AE1 via events
  clock = 0;
  recorder.observe({ type: "turn_start", turnIndex: 0 });
  clock = 1_000;
  recorder.observe({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "" }, // empty — ignored
  });
  clock = 3_000;
  recorder.observe({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: "Hello" },
  });
  clock = 4_000;
  // later deltas do not move first-output
  recorder.observe({
    type: "message_update",
    message: assistantMessage(),
    assistantMessageEvent: { type: "text_delta", delta: " world" },
  });
  clock = 7_000;
  recorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 120 }),
  });
  await flushSessionPerformance(sessionId);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].avgTps, 30);
  assert.equal(summaries[0].avgTtftMs, 3_000);
  assert.equal(summaries[0].sampleCount, 1);

  const reloaded = readSessionPerformanceSummary(sessionId);
  assert.ok(reloaded);
  assert.equal(reloaded!.avgTps, 30);
  assert.equal(reloaded!.sampleCount, 1);

  // AE3: tool interval between turns does not enter either TPS denominator
  clock = 10_000;
  recorder.observe({ type: "turn_start", turnIndex: 1 });
  clock = 11_000; // TTFT 1s
  recorder.observe({
    type: "message_update",
    message: assistantMessage({ model: "gpt-test" }),
    assistantMessageEvent: { type: "thinking_delta", delta: "…" },
  });
  clock = 16_000; // stream 5s
  recorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 50 }),
  });
  // Simulated 20s tool wait — no active timing window
  clock = 36_000;
  recorder.observe({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  clock = 56_000;
  recorder.observe({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
  clock = 57_000;
  recorder.observe({ type: "turn_start", turnIndex: 2 });
  clock = 58_000;
  recorder.observe({
    type: "message_update",
    message: assistantMessage({ model: "gpt-test" }),
    assistantMessageEvent: { type: "toolcall_delta", delta: "{" },
  });
  clock = 60_000; // stream 2s, 40 tokens
  recorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 40 }),
  });
  await flushSessionPerformance(sessionId);

  const afterTools = readSessionPerformanceSummary(sessionId)!;
  // samples: 120/4s + 50/5s + 40/2s = 210 tokens / 11s
  assert.equal(afterTools.sampleCount, 3);
  assert.equal(afterTools.totalOutputTokens, 210);
  assert.equal(afterTools.totalStreamDurationMs, 11_000);
  assert.ok(Math.abs((afterTools.avgTps ?? 0) - 210 / 11) < 1e-9);

  // Error then successful retry — only success counts
  const retrySession = "perf-session-retry";
  clock = 0;
  const retryRecorder = new SessionPerformanceRecorder({
    sessionId: retrySession,
    cwd,
    now,
  });
  clock = 0;
  retryRecorder.observe({ type: "turn_start" });
  clock = 100;
  retryRecorder.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "x" },
  });
  clock = 200;
  retryRecorder.observe({
    type: "message_end",
    message: assistantMessage({ stopReason: "error", output: 5 }),
  });
  clock = 300;
  retryRecorder.observe({ type: "turn_start" });
  clock = 500;
  retryRecorder.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ok" },
  });
  clock = 1_500;
  retryRecorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 10 }),
  });
  await flushSessionPerformance(retrySession);
  const retrySummary = readSessionPerformanceSummary(retrySession)!;
  assert.equal(retrySummary.sampleCount, 1);
  assert.equal(retrySummary.totalOutputTokens, 10);
  assert.equal(retrySummary.avgTps, 10); // 10 tokens / 1s

  // AE4 mixed models via direct samples
  const mixedId = "perf-session-mixed";
  await recordPerformanceSample({
    sessionId: mixedId,
    cwd,
    sample: {
      provider: "openai",
      model: "model-a",
      outputTokens: 100,
      streamDurationMs: 2_000,
      ttftMs: 1_000,
    },
  });
  await recordPerformanceSample({
    sessionId: mixedId,
    cwd,
    sample: {
      provider: "anthropic",
      model: "model-b",
      outputTokens: 100,
      streamDurationMs: 8_000,
      ttftMs: 2_000,
    },
  });
  const mixed = readSessionPerformanceSummary(mixedId)!;
  assert.equal(mixed.mixedModels, true);
  assert.equal(mixed.avgTps, 20);
  assert.equal(mixed.byModel.length, 2);
  assert.equal(mixed.byModel[0].provider, "anthropic");
  assert.equal(mixed.byModel[1].provider, "openai");

  // Concurrency: two queued writes both preserved
  const concurrentId = "perf-session-concurrent";
  const [a, b] = await Promise.all([
    recordPerformanceSample({
      sessionId: concurrentId,
      cwd,
      sample: {
        provider: "p",
        model: "m",
        outputTokens: 10,
        streamDurationMs: 1_000,
        ttftMs: 100,
      },
    }),
    recordPerformanceSample({
      sessionId: concurrentId,
      cwd,
      sample: {
        provider: "p",
        model: "m",
        outputTokens: 30,
        streamDurationMs: 1_000,
        ttftMs: 200,
      },
    }),
  ]);
  assert.equal(Math.max(a.sampleCount, b.sampleCount), 2);
  const concurrent = readSessionPerformanceSummary(concurrentId)!;
  assert.equal(concurrent.sampleCount, 2);
  assert.equal(concurrent.totalOutputTokens, 40);

  // Session isolation
  assert.equal(readSessionPerformanceSummary(sessionId)!.sampleCount, 3);
  assert.equal(readSessionPerformanceSummary("missing-session"), null);

  // Corruption recovery
  const corruptId = "perf-session-corrupt";
  const corruptPath = getSessionPerformancePath(corruptId);
  await mkdir(path.dirname(corruptPath), { recursive: true });
  await writeFile(corruptPath, "{not-json");
  assert.equal(readSessionPerformanceSummary(corruptId), null);
  await writeFile(corruptPath, JSON.stringify({ version: 99, sessionId: corruptId }));
  assert.equal(readSessionPerformanceSummary(corruptId), null);
  const repaired = await recordPerformanceSample({
    sessionId: corruptId,
    cwd,
    sample: {
      provider: "p",
      model: "m",
      outputTokens: 5,
      streamDurationMs: 500,
      ttftMs: 50,
    },
  });
  assert.equal(repaired.sampleCount, 1);
  const disk = JSON.parse(await readFile(corruptPath, "utf8")) as {
    version: number;
    totals: { sampleCount: number };
    byModel: Record<string, unknown>;
  };
  assert.equal(disk.version, 1);
  assert.equal(disk.totals.sampleCount, 1);
  // Privacy/bounds: counters + model ids only
  const raw = await readFile(corruptPath, "utf8");
  assert.equal(raw.includes("Hello"), false);
  assert.equal(raw.includes("prompt"), false);
  assert.ok(!("samples" in disk));
  assert.ok("byModel" in disk);

  // AE7: fork session starts empty; parent unchanged
  const forkId = "perf-session-fork";
  assert.equal(readSessionPerformanceSummary(forkId), null);
  assert.equal(readSessionPerformanceSummary(sessionId)!.sampleCount, 3);

  // AE6 delete removes only target
  deleteSessionPerformanceSidecar(corruptId);
  assert.equal(existsSync(corruptPath), false);
  assert.ok(readSessionPerformanceSummary(sessionId));

  // close() suppresses late writes/callbacks
  const closedId = "perf-session-closed";
  let closedCallbacks = 0;
  clock = 0;
  const closedRecorder = new SessionPerformanceRecorder({
    sessionId: closedId,
    cwd,
    now,
    onSummary: () => { closedCallbacks += 1; },
  });
  closedRecorder.observe({ type: "turn_start" });
  clock = 100;
  closedRecorder.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "x" },
  });
  closedRecorder.close();
  clock = 500;
  closedRecorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 9 }),
  });
  await flushSessionPerformance(closedId);
  assert.equal(closedCallbacks, 0);
  assert.equal(readSessionPerformanceSummary(closedId), null);

  // Zero listeners still persist (recorder does not require SSE)
  const silentId = "perf-session-silent";
  clock = 0;
  const silent = new SessionPerformanceRecorder({ sessionId: silentId, cwd, now });
  silent.observe({ type: "turn_start" });
  clock = 50;
  silent.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "a" },
  });
  clock = 250;
  silent.observe({
    type: "message_end",
    message: assistantMessage({ output: 20 }),
  });
  await silent.flush();
  assert.equal(readSessionPerformanceSummary(silentId)?.sampleCount, 1);

  // Delete race: accepted completion must land before flush resolves, so delete
  // can remove the file without a late recreate.
  const deleteRaceId = "perf-session-delete-race";
  clock = 0;
  const raceRecorder = new SessionPerformanceRecorder({
    sessionId: deleteRaceId,
    cwd,
    now,
    onSummary: () => {
      // ignore
    },
  });
  raceRecorder.observe({ type: "turn_start" });
  clock = 10;
  raceRecorder.observe({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "z" },
  });
  clock = 110;
  raceRecorder.observe({
    type: "message_end",
    message: assistantMessage({ output: 8 }),
  });
  raceRecorder.close();
  await raceRecorder.flush();
  assert.equal(readSessionPerformanceSummary(deleteRaceId)?.sampleCount, 1);
  deleteSessionPerformanceSidecar(deleteRaceId);
  await flushSessionPerformance(deleteRaceId);
  assert.equal(readSessionPerformanceSummary(deleteRaceId), null);
  assert.equal(existsSync(getSessionPerformancePath(deleteRaceId)), false);

  console.log("Session performance smoke checks passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
