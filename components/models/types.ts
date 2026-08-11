import type { CodexResetCreditDisplay } from "@/lib/quota-display";

export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

export interface OAuthAccountQuotaCache {
  success: boolean;
  tiers: QuotaTier[];
  error: string | null;
  queriedAt: number | null;
  resetCreditsAvailableCount: number | null;
  resetCredits: CodexResetCreditDisplay[];
  resetCreditsError: string | null;
}

export interface OAuthAccountSummary {
  accountId: string;
  label?: string;
  extraInfo?: string;
  quotaCache?: OAuthAccountQuotaCache;
  displayName: string;
  maskedAccountId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivatedAt: string | null;
}

export interface OAuthAccountsResponse {
  provider: string;
  activeAccountId: string | null;
  accounts: OAuthAccountSummary[];
}

export interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
}


export type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success"; message?: string }
  | { phase: "error"; message: string };

export type CredentialStatus = "valid" | "expired" | "not_found" | "parse_error";

export interface QuotaTier {
  name: string;
  utilization: number;
  resetsAt: string | null;
}

export interface SubscriptionQuota {
  tool: string;
  credentialStatus: CredentialStatus;
  credentialMessage: string | null;
  success: boolean;
  tiers: QuotaTier[];
  error: string | null;
  queriedAt: number | null;
  resetCreditsAvailableCount: number | null;
  resetCredits: CodexResetCreditDisplay[];
  resetCreditsError: string | null;
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
  /**
   * WebUI-only: rewrite empty post-tool "completed" assistant responses into
   * Pi auto-retry errors. Stored in models.json; Pi ignores unknown fields.
   */
  emptyCompletedRetry?: boolean;
}

export interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

export type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

export interface DiscoveredModelCandidate {
  id: string;
  name?: string;
  ownedBy?: string;
}

export type DiscoverModelsResponse =
  | { ok: true; url: string; triedUrls: string[]; models: DiscoveredModelCandidate[] }
  | { ok: false; error: string; triedUrls?: string[]; status?: number; responseText?: string };

export type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; url: string; triedUrls: string[]; models: DiscoveredModelCandidate[]; searchQuery: string; collapsedGroups: Record<string, boolean>; message?: string }
  | { phase: "error"; message: string; triedUrls?: string[]; status?: number; responseText?: string };

export interface CachedPricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow?: number;
}

export interface CachedPricingCandidate {
  provider: string;
  model: string;
  entry: CachedPricingEntry;
}

export type CachedPricingLookup =
  | { match: "exact" | "unique-id"; entry: CachedPricingEntry }
  | { match: "ambiguous"; candidates: CachedPricingCandidate[] }
  | { match: "no-match" };

export interface CachedPricingLookupResponse {
  ok: boolean;
  lookup?: CachedPricingLookup;
}

export interface DiscoveredModelGroup {
  owner: string;
  models: DiscoveredModelCandidate[];
}

export interface DiscoveredModelChangeResult {
  ok: boolean;
  message?: string;
}

export type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };
