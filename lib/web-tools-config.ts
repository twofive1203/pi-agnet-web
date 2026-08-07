import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const WEB_TOOLS_PACKAGE_VERSION = "2.3.1";
export const WEB_TOOLS_DEFAULT_PROVIDER = "brave";

export const WEB_TOOLS_PROVIDERS = [
  { id: "brave", label: "Brave", roles: ["search"], apiKeyEnvVar: "BRAVE_SEARCH_API_KEY" },
  { id: "tavily", label: "Tavily", roles: ["search", "fetch"], apiKeyEnvVar: "TAVILY_API_KEY" },
  { id: "serper", label: "Serper", roles: ["search"], apiKeyEnvVar: "SERPER_API_KEY" },
  { id: "exa", label: "Exa", roles: ["search", "fetch"], apiKeyEnvVar: "EXA_API_KEY" },
  { id: "youcom", label: "You.com", roles: ["search", "fetch"], apiKeyEnvVar: "YOUCOM_API_KEY" },
  { id: "jina", label: "Jina", roles: ["search", "fetch"], apiKeyEnvVar: "JINA_API_KEY" },
  { id: "firecrawl", label: "Firecrawl", roles: ["search", "fetch"], apiKeyEnvVar: "FIRECRAWL_API_KEY" },
  { id: "perplexity", label: "Perplexity", roles: ["search"], apiKeyEnvVar: "PERPLEXITY_API_KEY" },
  {
    id: "searxng",
    label: "SearXNG",
    roles: ["search"],
    apiKeyEnvVar: "SEARXNG_API_KEY",
    baseUrlEnvVar: "SEARXNG_URL",
    defaultBaseUrl: "http://localhost:8080",
  },
  {
    id: "ollama",
    label: "Ollama",
    roles: ["search", "fetch"],
    apiKeyEnvVar: "OLLAMA_API_KEY",
    baseUrlEnvVar: "OLLAMA_HOST",
    defaultBaseUrl: "http://localhost:11434",
  },
] as const;

export type WebToolsProviderId = typeof WEB_TOOLS_PROVIDERS[number]["id"];
export type WebToolsSecretOperation =
  | { mode: "preserve" }
  | { mode: "replace"; value: string }
  | { mode: "clear" };
export type WebToolsValueOperation = WebToolsSecretOperation;

export type WebToolsConfigErrorCode =
  | "PARSE_ERROR"
  | "REVISION_CONFLICT"
  | "VALIDATION_ERROR"
  | "IO_ERROR";

export class WebToolsConfigError extends Error {
  readonly code: WebToolsConfigErrorCode;
  readonly status: number;
  readonly fieldPath?: string;

  constructor(code: WebToolsConfigErrorCode, message: string, status = 400, fieldPath?: string) {
    super(message);
    this.name = "WebToolsConfigError";
    this.code = code;
    this.status = status;
    this.fieldPath = fieldPath;
  }
}

interface WebToolsNativeConfig extends Record<string, unknown> {
  provider?: string;
  apiKeys?: Record<string, string>;
  baseUrls?: Record<string, string>;
  apiKey?: string;
}

export interface WebToolsProviderProjection {
  id: WebToolsProviderId;
  label: string;
  roles: readonly ("search" | "fetch")[];
  apiKeyEnvVar: string;
  keySource: "environment" | "config" | "legacy" | "none";
  keyConfigured: boolean;
  storedKeyConfigured: boolean;
  legacyKeyConfigured: boolean;
  baseUrlEnvVar?: string;
  baseUrlSource?: "environment" | "config" | "default" | "none";
  baseUrl?: string;
  storedBaseUrl?: string;
  defaultBaseUrl?: string;
}

export interface WebToolsConfigSnapshot {
  path: string;
  sourcePath: string;
  sourceKind: "canonical" | "legacy-fallback";
  exists: boolean;
  revision: string;
  parseError?: string;
  persistedProvider: WebToolsProviderId;
  effectiveProvider: string;
  effectiveProviderSource: "environment" | "config" | "default";
  effectiveProviderKnown: boolean;
  providerEnvVar: "WEB_SEARCH_PROVIDER";
  providers: WebToolsProviderProjection[];
  unknownRootKeys: string[];
  packageVersion: typeof WEB_TOOLS_PACKAGE_VERSION;
}

