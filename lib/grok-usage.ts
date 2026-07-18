import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  createModelRegistry,
  createSessionServicesWithRegistry,
  FileCredentialStore,
} from "@/lib/pi-auth";

const GROK_PROVIDER_ID = "grok-cli";
const GROK_BILLING_TIMEOUT_MS = 15_000;
/** Refresh a little early so billing calls rarely hit an already-expired access token. */
const GROK_TOKEN_REFRESH_SKEW_MS = 120_000;
/** Public xAI OAuth client used by pi-grok-cli; overridable for private deployments. */
const GROK_OAUTH_CLIENT_ID =
  process.env.PI_GROK_CLI_OAUTH_CLIENT_ID || "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_DEFAULT_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

// Cache file location
const CACHE_FILE = "grok-cli-usage-cache.json";
const CACHE_VERSION = 1;

export interface GrokMonthlyUsage {
  used: number;
  monthlyLimit: number;
  remaining: number;
  utilization: number;
  billingPeriodEnd: string;
}

export interface GrokWeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd: string;
}

export interface GrokUsageResult {
  provider: string;
  configured: boolean;
  success: boolean;
  source: "cache" | "live";
  monthly: GrokMonthlyUsage | null;
  weekly: GrokWeeklyUsage | null;
  error: string | null;
  queriedAt: number | null;
  envBypass: boolean;
}

interface GrokUsageCache {
  version: number;
  provider: string;
  monthly: GrokMonthlyUsage | null;
  weekly: GrokWeeklyUsage | null;
  queriedAt: number;
  envBypass: boolean;
}

/**
 * 将未知错误转换为可展示的短消息。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 判断输入是否是普通对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 获取 Grok CLI billing base URL。
 * 优先 env，其次 auth.json 中 pi-grok-cli 写入的 baseUrl。
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.PI_GROK_CLI_BASE_URL || process.env.GROK_CLI_BASE_URL;
  if (fromEnv?.trim()) return fromEnv.trim().replace(/\/+$/, "");

  const stored = readStoredCredential(GROK_PROVIDER_ID);
  if (isRecord(stored) && typeof stored.baseUrl === "string" && stored.baseUrl.trim()) {
    return stored.baseUrl.trim().replace(/\/+$/, "");
  }

  return "https://cli-chat-proxy.grok.com/v1";
}

interface GrokStoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh?: string;
  expires?: number;
  tokenEndpoint?: string;
  discovery?: { token_endpoint?: string };
  [key: string]: unknown;
}

function isGrokStoredOAuthCredential(value: unknown): value is GrokStoredOAuthCredential {
  if (!isRecord(value) || value.type !== "oauth") return false;
  return typeof value.access === "string" && value.access.length > 0;
}

function isTokenFresh(expires: number | undefined): boolean {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return true;
  return expires > Date.now() + GROK_TOKEN_REFRESH_SKEW_MS;
}

function resolveTokenEndpoint(credential: GrokStoredOAuthCredential): string {
  const endpoint = credential.tokenEndpoint
    || credential.discovery?.token_endpoint
    || GROK_DEFAULT_TOKEN_ENDPOINT;
  return endpoint.trim();
}

/**
 * Refresh a stored grok-cli OAuth credential without loading the pi-grok-cli package.
 * Billing only needs a valid access token; OAuth login remains owned by the extension.
 */
