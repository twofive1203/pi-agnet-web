/**
 * Redaction helpers for browser tool outputs and audit metadata.
 * Never return Cookie/Authorization/Set-Cookie or common token query values.
 */

const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-session-token",
]);

const SENSITIVE_QUERY_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "authorization",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "passwd",
  "session",
  "sid",
  "code",
  "client_secret",
  "signature",
  "sig",
];

const PASSWORD_FIELD_RE = /password|passwd|pwd|passcode|pin|cvv|cvc|card.?number|cc-number|ssn|secret/i;
const PAYMENT_ROLE_RE = /payment|credit.?card|billing/i;

const SECRET_INLINE_RES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._\-+/=]+/g,
  /\b(?:sk|rk|pk)[-_][A-Za-z0-9]{16,}/g,
  /\b(?:xox[baprs]-)[A-Za-z0-9-]{10,}/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z\-_]{20,}/g,
];

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase());
}

export function redactHeaders(
  headers: Record<string, string> | Array<[string, string]> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName);
    if (isSensitiveHeaderName(name)) {
      out[name] = "[redacted]";
      continue;
    }
    out[name] = typeof rawValue === "string" ? rawValue : String(rawValue);
  }
  return out;
}

const QUERY_CREDENTIAL_RE =
  /([?&](?:token|access_token|refresh_token|id_token|auth|authorization|api_key|apikey|key|secret|password|passwd|session|sid|code|client_secret|signature|sig)=)[^&\s"'<>]*/gi;
const PLAIN_TOKEN_ASSIGN_RE =
  /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|session[_-]?token|auth[_-]?token|token|secret|password|passwd)\s*[=:]\s*)("?[^\s"'&,;<>]+"?)/gi;

function redactQueryCredentialsInText(text: string): string {
  return String(text ?? "")
    .replace(QUERY_CREDENTIAL_RE, "$1[redacted]")
    .replace(PLAIN_TOKEN_ASSIGN_RE, "$1[redacted]");
}

export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (SENSITIVE_QUERY_KEYS.some((k) => lower === k || lower.includes(k))) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    // Avoid leaking userinfo credentials.
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return redactQueryCredentialsInText(rawUrl);
  }
}

export function isSensitiveFieldName(name: string | null | undefined): boolean {
  if (!name) return false;
  return PASSWORD_FIELD_RE.test(name);
}

export function isSensitiveControl(meta: {
  name?: string | null;
  type?: string | null;
  autocomplete?: string | null;
  role?: string | null;
  label?: string | null;
}): boolean {
  const type = (meta.type ?? "").toLowerCase();
  if (type === "password" || type === "file") return true;
  if (isSensitiveFieldName(meta.name) || isSensitiveFieldName(meta.autocomplete) || isSensitiveFieldName(meta.label)) {
    return true;
  }
  if (PAYMENT_ROLE_RE.test(meta.role ?? "") || PAYMENT_ROLE_RE.test(meta.label ?? "")) return true;
  return false;
}

export function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

export function sanitizeConsoleText(text: string, maxChars = 2_000): string {
  let redacted = String(text ?? "");
  // Redact credential-bearing URLs embedded in stacks/messages before other scrubbing.
  redacted = redacted.replace(
    /https?:\/\/[^\s"'<>]+/gi,
    (match) => redactUrl(match),
  );
  redacted = redactQueryCredentialsInText(redacted);
  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]")
    .replace(/(authorization\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(cookie\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(set-cookie\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(api[_-]?key\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(x-api-key\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(access[_-]?token\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(refresh[_-]?token\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(session[_-]?token\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(secret\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]")
    .replace(/(password\s*[:=]\s*)("?)[^\s"']+/gi, "$1$2[redacted]");
  for (const re of SECRET_INLINE_RES) {
    redacted = redacted.replace(re, "[redacted]");
  }
  return truncateText(redacted, maxChars).text;
}

/** Deep-ish sanitize for console arg previews / exception payloads. */
export function sanitizeConsoleValue(value: unknown, maxChars = 2_000, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeConsoleText(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeConsoleValue(item, Math.min(400, maxChars), depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 30) {
        out["…"] = "truncated";
        break;
      }
      const lower = key.toLowerCase();
      if (
        lower.includes("authorization")
        || lower.includes("cookie")
        || lower.includes("password")
        || lower.includes("secret")
        || lower.includes("token")
        || lower.includes("api_key")
        || lower.includes("apikey")
      ) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeConsoleValue(nested, Math.min(400, maxChars), depth + 1);
      }
      count += 1;
    }
    return out;
  }
  return sanitizeConsoleText(String(value), maxChars);
}

/**
 * Audit-safe parameter summary: never stores typed/page text values.
 * Keys like text/value/url/html/body become redacted markers only.
 */
export function summarizeAuditParams(params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  const redactKey = /^(text|value|html|body|content|password|secret|token|code|query|input|title)$/i;
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("__")) continue;
    if (redactKey.test(key) || /password|secret|token|cookie|authorization/i.test(key)) {
      out[key] = typeof value === "string" ? `[redacted:${value.length}]` : "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      if (key.toLowerCase().includes("url")) {
        out[key] = redactUrl(value);
      } else {
        // Never keep free-form page/typed text in audit — only length + short hash-free marker.
        out[key] = value.length > 40 ? `[string:${value.length}]` : value;
        // Still scrub accidental secrets in short strings.
        if (typeof out[key] === "string") out[key] = sanitizeConsoleText(out[key] as string, 80);
      }
    } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = { type: "array", length: value.length };
    } else {
      out[key] = { type: typeof value };
    }
  }
  return out;
}

export function networkSummarySafe(entry: {
  url?: string;
  method?: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  timingMs?: number;
  startedAt?: number;
}): Record<string, unknown> {
  return {
    url: typeof entry.url === "string" ? redactUrl(entry.url) : "",
    method: entry.method ?? "GET",
    status: entry.status ?? null,
    resourceType: entry.resourceType ?? "other",
    failed: Boolean(entry.failed),
    errorText: entry.errorText ? sanitizeConsoleText(entry.errorText, 400) : undefined,
    timingMs: entry.timingMs,
    startedAt: entry.startedAt,
  };
}
