/**
 * Smoke checks for empty completed-response normalization and agent lifecycle
 * settlement mapping used by the WebUI retry path.
 * Run: node --import tsx scripts/smoke-empty-completed-retry.mjs
 */
import assert from "node:assert/strict";
import {
  DEFAULT_EMPTY_COMPLETED_RETRY_MODELS,
  normalizeEmptyCompletedAssistantMessage,
  readEmptyCompletedRetryModelWhitelist,
} from "../lib/empty-completed-retry.ts";
import { EMPTY_COMPLETED_RETRY_ERROR } from "../lib/agent-retry-errors.ts";
import { getAgentLifecycleDirective } from "../lib/agent-lifecycle.ts";

function baseMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "cun1",
    model: "kimi-k3",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    rawStopReason: "completed",
    timestamp: Date.now(),
    ...overrides,
  };
}

const whitelist = readEmptyCompletedRetryModelWhitelist();
assert.equal(whitelist.has("cun1/kimi-k3"), true);
assert.deepEqual([...DEFAULT_EMPTY_COMPLETED_RETRY_MODELS], ["cun1/kimi-k3"]);

// Empty completed after tool results on a whitelisted model becomes retryable.
{
  const normalized = normalizeEmptyCompletedAssistantMessage(baseMessage(), {
    followsToolResult: true,
    aborted: false,
    modelWhitelist: whitelist,
  });
  assert.equal(normalized.stopReason, "error");
  assert.equal(normalized.errorMessage, EMPTY_COMPLETED_RETRY_ERROR);
  assert.match(normalized.errorMessage, /retry your request/i);
}

// Non-empty completed responses stay untouched.
{
  const message = baseMessage({
    content: [{ type: "text", text: "hello" }],
    usage: {
      input: 12,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: true,
    aborted: false,
    modelWhitelist: whitelist,
  });
  assert.equal(normalized, message);
}

// Without a preceding tool result, empty completed is not rewritten.
{
  const message = baseMessage();
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: false,
    aborted: false,
    modelWhitelist: whitelist,
  });
  assert.equal(normalized, message);
}

// Non-whitelisted providers keep empty completed responses as-is.
{
  const message = baseMessage({ provider: "openai", model: "gpt-5" });
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: true,
    aborted: false,
    modelWhitelist: whitelist,
  });
  assert.equal(normalized, message);
}

// User abort must never be rewritten into a retryable error.
{
  const message = baseMessage();
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: true,
    aborted: true,
    modelWhitelist: whitelist,
  });
  assert.equal(normalized, message);
}

// Env override replaces the default whitelist.
{
  const custom = readEmptyCompletedRetryModelWhitelist("openai/gpt-test, bad-entry, deepseek/v4");
  assert.equal(custom.has("openai/gpt-test"), true);
  assert.equal(custom.has("deepseek/v4"), true);
  assert.equal(custom.has("cun1/kimi-k3"), false);
  assert.equal(custom.has("bad-entry"), false);
}

// Lifecycle mapping: only agent_settled / prompt_error settle model turns.
assert.equal(getAgentLifecycleDirective("agent_start", false), "start");
assert.equal(getAgentLifecycleDirective("agent_end", true), "keep-running");
assert.equal(getAgentLifecycleDirective("agent_settled", true), "settle");
assert.equal(getAgentLifecycleDirective("prompt_error", true), "settle");
assert.equal(getAgentLifecycleDirective("prompt_settled", true), "ignore");
assert.equal(getAgentLifecycleDirective("prompt_settled", false), "settle");

console.log("All empty completed retry smoke checks passed.");