async function refreshStoredGrokCredential(
  credential: GrokStoredOAuthCredential,
): Promise<GrokStoredOAuthCredential | null> {
  if (!credential.refresh) return null;
  const tokenEndpoint = resolveTokenEndpoint(credential);
  if (!tokenEndpoint) return null;

  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: GROK_OAUTH_CLIENT_ID,
        refresh_token: credential.refresh,
      }),
      signal: AbortSignal.timeout(GROK_BILLING_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const payload = await response.json() as Record<string, unknown>;
    const access = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!access) return null;

    const refresh = typeof payload.refresh_token === "string" && payload.refresh_token
      ? payload.refresh_token
      : credential.refresh;
    const expiresInRaw = payload.expires_in;
    const expiresIn = typeof expiresInRaw === "number"
      ? expiresInRaw
      : Number(expiresInRaw ?? 3600);
    const expires = Date.now()
      + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000
      - GROK_TOKEN_REFRESH_SKEW_MS;

    const next: GrokStoredOAuthCredential = {
      ...credential,
      type: "oauth",
      access,
      refresh,
      expires,
      tokenEndpoint,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : credential.tokenType ?? "Bearer",
      idToken: typeof payload.id_token === "string" ? payload.id_token : credential.idToken,
    };

    // Persist refreshed tokens so subsequent billing/UI reads stay in sync with auth.json.
    await FileCredentialStore.create().modify(GROK_PROVIDER_ID, async () => ({
      type: "oauth",
      access: next.access,
      refresh: next.refresh ?? credential.refresh ?? "",
      expires: next.expires ?? Date.now(),
      tokenEndpoint: next.tokenEndpoint,
      discovery: next.discovery,
      idToken: next.idToken,
      tokenType: next.tokenType,
      baseUrl: next.baseUrl,
    })).catch(() => undefined);
    return next;
  } catch {
    return null;
  }
}

/**
 * 获取 Grok CLI access token。
 * 1. GROK_CLI_OAUTH_TOKEN 环境变量
 * 2. createAgentSessionServices 加载扩展后的 ModelRegistry（可 OAuth refresh）
 * 3. 裸 ModelRuntime/ModelRegistry（通常拿不到 grok-cli）
 * 4. 直接读 auth.json 的 access，必要时本地 refresh
 */
async function resolveToken(): Promise<{ token: string; envBypass: boolean } | null> {
  if (process.env.GROK_CLI_OAUTH_TOKEN) {
    return { token: process.env.GROK_CLI_OAUTH_TOKEN, envBypass: true };
  }

  // pi-grok-cli registers the `grok-cli` provider only after extension load.
  // Bare ModelRuntime.create() will report configured status but getAuth() is undefined.
  try {
    const { registry } = await createSessionServicesWithRegistry(process.cwd(), getAgentDir());
    const apiKey = await registry.getApiKeyForProvider(GROK_PROVIDER_ID);
    if (apiKey) return { token: apiKey, envBypass: false };
  } catch {
    // Fall through to lighter paths
  }

  try {
    const { registry } = await createModelRegistry();
    const apiKey = await registry.getApiKeyForProvider(GROK_PROVIDER_ID);
    if (apiKey) return { token: apiKey, envBypass: false };
  } catch {
    // Extension providers like grok-cli are usually not present on a bare ModelRuntime.
  }

  const stored = readStoredCredential(GROK_PROVIDER_ID);
  if (isGrokStoredOAuthCredential(stored)) {
    if (isTokenFresh(stored.expires)) {
      return { token: stored.access, envBypass: false };
    }

    const refreshed = await refreshStoredGrokCredential(stored);
    if (refreshed?.access) return { token: refreshed.access, envBypass: false };

    // Last resort: try the stored access token; billing maps 401 to re-login guidance.
    return { token: stored.access, envBypass: false };
  }

  if (stored?.type === "api_key") {
    const key = typeof (stored as { key?: unknown }).key === "string"
      ? (stored as { key: string }).key.trim()
      : "";
    if (key) return { token: key, envBypass: false };
  }

  return null;
}

/**
 * 解析月度用量。
 */
function parseMonthlyUsage(payload: unknown): GrokMonthlyUsage {
  if (!isRecord(payload)) throw new Error("Invalid billing payload");
  const config = isRecord(payload.config) ? payload.config : null;
  if (!config) throw new Error("Invalid billing payload: missing config");

  const monthlyLimit = isRecord(config.monthlyLimit) && typeof config.monthlyLimit.val === "number" ? config.monthlyLimit.val : undefined;
  const used = isRecord(config.used) && typeof config.used.val === "number" ? config.used.val : undefined;
  const billingPeriodEnd = typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : undefined;

  if (typeof monthlyLimit !== "number" || !Number.isFinite(monthlyLimit) ||
      typeof used !== "number" || !Number.isFinite(used) ||
      typeof billingPeriodEnd !== "string" || !Number.isFinite(new Date(billingPeriodEnd).getTime())) {
    throw new Error("Invalid billing payload: malformed monthly usage fields");
  }

  const remaining = Math.max(0, monthlyLimit - used);
  const utilization = monthlyLimit > 0
    ? Math.min(Math.max(Math.round((used / monthlyLimit) * 100), 0), 100)
    : 0;

  return { used, monthlyLimit, remaining, utilization, billingPeriodEnd };
}

