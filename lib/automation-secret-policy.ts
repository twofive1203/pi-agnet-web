/**
 * Credential handle/scope policy and redaction for Automation.
 * Snapshots never store secret values — only identifiers/scopes.
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{8,}/g,
  /key[_-]?[a-zA-Z0-9]{16,}/gi,
  /Bearer\s+[a-zA-Z0-9._\-+=/]{10,}/g,
  /api[_-]?key["'\s:=]+[a-zA-Z0-9._\-]+/gi,
  /password["'\s:=]+[^\s"',]+/gi,
  /secret["'\s:=]+[^\s"',]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const CANARY_ENV_KEYS = [
  "AUTOMATION_CANARY_SECRET",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
];

export type CredentialHandle = {
  id: string;
  scope: string;
  provider?: string;
};

export function normalizeCredentialHandle(input: unknown): CredentialHandle | null {
  if (!input || typeof input !== "object") return null;
  const rec = input as Record<string, unknown>;
  if (typeof rec.id !== "string" || !rec.id.trim()) return null;
  if (typeof rec.scope !== "string" || !rec.scope.trim()) return null;
  return {
    id: rec.id.trim(),
    scope: rec.scope.trim(),
    provider: typeof rec.provider === "string" ? rec.provider : undefined,
  };
}

export function redactSecrets(text: string, extraCanaries: string[] = []): string {
  if (!text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  for (const key of CANARY_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 4) {
      out = out.split(value).join("[REDACTED]");
    }
  }
  for (const canary of extraCanaries) {
    if (canary && canary.length >= 4) {
      out = out.split(canary).join("[REDACTED]");
    }
  }
  return out;
}

export function redactUnknown(value: unknown, extraCanaries: string[] = []): unknown {
  if (typeof value === "string") return redactSecrets(value, extraCanaries);
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, extraCanaries));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|password|token|api.?key|authorization/i.test(k) && typeof v === "string") {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactUnknown(v, extraCanaries);
      }
    }
    return out;
  }
  return value;
}

/** Minimal env allowlist for headless runner processes. */
export function buildRunnerEnv(input: {
  baseEnv?: NodeJS.ProcessEnv;
  credentialHandles?: CredentialHandle[];
  extraAllowKeys?: string[];
}): NodeJS.ProcessEnv {
  const base = input.baseEnv ?? process.env;
  const allow = new Set([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "NODE_ENV",
    "PI_CODING_AGENT_DIR",
    "ComSpec",
    "TERM",
    ...(input.extraAllowKeys ?? []),
  ]);

  const out: NodeJS.ProcessEnv = { ...base };
  // Start from a copy then drop non-allowlisted keys.
  for (const key of Object.keys(out)) {
    if (!allow.has(key)) delete out[key];
  }
  for (const key of allow) {
    if (base[key] != null) out[key] = base[key];
  }

  // Credential values are resolved by approved tools via handles, not bulk-copied.
  // Only inject explicitly mapped provider keys when handle scope permits.
  for (const handle of input.credentialHandles ?? []) {
    if (handle.scope === "env" && handle.id && base[handle.id] != null) {
      out[handle.id] = base[handle.id];
    }
  }

  // Never forward canary/test secrets unless explicitly handled.
  delete out.AUTOMATION_CANARY_SECRET;
  return out;
}

export function assertNoSecretLeak(text: string, canaries: string[]): void {
  for (const canary of canaries) {
    if (canary && text.includes(canary)) {
      throw new Error("Secret canary leaked into automation output");
    }
  }
}
