"use client";

import { useI18n } from "@/components/I18nProvider";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { DeepSeekBalanceResult } from "@/lib/deepseek-balance";
import type { GrokUsageResult } from "@/lib/grok-usage";
import { ACCOUNT_JSON_CONVERTERS, RAW_ACCOUNT_JSON_EXAMPLE, validateRawOAuthCredentialImport, type OAuthAccountImportMode } from "@/lib/oauth-account-converters";
import { earliestResetCreditExpiration, formatQuotaQueriedAt, formatResetCountdown, knownQuotaTiers, quotaColor, QUOTA_TIER_LABELS, type CodexResetCreditDisplay } from "@/lib/quota-display";
import { ChatGptWarmupDialog } from "./ChatGptWarmupDialog";
import { ModelPricingCatalog } from "./ModelPricingCatalog";
// Color icons (have their own fill colors — no background needed)
import AnthropicIcon from "@lobehub/icons/es/Anthropic/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import GoogleColorIcon from "@lobehub/icons/es/Google/components/Color";
import DeepSeekColorIcon from "@lobehub/icons/es/DeepSeek/components/Color";
import GroqIcon from "@lobehub/icons/es/Groq/components/Mono";
import MistralColorIcon from "@lobehub/icons/es/Mistral/components/Color";
import MoonshotIcon from "@lobehub/icons/es/Moonshot/components/Mono";
import MinimaxColorIcon from "@lobehub/icons/es/Minimax/components/Color";
import FireworksColorIcon from "@lobehub/icons/es/Fireworks/components/Color";
import HuggingFaceColorIcon from "@lobehub/icons/es/HuggingFace/components/Color";
import CerebrasColorIcon from "@lobehub/icons/es/Cerebras/components/Color";
import OpenRouterIcon from "@lobehub/icons/es/OpenRouter/components/Mono";
import XAIIcon from "@lobehub/icons/es/XAI/components/Mono";
import CloudflareColorIcon from "@lobehub/icons/es/Cloudflare/components/Color";
import VercelIcon from "@lobehub/icons/es/Vercel/components/Mono";
import GithubCopilotIcon from "@lobehub/icons/es/GithubCopilot/components/Mono";
import AwsColorIcon from "@lobehub/icons/es/Aws/components/Color";
import AzureColorIcon from "@lobehub/icons/es/Azure/components/Color";
import KimiColorIcon from "@lobehub/icons/es/Kimi/components/Color";
import QwenColorIcon from "@lobehub/icons/es/Qwen/components/Color";
import ZhipuColorIcon from "@lobehub/icons/es/Zhipu/components/Color";
import CohereColorIcon from "@lobehub/icons/es/Cohere/components/Color";
import PerplexityColorIcon from "@lobehub/icons/es/Perplexity/components/Color";
import TogetherColorIcon from "@lobehub/icons/es/Together/components/Color";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import AntGroupColorIcon from "@lobehub/icons/es/AntGroup/components/Color";
import NvidiaColorIcon from "@lobehub/icons/es/Nvidia/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import XiaomiMiMoIcon from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import ZAIIcon from "@lobehub/icons/es/ZAI/components/Mono";

type IconComponent = React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>;

// hasColor=true → Color icon (self-colored SVG, no wrapper)
// hasColor=false → Mono icon (rendered with currentColor, inherits theme text color)
const PROVIDER_ICONS: Record<string, { Icon: IconComponent; hasColor: boolean }> = {
  "anthropic":              { Icon: AnthropicIcon,        hasColor: false },
  "openai":                 { Icon: OpenAIIcon,           hasColor: false },
  "openai-codex":           { Icon: OpenAIIcon,           hasColor: false },
  "google":                 { Icon: GoogleColorIcon,      hasColor: true },
  "google-vertex":          { Icon: GoogleColorIcon,      hasColor: true },
  "ant-ling":               { Icon: AntGroupColorIcon,    hasColor: true },
  "deepseek":               { Icon: DeepSeekColorIcon,    hasColor: true },
  "groq":                   { Icon: GroqIcon,             hasColor: false },
  "mistral":                { Icon: MistralColorIcon,     hasColor: true },
  "moonshotai":             { Icon: MoonshotIcon,         hasColor: false },
  "moonshotai-cn":          { Icon: MoonshotIcon,         hasColor: false },
  "moonshot":               { Icon: MoonshotIcon,         hasColor: false },
  "minimax":                { Icon: MinimaxColorIcon,     hasColor: true },
  "minimax-cn":             { Icon: MinimaxColorIcon,     hasColor: true },
  "fireworks":              { Icon: FireworksColorIcon,   hasColor: true },
  "huggingface":            { Icon: HuggingFaceColorIcon, hasColor: true },
  "cerebras":               { Icon: CerebrasColorIcon,    hasColor: true },
  "openrouter":             { Icon: OpenRouterIcon,       hasColor: false },
  "xai":                    { Icon: XAIIcon,              hasColor: false },
  "cloudflare-ai-gateway":  { Icon: CloudflareColorIcon,  hasColor: true },
  "cloudflare-workers-ai":  { Icon: CloudflareColorIcon,  hasColor: true },
  "vercel-ai-gateway":      { Icon: VercelIcon,           hasColor: false },
  "github-copilot":         { Icon: GithubCopilotIcon,    hasColor: false },
  "amazon-bedrock":         { Icon: AwsColorIcon,         hasColor: true },
  "azure-openai-responses": { Icon: AzureColorIcon,       hasColor: true },
  "kimi-coding":            { Icon: KimiColorIcon,        hasColor: true },
  "nvidia":                 { Icon: NvidiaColorIcon,      hasColor: true },
  "opencode":               { Icon: OpenCodeIcon,         hasColor: false },
  "opencode-go":            { Icon: OpenCodeIcon,         hasColor: false },
  "qwen":                   { Icon: QwenColorIcon,        hasColor: true },
  "xiaomi":                 { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-ams":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-cn":   { Icon: XiaomiMiMoIcon,       hasColor: false },
  "xiaomi-token-plan-sgp":  { Icon: XiaomiMiMoIcon,       hasColor: false },
  "zai":                    { Icon: ZAIIcon,              hasColor: false },
  "zai-coding-cn":          { Icon: ZAIIcon,              hasColor: false },
  "zhipu":                  { Icon: ZhipuColorIcon,       hasColor: true },
  "cohere":                 { Icon: CohereColorIcon,      hasColor: true },
  "perplexity":             { Icon: PerplexityColorIcon,  hasColor: true },
  "together":               { Icon: TogetherColorIcon,    hasColor: true },
  "grok":                   { Icon: GrokIcon,             hasColor: false },
  "grok-cli":               { Icon: GrokIcon,             hasColor: false },
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
}

interface OAuthAccountQuotaCache {
  success: boolean;
  tiers: QuotaTier[];
  error: string | null;
  queriedAt: number | null;
  resetCreditsAvailableCount: number | null;
  resetCredits: CodexResetCreditDisplay[];
  resetCreditsError: string | null;
}

interface OAuthAccountSummary {
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

interface OAuthAccountsResponse {
  provider: string;
  activeAccountId: string | null;
  accounts: OAuthAccountSummary[];
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
}


type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success"; message?: string }
  | { phase: "error"; message: string };

type CredentialStatus = "valid" | "expired" | "not_found" | "parse_error";

interface QuotaTier {
  name: string;
  utilization: number;
  resetsAt: string | null;
}

interface SubscriptionQuota {
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

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

interface DiscoveredModelCandidate {
  id: string;
  name?: string;
  ownedBy?: string;
}

type DiscoverModelsResponse =
  | { ok: true; url: string; triedUrls: string[]; models: DiscoveredModelCandidate[] }
  | { ok: false; error: string; triedUrls?: string[]; status?: number; responseText?: string };

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; url: string; triedUrls: string[]; models: DiscoveredModelCandidate[]; searchQuery: string; collapsedGroups: Record<string, boolean>; message?: string }
  | { phase: "error"; message: string; triedUrls?: string[]; status?: number; responseText?: string };

interface CachedPricingEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow?: number;
}

interface CachedPricingCandidate {
  provider: string;
  model: string;
  entry: CachedPricingEntry;
}

type CachedPricingLookup =
  | { match: "exact" | "unique-id"; entry: CachedPricingEntry }
  | { match: "ambiguous"; candidates: CachedPricingCandidate[] }
  | { match: "no-match" };

interface CachedPricingLookupResponse {
  ok: boolean;
  lookup?: CachedPricingLookup;
}

interface DiscoveredModelGroup {
  owner: string;
  models: DiscoveredModelCandidate[];
}

interface DiscoveredModelChangeResult {
  ok: boolean;
  message?: string;
}

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
const DEFAULT_MAX_TOKENS = 128000;
const discoveredModelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide API key" : "Show API key"}
        title={visible ? "Hide API key" : "Show API key"}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}>
      {!required && <option value="">— inherit / none —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

function getDiscoveredModelOwner(candidate: DiscoveredModelCandidate): string {
  const owner = candidate.ownedBy?.trim();
  return owner || "unknown";
}

function filterDiscoveredModels(models: DiscoveredModelCandidate[], query: string): DiscoveredModelCandidate[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((candidate) => {
    const owner = getDiscoveredModelOwner(candidate).toLowerCase();
    return candidate.id.toLowerCase().includes(normalized)
      || owner.includes(normalized)
      || (candidate.name?.toLowerCase().includes(normalized) ?? false);
  });
}

function groupDiscoveredModels(models: DiscoveredModelCandidate[]): DiscoveredModelGroup[] {
  const groups = new Map<string, DiscoveredModelCandidate[]>();
  for (const candidate of models) {
    const owner = getDiscoveredModelOwner(candidate);
    groups.set(owner, [...(groups.get(owner) ?? []), candidate]);
  }
  return [...groups.entries()]
    .map(([owner, items]) => ({
      owner,
      models: items.sort((a, b) => discoveredModelCollator.compare(a.id, b.id)),
    }))
    .sort((a, b) => discoveredModelCollator.compare(a.owner, b.owner));
}

async function lookupCachedPricing(providerName: string, modelId: string): Promise<CachedPricingLookup | null> {
  const res = await fetch(`/api/model-pricing?provider=${encodeURIComponent(providerName)}&model=${encodeURIComponent(modelId)}`);
  const data = await res.json() as CachedPricingLookupResponse;
  return res.ok && data.ok && data.lookup ? data.lookup : null;
}

function getMissingPricingFields(model: ModelEntry, entry: CachedPricingEntry): Partial<CachedPricingEntry> {
  const currentCost = model.cost ?? {};
  const fields: Partial<CachedPricingEntry> = {};
  if (currentCost.input === undefined) fields.input = entry.input;
  if (currentCost.output === undefined) fields.output = entry.output;
  if (currentCost.cacheRead === undefined) fields.cacheRead = entry.cacheRead;
  if (currentCost.cacheWrite === undefined) fields.cacheWrite = entry.cacheWrite;
  if (model.contextWindow === undefined && entry.contextWindow !== undefined) fields.contextWindow = entry.contextWindow;
  return fields;
}

function mergeMissingPricing(model: ModelEntry, entry: CachedPricingEntry): ModelEntry {
  const missingFields = getMissingPricingFields(model, entry);
  const { contextWindow, ...missingCostFields } = missingFields;
  return {
    ...model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    cost: { ...(model.cost ?? {}), ...missingCostFields },
  };
}

interface AutoAppliedPricing {
  provider: string;
  modelId: string;
  fields: Partial<CachedPricingEntry>;
}

type PricingLookupState =
  | { phase: "idle" | "loading" | "no-match" }
  | { phase: "matched"; match: "exact" | "unique-id" | "manual" }
  | { phase: "ambiguous"; candidates: CachedPricingCandidate[] };

const PRICING_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const PRICING_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "contextWindow"] as const;

