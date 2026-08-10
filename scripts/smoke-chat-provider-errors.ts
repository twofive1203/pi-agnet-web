/**
 * Chat provider error classification + send-readiness gate smoke.
 * Run: npx tsx scripts/smoke-chat-provider-errors.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_COMPLETED_RETRY_ERROR } from "../lib/agent-retry-errors";
import {
  buildChatAgentFailure,
  chatFailureOffersModelsFix,
  chatFailureTitleKey,
  classifyChatProviderError,
} from "../lib/chat-provider-errors";
import {
  chatSendBlockMessageKey,
  chatSendBlockOffersModelsFix,
  getChatSendBlockReason,
} from "../lib/chat-send-readiness";
import { ERROR_CODES, isErrorCode, localizeError } from "../lib/i18n";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function checkClassification(): void {
  const cases: Array<{ input: string; category: string; code: string }> = [
    { input: "401 Unauthorized: invalid api key", category: "auth", code: ERROR_CODES.chatAuthFailed },
    { input: "Error: Incorrect API key provided", category: "auth", code: ERROR_CODES.chatAuthFailed },
    { input: "429 Too Many Requests: rate limit exceeded", category: "quota", code: ERROR_CODES.chatQuotaExceeded },
    { input: "You exceeded your current quota", category: "quota", code: ERROR_CODES.chatQuotaExceeded },
    { input: "fetch failed: ECONNREFUSED 127.0.0.1:443", category: "network", code: ERROR_CODES.chatNetworkFailed },
    { input: "getaddrinfo ENOTFOUND api.openai.com", category: "network", code: ERROR_CODES.chatNetworkFailed },
    { input: "Model not found: acme/missing-v1", category: "model_not_found", code: ERROR_CODES.chatModelNotFound },
    { input: "The model `gpt-old` does not exist", category: "model_not_found", code: ERROR_CODES.chatModelNotFound },
    { input: EMPTY_COMPLETED_RETRY_ERROR, category: "empty_response", code: ERROR_CODES.chatEmptyResponse },
    { input: "Provider returned an empty completed response", category: "empty_response", code: ERROR_CODES.chatEmptyResponse },
    { input: "something completely novel went wrong", category: "unknown", code: ERROR_CODES.chatProviderFailed },
  ];

  for (const item of cases) {
    const classified = classifyChatProviderError(item.input);
    assert.equal(classified.category, item.category, `category for: ${item.input}`);
    assert.equal(classified.code, item.code, `code for: ${item.input}`);
    assert.equal(classified.technicalDetails, item.input.trim(), `details preserved for: ${item.input}`);
    assert.ok(isErrorCode(classified.code), `code registered: ${classified.code}`);
  }

  const failure = buildChatAgentFailure({
    error: "401 invalid api key",
    provider: "openai",
    model: "gpt-test",
    retryAttempts: 2,
    maxAttempts: 3,
  });
  assert.equal(failure.category, "auth");
  assert.equal(failure.code, ERROR_CODES.chatAuthFailed);
  assert.equal(failure.provider, "openai");
  assert.equal(failure.retryAttempts, 2);
  assert.match(failure.technicalDetails, /invalid api key/i);
  assert.equal(chatFailureOffersModelsFix("auth"), true);
  assert.equal(chatFailureOffersModelsFix("network"), false);
  assert.equal(chatFailureTitleKey("quota"), "chat.failureTitleQuota");
}

function checkLocalizeKeys(): void {
  const t = (key: string) => `L:${key}`;
  const classified = classifyChatProviderError("unauthorized api key");
  const text = localizeError(t, { code: classified.code, message: "raw" });
  assert.equal(text, "L:errors.chat.authFailed");

  // Legacy empty-completed English string maps through ERROR_CODES.
  const empty = localizeError(t, {
    message: "Provider returned an empty completed response after tool results; please retry your request",
  });
  assert.equal(empty, "L:errors.chat.emptyResponse");
}

function checkSendReadiness(): void {
  assert.equal(getChatSendBlockReason({ cwd: null }), "no_workspace");
  assert.equal(getChatSendBlockReason({ cwd: "  " }), "no_workspace");
  assert.equal(
    getChatSendBlockReason({ cwd: "/proj", modelsReady: false }),
    "models_loading",
  );
  assert.equal(
    getChatSendBlockReason({ cwd: "/proj", modelsReady: true, modelList: [] }),
    "no_models",
  );
  assert.equal(
    getChatSendBlockReason({
      cwd: "/proj",
      modelsReady: true,
      modelList: [{ id: "m1", provider: "p" }],
      selectedModel: null,
    }),
    "no_model_selected",
  );
  assert.equal(
    getChatSendBlockReason({
      cwd: "/proj",
      modelsReady: true,
      modelList: [{ id: "m1", provider: "p" }],
      selectedModel: { provider: "p", modelId: "other" },
    }),
    "no_model_selected",
  );
  assert.equal(
    getChatSendBlockReason({
      cwd: "/proj",
      modelsReady: true,
      modelList: [{ id: "m1", provider: "p" }],
      selectedModel: { provider: "p", modelId: "m1" },
    }),
    null,
  );

  assert.equal(chatSendBlockOffersModelsFix("no_models"), true);
  assert.equal(chatSendBlockOffersModelsFix("no_workspace"), false);
  assert.equal(chatSendBlockMessageKey("no_models"), "chat.sendBlockedNoModels");
}

function checkWiring(): void {
  const hook = readFileSync(join(ROOT, "hooks", "useAgentSession.ts"), "utf8");
  assert.match(hook, /buildChatAgentFailure/, "hook builds classified failures");
  assert.match(hook, /getChatSendBlockReason/, "hook gates send readiness");
  assert.match(hook, /modelsReady/, "hook tracks modelsReady");

  const windowSrc = readFileSync(join(ROOT, "components", "ChatWindow.tsx"), "utf8");
  assert.match(windowSrc, /chatFailureTitleKey/, "failure card uses category titles");
  assert.match(windowSrc, /onOpenModels/, "failure card can open Models");
  assert.match(windowSrc, /localizeError/, "failure card localizes by code");

  const input = readFileSync(join(ROOT, "components", "ChatInput.tsx"), "utf8");
  assert.match(input, /getChatSendBlockReason/, "composer uses send readiness");
  assert.match(input, /sendBlockedFixModels/, "composer exposes Models fix CTA");
  assert.match(input, /canSendNow/, "send button honors readiness gate");

  const shell = readFileSync(join(ROOT, "components", "AppShell.tsx"), "utf8");
  assert.match(shell, /onOpenModels=\{\(\) => \{/, "AppShell wires Models open handler");

  const codes = readFileSync(join(ROOT, "lib", "i18n", "error-codes.ts"), "utf8");
  assert.match(codes, /chatAuthFailed/, "error codes include chat auth");
  assert.match(codes, /chatEmptyResponse/, "error codes include empty response");
}

function main(): void {
  checkClassification();
  checkLocalizeKeys();
  checkSendReadiness();
  checkWiring();
  console.log("chat provider errors + send readiness smoke checks passed");
}

main();
