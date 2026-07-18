/**
 * Auth/model helpers for pi-coding-agent 0.80.10+.
 *
 * AuthStorage is no longer a public export. Prefer ModelRuntime for login,
 * logout, catalog, and request auth. Use FileCredentialStore only when the
 * Web UI must read/write auth.json credentials directly (multi-account).
 */
import {
  ModelRegistry,
  ModelRuntime,
  createAgentSessionServices,
  getAgentDir,
  readStoredCredential,
  type AgentSessionServices,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AuthInteraction,
  AuthResult,
  Credential,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "@/lib/file-credential-store";

export type { Credential, OAuthCredential, AuthInteraction, AuthResult };
export { FileCredentialStore, InMemoryCredentialStore, ModelRegistry, ModelRuntime, readStoredCredential };

export type ResolvedRequestAuth =
  | {
    ok: true;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }
  | {
    ok: false;
    error: string;
  };

export interface OAuthProviderSummary {
  id: string;
  name: string;
  usesCallbackServer: boolean;
}

/** Create the canonical ModelRuntime (default auth.json + models.json). */
export async function createDefaultModelRuntime(
  options: CreateModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  return ModelRuntime.create(options);
}

/** Create a ModelRegistry compatibility facade over a runtime. */
export async function createModelRegistry(
  options: CreateModelRuntimeOptions = {},
): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  const runtime = await ModelRuntime.create(options);
  const registry = new ModelRegistry(runtime);
  await registry.refresh().catch(() => undefined);
  return { runtime, registry };
}

/** Wrap an existing runtime with the sync ModelRegistry facade. */
export function modelRegistryFromRuntime(runtime: ModelRuntime): ModelRegistry {
  return new ModelRegistry(runtime);
}

/** Create cwd-bound services and a ModelRegistry facade. */
export async function createSessionServicesWithRegistry(
  cwd: string,
  agentDir = getAgentDir(),
): Promise<{ services: AgentSessionServices; registry: ModelRegistry }> {
  const services = await createAgentSessionServices({ cwd, agentDir });
  const registry = modelRegistryFromRuntime(services.modelRuntime);
  return { services, registry };
}

/** Map ModelRuntime.getAuth() into the previous getApiKeyAndHeaders shape. */
export async function getApiKeyAndHeaders(
  runtime: ModelRuntime,
  model: { provider: string; id: string } | Parameters<ModelRuntime["getAuth"]>[0],
): Promise<ResolvedRequestAuth> {
  try {
    const auth = await runtime.getAuth(model as never);
    if (!auth?.auth?.apiKey) {
      return { ok: false, error: "No API key found for model" };
    }
    return {
      ok: true,
      apiKey: auth.auth.apiKey,
      headers: auth.auth.headers as Record<string, string> | undefined,
      env: auth.env as Record<string, string> | undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Providers that expose OAuth login through ModelRuntime. */
export function listOAuthProviders(runtime: ModelRuntime): OAuthProviderSummary[] {
  return runtime
    .getProviders()
    .filter((provider) => Boolean(provider.auth?.oauth))
    .map((provider) => ({
      id: provider.id,
      name: provider.auth?.oauth?.name ?? provider.name,
      // 0.80.10 no longer surfaces callback-server metadata on providers.
      usesCallbackServer: provider.id === "openai-codex",
    }));
}

export function isOAuthProvider(runtime: ModelRuntime, providerId: string): boolean {
  return Boolean(runtime.getProvider(providerId)?.auth?.oauth);
}

export function hasStoredCredential(providerId: string): boolean {
  return readStoredCredential(providerId) !== undefined;
}

/** True when the active auth for this provider is an OAuth credential (not API key/env). */
export function isProviderUsingOAuth(runtime: ModelRuntime, providerId: string): boolean {
  return runtime.isUsingOAuth(providerId);
}

/**
 * API-key UI "configured" check.
 * Dual-auth providers (e.g. xai) store OAuth under the same provider id; that must
 * not make the API-key sidebar entry appear active.
 */
export function isApiKeyAuthConfigured(runtime: ModelRuntime, providerId: string): boolean {
  if (runtime.isUsingOAuth(providerId)) return false;
  return runtime.getProviderAuthStatus(providerId).configured;
}

export async function setStoredApiKey(providerId: string, apiKey: string): Promise<void> {
  // Match the previous AuthStorage.set({ type: "api_key", key }) behavior.
  // Direct store write avoids multi-step provider login prompts that the Web UI
  // API-key route does not support.
  const store = FileCredentialStore.create();
  await store.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
}

export async function removeStoredCredential(providerId: string): Promise<void> {
  const runtime = await ModelRuntime.create();
  await runtime.logout(providerId);
}

export async function writeStoredCredential(
  providerId: string,
  credential: Credential,
): Promise<void> {
  const store = FileCredentialStore.create();
  await store.modify(providerId, async () => credential);
}

export async function getProviderAccessToken(providerId: string): Promise<string | undefined> {
  const runtime = await ModelRuntime.create();
  const auth = await runtime.getAuth(providerId);
  return auth?.auth?.apiKey;
}

export function isOAuthCredential(value: unknown): value is OAuthCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "oauth"
    && typeof record.access === "string"
    && typeof record.refresh === "string"
    && typeof record.expires === "number";
}
