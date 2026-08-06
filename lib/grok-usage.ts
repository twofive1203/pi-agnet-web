import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore } from "@/lib/pi-auth";
import {
  fetchGrokBillingPayloads,
  GrokBillingPayloadError,
} from "@/lib/grok-billing-fetch";
import {
  listOAuthAccounts,
  readOAuthAccountCredential,
  saveOAuthAccountCredential,
  updateOAuthAccountQuotaCache,
  type OAuthAccountQuotaCache,
} from "@/lib/oauth-accounts";

const GROK_PROVIDER_ID = "grok-cli";
const XAI_PROVIDER_ID = "xai";
const GROK_AUTH_PROVIDER_IDS = [GROK_PROVIDER_ID, XAI_PROVIDER_ID] as const;
type GrokAuthProviderId = typeof GROK_AUTH_PROVIDER_IDS[number];
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
 * 获取 Grok billing base URL。
 * 优先 env，其次当前 auth provider 写入的 baseUrl。
 */
function resolveBaseUrl(providerId: GrokAuthProviderId): string {
  const fromEnv = process.env.PI_GROK_CLI_BASE_URL || process.env.GROK_CLI_BASE_URL;
  if (fromEnv?.trim()) return fromEnv.trim().replace(/\/+$/, "");

  const stored = readStoredCredential(providerId);
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
 * Exchange a Grok refresh token for a fresh access token without loading pi-grok-cli.
 * Billing only needs a valid access token; OAuth login remains owned by the extension.
 */
async function refreshGrokOAuthCredential(
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

    return {
      ...credential,
      type: "oauth",
      access,
      refresh,
      expires,
      tokenEndpoint,
      tokenType: typeof payload.token_type === "string" ? payload.token_type : credential.tokenType ?? "Bearer",
      idToken: typeof payload.id_token === "string" ? payload.id_token : credential.idToken,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh the active auth.json credential under its original provider key.
 */
async function refreshStoredGrokCredential(
  providerId: GrokAuthProviderId,
  credential: GrokStoredOAuthCredential,
): Promise<GrokStoredOAuthCredential | null> {
  const next = await refreshGrokOAuthCredential(credential);
  if (!next) return null;

  // Persist refreshed tokens so subsequent billing/UI reads stay in sync with auth.json.
  await FileCredentialStore.create().modify(providerId, async () => ({
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
}

function isGrokAuthProviderId(value: string): value is GrokAuthProviderId {
  return (GROK_AUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

function weeklyQuotaCacheFromResult(result: GrokUsageResult): OAuthAccountQuotaCache {
  const weekly = result.weekly;
  return {
    success: result.success,
    // Store as seven_day so account pies share Codex's "7d" label path.
    tiers: weekly
      ? [{
        name: "seven_day",
        utilization: Math.min(Math.max(weekly.creditUsagePercent, 0), 100),
        resetsAt: weekly.billingPeriodEnd,
      }]
      : [],
    error: result.error,
    queriedAt: result.queriedAt,
    resetCreditsAvailableCount: null,
    resetCredits: [],
    resetCreditsError: null,
  };
}

async function cacheWeeklyUsageToAccount(
  providerId: GrokAuthProviderId,
  accountId: string | null | undefined,
  result: GrokUsageResult,
): Promise<void> {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (!normalizedAccountId) return;
  // Always persist the attempt (success or error) so account rows leave the
  // "No quota cache" empty state after a manual refresh.
  try {
    await updateOAuthAccountQuotaCache(providerId, normalizedAccountId, weeklyQuotaCacheFromResult(result));
  } catch {
    // Best-effort only; callers still return the live result to the browser.
  }
}

async function cacheWeeklyUsageToActiveAccount(
  providerId: GrokAuthProviderId,
  result: GrokUsageResult,
): Promise<void> {
  try {
    const list = await listOAuthAccounts(providerId);
    await cacheWeeklyUsageToAccount(providerId, list.activeAccountId, result);
  } catch {
    // Account-store writes are best-effort and must not fail the billing response.
  }
}

function accountUsageFromQuotaCache(
  providerId: GrokAuthProviderId,
  quotaCache: OAuthAccountQuotaCache | undefined,
): GrokUsageResult {
  if (!quotaCache) {
    return {
      provider: GROK_PROVIDER_ID,
      configured: true,
      success: false,
      source: "cache",
      monthly: null,
      weekly: null,
      error: "Not queried yet. Click refresh to query this account's weekly usage.",
      queriedAt: null,
      envBypass: false,
    };
  }

  const weeklyTier = quotaCache.tiers.find((tier) => tier.name === "seven_day" || tier.name === "weekly");
  const weekly = weeklyTier && typeof weeklyTier.resetsAt === "string"
    ? {
      creditUsagePercent: weeklyTier.utilization,
      billingPeriodEnd: weeklyTier.resetsAt,
    }
    : null;

  return {
    provider: GROK_PROVIDER_ID,
    configured: true,
    success: quotaCache.success && Boolean(weekly),
    source: "cache",
    monthly: null,
    weekly,
    error: quotaCache.error,
    queriedAt: quotaCache.queriedAt,
    envBypass: false,
  };
}

/**
 * Resolve a saved non-active (or active) Grok account token without touching auth.json
 * unless the caller later activates the account.
 */
async function resolveAccountToken(
  providerId: GrokAuthProviderId,
  accountId: string,
): Promise<{ token: string; baseUrl: string } | { error: string }> {
  let credential;
  try {
    credential = await readOAuthAccountCredential(providerId, accountId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (!isGrokStoredOAuthCredential(credential)) {
    return { error: "Saved Grok account credential is invalid." };
  }

  let usable: GrokStoredOAuthCredential = credential;
  if (!isTokenFresh(credential.expires)) {
    const refreshed = await refreshGrokOAuthCredential(credential);
    if (!refreshed?.access) {
      // Do not fall back to an already-expired access token: billing will 401 and the
      // UI looks like an empty cache hit rather than a credential problem.
      return {
        error: "OAuth token expired and refresh failed. Re-login or re-add this account in Models → xAI / Grok CLI.",
      };
    }
    usable = refreshed;
    // Keep only the account-store credential in sync for non-active accounts.
    await saveOAuthAccountCredential(providerId, {
      ...refreshed,
      accountId,
    }).catch(() => undefined);
  }

  if (!usable.access) return { error: "OAuth token unavailable. Please re-login this account." };

  const baseUrl = typeof usable.baseUrl === "string" && usable.baseUrl.trim()
    ? usable.baseUrl.trim().replace(/\/+$/, "")
    : resolveBaseUrl(providerId);

  return { token: usable.access, baseUrl };
}

async function fetchBillingUsage(
  token: string,
  baseUrl: string,
  envBypass: boolean,
): Promise<GrokUsageResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
    accept: "application/json",
  };

  try {
    // Monthly and optional weekly billing start concurrently. Monthly remains
    // authoritative for the shared cache; weekly is what account rows display.
    const { monthlyResponse, monthlyPayload, weeklyPayload } = await fetchGrokBillingPayloads(
      baseUrl,
      headers,
      GROK_BILLING_TIMEOUT_MS,
    );

    if (!monthlyResponse.ok) {
      // Keep browser-facing errors free of raw upstream bodies (may contain sensitive detail).
      if (monthlyResponse.status === 401 || monthlyResponse.status === 403) {
        return errorResult(true, "Grok CLI token invalid or expired. Re-login via Models → Grok CLI / xAI.");
      }
      return errorResult(true, `xAI billing API error (HTTP ${monthlyResponse.status}). Please retry later.`);
    }

    let monthly: GrokMonthlyUsage;
    try {
      monthly = parseMonthlyUsage(monthlyPayload);
    } catch (parseError) {
      return errorResult(true, `Invalid billing response: ${errorMessage(parseError)}`);
    }

    const weekly = parseWeeklyUsage(weeklyPayload);
    return {
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
  } catch (fetchError) {
    if (fetchError instanceof GrokBillingPayloadError) {
      return errorResult(true, `Invalid billing response: ${fetchError.message}`);
    }
    if (typeof (fetchError as { name?: string }).name === "string" &&
        (fetchError as { name: string }).name === "TimeoutError") {
      return errorResult(true, "xAI billing 请求超时，请检查网络连接后重试。");
    }
    return errorResult(true, `Network error: ${errorMessage(fetchError)}`);
  }
}

/**
 * 获取 Grok CLI access token。
 * 1. GROK_CLI_OAUTH_TOKEN 环境变量
 * 2. auth.json 中 grok-cli 或 Pi 内置 xai 的 OAuth credential
 * Billing intentionally does not initialize AgentSession or extension registries;
 * cache/usage APIs must remain independent from active conversation load.
 */
async function resolveToken(): Promise<{ token: string; envBypass: boolean; providerId: GrokAuthProviderId } | null> {
  if (process.env.GROK_CLI_OAUTH_TOKEN) {
    return { token: process.env.GROK_CLI_OAUTH_TOKEN, envBypass: true, providerId: GROK_PROVIDER_ID };
  }

  let staleCredential: { token: string; envBypass: false; providerId: GrokAuthProviderId } | null = null;

  // Pi's built-in xAI OAuth stores the subscription credential under `xai`,
  // while pi-grok-cli stores the equivalent credential under `grok-cli`.
  // Read both keys before asking a registry so the provider identity is retained
  // when an expired credential has to be refreshed.
  for (const providerId of GROK_AUTH_PROVIDER_IDS) {
    const stored = readStoredCredential(providerId);
    if (isGrokStoredOAuthCredential(stored)) {
      if (isTokenFresh(stored.expires)) {
        return { token: stored.access, envBypass: false, providerId };
      }

      const refreshed = await refreshStoredGrokCredential(providerId, stored);
      if (refreshed?.access) return { token: refreshed.access, envBypass: false, providerId };

      // Keep a stale token only as a last resort after checking the other
      // supported provider key for a fresh credential.
      staleCredential ??= { token: stored.access, envBypass: false, providerId };
      continue;
    }

    // An API key is meaningful for the extension provider, but xAI subscription
    // billing requires OAuth and must not mistake XAI_API_KEY for a login.
    if (providerId === GROK_PROVIDER_ID && stored?.type === "api_key") {
      const key = typeof (stored as { key?: unknown }).key === "string"
        ? (stored as { key: string }).key.trim()
        : "";
      if (key) return { token: key, envBypass: false, providerId };
    }
  }

  return staleCredential;
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
    error: "Grok 未登录。请先在 Models → xAI 或 Grok CLI 完成 OAuth 登录，或设置 GROK_CLI_OAUTH_TOKEN 环境变量。",
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
 * 获取当前活跃 Grok / xAI 订阅用量。
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

  // Refresh mode: live billing fetch for the active credential.
  const resolved = await resolveToken();
  if (!resolved) return notConfiguredResult();

  const { token, envBypass, providerId } = resolved;
  const result = await fetchBillingUsage(token, resolveBaseUrl(providerId), envBypass);

  if (result.success && result.monthly) {
    writeCache(result);
    // Keep the active saved-account weekly pie in sync with the shared usage panel.
    await cacheWeeklyUsageToActiveAccount(providerId, result);
  }

  return result;
}

/**
 * 获取指定已保存 Grok / xAI 账号的用量。
 * cache 模式只读账号 metadata 中的 weekly quotaCache；refresh 会实时查询并回写。
 */
export async function getGrokAccountUsage(
  provider: string,
  accountId: string,
  mode: "cache" | "refresh" = "refresh",
): Promise<GrokUsageResult> {
  if (!isGrokAuthProviderId(provider)) {
    return errorResult(false, `Unsupported Grok account provider: ${provider}`);
  }

  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    return errorResult(false, "accountId is required");
  }

  if (mode === "cache") {
    try {
      const list = await listOAuthAccounts(provider);
      const account = list.accounts.find((entry) => entry.accountId === normalizedAccountId);
      if (!account) {
        return errorResult(false, "Saved Grok account not found");
      }
      return accountUsageFromQuotaCache(provider, account.quotaCache);
    } catch (error) {
      return errorResult(false, error instanceof Error ? error.message : String(error));
    }
  }

  const resolved = await resolveAccountToken(provider, normalizedAccountId);
  if ("error" in resolved) {
    const failed = errorResult(true, resolved.error);
    await cacheWeeklyUsageToAccount(provider, normalizedAccountId, failed);
    return failed;
  }

  const result = await fetchBillingUsage(resolved.token, resolved.baseUrl, false);
  await cacheWeeklyUsageToAccount(provider, normalizedAccountId, result);

  // Active-account live refresh also keeps the shared top-bar/Models cache current.
  try {
    const list = await listOAuthAccounts(provider);
    if (result.success && result.monthly && list.activeAccountId === normalizedAccountId) {
      writeCache(result);
    }
  } catch {
    // Ignore shared-cache sync failures for inactive account queries.
  }

  return result;
}
