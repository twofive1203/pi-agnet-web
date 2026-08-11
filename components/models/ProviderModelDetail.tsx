"use client";

import { useI18n } from "@/components/I18nProvider";
import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  SettingsActionRow,
  SettingsButton,
  SettingsNotice,
  SettingsSurface,
} from "@/components/ui/SettingsPrimitives";
import type {
  CachedPricingCandidate,
  CachedPricingEntry,
  DiscoverModelsResponse,
  DiscoveredModelCandidate,
  DiscoveredModelChangeResult,
  ModelDiscoveryState,
  ModelEntry,
  ModelTestState,
  ProviderEntry,
} from "./types";
import {
  API_OPTIONS,
  applyApiChangeHeaders,
  defaultUserAgentHint,
  ensureDefaultApiUserAgent,
} from "./api-headers";
import {
  Check,
  Field,
  HeadersEditor,
  NumInput,
  SectionTitle,
  SecretTextInput,
  Select,
  TextInput,
} from "./form-fields";
import {
  filterDiscoveredModels,
  formatPricingCandidateValue,
  getMissingPricingFields,
  groupDiscoveredModels,
  lookupCachedPricing,
  mergeMissingPricing,
  PRICING_COST_FIELDS,
  PRICING_FIELDS,
  type AutoAppliedPricing,
  type PricingLookupState,
} from "./discovery-pricing";

// ── Provider detail ───────────────────────────────────────────────────────────