/**
 * 解析周度用量（可选）。
 */
function parseWeeklyUsage(payload: unknown): GrokWeeklyUsage | null {
  if (!isRecord(payload)) return null;
  const config = isRecord(payload.config) ? payload.config : null;
  if (!config) return null;

  const currentPeriod = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  if (!currentPeriod || currentPeriod.type !== "USAGE_PERIOD_TYPE_WEEKLY") return null;

  const billingPeriodEnd = typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : undefined;
  if (typeof billingPeriodEnd !== "string" || !Number.isFinite(new Date(billingPeriodEnd).getTime())) return null;

  const raw = config.creditUsagePercent;
  const creditUsagePercent = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;

  return { creditUsagePercent, billingPeriodEnd };
}

/**
 * 获取缓存文件路径。
 */
function getCacheFilePath(): string {
  return join(getAgentDir(), CACHE_FILE);
}

/**
 * 从磁盘读取 last-known 缓存。
 */
function isMonthlyUsage(value: unknown): value is GrokMonthlyUsage {
  if (!isRecord(value)) return false;
  return typeof value.used === "number" && Number.isFinite(value.used)
    && typeof value.monthlyLimit === "number" && Number.isFinite(value.monthlyLimit)
    && typeof value.remaining === "number" && Number.isFinite(value.remaining)
    && typeof value.utilization === "number" && Number.isFinite(value.utilization)
    && typeof value.billingPeriodEnd === "string"
    && Number.isFinite(new Date(value.billingPeriodEnd).getTime());
}

function isWeeklyUsage(value: unknown): value is GrokWeeklyUsage {
  if (!isRecord(value)) return false;
  return typeof value.creditUsagePercent === "number" && Number.isFinite(value.creditUsagePercent)
    && typeof value.billingPeriodEnd === "string"
    && Number.isFinite(new Date(value.billingPeriodEnd).getTime());
}

function readCache(): GrokUsageCache | null {
  const cachePath = getCacheFilePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    if (!isRecord(raw) || raw.version !== CACHE_VERSION || raw.provider !== GROK_PROVIDER_ID) return null;
    if (raw.monthly !== null && !isMonthlyUsage(raw.monthly)) return null;
    if (raw.weekly !== null && raw.weekly !== undefined && !isWeeklyUsage(raw.weekly)) return null;
    if (typeof raw.queriedAt !== "number" || !Number.isFinite(raw.queriedAt)) return null;
    if (typeof raw.envBypass !== "boolean") return null;
    return {
      version: CACHE_VERSION,
      provider: GROK_PROVIDER_ID,
      monthly: raw.monthly,
      weekly: raw.weekly ?? null,
      queriedAt: raw.queriedAt,
      envBypass: raw.envBypass,
    };
  } catch {
    return null;
  }
}

/**
 * 将成功结果写入缓存。
 */
