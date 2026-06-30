import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getOAuthAccountAccessToken, OPENAI_CODEX_PROVIDER_ID, readOAuthAccountCredential } from "@/lib/oauth-accounts";
import { getOAuthAccountSubscriptionQuota } from "@/lib/subscription-quota";

export const OPENAI_CODEX_WARMUP_MODEL_ID = "gpt-5.4-mini";

const WARMUP_TIMEOUT_MS = 30_000;
const WARMUP_PROMPT = "Reply with OK only.";
const warmupModel = OPENAI_CODEX_MODELS[OPENAI_CODEX_WARMUP_MODEL_ID];

export interface OpenAICodexWarmupResult {
  accountId: string;
  success: boolean;
  error: string | null;
  latencyMs: number | null;
  quotaRefreshSuccess: boolean;
  quotaError: string | null;
}

export interface OpenAICodexWarmupResponse {
  provider: typeof OPENAI_CODEX_PROVIDER_ID;
  modelId: typeof OPENAI_CODEX_WARMUP_MODEL_ID;
  results: OpenAICodexWarmupResult[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runMinimalCodexRequest(accessToken: string): Promise<AssistantMessage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
  try {
    const stream = streamSimple(warmupModel, {
      messages: [{ role: "user", content: WARMUP_PROMPT, timestamp: Date.now() }],
    }, {
      apiKey: accessToken,
      maxTokens: 16,
      reasoning: "minimal",
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: WARMUP_TIMEOUT_MS,
      maxRetries: 0,
      signal: controller.signal,
    });
    return await stream.result();
  } finally {
    clearTimeout(timeout);
  }
}

async function warmOpenAICodexAccount(accountId: string): Promise<OpenAICodexWarmupResult> {
  let success = false;
  let error: string | null = null;
  let latencyMs: number | null = null;
  const startedAt = Date.now();

  try {
    const credential = await readOAuthAccountCredential(OPENAI_CODEX_PROVIDER_ID, accountId);
    const accessToken = await getOAuthAccountAccessToken(OPENAI_CODEX_PROVIDER_ID, credential);
    if (!accessToken) throw new Error("OAuth token unavailable. Please re-login.");

    const message = await runMinimalCodexRequest(accessToken);
    latencyMs = Date.now() - startedAt;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? "Codex warmup request failed");
    }
    success = true;
  } catch (warmupError) {
    latencyMs = Date.now() - startedAt;
    error = errorMessage(warmupError);
  }

  let quotaRefreshSuccess = false;
  let quotaError: string | null = null;
  try {
    const quota = await getOAuthAccountSubscriptionQuota(OPENAI_CODEX_PROVIDER_ID, accountId);
    quotaRefreshSuccess = quota.success;
    quotaError = quota.error;
  } catch (quotaRefreshError) {
    quotaError = errorMessage(quotaRefreshError);
  }

  return {
    accountId,
    success,
    error,
    latencyMs,
    quotaRefreshSuccess,
    quotaError,
  };
}

export async function warmOpenAICodexAccounts(accountIds: string[]): Promise<OpenAICodexWarmupResponse> {
  const results: OpenAICodexWarmupResult[] = [];
  for (const accountId of accountIds) {
    results.push(await warmOpenAICodexAccount(accountId));
  }
  return {
    provider: OPENAI_CODEX_PROVIDER_ID,
    modelId: OPENAI_CODEX_WARMUP_MODEL_ID,
    results,
  };
}
