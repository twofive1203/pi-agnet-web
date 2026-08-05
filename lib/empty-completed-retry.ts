import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EMPTY_COMPLETED_RETRY_ERROR } from "./agent-retry-errors";

/** Resolve ~/.pi/agent without importing the ESM-only pi package entry. */
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof envDir === "string" && envDir.trim()) return envDir.trim();
  return join(homedir(), ".pi", "agent");
}

/** Provider-level models.json flag recognized by WebUI (ignored by Pi schema extras). */
export const EMPTY_COMPLETED_RETRY_PROVIDER_FLAG = "emptyCompletedRetry" as const;

export interface EmptyCompletedRetryProviderConfig {
  [EMPTY_COMPLETED_RETRY_PROVIDER_FLAG]?: unknown;
}

function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

export function isEmptyCompletedRetryProviderEnabled(
  providerConfig: EmptyCompletedRetryProviderConfig | null | undefined,
): boolean {
  return providerConfig?.[EMPTY_COMPLETED_RETRY_PROVIDER_FLAG] === true;
}

/** Collect provider ids that opted into empty-completed retry from a models.json object. */
export function readEmptyCompletedRetryProvidersFromModelsJson(
  modelsJson: unknown,
): Set<string> {
  const enabled = new Set<string>();
  if (!modelsJson || typeof modelsJson !== "object" || Array.isArray(modelsJson)) {
    return enabled;
  }
  const providers = (modelsJson as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return enabled;
  }
  for (const [providerId, config] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerId.trim()) continue;
    if (
      config
      && typeof config === "object"
      && !Array.isArray(config)
      && isEmptyCompletedRetryProviderEnabled(config as EmptyCompletedRetryProviderConfig)
    ) {
      enabled.add(normalizeProviderId(providerId));
    }
  }
  return enabled;
}

export function getModelsJsonPath(agentDir = getAgentDir()): string {
  return join(agentDir, "models.json");
}

let providerCache:
  | {
      path: string;
      mtimeMs: number;
      size: number;
      providers: Set<string>;
    }
  | null = null;

/** Read enabled providers from disk, reusing a small mtime/size cache. */
export function readEmptyCompletedRetryProviders(
  modelsJsonPath = getModelsJsonPath(),
): Set<string> {
  if (!existsSync(modelsJsonPath)) {
    providerCache = null;
    return new Set();
  }

  let stats: { mtimeMs: number; size: number };
  try {
    const fileStats = statSync(modelsJsonPath);
    stats = { mtimeMs: fileStats.mtimeMs, size: fileStats.size };
  } catch {
    providerCache = null;
    return new Set();
  }

  if (
    providerCache
    && providerCache.path === modelsJsonPath
    && providerCache.mtimeMs === stats.mtimeMs
    && providerCache.size === stats.size
  ) {
    return providerCache.providers;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as unknown;
  } catch {
    providerCache = {
      path: modelsJsonPath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      providers: new Set(),
    };
    return providerCache.providers;
  }

  const providers = readEmptyCompletedRetryProvidersFromModelsJson(parsed);
  providerCache = {
    path: modelsJsonPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    providers,
  };
  return providers;
}

/** Test helper to clear the on-disk cache between smoke cases. */
export function clearEmptyCompletedRetryProviderCache(): void {
  providerCache = null;
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
  /** Provider ids with emptyCompletedRetry enabled in models.json. */
  enabledProviders: ReadonlySet<string>;
}

export function normalizeEmptyCompletedAssistantMessage(
  message: AssistantMessage,
  context: EmptyCompletedNormalizationContext,
): AssistantMessage {
  if (
    context.aborted
    || !context.followsToolResult
    || !context.enabledProviders.has(normalizeProviderId(message.provider))
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
 * Opt-in is provider-scoped via models.json `emptyCompletedRetry: true`.
 * The in-memory continuation flag keeps later retry attempts tied to the same
 * post-tool turn even though each failed Assistant message is persisted.
 */
export function createEmptyCompletedRetryExtension(): InlineExtension {
  return {
    name: "empty-completed-retry",
    hidden: true,
    factory(pi) {
      let continuingAfterToolResult = false;

      pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "assistant") return;

        const followsToolResult = continuingAfterToolResult
          || lastContextMessageRole(ctx.sessionManager) === "toolResult";
        const normalized = normalizeEmptyCompletedAssistantMessage(event.message, {
          followsToolResult,
          aborted: ctx.signal?.aborted === true,
          // Re-read on each check so Models UI saves apply without restarting the process.
          enabledProviders: readEmptyCompletedRetryProviders(),
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
