import assert from "node:assert/strict";
import { BoundedSubagentMetrics } from "../lib/subagent-observability";
import { SubagentProgressThrottler, type ThrottledAgentEvent } from "../lib/subagent-progress-throttler";
import { projectSubagentEvent } from "../lib/subagent-event-projection";

function progress(toolCallId: string, marker: string, details: Record<string, unknown> = {}): ThrottledAgentEvent & { marker: string } {
  return {
    type: "tool_execution_update",
    toolCallId,
    marker,
    partialResult: { details },
  };
}

function pass(name: string): void {
  console.log(`ok - ${name}`);
}

async function main(): Promise<void> {
  {
    const delivered: string[] = [];
    let coalesced = 0;
    const throttler = new SubagentProgressThrottler(
      (event: ThrottledAgentEvent & { marker?: string }) => delivered.push(event.marker ?? event.type),
      25,
      Date.now,
      () => { coalesced += 1; },
    );
    throttler.handle(progress("a", "a1"), true);
    throttler.handle(progress("a", "a2"), true);
    throttler.handle(progress("a", "a3"), true);
    throttler.handle(progress("b", "b1"), true);
    assert.deepEqual(delivered, ["a1", "b1"]);
    assert.equal(coalesced, 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(delivered, ["a1", "b1", "a3"]);
    throttler.clear();
    pass("ordinary progress coalesces independently to the latest snapshot");
  }

  {
    const delivered: string[] = [];
    const throttler = new SubagentProgressThrottler(
      (event: ThrottledAgentEvent & { marker?: string }) => delivered.push(event.marker ?? event.type),
      100,
    );
    throttler.handle(progress("a", "first"), true);
    throttler.handle(progress("a", "pending"), true);
    throttler.handle({ type: "tool_execution_end", toolCallId: "a" }, true);
    assert.deepEqual(delivered, ["first", "pending", "tool_execution_end"]);
    throttler.clear();
    pass("terminal delivery flushes pending progress in order");
  }

  {
    const delivered: string[] = [];
    let immediate = 0;
    const throttler = new SubagentProgressThrottler(
      (event: ThrottledAgentEvent & { marker?: string }) => delivered.push(event.marker ?? event.type),
      100,
      Date.now,
      () => {},
      () => { immediate += 1; },
    );
    throttler.handle(progress("a", "first"), true);
    throttler.handle(progress("a", "pending"), true);
    throttler.handle(progress("a", "attention", {
      progress: [{ status: "running", activityState: "needs_attention" }],
    }), true);
    throttler.handle(progress("a", "same-attention", {
      progress: [{ status: "running", activityState: "needs_attention" }],
    }), true);
    throttler.handle(progress("a", "second-agent-attention", {
      progress: [
        { index: 0, status: "running", activityState: "needs_attention" },
        { index: 1, status: "running", activityState: "active_long_running" },
      ],
    }), true);
    throttler.handle(progress("a", "failed", {
      progress: [{ status: "failed" }],
    }), true);
    assert.deepEqual(delivered, ["first", "attention", "second-agent-attention", "failed"]);
    assert.equal(immediate, 3);
    throttler.clear();
    pass("attention and failure snapshots bypass throttling");
  }

  {
    const delivered: string[] = [];
    const throttler = new SubagentProgressThrottler(
      (event: ThrottledAgentEvent & { marker?: string }) => delivered.push(event.marker ?? event.type),
      20,
    );
    throttler.handle(progress("a", "first"), true);
    throttler.handle(progress("a", "cancelled"), true);
    throttler.clear();
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(delivered, ["first"]);
    throttler.handle(progress("ordinary", "ordinary"), false);
    assert.deepEqual(delivered, ["first", "ordinary"]);
    pass("clear cancels timers and non-subagent events stay immediate");
  }

  {
    const projected = projectSubagentEvent({
      type: "tool_execution_update",
      pluginPayload: "p".repeat(100_000),
      partialResult: {
        pluginPayload: "p".repeat(100_000),
        content: [{ type: "text", text: "x".repeat(100_000) }],
        details: {
          progress: Array.from({ length: 70 }, (_, index) => ({
            index,
            agent: "a".repeat(200),
            status: "running",
            currentToolArgs: "x".repeat(500),
            recentTools: Array.from({ length: 30 }, () => ({ tool: "bash", args: "y".repeat(500), endMs: 1 })),
          })),
          controlEvents: Array.from({ length: 40 }, (_, index) => ({ index, to: "needs_attention", reason: "z".repeat(800) })),
        },
      },
    });
    const partial = projected.partialResult as { content: unknown[]; details: { progress: Array<Record<string, unknown>>; controlEvents: Array<Record<string, unknown>> } };
    assert.deepEqual(partial.content, []);
    assert.equal(projected.pluginPayload, undefined);
    assert.equal((projected.partialResult as Record<string, unknown>).pluginPayload, undefined);
    assert.equal(partial.details.progress.length, 64);
    assert.equal((partial.details.progress[0]?.agent as string).length, 120);
    assert.equal((partial.details.progress[0]?.currentToolArgs as string).length, 240);
    assert.equal((partial.details.progress[0]?.recentTools as unknown[]).length, 20);
    assert.equal(partial.details.controlEvents.length, 32);
    assert.equal((partial.details.controlEvents[0]?.reason as string).length, 400);

    const terminal = projectSubagentEvent({
      type: "tool_execution_end",
      result: { content: [{ type: "text", text: "q".repeat(9_000) }] },
    });
    const terminalText = (terminal.result as { content: Array<{ text: string }> }).content[0]?.text;
    assert.equal(terminalText?.length, 8_000);
    pass("browser projection strips progress output and bounds summary/terminal fields");
  }

  {
    const metrics = new BoundedSubagentMetrics();
    for (let i = 0; i < 10_000; i += 1) metrics.record("rawProgress", i);
    metrics.record("sseBytes", 42);
    const snapshot = metrics.takeSnapshot();
    assert.equal(snapshot.rawProgress.count, 10_000);
    assert.equal(snapshot.rawProgress.max, 9_999);
    assert.equal(snapshot.sseBytes.sum, 42);
    assert.equal(metrics.takeSnapshot().rawProgress.count, 0);
    assert.equal(Object.keys(snapshot).length, 10);
    pass("metrics remain fixed-size and reset after bounded aggregation");
  }

  console.log("All subagent observability smoke checks passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
