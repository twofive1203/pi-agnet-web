export const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const DEFAULT_MAX_TOKENS = 128000;
/** Default UA for openai-responses custom providers (many gateways expect a Codex-like client). */
export const DEFAULT_OPENAI_RESPONSES_USER_AGENT =
  "codex-tui/0.125.0 (Windows 10.0.26100; x86_64) WindowsTerminal (codex-tui; 0.125.0)";
/** Default UA for anthropic-messages custom providers (many gateways expect a Claude CLI client). */
export const DEFAULT_ANTHROPIC_MESSAGES_USER_AGENT = "claude-cli/2.1.220 (external, cli)";
export const DEFAULT_API_USER_AGENTS: Record<string, string> = {
  "openai-responses": DEFAULT_OPENAI_RESPONSES_USER_AGENT,
  "anthropic-messages": DEFAULT_ANTHROPIC_MESSAGES_USER_AGENT,
};
export const discoveredModelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function hasHeaderKey(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

export function defaultUserAgentForApi(api: string | undefined): string | undefined {
  if (!api) return undefined;
  return DEFAULT_API_USER_AGENTS[api];
}

export function withDefaultApiUserAgent(
  headers: Record<string, string> | undefined,
  api: string | undefined,
): Record<string, string> | undefined {
  const defaultUa = defaultUserAgentForApi(api);
  if (!defaultUa) return headers;
  if (hasHeaderKey(headers, "User-Agent")) return headers ? { ...headers } : undefined;
  return { ...(headers ?? {}), "User-Agent": defaultUa };
}

export function applyApiChangeHeaders<
  T extends { api?: string; headers?: Record<string, string> },
>(entry: T, nextApi: string | undefined): T {
  const api = nextApi || undefined;
  const headers = withDefaultApiUserAgent(entry.headers, api);
  return { ...entry, api, headers };
}

export function ensureDefaultApiUserAgent<
  T extends { api?: string; headers?: Record<string, string> },
>(entry: T): T | null {
  const defaultUa = defaultUserAgentForApi(entry.api);
  if (!defaultUa || hasHeaderKey(entry.headers, "User-Agent")) return null;
  return { ...entry, headers: withDefaultApiUserAgent(entry.headers, entry.api) };
}

export function defaultUserAgentHint(api: string | undefined, scope: "provider" | "model"): string | undefined {
  const defaultUa = defaultUserAgentForApi(api);
  if (!defaultUa || !api) return undefined;
  if (scope === "model") {
    return `Model-level ${api} defaults User-Agent to ${defaultUa} when unset. Overrides provider headers with the same name.`;
  }
  return `${api} defaults User-Agent to ${defaultUa} when unset. Edit or remove it as needed.`;
}