export interface WebToolsPathOptions {
  homeDir?: string;
  xdgConfigHome?: string;
  env?: Record<string, string | undefined>;
}

export interface ApplyWebToolsConfigInput extends WebToolsPathOptions {
  expectedRevision: string;
  provider: WebToolsProviderId;
  credentialProvider?: WebToolsProviderId;
  apiKey: WebToolsSecretOperation;
  baseUrl?: WebToolsValueOperation;
}

const KNOWN_ROOT_KEYS = new Set(["provider", "apiKeys", "baseUrls", "apiKey", "guidance", "interceptors"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

export function resolveWebToolsConfigPaths(options: WebToolsPathOptions = {}): {
  canonicalPath: string;
  legacyPath: string;
} {
  const homeDir = options.homeDir ?? homedir();
  const rawXdg = options.xdgConfigHome ?? (options.env ? options.env.XDG_CONFIG_HOME : process.env.XDG_CONFIG_HOME);
  const trimmedXdg = rawXdg?.trim();
  const expandedXdg = trimmedXdg ? expandTilde(trimmedXdg, homeDir) : undefined;
  const configDir = expandedXdg && isAbsolute(expandedXdg) ? expandedXdg : join(homeDir, ".config");
  return {
    canonicalPath: join(configDir, "rpiv-web-tools", "config.json"),
    legacyPath: join(homeDir, ".config", "rpiv-web-tools", "config.json"),
  };
}

export function computeWebToolsRevision(sourcePath: string, targetPath: string, bytes: string | null): string {
  return createHash("sha256")
    .update(sourcePath)
    .update("\0")
    .update(targetPath)
    .update("\0")
    .update(bytes ?? "<missing>")
    .digest("hex");
}

function parseStringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object of string values`);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${field}.${key} must be a string`);
    output[key] = entry;
  }
  return output;
}

function parseNativeConfig(bytes: string): WebToolsNativeConfig {
  const parsed = JSON.parse(bytes) as unknown;
  if (!isRecord(parsed)) throw new Error("Config root must be a JSON object");
  if (parsed.provider !== undefined && typeof parsed.provider !== "string") {
    throw new Error("provider must be a string");
  }
  if (parsed.apiKey !== undefined && typeof parsed.apiKey !== "string") {
    throw new Error("apiKey must be a string");
  }
  const apiKeys = parseStringMap(parsed.apiKeys, "apiKeys");
  const baseUrls = parseStringMap(parsed.baseUrls, "baseUrls");
  return {
    ...parsed,
    ...(apiKeys ? { apiKeys } : {}),
    ...(baseUrls ? { baseUrls } : {}),
  };
}

function safeConfigParseError(error: unknown): string {
  if (error instanceof SyntaxError) {
    const message = error.message;
    const position = /position\s+(\d+)/i.exec(message)?.[1];
    const line = /line\s+(\d+)/i.exec(message)?.[1];
    const column = /column\s+(\d+)/i.exec(message)?.[1];
    const location = [
      position ? `position ${position}` : null,
      line ? `line ${line}` : null,
      column ? `column ${column}` : null,
    ].filter(Boolean).join(", ");
    return location ? `Invalid JSON (${location})` : "Invalid JSON";
  }
  return error instanceof Error ? error.message : "Invalid configuration";
}

function isProviderId(value: string | undefined): value is WebToolsProviderId {
  return !!value && WEB_TOOLS_PROVIDERS.some((provider) => provider.id === value);
}

function readEffectiveFile(options: WebToolsPathOptions = {}): {
  canonicalPath: string;
  sourcePath: string;
  sourceKind: "canonical" | "legacy-fallback";
  exists: boolean;
  bytes: string | null;
} {
  const { canonicalPath, legacyPath } = resolveWebToolsConfigPaths(options);
  const canonicalExists = existsSync(canonicalPath);
  const legacyFallback = !canonicalExists && legacyPath !== canonicalPath && existsSync(legacyPath);
  const sourcePath = legacyFallback ? legacyPath : canonicalPath;
  const exists = canonicalExists || legacyFallback;
  return {
    canonicalPath,
    sourcePath,
    sourceKind: legacyFallback ? "legacy-fallback" : "canonical",
    exists,
    bytes: exists ? readFileSync(sourcePath, "utf8") : null,
  };
}

