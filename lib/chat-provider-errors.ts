/**
 * Classify chat/provider failure text into stable categories for localized UI.
 * Extends the shared ERROR_CODES surface without a parallel framework.
 */
import { EMPTY_COMPLETED_RETRY_ERROR, isEmptyCompletedRetryError } from "./agent-retry-errors";
import { ERROR_CODES, type ErrorCode } from "./i18n/error-codes";

export type ChatProviderErrorCategory =
  | "auth"
  | "quota"
  | "network"
  | "model_not_found"
  | "empty_response"
  | "unknown";

export interface ClassifiedChatProviderError {
  category: ChatProviderErrorCategory;
  code: ErrorCode;
  /** Original provider/SDK text kept for technical details. */
  technicalDetails: string;
  /** Prefer localized title via code; this is an English fallback. */
  englishSummary: string;
}

export interface ChatAgentFailureFields {
  provider?: string;
  model?: string;
  errorMessage: string;
  retryAttempts: number;
  maxAttempts?: number;
  technicalDetails: string;
  code: ErrorCode;
  category: ChatProviderErrorCategory;
}

const AUTH_RE =
  /unauthorized|unauthorised|unauthenticated|authentication|invalid[_ -]?api[_ -]?key|api[_ -]?key(?:\s+is)?(?:\s+missing|\s+invalid)?|missing[_ -]?api[_ -]?key|invalid[_ -]?key|401\b|403\b|forbidden|permission denied|access denied|not\s+logged\s+in|login\s+required|credential|bearer\s+token|oauth|expired\s+token|token\s+expired|invalid_grant/i;

const QUOTA_RE =
  /rate[_ -]?limit|too\s+many\s+requests|429\b|quota|billing|insufficient[_ -]?quota|exceeded.+limit|limit\s+exceeded|tokens?\s+per\s+min|tpm|rpm|overloaded|capacity|spend\s+limit|credit/i;

const NETWORK_RE =
  /network|fetch\s+failed|econnrefused|enotfound|etimedout|econnreset|socket\s+hang\s+up|tls|certificate|dns|offline|unreachable|connection\s+refused|connection\s+reset|aborted\s+due\s+to\s+timeout|timeout|timed\s+out|proxy/i;

const MODEL_NOT_FOUND_RE =
  /model[_ -]?not[_ -]?found|unknown\s+model|does\s+not\s+exist|invalid\s+model|no\s+such\s+model|model\s+['"`][^'"`]+['"`]\s+(is\s+)?(?:not|unavailable)|404\b.*model|model.+(?:unavailable|not\s+available)/i;

const EMPTY_PROTOCOL_RE =
  /empty\s+completed\s+response|empty\s+response|no\s+content|invalid\s+response|malformed|protocol|json\s+parse|unexpected\s+end\s+of\s+json|failed\s+to\s+parse/i;

const CATEGORY_META: Record<
  ChatProviderErrorCategory,
  { code: ErrorCode; englishSummary: string }
> = {
  auth: {
    code: ERROR_CODES.chatAuthFailed,
    englishSummary: "Model authentication failed",
  },
  quota: {
    code: ERROR_CODES.chatQuotaExceeded,
    englishSummary: "Account quota exceeded or requests are too frequent",
  },
  network: {
    code: ERROR_CODES.chatNetworkFailed,
    englishSummary: "Could not reach the model service",
  },
  model_not_found: {
    code: ERROR_CODES.chatModelNotFound,
    englishSummary: "The selected model is unavailable",
  },
  empty_response: {
    code: ERROR_CODES.chatEmptyResponse,
    englishSummary: "The model returned no usable content",
  },
  unknown: {
    code: ERROR_CODES.chatProviderFailed,
    englishSummary: "The model request failed",
  },
};

export function classifyChatProviderError(raw: unknown): ClassifiedChatProviderError {
  const technicalDetails = normalizeErrorText(raw);
  const category = detectCategory(technicalDetails);
  const meta = CATEGORY_META[category];
  return {
    category,
    code: meta.code,
    technicalDetails: technicalDetails || meta.englishSummary,
    englishSummary: meta.englishSummary,
  };
}

export function buildChatAgentFailure(input: {
  error: unknown;
  provider?: string;
  model?: string;
  retryAttempts?: number;
  maxAttempts?: number;
}): ChatAgentFailureFields {
  const classified = classifyChatProviderError(input.error);
  return {
    provider: input.provider,
    model: input.model,
    errorMessage: classified.englishSummary,
    retryAttempts: input.retryAttempts ?? 0,
    maxAttempts: input.maxAttempts,
    technicalDetails: classified.technicalDetails,
    code: classified.code,
    category: classified.category,
  };
}

/** Categories that should offer a Models fix entry in the failure card. */
export function chatFailureOffersModelsFix(category: ChatProviderErrorCategory | undefined): boolean {
  return category === "auth"
    || category === "quota"
    || category === "model_not_found"
    || category === "unknown";
}

export function chatFailureTitleKey(category: ChatProviderErrorCategory | undefined): string {
  switch (category) {
    case "auth":
      return "chat.failureTitleAuth";
    case "quota":
      return "chat.failureTitleQuota";
    case "network":
      return "chat.failureTitleNetwork";
    case "model_not_found":
      return "chat.failureTitleModel";
    case "empty_response":
      return "chat.failureTitleEmpty";
    default:
      return "chat.agentFailureTitle";
  }
}

export function chatFailureActionKey(category: ChatProviderErrorCategory | undefined): string | null {
  switch (category) {
    case "auth":
      return "chat.failureActionAuth";
    case "quota":
      return "chat.failureActionQuota";
    case "network":
      return "chat.failureActionNetwork";
    case "model_not_found":
      return "chat.failureActionModel";
    case "empty_response":
      return "chat.failureActionEmpty";
    default:
      return null;
  }
}

function detectCategory(text: string): ChatProviderErrorCategory {
  if (!text) return "unknown";
  if (isEmptyCompletedRetryError(text) || text.includes("empty completed response")) {
    return "empty_response";
  }
  // More specific checks before broad auth (401/403 also appear in other contexts).
  if (MODEL_NOT_FOUND_RE.test(text)) return "model_not_found";
  if (QUOTA_RE.test(text)) return "quota";
  if (NETWORK_RE.test(text)) return "network";
  if (AUTH_RE.test(text)) return "auth";
  if (EMPTY_PROTOCOL_RE.test(text)) return "empty_response";
  if (text === EMPTY_COMPLETED_RETRY_ERROR) return "empty_response";
  return "unknown";
}

function normalizeErrorText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (raw instanceof Error) return (raw.message || String(raw)).trim();
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["errorMessage", "message", "error", "detail", "details"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value instanceof Error && value.message.trim()) return value.message.trim();
    }
  }
  return String(raw).trim();
}
