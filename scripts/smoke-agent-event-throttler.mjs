/**
 * Deterministic smoke checks for token-stream event coalescing.
 * Run: node --import tsx scripts/smoke-agent-event-throttler.mjs
 */
import assert from "node:assert/strict";
import { AgentEventThrottler } from "../lib/agent-event-throttler.ts";

function update(text) {
  return { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function textOf(event) {
  return event.message?.content?.[0]?.text ?? event.type;
}

// First update is immediate; later token updates collapse to the latest snapshot.
{
  const delivered = [];
  const throttler = new AgentEventThrottler((event) => delivered.push(textOf(event)), 25);
  throttler.handle(update("a"));
  throttler.handle(update("ab"));
  throttler.handle(update("abc"));
  assert.deepEqual(delivered, ["a"]);

  // A non-update event is an ordering barrier: latest text must arrive before message_end.
  throttler.handle({ type: "message_end" });
  assert.deepEqual(delivered, ["a", "abc", "message_end"]);
  throttler.clear();
}

// A pending snapshot is eventually delivered even if no barrier event follows.
{
  const delivered = [];
  const throttler = new AgentEventThrottler((event) => delivered.push(textOf(event)), 10);
  throttler.handle(update("a"));
  throttler.handle(update("ab"));
  throttler.handle(update("abc"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(delivered, ["a", "abc"]);
  throttler.clear();
}

// Terminal barriers reset the leading edge so the next turn renders immediately.
{
  let now = 100;
  const delivered = [];
  const throttler = new AgentEventThrottler((event) => delivered.push(textOf(event)), 50, () => now);
  throttler.handle(update("turn-1-a"));
  now += 1;
  throttler.handle(update("turn-1-b"));
  throttler.handle({ type: "agent_end" });
  throttler.handle(update("turn-2-a"));
  assert.deepEqual(delivered, ["turn-1-a", "turn-1-b", "agent_end", "turn-2-a"]);
  throttler.clear();
}

// agent_settled is also a terminal barrier for multi-run prompt lifecycles.
{
  let now = 100;
  const delivered = [];
  const throttler = new AgentEventThrottler((event) => delivered.push(textOf(event)), 50, () => now);
  throttler.handle(update("retry-1-a"));
  now += 1;
  throttler.handle(update("retry-1-b"));
  throttler.handle({ type: "agent_settled" });
  throttler.handle(update("retry-2-a"));
  assert.deepEqual(delivered, ["retry-1-a", "retry-1-b", "agent_settled", "retry-2-a"]);
  throttler.clear();
}

// clear() must not leak a delayed update after wrapper teardown.
{
  const delivered = [];
  const throttler = new AgentEventThrottler((event) => delivered.push(textOf(event)), 10);
  throttler.handle(update("a"));
  throttler.handle(update("ab"));
  throttler.clear();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(delivered, ["a"]);
}

console.log("All agent event throttler smoke checks passed.");
