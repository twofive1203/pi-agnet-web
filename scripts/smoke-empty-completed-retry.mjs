/**
 * Smoke checks for empty completed-response normalization and agent lifecycle
 * settlement mapping used by the WebUI retry path.
 * Run: node --import tsx scripts/smoke-empty-completed-retry.mjs
 */
import assert from "node:assert/strict";
import {
  clearEmptyCompletedRetryProviderCache,
  isEmptyCompletedRetryProviderEnabled,
  normalizeEmptyCompletedAssistantMessage,
  readEmptyCompletedRetryProvidersFromModelsJson,
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

clearEmptyCompletedRetryProviderCache();

// models.json provider flag parsing is case-insensitive on provider id.
{
  const enabled = readEmptyCompletedRetryProvidersFromModelsJson({
    providers: {
      Cun1: { emptyCompletedRetry: true, baseUrl: "https://example.test" },
      other: { emptyCompletedRetry: false },
      skipped: { baseUrl: "https://example.test" },
      bad: null,
    },
  });
  assert.equal(enabled.has("cun1"), true);
  assert.equal(enabled.has("other"), false);
  assert.equal(enabled.has("skipped"), false);
  assert.equal(isEmptyCompletedRetryProviderEnabled({ emptyCompletedRetry: true }), true);
  assert.equal(isEmptyCompletedRetryProviderEnabled({ emptyCompletedRetry: false }), false);
  assert.equal(isEmptyCompletedRetryProviderEnabled({}), false);
}

const enabledProviders = new Set(["cun1"]);

// Empty completed after tool results on an opted-in provider becomes retryable.
{
  const normalized = normalizeEmptyCompletedAssistantMessage(baseMessage(), {
    followsToolResult: true,
    aborted: false,
    enabledProviders,
  });
  assert.equal(normalized.stopReason, "error");
  assert.equal(normalized.errorMessage, EMPTY_COMPLETED_RETRY_ERROR);
  assert.match(normalized.errorMessage, /retry your request/i);
}

// All models under the provider are covered (not a model-id whitelist).
{
  const normalized = normalizeEmptyCompletedAssistantMessage(baseMessage({ model: "any-model" }), {
    followsToolResult: true,
    aborted: false,
    enabledProviders,
  });
  assert.equal(normalized.stopReason, "error");
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
    enabledProviders,
  });
  assert.equal(normalized, message);
}

// Without a preceding tool result, empty completed is not rewritten.
{
  const message = baseMessage();
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: false,
    aborted: false,
    enabledProviders,
  });
  assert.equal(normalized, message);
}

// Providers without the switch keep empty completed responses as-is.
{
  const message = baseMessage({ provider: "openai", model: "gpt-5" });
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: true,
    aborted: false,
    enabledProviders,
  });
  assert.equal(normalized, message);
}

// User abort must never be rewritten into a retryable error.
{
  const message = baseMessage();
  const normalized = normalizeEmptyCompletedAssistantMessage(message, {
    followsToolResult: true,
    aborted: true,
    enabledProviders,
  });
  assert.equal(normalized, message);
}

// Lifecycle mapping: only agent_settled / prompt_error settle model turns.
assert.equal(getAgentLifecycleDirective("agent_start", false), "start");
assert.equal(getAgentLifecycleDirective("agent_end", true), "keep-running");
assert.equal(getAgentLifecycleDirective("agent_settled", true), "settle");
assert.equal(getAgentLifecycleDirective("prompt_error", true), "settle");
assert.equal(getAgentLifecycleDirective("prompt_settled", true), "ignore");
assert.equal(getAgentLifecycleDirective("prompt_settled", false), "settle");

console.log("All empty completed retry smoke checks passed.");