export function ProviderDetail({ name, provider, onChange, onRename, onDelete, onAddDiscoveredModel, onRemoveDiscoveredModel }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
  onAddDiscoveredModel: (candidate: DiscoveredModelCandidate) => DiscoveredModelChangeResult;
  onRemoveDiscoveredModel: (modelId: string) => DiscoveredModelChangeResult;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) {
      onChange({ ...provider, api: "openai-completions" });
      return;
    }
    // Seed default UA once for APIs that need a client identity and User-Agent is absent.
    // Do not re-run on header edits so users can clear/override the default.
    const withDefaultUa = ensureDefaultApiUserAgent(provider);
    if (withDefaultUa) onChange(withDefaultUa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  useEffect(() => {
    setDiscoveryState({ phase: "idle" });
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const providerModelIds = new Set((provider.models ?? []).map((model) => model.id).filter(Boolean));
  const isOpenAICompatible = provider.api === "openai-completions" || provider.api === "openai-responses";
  const discoveryDisabledReason = !isOpenAICompatible
    ? t("settings.models.discoveryOpenAIOnly")
    : !provider.baseUrl?.trim()
      ? t("settings.models.discoveryNeedBaseUrl")
      : !provider.apiKey?.trim()
        ? t("settings.models.discoveryNeedApiKey")
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
        message: data.models.length === 0 ? t("settings.models.discoveryEmptyFetched") : undefined,
      });
    } catch (error) {
      setDiscoveryState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [discoveryDisabledReason, discoveryState.phase, formatDiscoveryFailure, name, provider, t]);

  const handleAddDiscoveredModel = useCallback((candidate: DiscoveredModelCandidate) => {
    if (discoveryState.phase !== "success") return;
    const result = onAddDiscoveredModel(candidate);
    setDiscoveryState((current) => current.phase === "success" ? {
      ...current,
      message: result.message ?? (result.ok ? t("settings.models.discoveryAdded", { id: candidate.id }) : t("settings.models.discoveryCouldNotAdd")),
    } : current);
  }, [discoveryState.phase, onAddDiscoveredModel, t]);

  const handleRemoveDiscoveredModel = useCallback((modelId: string) => {
    if (discoveryState.phase !== "success") return;
    const result = onRemoveDiscoveredModel(modelId);
    setDiscoveryState({
      ...discoveryState,
      message: result.message ?? (result.ok ? t("settings.models.discoveryRemoved", { id: modelId }) : t("settings.models.discoveryCouldNotRemove")),
    });
  }, [discoveryState, onRemoveDiscoveredModel, t]);

  const setDiscoverySearchQuery = useCallback((query: string) => {
    setDiscoveryState((prev) => prev.phase === "success" ? { ...prev, searchQuery: query, message: undefined } : prev);
  }, []);

  const toggleDiscoveryGroup = useCallback((owner: string) => {
    setDiscoveryState((prev) => prev.phase === "success"
      ? { ...prev, collapsedGroups: { ...prev.collapsedGroups, [owner]: !prev.collapsedGroups[owner] } }
      : prev);
  }, []);

  return (
    <div className="models-detail-form">
      <SettingsActionRow>
        <SectionTitle>{t("settings.models.provider")}</SectionTitle>
        <SettingsButton size="sm" variant="danger" onClick={onDelete}>{t("settings.models.delete")}</SettingsButton>
      </SettingsActionRow>

      <Field label={t("settings.models.providerName")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <SettingsButton size="sm" variant="primary" className="settings-align-start" onClick={() => onRename(editingName.trim())}>{t("settings.models.rename")}</SettingsButton>
        )}
      </Field>

      <Field label={t("settings.models.baseUrl")}>
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label={t("settings.models.apiKey")}>
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("settings.models.apiKeyPlaceholder")} mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {t("settings.models.apiKeyHint")}
        </span>
      </Field>

      <Field label={t("settings.models.api")}>
        <Select
          value={provider.api ?? "openai-completions"}
          onChange={(v) => onChange(applyApiChangeHeaders(provider, v))}
          options={API_OPTIONS}
          required
        />
      </Field>

      <SettingsSurface>
        <Check
          label={t("settings.models.retryEmptyCompleted")}
          checked={provider.emptyCompletedRetry === true}
          onChange={(enabled) => set("emptyCompletedRetry", enabled ? true : undefined)}
        />
        <div className="settings-surface-muted">
          {t("settings.models.retryEmptyCompletedHint")}
        </div>
      </SettingsSurface>

      <HeadersEditor
        headers={provider.headers}
        onChange={(headers) => set("headers", headers)}
        hint={defaultUserAgentHint(provider.api, "provider")
          ?? t("settings.models.headersHintProvider")}
      />

      <SettingsSurface className="models-discovery">
        <SettingsActionRow>
          <div><SectionTitle>{t("settings.models.discoverModels")}</SectionTitle><div className="settings-surface-muted">{t("settings.models.discoverModelsHint")}</div></div>
          <SettingsButton variant="primary" onClick={handleDiscoverModels} disabled={Boolean(discoveryDisabledReason)} busy={discoveryState.phase === "loading"}>{discoveryState.phase === "loading" ? t("settings.models.fetching") : t("settings.models.fetchModels")}</SettingsButton>
        </SettingsActionRow>

        {discoveryDisabledReason && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>{discoveryDisabledReason}</div>
        )}

        {discoveryState.phase === "loading" && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("settings.models.fetchingRemote")}</div>
        )}

        {discoveryState.phase === "error" && <SettingsNotice tone="danger">{discoveryState.message}</SettingsNotice>}

        {discoveryState.phase === "success" && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {discoveryModels.length === 0 ? t("settings.models.noModelsReturnedShort") : t("settings.models.discoveryFetched", { count: discoveryModels.length, url: discoveryState.url })}
            </div>
            {discoveryModels.length > 0 && (
              <>
                <Field label={t("settings.models.searchModels")}>
                  <TextInput
                    value={discoverySearchQuery}
                    onChange={setDiscoverySearchQuery}
                    placeholder={t("settings.models.searchModelsPlaceholder")}
                    mono
                  />
                </Field>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  {t("settings.models.discoveryShowing", { shown: filteredDiscoveryModels.length, total: discoveryModels.length })}
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
      </SettingsSurface>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
  max:     "#ef4444",
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
  supportsDeveloperRole: false,
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
  delete rest.supportsDeveloperRole;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

export function ModelDetail({
  providerName,
  provider,
  model,
  autoAppliedPricing,
  favorite,
  favoriteBusy,
  onChange,
  onAutoAppliedPricingChange,
  onFavoriteChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  autoAppliedPricing: AutoAppliedPricing | null;
  favorite: boolean;
  favoriteBusy: boolean;
  onChange: (m: ModelEntry) => void;
  onAutoAppliedPricingChange: (pricing: AutoAppliedPricing | null) => void;
  onFavoriteChange: (favorite: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
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
    if (testState.phase === "testing") return t("settings.models.testingConnection");
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

  useEffect(() => {
    // Seed default UA when model API override needs a client identity and User-Agent is absent.
    // Intentionally ignores header edits so the default can be removed.
    const withDefaultUa = ensureDefaultApiUserAgent(model);
    if (withDefaultUa) onChange(withDefaultUa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.api]);

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
    <div className="models-detail-form">
      <SettingsActionRow>
        <SectionTitle>Model</SectionTitle>
        <div className="settings-action-group">
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
            title={t("settings.models.testConnection")}
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
            {testState.phase === "testing" ? t("settings.models.testing") : testState.phase === "success" ? "OK" : "Test"}
          </button>
          <SettingsButton size="sm" variant="danger" onClick={onDelete}>Remove</SettingsButton>
        </div>
      </SettingsActionRow>

      <div className="settings-grid">
        <Field label={t("settings.models.modelIdRequired")}><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label={t("settings.models.modelName")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={t("settings.models.displayName")} /></Field>
      </div>

      <Field label={t("settings.models.apiOverride")}>
        <Select
          value={model.api ?? ""}
          onChange={(v) => onChange(applyApiChangeHeaders(model, v || undefined))}
          options={API_OPTIONS}
        />
      </Field>

      <HeadersEditor
        headers={model.headers}
        onChange={(headers) => set("headers", headers)}
        hint={defaultUserAgentHint(model.api, "model")
          ?? t("settings.models.headersHintModel")}
      />

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check label={t("settings.models.reasoningThinking")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
        <Check label={t("settings.models.imageInput")} checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
        <Check
          label={t("settings.models.primaryCandidate")}
          checked={favorite}
          disabled={!model.id.trim() || favoriteBusy}
          onChange={onFavoriteChange}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: -8 }}>
        {t("settings.models.primaryCandidateHint")}
      </div>

      {model.reasoning && (
        <>
          <Check
            label={t("settings.models.deepseekThinkingCompat")}
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

      <div className="settings-grid">
        <Field label={t("settings.models.contextWindow")}>
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label={t("settings.models.maxOutputTokens")}>
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
        <div className="models-cost-grid">
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
    <div className="pi-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pi-modal-panel models-pricing-match-dialog">
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy"><div className="pi-modal-title">Match pricing</div><div className="pi-modal-subtitle resource-path">{modelId}</div></div>
          <button type="button" onClick={onClose} aria-label="Close pricing match" className="pi-modal-close">×</button>
        </div>
        <div className="pi-modal-body models-pricing-candidates">
          {candidates.map((candidate) => (
            <button
              key={`${candidate.provider}:${candidate.model}`}
              type="button"
              onClick={() => onSelect(candidate)}
              className="models-pricing-candidate"
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
