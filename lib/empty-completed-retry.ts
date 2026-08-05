import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EMPTY_COMPLETED_RETRY_ERROR } from "./agent-retry-errors";

export const EMPTY_COMPLETED_RETRY_MODELS_ENV = "PI_WEB_EMPTY_COMPLETED_RETRY_MODELS";
export const DEFAULT_EMPTY_COMPLETED_RETRY_MODELS = ["cun1/kimi-k3"] as const;

function modelKey(provider: string, model: string): string {
  return `${provider.trim()}/${model.trim()}`.toLowerCase();
}

export function readEmptyCompletedRetryModelWhitelist(
  configuredValue = process.env[EMPTY_COMPLETED_RETRY_MODELS_ENV],
): Set<string> {
  const configuredModels = configuredValue === undefined
    ? DEFAULT_EMPTY_COMPLETED_RETRY_MODELS
    : configuredValue.split(",");
  return new Set(
    configuredModels
      .map((value) => value.trim().toLowerCase())
      .filter((value) => /^[^/\s]+\/[^/\s]+$/.test(value)),
  );
}

function hasMeaningfulAssistantContent(message: AssistantMessage): boolean {
  return message.content.some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    if (block.type === "thinking") return block.thinking.trim().length > 0;
    if (block.type === "toolCall") return true;
    // Future block types must be treated as meaningful until explicitly understood.
    return true;
  });
}

function hasZeroUsage(message: AssistantMessage): boolean {
  const usage = message.usage;
  if (!usage) return false;
  const values = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.reasoning,
    usage.totalTokens,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 && values.every((value) => value === 0);
}

export interface EmptyCompletedNormalizationContext {
  followsToolResult: boolean;
  aborted: boolean;
  modelWhitelist: ReadonlySet<string>;
}

export function normalizeEmptyCompletedAssistantMessage(
  message: AssistantMessage,
  context: EmptyCompletedNormalizationContext,
): AssistantMessage {
  if (
    context.aborted
    || !context.followsToolResult
    || !context.modelWhitelist.has(modelKey(message.provider, message.model))
    || message.stopReason !== "stop"
    || message.rawStopReason !== "completed"
    || hasMeaningfulAssistantContent(message)
    || !hasZeroUsage(message)
  ) {
    return message;
  }

  return {
    ...message,
    stopReason: "error",
    errorMessage: EMPTY_COMPLETED_RETRY_ERROR,
  };
}

function lastContextMessageRole(sessionManager: { getBranch(): unknown[] }): string | undefined {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: string; message?: { role?: string } };
    if (entry.type === "message") return entry.message?.role;
  }
  return undefined;
}

/**
 * Convert a provider-specific empty success into a normal Pi retryable error.
 * The in-memory continuation flag keeps later retry attempts tied to the same
 * post-tool turn even though each failed Assistant message is persisted.
 */
export function createEmptyCompletedRetryExtension(): InlineExtension {
  return {
    name: "empty-completed-retry",
    hidden: true,
    factory(pi) {
      const modelWhitelist = readEmptyCompletedRetryModelWhitelist();
      let continuingAfterToolResult = false;

      pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "assistant") return;

        const followsToolResult = continuingAfterToolResult
          || lastContextMessageRole(ctx.sessionManager) === "toolResult";
        const normalized = normalizeEmptyCompletedAssistantMessage(event.message, {
          followsToolResult,
          aborted: ctx.signal?.aborted === true,
          modelWhitelist,
        });

        if (normalized !== event.message) {
          continuingAfterToolResult = true;
          return { message: normalized };
        }

        continuingAfterToolResult = followsToolResult
          && event.message.stopReason === "error"
          && ctx.signal?.aborted !== true;
      });

      pi.on("agent_settled", () => {
        continuingAfterToolResult = false;
      });
    },
  };
}