function projectSnapshot(
  file: ReturnType<typeof readEffectiveFile>,
  config: WebToolsNativeConfig,
  parseError: string | undefined,
  env: Record<string, string | undefined>,
): WebToolsConfigSnapshot {
  const configuredProvider = isProviderId(config.provider) ? config.provider : WEB_TOOLS_DEFAULT_PROVIDER;
  const envProvider = envValue(env, "WEB_SEARCH_PROVIDER");
  const effectiveProvider = envProvider ?? config.provider?.trim() ?? WEB_TOOLS_DEFAULT_PROVIDER;
  const effectiveProviderSource = envProvider ? "environment" : config.provider?.trim() ? "config" : "default";

  const providers: WebToolsProviderProjection[] = WEB_TOOLS_PROVIDERS.map((provider) => {
    const envKeyConfigured = !!envValue(env, provider.apiKeyEnvVar);
    const storedKeyConfigured = !!config.apiKeys?.[provider.id]?.trim();
    const legacyKeyConfigured = provider.id === "brave" && !!config.apiKey?.trim();
    const keySource = envKeyConfigured
      ? "environment"
      : storedKeyConfigured
        ? "config"
        : legacyKeyConfigured
          ? "legacy"
          : "none";
    const baseUrlEnvVar = "baseUrlEnvVar" in provider ? provider.baseUrlEnvVar : undefined;
    const defaultBaseUrl = "defaultBaseUrl" in provider ? provider.defaultBaseUrl : undefined;
    const envBaseUrl = baseUrlEnvVar ? envValue(env, baseUrlEnvVar) : undefined;
    const storedBaseUrl = config.baseUrls?.[provider.id]?.trim() || undefined;
    const baseUrl = envBaseUrl ?? storedBaseUrl ?? defaultBaseUrl;
    const baseUrlSource = baseUrlEnvVar
      ? envBaseUrl
        ? "environment"
        : storedBaseUrl
          ? "config"
          : defaultBaseUrl
            ? "default"
            : "none"
      : undefined;
    return {
      id: provider.id,
      label: provider.label,
      roles: provider.roles,
      apiKeyEnvVar: provider.apiKeyEnvVar,
      keySource,
      keyConfigured: keySource !== "none",
      storedKeyConfigured,
      legacyKeyConfigured,
      ...(baseUrlEnvVar ? { baseUrlEnvVar } : {}),
      ...(baseUrlSource ? { baseUrlSource } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(storedBaseUrl ? { storedBaseUrl } : {}),
      ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    };
  });

  return {
    path: file.canonicalPath,
    sourcePath: file.sourcePath,
    sourceKind: file.sourceKind,
    exists: file.exists,
    revision: computeWebToolsRevision(file.sourcePath, file.canonicalPath, file.bytes),
    parseError,
    persistedProvider: configuredProvider,
    effectiveProvider,
    effectiveProviderSource,
    effectiveProviderKnown: isProviderId(effectiveProvider),
    providerEnvVar: "WEB_SEARCH_PROVIDER",
    providers,
    unknownRootKeys: Object.keys(config).filter((key) => !KNOWN_ROOT_KEYS.has(key)).sort(),
    packageVersion: WEB_TOOLS_PACKAGE_VERSION,
  };
}

export function readWebToolsConfigSnapshot(options: WebToolsPathOptions = {}): WebToolsConfigSnapshot {
  const file = readEffectiveFile(options);
  let config: WebToolsNativeConfig = {};
  let parseError: string | undefined;
  if (file.bytes !== null) {
    try {
      config = parseNativeConfig(file.bytes);
    } catch (error) {
      parseError = safeConfigParseError(error);
    }
  }
  return projectSnapshot(file, config, parseError, options.env ?? process.env);
}

function validateOperation(operation: WebToolsSecretOperation, field: string): void {
  if (!operation || typeof operation !== "object") {
    throw new WebToolsConfigError("VALIDATION_ERROR", `${field} operation is required`, 400, field);
  }
  if (operation.mode === "preserve" || operation.mode === "clear") return;
  if (operation.mode === "replace" && typeof operation.value === "string" && operation.value.trim()) return;
  throw new WebToolsConfigError("VALIDATION_ERROR", `${field} operation is invalid`, 400, field);
}

function applyMapOperation(
  current: Record<string, string> | undefined,
  key: string,
  operation: WebToolsSecretOperation,
): Record<string, string> | undefined {
  if (operation.mode === "preserve") return current ? { ...current } : undefined;
  const next = { ...(current ?? {}) };
  if (operation.mode === "replace") next[key] = operation.value.trim();
  else delete next[key];
  return Object.keys(next).length > 0 ? next : undefined;
}

function validateBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebToolsConfigError("VALIDATION_ERROR", "baseUrl must be a valid URL", 400, "baseUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebToolsConfigError("VALIDATION_ERROR", "baseUrl must use http:// or https://", 400, "baseUrl");
  }
  return trimmed.replace(/\/$/, "");
}