function formatPricingCandidateValue(field: typeof PRICING_FIELDS[number], entry: CachedPricingEntry): string {
  if (field === "contextWindow") return entry.contextWindow?.toLocaleString() ?? "—";
  return `$${entry[field]}`;
}

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({ name, provider, onChange, onRename, onDelete, onAddDiscoveredModel, onRemoveDiscoveredModel }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
  onAddDiscoveredModel: (candidate: DiscoveredModelCandidate) => DiscoveredModelChangeResult;
  onRemoveDiscoveredModel: (modelId: string) => DiscoveredModelChangeResult;
}) {
  const [editingName, setEditingName] = useState(name);
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  useEffect(() => {
    setDiscoveryState({ phase: "idle" });
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const providerModelIds = new Set((provider.models ?? []).map((model) => model.id).filter(Boolean));
  const isOpenAICompatible = provider.api === "openai-completions" || provider.api === "openai-responses";
  const discoveryDisabledReason = !isOpenAICompatible
    ? "Model discovery is available for OpenAI-compatible providers only."
    : !provider.baseUrl?.trim()
      ? "Set a Base URL before fetching models."
      : !provider.apiKey?.trim()
        ? "Set an API key before fetching models."
        : null;
  const discoveryModels = discoveryState.phase === "success" ? discoveryState.models : [];
  const discoverySearchQuery = discoveryState.phase === "success" ? discoveryState.searchQuery : "";
  const filteredDiscoveryModels = discoveryState.phase === "success" ? filterDiscoveredModels(discoveryState.models, discoverySearchQuery) : [];
  const discoveryGroups = groupDiscoveredModels(filteredDiscoveryModels);

  const formatDiscoveryFailure = useCallback((data: DiscoverModelsResponse, status: number): string => {
    if (data.ok) return "";
    return [
      data.error || `HTTP ${status}`,
      data.status !== undefined ? `remote HTTP ${data.status}` : null,
      data.triedUrls?.length ? `tried ${data.triedUrls.join(", ")}` : null,
      data.responseText ? `response: ${data.responseText}` : null,
    ].filter(Boolean).join(" · ");
  }, []);

  const handleDiscoverModels = useCallback(async () => {
    if (discoveryState.phase === "loading") return;
    if (discoveryDisabledReason) {
      setDiscoveryState({ phase: "error", message: discoveryDisabledReason });
      return;
    }

    setDiscoveryState({ phase: "loading" });
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider }),
      });
      const data = await res.json().catch((): DiscoverModelsResponse => ({ ok: false, error: `HTTP ${res.status}` })) as DiscoverModelsResponse;
      if (!res.ok || !data.ok) {
        setDiscoveryState({
          phase: "error",
          message: formatDiscoveryFailure(data, res.status),
          ...(!data.ok && data.triedUrls ? { triedUrls: data.triedUrls } : {}),
          ...(!data.ok && data.status !== undefined ? { status: data.status } : {}),
          ...(!data.ok && data.responseText ? { responseText: data.responseText } : {}),
        });
        return;
      }

      setDiscoveryState({
        phase: "success",
        url: data.url,
        triedUrls: data.triedUrls,
        models: data.models,
        searchQuery: "",
        collapsedGroups: {},
        message: data.models.length === 0 ? "Fetched the model list, but no models were returned." : undefined,
      });
    } catch (error) {
      setDiscoveryState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [discoveryDisabledReason, discoveryState.phase, formatDiscoveryFailure, name, provider]);

  const handleAddDiscoveredModel = useCallback((candidate: DiscoveredModelCandidate) => {
    if (discoveryState.phase !== "success") return;
    const result = onAddDiscoveredModel(candidate);
    setDiscoveryState((current) => current.phase === "success" ? {
      ...current,
      message: result.message ?? (result.ok ? `Added ${candidate.id}. Click Save to persist it.` : "Could not add the selected model."),
    } : current);
  }, [discoveryState.phase, onAddDiscoveredModel]);

  const handleRemoveDiscoveredModel = useCallback((modelId: string) => {
    if (discoveryState.phase !== "success") return;
    const result = onRemoveDiscoveredModel(modelId);
    setDiscoveryState({
      ...discoveryState,
      message: result.message ?? (result.ok ? `Removed ${modelId}. Click Save to persist it.` : "Could not remove the selected model."),
    });
  }, [discoveryState, onRemoveDiscoveredModel]);

  const setDiscoverySearchQuery = useCallback((query: string) => {
    setDiscoveryState((prev) => prev.phase === "success" ? { ...prev, searchQuery: query, message: undefined } : prev);
  }, []);

  const toggleDiscoveryGroup = useCallback((owner: string) => {
    setDiscoveryState((prev) => prev.phase === "success"
      ? { ...prev, collapsedGroups: { ...prev.collapsedGroups, [owner]: !prev.collapsedGroups[owner] } }
      : prev);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Provider</SectionTitle>
        <button onClick={onDelete}
          style={{ padding: "3px 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 11 }}>
          Delete
        </button>
      </div>

      <Field label="Provider name">
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: 11, alignSelf: "flex-start" }}>
            Rename
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Prefix with <code style={{ fontFamily: "var(--font-mono)" }}>!</code> to run a shell command, or use an env var name
        </span>
      </Field>

      <Field label="API">
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>

      <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <SectionTitle>Discover models</SectionTitle>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Fetches the provider&apos;s OpenAI-compatible model list. Additions stay staged until Save.</span>
          </div>
          <button
            type="button"
            onClick={handleDiscoverModels}
            disabled={Boolean(discoveryDisabledReason) || discoveryState.phase === "loading"}
            style={{ padding: "5px 11px", background: !discoveryDisabledReason && discoveryState.phase !== "loading" ? "var(--accent)" : "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: !discoveryDisabledReason && discoveryState.phase !== "loading" ? "#fff" : "var(--text-dim)", cursor: !discoveryDisabledReason && discoveryState.phase !== "loading" ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600, flexShrink: 0 }}
          >
            {discoveryState.phase === "loading" ? "Fetching…" : "Fetch models"}
          </button>
        </div>

        {discoveryDisabledReason && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>{discoveryDisabledReason}</div>
        )}

        {discoveryState.phase === "loading" && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>Fetching remote model list…</div>
        )}

        {discoveryState.phase === "error" && (
          <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{discoveryState.message}</div>
        )}

        {discoveryState.phase === "success" && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {discoveryModels.length === 0 ? "No models returned." : `Fetched ${discoveryModels.length} model${discoveryModels.length === 1 ? "" : "s"} from ${discoveryState.url}`}
            </div>
            {discoveryModels.length > 0 && (
              <>
                <Field label="Search models">
                  <TextInput
                    value={discoverySearchQuery}
                    onChange={setDiscoverySearchQuery}
                    placeholder="Model ID, name, or owner"
                    mono
                  />
                </Field>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  Showing {filteredDiscoveryModels.length} of {discoveryModels.length} model{discoveryModels.length === 1 ? "" : "s"}
                </div>
                {discoveryGroups.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No models match the search.</div>
                ) : (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", background: "var(--bg)", maxHeight: 360, overflowY: "auto" }}>
                    {discoveryGroups.map((group) => {
                      const collapsed = discoveryState.collapsedGroups[group.owner] ?? false;
                      return (
                        <div key={group.owner}>
                          <button
                            type="button"
                            onClick={() => toggleDiscoveryGroup(group.owner)}
                            style={{ width: "100%", padding: "8px 10px", border: "none", borderBottom: collapsed ? "1px solid var(--border)" : "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left" }}
                          >
                            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                              <span style={{ color: "var(--accent)", fontSize: 14, lineHeight: 1 }}>{collapsed ? "›" : "⌄"}</span>
                              <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.owner}</span>
                            </span>
                            <span style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 999, padding: "2px 7px", flexShrink: 0 }}>{group.models.length} model{group.models.length === 1 ? "" : "s"}</span>
                          </button>
                          {!collapsed && group.models.map((candidate) => {
                            const added = providerModelIds.has(candidate.id);
                            return (
                              <div key={`${group.owner}:${candidate.id}`} style={{ display: "grid", gridTemplateColumns: "1fr 34px", gap: 10, alignItems: "center", padding: "9px 10px", borderBottom: "1px solid var(--border)" }}>
                                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                                  <span title={candidate.id} style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{candidate.id}</span>
                                  <span style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    owned by {group.owner}{candidate.name && candidate.name !== candidate.id ? ` · ${candidate.name}` : ""}{added ? " · added" : ""}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => added ? handleRemoveDiscoveredModel(candidate.id) : handleAddDiscoveredModel(candidate)}
                                  aria-label={added ? `Remove ${candidate.id}` : `Add ${candidate.id}`}
                                  title={added ? "Remove from staged models" : "Add to staged models"}
                                  style={{ width: 30, height: 30, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: added ? "#fb7185" : "#34d399", cursor: "pointer", fontSize: 17, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
                                >
                                  {added ? "-" : "+"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            {discoveryState.message && (
              <div style={{ fontSize: 12, color: discoveryState.message.includes("already exists") ? "#fb923c" : "var(--text-dim)", lineHeight: 1.5 }}>{discoveryState.message}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                Default
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                Disabled
              </button>
            </div>

            {/* Custom button + input fused */}
            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color 0.1s" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                Custom
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

function ModelDetail({
  providerName,
  provider,
  model,
  autoAppliedPricing,
  onChange,
  onAutoAppliedPricingChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  autoAppliedPricing: AutoAppliedPricing | null;
  onChange: (m: ModelEntry) => void;
  onAutoAppliedPricingChange: (pricing: AutoAppliedPricing | null) => void;
  onDelete: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const latestModelRef = useRef(model);
  latestModelRef.current = model;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const autoAppliedPricingRef = useRef(autoAppliedPricing);
  autoAppliedPricingRef.current = autoAppliedPricing;
  const onAutoAppliedPricingChangeRef = useRef(onAutoAppliedPricingChange);
  onAutoAppliedPricingChangeRef.current = onAutoAppliedPricingChange;
  const clearAutoAppliedField = (field: keyof CachedPricingEntry) => {
    const autoApplied = autoAppliedPricingRef.current;
    if (autoApplied?.provider !== providerName || autoApplied.modelId !== model.id.trim()) return;
    const remainingFields = { ...autoApplied.fields };
    delete remainingFields[field];
    const remainingPricing = Object.keys(remainingFields).length > 0
      ? { ...autoApplied, fields: remainingFields }
      : null;
    autoAppliedPricingRef.current = remainingPricing;
    onAutoAppliedPricingChangeRef.current(remainingPricing);
  };
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => {
    if (k === "contextWindow") clearAutoAppliedField("contextWindow");
    onChange({ ...model, [k]: v });
  };
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof CachedPricingEntry, v: string) => {
    clearAutoAppliedField(k);
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
    if (testState.phase === "testing") return "Testing model connection...";
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return ["Connected", ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
    return ["Failed", ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  // Auto-lookup cached pricing when model id changes (debounced)
  const [pricingSource, setPricingSource] = useState<string | null>(null);
  const [pricingLookup, setPricingLookup] = useState<PricingLookupState>({ phase: "idle" });
  const [pricingMatchOpen, setPricingMatchOpen] = useState(false);
  const pricingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pricingLookupSequenceRef = useRef(0);

  const applyPricing = useCallback((entry: CachedPricingEntry, source: string) => {
    const currentModel = latestModelRef.current;
    const fields = getMissingPricingFields(currentModel, entry);
    if (Object.keys(fields).length === 0) return;
    const nextModel = mergeMissingPricing(currentModel, entry);
    const appliedPricing = { provider: providerName, modelId: currentModel.id.trim(), fields };
    autoAppliedPricingRef.current = appliedPricing;
    onAutoAppliedPricingChangeRef.current(appliedPricing);
    latestModelRef.current = nextModel;
    onChangeRef.current(nextModel);
    setPricingSource(source);
  }, [providerName]);

  useEffect(() => {
    setTestState({ phase: "idle" });

    if (pricingTimerRef.current) clearTimeout(pricingTimerRef.current);
    setPricingSource(null);
    setPricingMatchOpen(false);
    setPricingLookup({ phase: "idle" });
    const lookupSequence = ++pricingLookupSequenceRef.current;

    const id = model.id.trim();
    const previousAutoPricing = autoAppliedPricingRef.current;
    if (previousAutoPricing && (previousAutoPricing.provider !== providerName || previousAutoPricing.modelId !== id)) {
      const currentModel = latestModelRef.current;
      const nextCost = { ...(currentModel.cost ?? {}) };
      let nextContextWindow = currentModel.contextWindow;
      let removedAutoPricing = false;
      for (const field of PRICING_FIELDS) {
        const previousValue = previousAutoPricing.fields[field];
        if (previousValue === undefined) continue;
        if (field === "contextWindow") {
          if (nextContextWindow === previousValue) {
            nextContextWindow = undefined;
            removedAutoPricing = true;
          }
        } else if (nextCost[field] === previousValue) {
          delete nextCost[field];
          removedAutoPricing = true;
        }
      }
      autoAppliedPricingRef.current = null;
      onAutoAppliedPricingChangeRef.current(null);
      if (removedAutoPricing) {
        const nextModel = {
          ...currentModel,
          contextWindow: nextContextWindow,
          cost: Object.keys(nextCost).length > 0 ? nextCost : undefined,
        };
        latestModelRef.current = nextModel;
        onChangeRef.current(nextModel);
      }
    }
    if (!id) return;
    setPricingLookup({ phase: "loading" });

    pricingTimerRef.current = setTimeout(async () => {
      try {
        const lookup = await lookupCachedPricing(providerName, id);
        if (!mountedRef.current || pricingLookupSequenceRef.current !== lookupSequence || latestModelRef.current.id.trim() !== id) return;
        if (!lookup) {
          setPricingLookup({ phase: "no-match" });
          return;
        }
        if (lookup.match === "ambiguous") {
          setPricingLookup({ phase: "ambiguous", candidates: lookup.candidates });
          return;
        }
        if (lookup.match === "no-match") {
          setPricingLookup({ phase: "no-match" });
          return;
        }
        setPricingLookup({ phase: "matched", match: lookup.match });
        applyPricing(lookup.entry, lookup.match === "exact" ? `pricing from ${providerName}` : "pricing from pi.dev");
      } catch {
        if (mountedRef.current && pricingLookupSequenceRef.current === lookupSequence && latestModelRef.current.id.trim() === id) {
          setPricingLookup({ phase: "no-match" });
        }
        // Cached pricing is best-effort and must not block model editing.
      }
    }, 600);

    return () => {
      if (pricingTimerRef.current) clearTimeout(pricingTimerRef.current);
    };
  }, [applyPricing, providerName, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  const handleManualPricingSelection = useCallback((candidate: CachedPricingCandidate) => {
    if (latestModelRef.current.id.trim() !== candidate.model) {
      setPricingMatchOpen(false);
      return;
    }
    setPricingLookup({ phase: "matched", match: "manual" });
    applyPricing(candidate.entry, `selected pricing from ${candidate.provider}`);
    setPricingMatchOpen(false);
  }, [applyPricing]);

  return (
    <>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Model</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 24,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <button
            onClick={handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title="Test model connection"
            style={{
              height: 24,
              padding: "0 8px",
              background: testState.phase === "success" ? "#16a34a" : "none",
              border: `1px solid ${testState.phase === "success" ? "#16a34a" : "var(--border)"}`,
              borderRadius: 4,
              color: testState.phase === "success" ? "#fff" : (!model.id.trim() || testState.phase === "testing") ? "var(--text-dim)" : "var(--text-muted)",
              cursor: (!model.id.trim() || testState.phase === "testing") ? "not-allowed" : "pointer",
              fontSize: 11,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              gap: 5,
            }}
          >
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {testState.phase === "testing" ? "Testing…" : testState.phase === "success" ? "OK" : "Test"}
          </button>
          <button onClick={onDelete}
            style={{ height: 24, padding: "0 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: 11, boxSizing: "border-box" }}>
            Remove
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label="Name"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder="Display name" /></Field>
      </div>

      <Field label="API override">
        <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check label="Reasoning / thinking" checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label="Image input" checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
      </div>

      {model.reasoning && (
        <>
          <Check
            label="DeepSeek thinking compat"
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>Thinking level map</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{ fontSize: 10, padding: "2px 7px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}
                >
                  clear all
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor
              value={model.thinkingLevelMap}
              onChange={(v) => set("thinkingLevelMap", v)}
            />
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Context window (tokens)">
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label="Max output tokens">
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <SectionTitle>Cost (per million tokens)</SectionTitle>
          {pricingLookup.phase === "ambiguous" && (
            <button
              type="button"
              onClick={() => setPricingMatchOpen(true)}
              style={{ height: 26, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
            >
              Match pricing ({pricingLookup.candidates.length})
            </button>
          )}
        </div>
        {pricingSource && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, marginBottom: 4 }}>
            Cached pricing applied · source: {pricingSource}
          </div>
        )}
        {!pricingSource && pricingLookup.phase === "ambiguous" && (
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4, marginBottom: 4 }}>
            Multiple providers have pricing for this model. Choose one to apply it.
          </div>
        )}
        <div style={{ marginTop: pricingSource || pricingLookup.phase === "ambiguous" ? 4 : 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {PRICING_COST_FIELDS.map((k) => (
            <Field key={k} label={k}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
    </div>
    {pricingMatchOpen && pricingLookup.phase === "ambiguous" && (
      <PricingMatchDialog
        modelId={model.id.trim()}
        candidates={pricingLookup.candidates}
        onSelect={handleManualPricingSelection}
        onClose={() => setPricingMatchOpen(false)}
      />
    )}
    </>
  );
}

function PricingMatchDialog({
  modelId,
  candidates,
  onSelect,
  onClose,
}: {
  modelId: string;
  candidates: CachedPricingCandidate[];
  onSelect: (candidate: CachedPricingCandidate) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{ width: "min(620px, calc(100vw - 32px))", maxHeight: "min(680px, calc(100dvh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Match pricing</div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{modelId}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close pricing match" style={{ width: 28, height: 28, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ minHeight: 0, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {candidates.map((candidate) => (
            <button
              key={`${candidate.provider}:${candidate.model}`}
              type="button"
              onClick={() => onSelect(candidate)}
              style={{ width: "100%", padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", textAlign: "left", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <span style={{ minWidth: 0, fontSize: 12, fontWeight: 700, overflowWrap: "anywhere" }}>{candidate.provider}</span>
              <span style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8 }}>
                {PRICING_FIELDS.map((field) => (
                  <span key={field} style={{ minWidth: 0, fontSize: 10, color: "var(--text-dim)" }}>
                    <span style={{ display: "block", marginBottom: 2 }}>{field === "contextWindow" ? "context" : field}</span>
                    <span style={{ color: "var(--text)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{formatPricingCandidateValue(field, candidate.entry)}</span>
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

/**
 * 渲染 OAuth 订阅额度查询结果。
 *
 * @param props.quota 当前订阅额度结果。
 * @param props.loading 是否正在刷新额度。
 * @param props.onRefresh 手动刷新额度的回调。
 * @returns 订阅额度展示内容。
 */
function OAuthQuotaView({
  quota,
  loading,
  account,
  resetting,
  onRefresh,
  onReset,
}: {
  quota: SubscriptionQuota | null;
  loading: boolean;
  account: OAuthAccountSummary | null;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}) {
  if (!quota && !loading && !account) return null;

  const displayedQuota = quota?.success ? quota : account?.quotaCache;
  const knownTiers = knownQuotaTiers(displayedQuota?.tiers ?? []);
  const resetCreditsAvailableCount = displayedQuota?.resetCreditsAvailableCount ?? null;
  const resetCredits = displayedQuota?.resetCredits ?? [];
  const resetCreditsError = displayedQuota?.resetCreditsError ?? null;
  const resetExpiresAt = earliestResetCreditExpiration(resetCredits);
  const resetExpiresCountdown = formatResetCountdown(resetExpiresAt);
  const canReset = Boolean(account) && (resetCreditsAvailableCount ?? 0) > 0;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Usage</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {loading ? "Refreshing…" : `Updated ${formatQuotaQueriedAt(displayedQuota?.queriedAt ?? null)}`}
          </span>
        </div>
        <button
          onClick={() => onRefresh()}
          disabled={loading || resetting}
          title="Refresh usage"
          aria-label="Refresh usage"
          style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading || resetting ? "var(--text-dim)" : "var(--text-muted)", cursor: loading || resetting ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
            <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
            <path d="M3 4v8h8" />
            <path d="M21 20v-8h-8" />
          </svg>
        </button>
      </div>

      {account && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: account.active ? "#4ade80" : "var(--border)", flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.maskedAccountId}</span>
            {account.extraInfo && <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
          </div>
          <span style={{ fontSize: 11, color: account.active ? "#4ade80" : "var(--text-dim)", fontWeight: 600, flexShrink: 0 }}>
            {account.active ? "active account" : "temporary view"}
          </span>
        </div>
      )}

      {resetCreditsAvailableCount !== null && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>Reset credits: {resetCreditsAvailableCount}</span>
            <span style={{ fontSize: 10, color: resetCreditsError ? "#fb923c" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {resetCreditsError ? resetCreditsError : resetExpiresCountdown ? `Earliest expires in ${resetExpiresCountdown}` : resetExpiresAt ? `Earliest expires ${new Date(resetExpiresAt).toLocaleDateString()}` : "No credit expiration details"}
            </span>
          </div>
          {canReset && (
            <button
              type="button"
              onClick={() => onReset()}
              disabled={loading || resetting}
              title={resetExpiresCountdown ? `Consumes one reset credit. Earliest expires in ${resetExpiresCountdown}` : "Consumes one Codex reset credit"}
              style={{ padding: "5px 10px", border: "1px solid rgba(34,197,94,0.45)", borderRadius: 5, background: "transparent", color: loading || resetting ? "var(--text-dim)" : "#22c55e", cursor: loading || resetting ? "default" : "pointer", fontSize: 11, fontWeight: 700, flexShrink: 0 }}
            >
              {resetting ? "Resetting…" : "Reset limit"}
            </button>
          )}
        </div>
      )}

      {quota && quota.credentialStatus === "expired" && !quota.success && (
        <div style={{ fontSize: 12, color: "#fb923c", lineHeight: 1.5 }}>{quota.error ?? "Token expired. Please re-login."}</div>
      )}

      {quota && quota.credentialStatus === "parse_error" && (
        <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{quota.error ?? "Failed to read OAuth credentials."}</div>
      )}

      {quota && quota.credentialStatus === "not_found" && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No OAuth credential found.</div>
      )}

      {quota && quota.credentialStatus === "valid" && !quota.success && (
        <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{quota.error ?? "Usage query failed."}</div>
      )}

      {quota?.success && knownTiers.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No quota windows returned.</div>
      )}

      {knownTiers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {knownTiers.map((tier) => {
            const color = quotaColor(tier.utilization);
            const countdown = formatResetCountdown(tier.resetsAt);
            return (
              <div key={tier.name} style={{ display: "grid", gridTemplateColumns: "46px 1fr 84px", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{QUOTA_TIER_LABELS[tier.name]}</span>
                <div style={{ height: 6, borderRadius: 99, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(Math.max(tier.utilization, 0), 100)}%`, background: color }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{Math.round(tier.utilization)}%</span>
                  {countdown && <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{countdown}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GrokUsageView({
  result,
  loading,
  onRefresh,
}: {
  result: GrokUsageResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const monthly = result?.monthly ?? null;
  const monthlyUtilization = monthly?.utilization ?? null;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Usage</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {loading ? "Refreshing…" : result?.queriedAt ? `Updated ${formatQuotaQueriedAt(result.queriedAt)}` : "Not queried yet"}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh Grok CLI usage"
          aria-label="Refresh Grok CLI usage"
          style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading ? "var(--text-dim)" : "var(--text-muted)", cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
            <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
            <path d="M3 4v8h8" />
            <path d="M21 20v-8h-8" />
          </svg>
        </button>
      </div>

      {result?.error && (
        <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{result.error}</div>
      )}

      {monthly ? (
        <div style={{
          display: "grid", gridTemplateColumns: "36px 1fr auto", alignItems: "center", gap: 10,
          padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.08)",
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: `conic-gradient(${quotaColor(monthlyUtilization ?? 0)} ${(monthlyUtilization ?? 0) * 3.6}deg, rgba(148,163,184,0.18) 0deg)`,
            border: "1px solid rgba(148,163,184,0.35)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
          }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--bg-panel)", opacity: 0.92 }} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Monthly</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
              Used: {monthly.used.toLocaleString()} · Limit: {monthly.monthlyLimit.toLocaleString()} · Remaining: {monthly.remaining.toLocaleString()}
              {monthly.billingPeriodEnd && <> · Reset: {new Date(monthly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
            </span>
          </div>
          <span style={{ color: quotaColor(monthlyUtilization ?? 0), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(monthlyUtilization ?? 0)}%
          </span>
        </div>
      ) : !loading && !result?.error && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Click refresh to query Grok CLI billing.
          {!result?.configured && !result?.envBypass && <> Make sure Grok CLI is logged in.</>}
        </div>
      )}

      {result?.weekly && (
        <div style={{
          display: "grid", gridTemplateColumns: "36px 1fr auto", alignItems: "center", gap: 10,
          padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.08)",
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: `conic-gradient(${quotaColor(result.weekly.creditUsagePercent)} ${result.weekly.creditUsagePercent * 3.6}deg, rgba(148,163,184,0.18) 0deg)`,
            border: "1px solid rgba(148,163,184,0.35)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
          }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--bg-panel)", opacity: 0.92 }} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Weekly</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
              {result.weekly.billingPeriodEnd && <>Reset: {new Date(result.weekly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
            </span>
          </div>
          <span style={{ color: quotaColor(result.weekly.creditUsagePercent), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(result.weekly.creditUsagePercent)}%
          </span>
        </div>
      )}

      {result?.envBypass && (
        <div style={{ fontSize: 11, color: "#fb923c" }}>Using GROK_CLI_OAUTH_TOKEN env variable.</div>
      )}
    </div>
  );
}


function accountQuotaResetText(account: OAuthAccountSummary): string {
  const resetCreditsAvailableCount = account.quotaCache?.resetCreditsAvailableCount;
  const resetCreditsText = typeof resetCreditsAvailableCount === "number" ? `Credits ${resetCreditsAvailableCount}` : null;
  const tiers = knownQuotaTiers(account.quotaCache?.tiers ?? []).filter((tier) => tier.resetsAt);
  if (tiers.length === 0) return resetCreditsText ?? (account.quotaCache?.queriedAt ? "No reset time" : "No quota cache");
  const windowsText = tiers.map((tier) => {
    const countdown = formatResetCountdown(tier.resetsAt);
    return `${QUOTA_TIER_LABELS[tier.name]} ${countdown ?? "due"}`;
  }).join(" · ");
  return resetCreditsText ? `${windowsText} · ${resetCreditsText}` : windowsText;
}

function AccountQuotaMiniCharts({ account }: { account: OAuthAccountSummary }) {
  const tiers = knownQuotaTiers(account.quotaCache?.tiers ?? []);
  if (tiers.length === 0) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, verticalAlign: "middle" }}>
      {tiers.map((tier) => {
        const utilization = Math.min(Math.max(tier.utilization, 0), 100);
        const color = quotaColor(utilization);
        const label = QUOTA_TIER_LABELS[tier.name];
        return (
          <span key={tier.name} title={`${label} quota ${Math.round(utilization)}% used`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: 16, height: 16, borderRadius: "50%", background: `conic-gradient(${color} ${utilization * 3.6}deg, var(--bg-panel) 0deg)`, border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--bg)" }} />
            </span>
            <span style={{ fontSize: 9, color: "var(--text-dim)", fontWeight: 600 }}>{label}</span>
          </span>
        );
      })}
    </span>
  );
}

function OAuthAccountsView({
  accounts,
  loading,
  error,
  activatingAccountId,
  savingLabelAccountId,
  savingExtraInfoAccountId,
  refreshingQuotaAccountId,
  quotaResetting,
  deletingAccountId,
  selectedAccountId,
  onRefresh,
  onSelect,
  onActivate,
  onEditLabel,
  onEditExtraInfo,
  onRefreshQuota,
  onDelete,
  onWarmup,
}: {
  accounts: OAuthAccountSummary[];
  loading: boolean;
  error: string | null;
  activatingAccountId: string | null;
  savingLabelAccountId: string | null;
  savingExtraInfoAccountId: string | null;
  refreshingQuotaAccountId: string | null;
  quotaResetting: boolean;
  deletingAccountId: string | null;
  selectedAccountId: string | null;
  onRefresh: () => void;
  onSelect: (account: OAuthAccountSummary) => void;
  onActivate: (accountId: string) => void;
  onEditLabel: (account: OAuthAccountSummary) => void;
  onEditExtraInfo: (account: OAuthAccountSummary) => void;
  onRefreshQuota: (account: OAuthAccountSummary) => void;
  onDelete: (account: OAuthAccountSummary) => void;
  onWarmup: () => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Accounts</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{loading ? "Loading…" : `${accounts.length} saved`}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            onClick={onWarmup}
            disabled={loading || accounts.length === 0}
            style={{ padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading || accounts.length === 0 ? "var(--text-dim)" : "var(--accent)", cursor: loading || accounts.length === 0 ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700 }}
          >
            Warm up
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh accounts"
            aria-label="Refresh accounts"
            style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading ? "var(--text-dim)" : "var(--text-muted)", cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
              <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
              <path d="M3 4v8h8" />
              <path d="M21 20v-8h-8" />
            </svg>
          </button>
        </div>
      </div>

      {error && <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{error}</div>}
      {!loading && !error && accounts.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No saved accounts yet.</div>
      )}

      {accounts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map((account) => {
            const quotaRefreshing = refreshingQuotaAccountId === account.accountId;
            const selected = selectedAccountId === account.accountId;
            return (
              <div key={account.accountId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", background: selected ? "var(--bg-selected)" : "var(--bg)", border: selected ? "1px solid var(--accent)" : "1px solid var(--border)", borderRadius: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: account.active ? "#4ade80" : "var(--border)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.maskedAccountId}</span>
                  {account.extraInfo && <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, fontSize: 10, color: account.quotaCache?.error ? "#fb923c" : "var(--text-dim)" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      Reset: {accountQuotaResetText(account)}{account.quotaCache?.queriedAt ? ` · ${formatQuotaQueriedAt(account.quotaCache.queriedAt)}` : ""}
                    </span>
                    <AccountQuotaMiniCharts account={account} />
                  </div>
                </div>
                <button
                  onClick={() => onSelect(account)}
                  disabled={selected || Boolean(refreshingQuotaAccountId) || quotaResetting}
                  style={{ padding: "4px 9px", background: selected ? "var(--accent)" : "none", border: selected ? "1px solid var(--accent)" : "1px solid var(--border)", borderRadius: 4, color: selected ? "#fff" : quotaResetting ? "var(--text-dim)" : "var(--accent)", cursor: selected || refreshingQuotaAccountId || quotaResetting ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {selected ? "Viewing" : "View"}
                </button>
                <button
                  onClick={() => onEditLabel(account)}
                  disabled={savingLabelAccountId === account.accountId}
                  style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: savingLabelAccountId === account.accountId ? "var(--text-dim)" : "var(--text-muted)", cursor: savingLabelAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {savingLabelAccountId === account.accountId ? "Saving…" : "Remark"}
                </button>
                <button
                  onClick={() => onEditExtraInfo(account)}
                  disabled={savingExtraInfoAccountId === account.accountId}
                  style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: savingExtraInfoAccountId === account.accountId ? "var(--text-dim)" : "var(--text-muted)", cursor: savingExtraInfoAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {savingExtraInfoAccountId === account.accountId ? "Saving…" : "Details"}
                </button>
                {account.active ? (
                  <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>active</span>
                ) : (
                  <>
                    <button
                      onClick={() => onActivate(account.accountId)}
                      disabled={Boolean(activatingAccountId) || deletingAccountId === account.accountId}
                      style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: activatingAccountId === account.accountId ? "var(--text-dim)" : "var(--accent)", cursor: activatingAccountId || deletingAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                    >
                      {activatingAccountId === account.accountId ? "Activating…" : "Activate"}
                    </button>
                    <button
                      onClick={() => onDelete(account)}
                      disabled={Boolean(deletingAccountId) || Boolean(activatingAccountId)}
                      style={{ padding: "4px 9px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: deletingAccountId === account.accountId ? "var(--text-dim)" : "#ef4444", cursor: deletingAccountId || activatingAccountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                    >
                      {deletingAccountId === account.accountId ? "Deleting…" : "Delete"}
                    </button>
                  </>
                )}
                <button
                  onClick={() => onRefreshQuota(account)}
                  disabled={Boolean(refreshingQuotaAccountId) || quotaResetting}
                  title="Refresh this account quota reset time"
                  aria-label="Refresh this account quota reset time"
                  style={{ width: 28, height: 28, padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: quotaRefreshing || quotaResetting ? "var(--text-dim)" : "var(--accent)", cursor: refreshingQuotaAccountId || quotaResetting ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
                    <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
                    <path d="M3 4v8h8" />
                    <path d="M21 20v-8h-8" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExtraInfoDialog({
  account,
  saving,
  onSave,
  onClose,
}: {
  account: OAuthAccountSummary;
  saving: boolean;
  onSave: (account: OAuthAccountSummary, extraInfo: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(account.extraInfo ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(account.extraInfo ?? "");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [account]);

  return (
    <div
      className="pi-modal-overlay"
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}
    >
      <div className="pi-modal-panel pi-modal-panel-compact" style={{ width: 520, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 10px 36px rgba(0,0,0,0.28)", overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Account details</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</div>
          </div>
          <button type="button" disabled={saving} onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: saving ? "not-allowed" : "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Extra information</label>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
            placeholder="Add notes such as subscription owner, renewal notes, usage hints…"
            style={{ minHeight: 120, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", boxSizing: "border-box", lineHeight: 1.5 }}
          />
          <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>Leave empty to clear this account&apos;s extra information.</div>
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" disabled={saving} onClick={onClose} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: saving ? "not-allowed" : "pointer", fontSize: 12 }}>Cancel</button>
          <button type="button" disabled={saving} onClick={() => onSave(account, value)} style={{ padding: "6px 14px", background: saving ? "var(--bg-panel)" : "var(--accent)", border: "none", borderRadius: 6, color: saving ? "var(--text-dim)" : "#fff", cursor: saving ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function AddAccountDialog({
  provider,
  view,
  onViewChange,
  onCodexAuth,
  onImported,
  onClose,
}: {
  provider: OAuthProvider;
  view: "method" | "json";
  onViewChange: (view: "method" | "json") => void;
  onCodexAuth: () => void;
  onImported: (accounts: OAuthAccountSummary[]) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<OAuthAccountImportMode>("raw");
  const [jsonText, setJsonText] = useState("");
  const [convertedJsonText, setConvertedJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const converter = mode === "raw" ? undefined : ACCOUNT_JSON_CONVERTERS[mode];
  const finalJsonText = converter ? convertedJsonText : jsonText;

  useEffect(() => {
    if (view === "json") setTimeout(() => textareaRef.current?.focus(), 50);
  }, [view]);

  const parseFinalCredential = useCallback((): unknown | null => {
    try {
      return JSON.parse(finalJsonText);
    } catch (parseError) {
      setValidationMessage({ type: "error", text: parseError instanceof Error ? t("settings.models.finalJsonInvalidDetail", { message: parseError.message }) : t("settings.models.finalJsonInvalid") });
      return null;
    }
  }, [finalJsonText, t]);

  const validateFinalJson = useCallback((): unknown | null => {
    setError(null);
    const credential = parseFinalCredential();
    if (!credential) return null;
    const validationError = validateRawOAuthCredentialImport(credential);
    if (validationError) {
      setValidationMessage({ type: "error", text: validationError });
      return null;
    }
    setValidationMessage({ type: "success", text: Array.isArray(credential) ? t("settings.models.validateOkCount", { count: credential.length }) : t("settings.models.validateOk") });
    return credential;
  }, [parseFinalCredential, t]);

  const convertSourceJson = useCallback(() => {
    if (!converter) return;
    setError(null);
    setValidationMessage(null);

    let source: unknown;
    try {
      source = JSON.parse(jsonText);
    } catch (parseError) {
      setError(parseError instanceof Error ? t("settings.models.sourceJsonInvalidDetail", { message: parseError.message }) : t("settings.models.sourceJsonInvalid"));
      return;
    }

    try {
      const converted = converter.convert(source);
      setConvertedJsonText(JSON.stringify(converted, null, 2));
      setValidationMessage({ type: "success", text: t("settings.models.convertDone") });
    } catch (convertError) {
      setError(convertError instanceof Error ? convertError.message : t("settings.models.convertFailed"));
    }
  }, [converter, jsonText, t]);

  const submitRawJson = useCallback(async () => {
    if (submitting) return;
    const credential = validateFinalJson();
    if (!credential) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "raw", credential }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onImported(data.accounts ?? []);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("settings.models.importFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [onClose, onImported, provider.id, submitting, validateFinalJson, t]);

  const modeButton = (value: OAuthAccountImportMode, label: string, disabled = false) => {
    const active = mode === value;
    return (
      <button
        type="button"
        disabled={disabled || submitting}
        onClick={() => {
          if (disabled) return;
          setMode(value);
          setError(null);
          setValidationMessage(null);
        }}
        style={{
          padding: "6px 9px",
          borderRadius: 6,
          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
          background: active ? "rgba(59,130,246,0.12)" : "var(--bg-panel)",
          color: disabled ? "var(--text-dim)" : active ? "var(--accent)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {label}{disabled ? t("settings.models.laterSupport") : ""}
      </button>
    );
  };

  return (
    <div
      className="pi-modal-overlay"
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div className="pi-modal-panel" style={{ width: view === "json" ? 920 : 560, maxWidth: "calc(100vw - 32px)", maxHeight: "min(82vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 10px 36px rgba(0,0,0,0.28)", overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <ProviderIcon id={provider.id} size={18} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("settings.models.addAccountTitle", { name: provider.name })}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{t("settings.models.addAccountHint")}</div>
            </div>
          </div>
          <button type="button" disabled={submitting} onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
        </div>

        {view === "method" ? (
          <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 10 }}>
            <button type="button" onClick={onCodexAuth} style={{ padding: 14, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{t("settings.models.codexAuth")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("settings.models.codexAuthHint")}</div>
            </button>
            <button type="button" onClick={() => onViewChange("json")} style={{ padding: 14, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{t("settings.models.pasteJson")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("settings.models.pasteJsonHint")}</div>
            </button>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {locale === "zh" ? (
                    <>请粘贴原始 credential 对象，或由 CPA/SUB2API 转换得到的 credential 数组。必填字段为 <code style={{ fontFamily: "var(--font-mono)" }}>type</code>、<code style={{ fontFamily: "var(--font-mono)" }}>access</code>、<code style={{ fontFamily: "var(--font-mono)" }}>refresh</code> 和 <code style={{ fontFamily: "var(--font-mono)" }}>expires</code>。账号会被保存，但不会自动切换为当前激活账号。</>
                  ) : (
                    <>Paste a raw credential object or a CPA/SUB2API-converted credential array. Required fields: <code style={{ fontFamily: "var(--font-mono)" }}>type</code>, <code style={{ fontFamily: "var(--font-mono)" }}>access</code>, <code style={{ fontFamily: "var(--font-mono)" }}>refresh</code>, and <code style={{ fontFamily: "var(--font-mono)" }}>expires</code>. Accounts are saved but not auto-activated.</>
                  )}
                </div>
                <pre style={{ margin: 0, padding: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 11, lineHeight: 1.5, overflow: "auto", fontFamily: "var(--font-mono)" }}>{RAW_ACCOUNT_JSON_EXAMPLE}</pre>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                  {locale === "zh" ? (
                    <>如果省略 <code style={{ fontFamily: "var(--font-mono)" }}>accountId</code>，蜗牛派会尝试从 access token 中解析，失败时使用稳定 fallback。账号显示名会按邮箱、手机号、accountId 的顺序自动补全。</>
                  ) : (
                    <>If <code style={{ fontFamily: "var(--font-mono)" }}>accountId</code> is omitted, Snail Pi tries to parse it from the access token and falls back stably on failure. Display names are filled from email, phone, then accountId.</>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {modeButton("raw", t("settings.models.sourceJson"))}
                  {modeButton("cpa", t("settings.models.cpaFormat"))}
                  {modeButton("sub2api", t("settings.models.sub2apiFormat"))}
                </div>
                {converter ? (
                  <>
                    <textarea
                      ref={textareaRef}
                      value={jsonText}
                      onChange={(e) => { setJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                      placeholder={converter.sourcePlaceholder}
                      spellCheck={false}
                      style={{ minHeight: 150, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                    />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <button type="button" disabled={submitting || !jsonText.trim()} onClick={convertSourceJson} style={{ padding: "6px 12px", background: !submitting && jsonText.trim() ? "var(--accent)" : "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: !submitting && jsonText.trim() ? "#fff" : "var(--text-dim)", cursor: !submitting && jsonText.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}>{locale === "zh" ? "转换 ↓" : "Convert ↓"}</button>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("settings.models.convertToRaw", { label: converter.label })}</span>
                    </div>
                    <textarea
                      value={convertedJsonText}
                      onChange={(e) => { setConvertedJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                      placeholder={RAW_ACCOUNT_JSON_EXAMPLE}
                      spellCheck={false}
                      style={{ minHeight: 150, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                    />
                  </>
                ) : (
                  <textarea
                    ref={textareaRef}
                    value={jsonText}
                    onChange={(e) => { setJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                    placeholder={RAW_ACCOUNT_JSON_EXAMPLE}
                    spellCheck={false}
                    style={{ minHeight: 260, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                  />
                )}
                {error && <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{error}</div>}
                {validationMessage && <div style={{ fontSize: 12, color: validationMessage.type === "success" ? "#34d399" : "#f87171", lineHeight: 1.5 }}>{validationMessage.text}</div>}
              </div>
            </div>

            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button type="button" disabled={submitting} onClick={() => onViewChange("method")} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 12 }}>{t("settings.models.back")}</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={submitting} onClick={onClose} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 12 }}>{t("common.cancel")}</button>
                <button type="button" disabled={submitting || !finalJsonText.trim()} onClick={validateFinalJson} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: !submitting && finalJsonText.trim() ? "var(--text-muted)" : "var(--text-dim)", cursor: !submitting && finalJsonText.trim() ? "pointer" : "not-allowed", fontSize: 12 }}>{t("settings.models.validate")}</button>
                <button type="button" disabled={submitting || !finalJsonText.trim()} onClick={submitRawJson} style={{ padding: "6px 14px", background: !submitting && finalJsonText.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 6, color: !submitting && finalJsonText.trim() ? "#fff" : "var(--text-dim)", cursor: !submitting && finalJsonText.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}>{submitting ? t("settings.models.savingAccount") : t("settings.models.saveAccount")}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const { t } = useI18n();
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const [quota, setQuota] = useState<SubscriptionQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [grokUsage, setGrokUsage] = useState<GrokUsageResult | null>(null);
  const [grokUsageLoading, setGrokUsageLoading] = useState(false);
  const [quotaResetting, setQuotaResetting] = useState(false);
  const [accounts, setAccounts] = useState<OAuthAccountSummary[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedQuotaAccountId, setSelectedQuotaAccountId] = useState<string | null>(null);
  const [activatingAccountId, setActivatingAccountId] = useState<string | null>(null);
  const [savingLabelAccountId, setSavingLabelAccountId] = useState<string | null>(null);
  const [savingExtraInfoAccountId, setSavingExtraInfoAccountId] = useState<string | null>(null);
  const [editingExtraInfoAccount, setEditingExtraInfoAccount] = useState<OAuthAccountSummary | null>(null);
  const [refreshingQuotaAccountId, setRefreshingQuotaAccountId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);
  const [addAccountDialogView, setAddAccountDialogView] = useState<"method" | "json" | null>(null);
  const [warmupDialogOpen, setWarmupDialogOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    setQuota(null);
    setQuotaLoading(false);
    setQuotaResetting(false);
    setGrokUsage(null);
    setGrokUsageLoading(false);
    setAccounts([]);
    setAccountsLoading(false);
    setAccountsError(null);
    setSelectedQuotaAccountId(null);
    setActivatingAccountId(null);
    setSavingLabelAccountId(null);
    setSavingExtraInfoAccountId(null);
    setEditingExtraInfoAccount(null);
    setRefreshingQuotaAccountId(null);
    setDeletingAccountId(null);
    setAddAccountDialogView(null);
    setWarmupDialogOpen(false);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const loadAccounts = useCallback(async () => {
    if (provider.id !== "openai-codex") return;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`);
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Failed to load accounts");
    } finally {
      setAccountsLoading(false);
    }
  }, [provider.id]);

  useEffect(() => {
    if (provider.id === "openai-codex") {
      void loadAccounts();
    }
  }, [provider.id, provider.loggedIn, loadAccounts]);

  useEffect(() => {
    if (provider.id !== "openai-codex") return;
    setSelectedQuotaAccountId((current) => {
      if (accounts.length === 0) return null;
      if (current && accounts.some((account) => account.accountId === current)) return current;
      return accounts.find((account) => account.active)?.accountId ?? null;
    });
  }, [accounts, provider.id]);

  const loadQuota = useCallback(async (force = false, accountIdOverride?: string | null) => {
    if (provider.id !== "openai-codex" || (!provider.loggedIn && !force)) return;
    const quotaAccountId = accountIdOverride !== undefined ? accountIdOverride : selectedQuotaAccountId;
    setQuotaLoading(true);
    try {
      const accountQuery = quotaAccountId ? `?accountId=${encodeURIComponent(quotaAccountId)}` : "";
      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}${accountQuery}`);
      const data = await res.json() as SubscriptionQuota;
      setQuota(data);
      void loadAccounts();
    } catch (error) {
      setQuota({
        tool: provider.id,
        credentialStatus: "valid",
        credentialMessage: error instanceof Error ? error.message : String(error),
        success: false,
        tiers: [],
        error: error instanceof Error ? error.message : "Usage query failed",
        queriedAt: Date.now(),
        resetCreditsAvailableCount: null,
        resetCredits: [],
        resetCreditsError: null,
      });
    } finally {
      setQuotaLoading(false);
    }
  }, [provider.id, provider.loggedIn, selectedQuotaAccountId, loadAccounts]);

  useEffect(() => {
    if (provider.id === "openai-codex" && provider.loggedIn) {
      void loadQuota();
    }
  }, [provider.id, provider.loggedIn, loadQuota]);

  const loadGrokUsage = useCallback(async (forceRefresh = false) => {
    if ((provider.id !== "grok-cli" && provider.id !== "xai") || !provider.loggedIn) return;

    setGrokUsageLoading(true);
    try {
      const mode = forceRefresh ? "refresh" : "cache";
      const res = await fetch(`/api/auth/usage/grok-cli?mode=${mode}`);
      const data = await res.json().catch(() => ({})) as GrokUsageResult & { error?: string };
      if (data.success && data.monthly) {
        setGrokUsage(data);
        return;
      }
      // Keep previous successful result in memory when a live refresh fails.
      setGrokUsage((prev) => {
        if (forceRefresh && prev?.success && prev.monthly) {
          return { ...prev, error: data.error ?? prev.error, source: data.source ?? prev.source };
        }
        return data.provider
          ? data
          : {
              provider: "grok-cli",
              configured: true,
              success: false,
              source: forceRefresh ? "live" : "cache",
              monthly: null,
              weekly: null,
              error: data.error ?? "Grok CLI usage query failed",
              queriedAt: Date.now(),
              envBypass: false,
            };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grok CLI usage query failed";
      setGrokUsage((prev) => {
        if (forceRefresh && prev?.success && prev.monthly) {
          return { ...prev, error: message, source: "live" };
        }
        return {
          provider: "grok-cli",
          configured: true,
          success: false,
          source: "live",
          monthly: null,
          weekly: null,
          error: message,
          queriedAt: Date.now(),
          envBypass: false,
        };
      });
    } finally {
      setGrokUsageLoading(false);
    }
  }, [provider.id, provider.loggedIn]);

  useEffect(() => {
    setGrokUsage(null);
    setGrokUsageLoading(false);
    if ((provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn) void loadGrokUsage();
  }, [provider.id, provider.loggedIn, loadGrokUsage]);

  const handleLogin = useCallback((accountMode: "login" | "add" = "login") => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const loginUrl = `/api/auth/login/${encodeURIComponent(provider.id)}${accountMode === "add" ? "?accountMode=add" : ""}`;
    const es = new EventSource(loginUrl);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
        account?: OAuthAccountSummary; activeAccountId?: string | null;
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success", message: data.message ?? (accountMode === "add" ? "Account saved successfully." : "Connected successfully.") });
        onRefresh();
        void loadAccounts();
        if (provider.loggedIn) void loadQuota();
        if ((provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn) void loadGrokUsage();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: "Connection lost" });
    };
  }, [provider.id, provider.loggedIn, onRefresh, loadAccounts, loadQuota, loadGrokUsage]);

  const handleLogout = useCallback(async () => {
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
    setLoginState({ phase: "idle" });
    setQuota(null);
    setGrokUsage(null);
    setGrokUsageLoading(false);
    setSelectedQuotaAccountId(null);
    onRefresh();
    void loadAccounts();
  }, [provider.id, onRefresh, loadAccounts]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: "Verifying…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: "Continuing…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const handleSelectQuotaAccount = useCallback((account: OAuthAccountSummary) => {
    setSelectedQuotaAccountId(account.accountId);
    void loadQuota(true, account.accountId);
  }, [loadQuota]);

  const handleActivateAccount = useCallback(async (accountId: string) => {
    setActivatingAccountId(accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setSelectedQuotaAccountId(accountId);
      setLoginState({ phase: "success", message: "Account activated." });
      onRefresh();
      await loadQuota(true, accountId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to activate account";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setActivatingAccountId(null);
    }
  }, [provider.id, onRefresh, loadQuota]);

  const handleEditAccountLabel = useCallback(async (account: OAuthAccountSummary) => {
    const nextLabel = window.prompt("Account remark (leave empty to clear):", account.label ?? "");
    if (nextLabel === null) return;

    setSavingLabelAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId, label: nextLabel }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setLoginState({ phase: "success", message: nextLabel.trim() ? "Account remark saved." : "Account remark cleared." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save account remark";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setSavingLabelAccountId(null);
    }
  }, [provider.id]);

  const handleEditAccountExtraInfo = useCallback((account: OAuthAccountSummary) => {
    setEditingExtraInfoAccount(account);
  }, []);

  const handleSaveAccountExtraInfo = useCallback(async (account: OAuthAccountSummary, nextExtraInfo: string) => {
    setSavingExtraInfoAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId, extraInfo: nextExtraInfo }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setEditingExtraInfoAccount(null);
      setLoginState({ phase: "success", message: nextExtraInfo.trim() ? "Account extra info saved." : "Account extra info cleared." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save account extra info";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setSavingExtraInfoAccountId(null);
    }
  }, [provider.id]);

  const handleRefreshAccountQuota = useCallback(async (account: OAuthAccountSummary) => {
    if (quotaResetting) return;
    setRefreshingQuotaAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}?accountId=${encodeURIComponent(account.accountId)}`);
      const data = await res.json().catch(() => ({})) as SubscriptionQuota & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (selectedQuotaAccountId ? account.accountId === selectedQuotaAccountId : account.active) setQuota(data);
      await loadAccounts();
      setLoginState({ phase: data.success ? "success" : "error", message: data.success ? "Account quota refreshed." : (data.error ?? "Quota query failed.") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh account quota";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setRefreshingQuotaAccountId(null);
    }
  }, [loadAccounts, provider.id, quotaResetting, selectedQuotaAccountId]);

  const handleResetQuota = useCallback(async () => {
    const quotaAccountId = selectedQuotaAccountId;
    if (!quotaAccountId || quotaResetting) return;
    const ok = window.confirm(t("settings.models.resetConfirm"));
    if (!ok) return;

    setQuotaResetting(true);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: quotaAccountId }),
      });
      const data = await res.json().catch(() => ({})) as SubscriptionQuota & { error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? data.credentialMessage ?? `HTTP ${res.status}`);
      setQuota(data);
      await loadAccounts();
      setLoginState({ phase: "success", message: "Codex rate limit reset." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset Codex rate limit";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setQuotaResetting(false);
    }
  }, [loadAccounts, provider.id, quotaResetting, selectedQuotaAccountId, t]);

  const handleDeleteAccount = useCallback(async (account: OAuthAccountSummary) => {
    if (!window.confirm(`Delete saved credentials for ${account.displayName}?\n\nThe account must be added again to restore it.`)) return;

    setDeletingAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setLoginState({ phase: "success", message: "Account deleted." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setDeletingAccountId(null);
    }
  }, [provider.id]);

  const selectedQuotaAccount = accounts.find((account) => account.accountId === selectedQuotaAccountId)
    ?? accounts.find((account) => account.active)
    ?? null;

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Subscription</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
            {provider.loggedIn ? "connected" : "not connected"}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn ? "Already connected. You can re-login or disconnect." : `Connect your ${provider.name} account.`}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Opening browser…</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below."
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                If the browser window did not open,{" "}
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  click here to open the login page
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
                placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? "Enter value…")}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() ? "#fff" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
              >
                Submit
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Open the verification page and enter this code:
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` Expires in ${Math.ceil(loginState.expiresInSeconds / 60)} minutes.` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{loginState.message ?? "Connected successfully."}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              onClick={() => handleLogin()}
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {provider.loggedIn ? "Re-login" : "Login"}
            </button>
            {provider.id === "openai-codex" && provider.loggedIn && (
              <button
                onClick={() => setAddAccountDialogView("method")}
                style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                Add Account
              </button>
            )}
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{ padding: "5px 12px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 12 }}
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>

      {provider.id === "openai-codex" && provider.loggedIn && (
        <OAuthQuotaView quota={quota} loading={quotaLoading} account={selectedQuotaAccount} resetting={quotaResetting} onRefresh={loadQuota} onReset={handleResetQuota} />
      )}

      {(provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn && (
        <GrokUsageView result={grokUsage} loading={grokUsageLoading} onRefresh={() => void loadGrokUsage(true)} />
      )}

      {provider.id === "openai-codex" && (
        <OAuthAccountsView
          accounts={accounts}
          loading={accountsLoading}
          error={accountsError}
          activatingAccountId={activatingAccountId}
          savingLabelAccountId={savingLabelAccountId}
          savingExtraInfoAccountId={savingExtraInfoAccountId}
          refreshingQuotaAccountId={refreshingQuotaAccountId}
          quotaResetting={quotaResetting}
          deletingAccountId={deletingAccountId}
          selectedAccountId={selectedQuotaAccount?.accountId ?? null}
          onRefresh={loadAccounts}
          onSelect={handleSelectQuotaAccount}
          onActivate={handleActivateAccount}
          onEditLabel={handleEditAccountLabel}
          onEditExtraInfo={handleEditAccountExtraInfo}
          onRefreshQuota={handleRefreshAccountQuota}
          onDelete={handleDeleteAccount}
          onWarmup={() => setWarmupDialogOpen(true)}
        />
      )}

      {provider.id === "openai-codex" && warmupDialogOpen && (
        <ChatGptWarmupDialog
          accounts={accounts}
          onComplete={loadAccounts}
          onClose={() => setWarmupDialogOpen(false)}
        />
      )}

      {provider.id === "openai-codex" && editingExtraInfoAccount && (
        <ExtraInfoDialog
          account={editingExtraInfoAccount}
          saving={savingExtraInfoAccountId === editingExtraInfoAccount.accountId}
          onSave={handleSaveAccountExtraInfo}
          onClose={() => { if (!savingExtraInfoAccountId) setEditingExtraInfoAccount(null); }}
        />
      )}

      {provider.id === "openai-codex" && addAccountDialogView && (
        <AddAccountDialog
          provider={provider}
          view={addAccountDialogView}
          onViewChange={setAddAccountDialogView}
          onCodexAuth={() => { setAddAccountDialogView(null); handleLogin("add"); }}
          onImported={(nextAccounts) => {
            setAccounts(nextAccounts);
            setLoginState({ phase: "success", message: t("settings.models.accountSaved") });
            onRefresh();
            if (provider.loggedIn) void loadQuota();
          }}
          onClose={() => setAddAccountDialogView(null)}
        />
      )}
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

/**
 * 格式化余额查询的相对更新时间。
 *
 * @param timestamp 查询完成的毫秒时间戳。
 * @returns 简短相对时间文本。
 */
function formatBalanceQueriedAt(timestamp: number | null): string {
  if (!timestamp) return "never";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return "just now";
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

/**
 * 将 DeepSeek 币种转换为展示前缀。
 *
 * @param currency DeepSeek 返回的币种代码。
 * @returns 展示余额时使用的货币前缀。
 */
function deepSeekCurrencyPrefix(currency: string): string {
  if (currency === "CNY") return "¥";
  if (currency === "USD") return "$";
  return "";
}

/**
 * 渲染 DeepSeek 官方余额查询结果。
 *
 * @param props.balance 当前余额查询结果。
 * @param props.loading 是否正在刷新余额。
 * @param props.onRefresh 手动刷新余额的回调。
 * @returns DeepSeek 余额展示内容。
 */
function DeepSeekBalanceView({
  balance,
  loading,
  onRefresh,
}: {
  balance: DeepSeekBalanceResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const availableColor = balance?.isAvailable === false ? "#f87171" : "#4ade80";

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Balance</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {loading ? "Refreshing…" : `Updated ${formatBalanceQueriedAt(balance?.queriedAt ?? null)}`}
          </span>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh balance"
          aria-label="Refresh balance"
          style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading ? "var(--text-dim)" : "var(--text-muted)", cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
            <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
            <path d="M3 4v8h8" />
            <path d="M21 20v-8h-8" />
          </svg>
        </button>
      </div>

      {balance?.error && (
        <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{balance.error}</div>
      )}

      {balance?.success && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>API calls</span>
            <span style={{ fontSize: 12, color: availableColor, fontWeight: 700 }}>
              {balance.isAvailable === false ? "Unavailable" : "Available"}
            </span>
          </div>

          {balance.balanceInfos.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No balance details returned.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {balance.balanceInfos.map((info) => {
                const prefix = deepSeekCurrencyPrefix(info.currency);
                return (
                  <div key={info.currency} style={{ border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", padding: 10, display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600 }}>{info.currency}</span>
                      <span style={{ fontSize: 18, color: "var(--text)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{prefix}{info.totalBalance}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end", justifyContent: "center" }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>grant {prefix}{info.grantedBalance}</span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>top-up {prefix}{info.toppedUpBalance}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [balance, setBalance] = useState<DeepSeekBalanceResult | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
    setBalance(null);
    setBalanceLoading(false);
  }, [provider.id, provider.configured]);

  /**
   * 从服务端刷新 DeepSeek 官方余额。
   *
   * @returns 无返回值，查询结果写入组件状态。
   */
  const loadDeepSeekBalance = useCallback(async () => {
    if (provider.id !== "deepseek" || !provider.configured) return;
    setBalanceLoading(true);
    try {
      const res = await fetch(`/api/auth/balance/${encodeURIComponent(provider.id)}`);
      const data = await res.json() as DeepSeekBalanceResult;
      setBalance(data);
    } catch (e) {
      setBalance({
        provider: provider.id,
        configured: provider.configured,
        success: false,
        isAvailable: null,
        balanceInfos: [],
        error: e instanceof Error ? e.message : String(e),
        queriedAt: Date.now(),
      });
    } finally {
      setBalanceLoading(false);
    }
  }, [provider.id, provider.configured]);

  useEffect(() => {
    if (provider.id === "deepseek" && provider.configured) {
      void loadDeepSeekBalance();
    }
  }, [provider.id, provider.configured, loadDeepSeekBalance]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setBalance(null);
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else {
        setBalance(null);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>API Key</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "#4ade80" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
            {provider.configured ? "configured" : "not configured"}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? `API key is stored. Enter a new key below to replace it, or disconnect to remove it.`
          : `Enter your ${provider.displayName} API key to enable ${provider.modelCount} model${provider.modelCount !== 1 ? "s" : ""}.`}
      </p>

      <Field label="API Key">
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
            placeholder={provider.configured ? "Enter new key to replace…" : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none", borderRadius: 5,
              color: (apiKey.trim() || savedOk) ? "#fff" : "var(--text-dim)",
              cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
              fontSize: 12, fontWeight: 600, flexShrink: 0,
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            {savedOk && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {savedOk ? "Saved" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

      {provider.id === "deepseek" && provider.configured && (
        <DeepSeekBalanceView balance={balance} loading={balanceLoading} onRefresh={loadDeepSeekBalance} />
      )}

      {provider.configured && (
        <button
          onClick={handleRemove}
          disabled={removing}
          style={{
            alignSelf: "flex-start", padding: "5px 12px",
            background: "none", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 5, color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer", fontSize: 12,
          }}
        >
          {removing ? "Removing…" : "Disconnect"}
        </button>
      )}
    </div>
  );
}

// ── Provider icon ─────────────────────────────────────────────────────────────

function ProviderIcon({ id, size }: { id: string; size: number }) {
  const pi = PROVIDER_ICONS[id];
  if (!pi) {
    const label = id
      .split(/[-_]/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--text-dim)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: Math.max(8, Math.floor(size * 0.42)),
          fontWeight: 700,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    );
  }
  // Color icons: self-colored SVG, no wrapper needed
  if (pi.hasColor) return <pi.Icon size={size} />;
  // Mono icons: use currentColor so they adapt to light/dark theme
  return <pi.Icon size={size} style={{ color: "var(--text-muted)" }} />;
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };



  return (
    <div
      className="pi-modal-overlay"
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="pi-modal-panel" style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Search */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search providers…"
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>No providers match</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Custom</div>
              )}
              {showCustom && (
                <button
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>OpenAI / Anthropic compatible</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>Custom endpoint format</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Subscriptions</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>API Key</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{p.modelCount} models</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pricing sync status ───────────────────────────────────────────────────────

type PricingSyncPhase = { kind: "initial" } | { kind: "loading" } | { kind: "success"; syncedAt: number; providerCount: number; modelCount: number } | { kind: "error"; message: string };

function PricingSyncStatus() {
  const [phase, setPhase] = useState<PricingSyncPhase>({ kind: "initial" });

  // Load summary on mount — no network call
  useEffect(() => {
    fetch("/api/model-pricing")
      .then((r) => r.json())
      .then((d: { ok: boolean; syncedAt?: number; providerCount?: number; modelCount?: number }) => {
        if (d.ok && d.syncedAt) {
          setPhase({ kind: "success", syncedAt: d.syncedAt, providerCount: d.providerCount ?? 0, modelCount: d.modelCount ?? 0 });
        }
      })
      .catch(() => {});
  }, []);

  const handleSync = useCallback(async () => {
    if (phase.kind === "loading") return;
    setPhase({ kind: "loading" });
    try {
      const res = await fetch("/api/model-pricing", { method: "POST" });
      const d = await res.json() as { ok: boolean; syncedAt?: number; providerCount?: number; modelCount?: number; error?: string };
      if (!res.ok || !d.ok) {
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setPhase({ kind: "success", syncedAt: d.syncedAt!, providerCount: d.providerCount ?? 0, modelCount: d.modelCount ?? 0 });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [phase.kind]);

  const label = (() => {
    if (phase.kind === "initial") return "Not synced";
    if (phase.kind === "loading") return "Syncing…";
    if (phase.kind === "error") return `Sync failed: ${phase.message}`;
    const ago = formatRelativeTime(phase.syncedAt);
    return `${phase.providerCount} providers · ${phase.modelCount} models · ${ago}`;
  })();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={label}>
      {phase.kind === "success" && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {phase.providerCount}/{phase.modelCount}
        </span>
      )}
      {phase.kind === "error" && (
        <span style={{ fontSize: 10, color: "#f87171", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={phase.message}>
          {phase.message}
        </span>
      )}
      <button
        type="button"
        onClick={handleSync}
        disabled={phase.kind === "loading"}
        title={phase.kind === "loading" ? "Syncing…" : "Sync pricing from pi.dev"}
        aria-label={phase.kind === "loading" ? "Syncing pricing" : "Sync pricing"}
        style={{
          width: 24,
          height: 24,
          padding: 0,
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--bg-panel)",
          color: phase.kind === "loading" ? "var(--text-dim)" : "var(--text-muted)",
          cursor: phase.kind === "loading" ? "not-allowed" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
          <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
          <path d="M3 4v8h8" />
          <path d="M21 20v-8h-8" />
        </svg>
      </button>
    </div>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

type AutoPricingByProvider = Record<string, Record<number, AutoAppliedPricing>>;

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ cwd: _cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  void _cwd;
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pricingCatalogOpen, setPricingCatalogOpen] = useState(false);
  const [autoPricingByProvider, setAutoPricingByProvider] = useState<AutoPricingByProvider>({});

  const updateAutoAppliedPricing = useCallback((providerName: string, index: number, pricing: AutoAppliedPricing | null) => {
    setAutoPricingByProvider((prev) => {
      const indexes = { ...(prev[providerName] ?? {}) };
      if (pricing) indexes[index] = pricing;
      else delete indexes[index];
      const next = { ...prev };
      if (Object.keys(indexes).length > 0) next[providerName] = indexes;
      else delete next[providerName];
      return next;
    });
  }, []);

  const shiftAutoPricingAfterRemove = useCallback((providerName: string, removedIndex: number) => {
    setAutoPricingByProvider((prev) => {
      const current = prev[providerName];
      if (!current) return prev;
      const shifted: Record<number, AutoAppliedPricing> = {};
      for (const [rawIndex, pricing] of Object.entries(current)) {
        const index = Number(rawIndex);
        if (index === removedIndex) continue;
        shifted[index > removedIndex ? index - 1 : index] = pricing;
      }
      const next = { ...prev };
      if (Object.keys(shifted).length > 0) next[providerName] = shifted;
      else delete next[providerName];
      return next;
    });
  }, []);

  const loadOAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { providers: OAuthProvider[] }) => setOauthProviders(d.providers))
      .catch(() => {});
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    fetch("/api/auth/all-providers")
      .then((r) => r.json())
      .then((d: { providers: ApiKeyProvider[] }) => setApiKeyProviders(d.providers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/models-config")
      .then((r) => r.json())
      .then((d: ModelsJson) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        const keys = Object.keys(normalized.providers ?? {});
        if (keys.length > 0) setSelection({ type: "provider", name: keys[0] });
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadOAuthProviders, loadApiKeyProviders]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    setAutoPricingByProvider((prev) => {
      if (!prev[oldName]) return prev;
      const next = { ...prev };
      next[newName] = next[oldName];
      delete next[oldName];
      return next;
    });
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const deleteProvider = useCallback((name: string) => {
    setAutoPricingByProvider((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "", maxTokens: DEFAULT_MAX_TOKENS }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const addDiscoveredModel = useCallback((providerName: string, candidate: DiscoveredModelCandidate): DiscoveredModelChangeResult => {
    const provider = config.providers?.[providerName];
    if (!provider) return { ok: false, message: `Provider not found: ${providerName}` };

    const models = provider.models ?? [];
    if (models.some((model) => model.id === candidate.id)) {
      return { ok: false, message: `Model "${candidate.id}" already exists under this provider.` };
    }

    const model: ModelEntry = candidate.name
      ? { id: candidate.id, name: candidate.name, maxTokens: DEFAULT_MAX_TOKENS }
      : { id: candidate.id, maxTokens: DEFAULT_MAX_TOKENS };
    setConfig((prev) => {
      const currentProvider = prev.providers?.[providerName] ?? {};
      const currentModels = currentProvider.models ?? [];
      if (currentModels.some((existing) => existing.id === candidate.id)) return prev;
      return {
        ...prev,
        providers: {
          ...(prev.providers ?? {}),
          [providerName]: { ...currentProvider, models: [...currentModels, model] },
        },
      };
    });
    setSelection({ type: "model", providerName, index: models.length });
    return { ok: true, message: `Added ${candidate.id}. Cached pricing will be applied when available; click Save to persist it.` };
  }, [config.providers]);

  const removeDiscoveredModel = useCallback((providerName: string, modelId: string): DiscoveredModelChangeResult => {
    const provider = config.providers?.[providerName];
    if (!provider) return { ok: false, message: `Provider not found: ${providerName}` };

    const models = provider.models ?? [];
    const index = models.findIndex((model) => model.id === modelId);
    if (index === -1) return { ok: false, message: `Model "${modelId}" is not currently added under this provider.` };

    setConfig((prev) => {
      const currentProvider = prev.providers?.[providerName] ?? {};
      const currentModels = [...(currentProvider.models ?? [])];
      const currentIndex = currentModels.findIndex((model) => model.id === modelId);
      if (currentIndex === -1) return prev;
      currentModels.splice(currentIndex, 1);
      return {
        ...prev,
        providers: {
          ...(prev.providers ?? {}),
          [providerName]: { ...currentProvider, models: currentModels.length ? currentModels : undefined },
        },
      };
    });
    setSelection((prev) => {
      if (!prev || prev.type !== "model" || prev.providerName !== providerName) return prev;
      if (prev.index === index) return { type: "provider", name: providerName };
      if (prev.index > index) return { ...prev, index: prev.index - 1 };
      return prev;
    });
    shiftAutoPricingAfterRemove(providerName, index);
    return { ok: true, message: `Removed ${modelId}. Click Save to persist it.` };
  }, [config.providers, shiftAutoPricingAfterRemove]);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    shiftAutoPricingAfterRemove(providerName, index);
    setSelection({ type: "provider", name: providerName });
  }, [shiftAutoPricingAfterRemove]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else { setSavedOk(true); setTimeout(() => setSavedOk(false), 2000); }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config]);

  const providers = Object.entries(config.providers ?? {});
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={loadOAuthProviders} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={loadApiKeyProviders} />;
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
          onAddDiscoveredModel={(candidate) => addDiscoveredModel(selection.name, candidate)}
          onRemoveDiscoveredModel={(modelId) => removeDiscoveredModel(selection.name, modelId)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        autoAppliedPricing={autoPricingByProvider[selection.providerName]?.[selection.index] ?? null}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onAutoAppliedPricingChange={(pricing) => updateAutoAppliedPricing(selection.providerName, selection.index, pricing)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
    <div className="pi-modal-overlay" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pi-modal-panel pi-modal-panel-large" style={{ width: 860, height: "78vh", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Models</span>
            <code style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>~/.pi/agent/models.json</code>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPricingCatalogOpen(true)}
              title="View pricing catalog"
              aria-label="View pricing catalog"
              style={{ width: 24, height: 24, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" />
                <path d="M8 3v18" /><path d="M16 3v18" />
              </svg>
            </button>
            <PricingSyncStatus />
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
          </div>
        </div>

        {/* Body */}
        <div className="pi-modal-split-body" style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Left: tree */}
          <div style={{ width: 210, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 5, cursor: "pointer", background: isSelected ? "var(--bg-selected)" : "none" }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "none"; }}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  </div>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 5, cursor: "pointer", background: isSelected ? "var(--bg-selected)" : "none" }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "none"; }}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <span style={{ fontSize: 12, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</span>
                  </div>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
              )}

              {/* Custom providers */}
              {loading ? (
                <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} style={{ marginBottom: 2 }}>
                    {/* Provider row */}
                    <div
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 5, cursor: "pointer", background: isProviderSelected ? "var(--bg-selected)" : "none" }}
                      onMouseEnter={(e) => { if (!isProviderSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isProviderSelected) e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                      <span style={{ fontSize: 12, fontWeight: isProviderSelected ? 600 : 400, color: "var(--text)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {pName}
                      </span>
                    </div>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <div
                          key={i}
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                          style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 26px", borderRadius: 5, cursor: "pointer", background: isModelSelected ? "var(--bg-selected)" : "none" }}
                          onMouseEnter={(e) => { if (!isModelSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isModelSelected) e.currentTarget.style.background = "none"; }}
                        >
                          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: m.id ? "var(--text-muted)" : "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.id || "new model"}
                          </span>
                          {m.reasoning && (
                            <span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.8)", borderRadius: 3, flexShrink: 0 }}>T</span>
                          )}
                        </div>
                      );
                    })}

                    {/* Add model button */}
                    <div
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 4px 26px", borderRadius: 5, cursor: "pointer", color: "var(--text-dim)" }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                    >
                      <span style={{ fontSize: 11 }}>+ model</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add provider */}
            <div style={{ borderTop: "1px solid var(--border)", padding: "8px 6px" }}>
              <button onClick={() => setPickerOpen(true)} style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                width: "100%", padding: "6px 0", background: "none", border: "1px dashed var(--border)", borderRadius: 5,
                color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
              }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                + Add provider
              </button>
            </div>
          </div>

          {/* Right: detail */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {loading ? null : detailContent ?? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>
                Select a provider or model
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          {saveError && <span style={{ fontSize: 12, color: "#f87171", flex: 1 }}>{saveError}</span>}
          <button onClick={onClose} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || savedOk} style={{
            position: "relative",
            padding: "6px 16px",
            minWidth: 92,
            background: savedOk ? "#16a34a" : saving ? "var(--bg-panel)" : "var(--accent)",
            border: "none", borderRadius: 6,
            color: savedOk ? "#fff" : saving ? "var(--text-muted)" : "#fff",
            cursor: (saving || savedOk) ? "default" : "pointer", fontSize: 13, fontWeight: 600,
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            transition: "background-color 0.2s ease, color 0.2s ease",
            animation: savedOk ? "saved-pop 0.45s ease" : undefined,
          }}>
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                style={{ strokeDasharray: 18, animation: "saved-check-draw 0.35s ease forwards", flexShrink: 0 }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? "Saved" : saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
    {pricingCatalogOpen && <ModelPricingCatalog onClose={() => setPricingCatalogOpen(false)} />}
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