function writeCache(result: GrokUsageResult): void {
  const cache: GrokUsageCache = {
    version: CACHE_VERSION,
    provider: GROK_PROVIDER_ID,
    monthly: result.monthly,
    weekly: result.weekly,
    queriedAt: result.queriedAt ?? Date.now(),
    envBypass: result.envBypass,
  };
  const cachePath = getCacheFilePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function notConfiguredResult(): GrokUsageResult {
  return {
    provider: GROK_PROVIDER_ID,
    configured: false,
    success: false,
    source: "live",
    monthly: null,
    weekly: null,
    error: "Grok CLI 未登录。请先在 Models → Grok CLI 完成 OAuth 登录，或设置 GROK_CLI_OAUTH_TOKEN 环境变量。",
    queriedAt: null,
    envBypass: false,
  };
}

function errorResult(configured: boolean, message: string): GrokUsageResult {
  return {
    provider: GROK_PROVIDER_ID,
    configured,
    success: false,
    source: "live",
    monthly: null,
    weekly: null,
    error: message,
    queriedAt: Date.now(),
    envBypass: false,
  };
}

function cacheResult(cache: GrokUsageCache): GrokUsageResult {
  return {
    provider: GROK_PROVIDER_ID,
    configured: true,
    success: true,
    source: "cache",
    monthly: cache.monthly,
    weekly: cache.weekly,
    error: null,
    queriedAt: cache.queriedAt,
    envBypass: cache.envBypass,
  };
}

/**
 * 获取 Grok CLI 用量。
 *
 * @param mode "cache" 仅返回 last-known 缓存；"refresh" 从 billing 端点实时查询。
 * @returns 脱敏后的用量结果。
 */
export async function getGrokUsage(mode: "cache" | "refresh" = "cache"): Promise<GrokUsageResult> {
  if (mode === "cache") {
    const cache = readCache();
    if (cache) return cacheResult(cache);
    // Cache miss does not imply unconfigured; avoid token resolution / billing hits.
    return {
      provider: GROK_PROVIDER_ID,
      configured: true,
      success: false,
      source: "cache",
      monthly: null,
      weekly: null,
      error: "Not queried yet. Click refresh to query Grok CLI billing.",
      queriedAt: null,
      envBypass: false,
    };
  }

  // Refresh mode: live billing fetch
  const resolved = await resolveToken();
  if (!resolved) return notConfiguredResult();

  const { token, envBypass } = resolved;
  const baseUrl = resolveBaseUrl();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    accept: "application/json",
  };

  try {
    // Fetch monthly billing
    const monthlyResponse = await fetch(`${baseUrl}/billing`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(GROK_BILLING_TIMEOUT_MS),
    });

    if (!monthlyResponse.ok) {
      // Keep browser-facing errors free of raw upstream bodies (may contain sensitive detail).
      if (monthlyResponse.status === 401 || monthlyResponse.status === 403) {
        return errorResult(true, "Grok CLI token invalid or expired. Re-login via Models → Grok CLI.");
      }
      return errorResult(true, `xAI billing API error (HTTP ${monthlyResponse.status}). Please retry later.`);
    }

    const monthlyPayload = await monthlyResponse.json() as unknown;
    let monthly: GrokMonthlyUsage;
    try {
      monthly = parseMonthlyUsage(monthlyPayload);
    } catch (parseError) {
      return errorResult(true, `Invalid billing response: ${errorMessage(parseError)}`);
    }

    // Fetch optional weekly credits
    let weekly: GrokWeeklyUsage | null = null;
    try {
      const weeklyResponse = await fetch(`${baseUrl}/billing?format=credits`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(GROK_BILLING_TIMEOUT_MS),
      });
      if (weeklyResponse.ok) {
        try {
          const weeklyPayload = await weeklyResponse.json() as unknown;
          weekly = parseWeeklyUsage(weeklyPayload);
        } catch {
          // Weekly is optional; degrade gracefully
        }
      }
    } catch {
      // Weekly is optional
    }

    const result: GrokUsageResult = {
      provider: GROK_PROVIDER_ID,
      configured: true,
      success: true,
      source: "live",
      monthly,
      weekly,
      error: null,
      queriedAt: Date.now(),
      envBypass,
    };

    // Write cache on success
    writeCache(result);

    return result;
  } catch (fetchError) {
    if (typeof (fetchError as { name?: string }).name === "string" &&
        (fetchError as { name: string }).name === "TimeoutError") {
      return errorResult(true, "xAI billing 请求超时，请检查网络连接后重试。");
    }
    return errorResult(true, `Network error: ${errorMessage(fetchError)}`);
  }
}