function writeAtomic(path: string, config: WebToolsNativeConfig): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.config.json.snail-pi-${process.pid}-${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on Windows and filesystems without POSIX permissions.
    }
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw new WebToolsConfigError(
      "IO_ERROR",
      `Failed to write Web Search config: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

export function applyWebToolsConfig(input: ApplyWebToolsConfigInput): WebToolsConfigSnapshot {
  if (!isProviderId(input.provider)) {
    throw new WebToolsConfigError("VALIDATION_ERROR", "provider is not supported by the bundled package", 400, "provider");
  }
  const credentialProvider = input.credentialProvider ?? input.provider;
  if (!isProviderId(credentialProvider)) {
    throw new WebToolsConfigError(
      "VALIDATION_ERROR",
      "credentialProvider is not supported by the bundled package",
      400,
      "credentialProvider",
    );
  }
  validateOperation(input.apiKey, "apiKey");
  if (input.baseUrl) validateOperation(input.baseUrl, "baseUrl");

  const file = readEffectiveFile(input);
  const revision = computeWebToolsRevision(file.sourcePath, file.canonicalPath, file.bytes);
  if (revision !== input.expectedRevision) {
    throw new WebToolsConfigError(
      "REVISION_CONFLICT",
      "Web Search configuration changed since it was loaded. Reload Settings and try again.",
      409,
    );
  }

  let current: WebToolsNativeConfig = {};
  if (file.bytes !== null) {
    try {
      current = parseNativeConfig(file.bytes);
    } catch (error) {
      throw new WebToolsConfigError(
        "PARSE_ERROR",
        `Cannot update malformed Web Search config: ${safeConfigParseError(error)}`,
        409,
      );
    }
  }

  const next: WebToolsNativeConfig = { ...current, provider: input.provider };
  const nextApiKeys = applyMapOperation(current.apiKeys, credentialProvider, input.apiKey);
  if (nextApiKeys) next.apiKeys = nextApiKeys;
  else delete next.apiKeys;

  if (credentialProvider === "brave" && input.apiKey.mode !== "preserve") {
    delete next.apiKey;
  }

  const provider = WEB_TOOLS_PROVIDERS.find((item) => item.id === credentialProvider);
  const supportsBaseUrl = provider && "baseUrlEnvVar" in provider;
  if (input.baseUrl && !supportsBaseUrl && input.baseUrl.mode !== "preserve") {
    throw new WebToolsConfigError("VALIDATION_ERROR", `${credentialProvider} does not support a configurable base URL`, 400, "baseUrl");
  }
  if (input.baseUrl && supportsBaseUrl) {
    const normalizedOperation: WebToolsValueOperation = input.baseUrl.mode === "replace"
      ? { mode: "replace", value: validateBaseUrl(input.baseUrl.value) }
      : input.baseUrl;
    const nextBaseUrls = applyMapOperation(current.baseUrls, credentialProvider, normalizedOperation);
    if (nextBaseUrls) next.baseUrls = nextBaseUrls;
    else delete next.baseUrls;
  }

  writeAtomic(file.canonicalPath, next);
  return readWebToolsConfigSnapshot(input);
}
