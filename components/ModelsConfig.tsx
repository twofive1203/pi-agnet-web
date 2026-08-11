"use client";

import { useI18n } from "@/components/I18nProvider";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsNotice,
  SettingsState,
} from "@/components/ui/SettingsPrimitives";
import { ModelPricingCatalog } from "./ModelPricingCatalog";
import { modelPrimaryCandidateKey } from "@/lib/model-primary-candidates";
import type {
  ApiKeyProvider,
  DiscoveredModelCandidate,
  DiscoveredModelChangeResult,
  ModelEntry,
  ModelsJson,
  OAuthProvider,
  ProviderEntry,
  Selection,
} from "./models/types";
import { DEFAULT_MAX_TOKENS } from "./models/api-headers";
import type { AutoAppliedPricing } from "./models/discovery-pricing";
import { ProviderIcon } from "./models/provider-icons";
import { OAuthDetail } from "./models/OAuthDetail";
import { ApiKeyDetail } from "./models/ApiKeyDetail";
import { ProviderDetail, ModelDetail } from "./models/ProviderModelDetail";
import { AddProviderPicker, PricingSyncStatus } from "./models/AddProviderPicker";

type AutoPricingByProvider = Record<string, Record<number, AutoAppliedPricing>>;

interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  primaryCandidate?: boolean;
}

interface ModelFavoritesResponse {
  favorites?: { provider: string; modelId: string }[];
  error?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const { t } = useI18n();
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
  /** Custom providers are expanded by default; authenticated built-in providers are collapsed. */
  const [collapsedProviders, setCollapsedProviders] = useState<Record<string, true>>({});
  const [expandedAuthenticatedProviders, setExpandedAuthenticatedProviders] = useState<Record<string, true>>({});
  const [autoPricingByProvider, setAutoPricingByProvider] = useState<AutoPricingByProvider>({});
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [availableModelsError, setAvailableModelsError] = useState<string | null>(null);
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set());
  const [favoriteBusyKeys, setFavoriteBusyKeys] = useState<Set<string>>(new Set());
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

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

  const loadAvailableModels = useCallback(() => {
    const params = new URLSearchParams({ refresh: "1" });
    if (cwd) params.set("cwd", cwd);
    fetch(`/api/models?${params.toString()}`)
      .then(async (response) => {
        const body = await response.json() as { modelList?: AvailableModel[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setAvailableModels(body.modelList ?? []);
        setAvailableModelsError(null);
      })
      .catch((error) => {
        setAvailableModels([]);
        setAvailableModelsError(error instanceof Error ? error.message : String(error));
      });
  }, [cwd]);

  const loadModelFavorites = useCallback(() => {
    fetch("/api/model-favorites")
      .then(async (response) => {
        const body = await response.json() as ModelFavoritesResponse;
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setFavoriteKeys(new Set((body.favorites ?? []).map((favorite) => (
          modelPrimaryCandidateKey(favorite.provider, favorite.modelId)
        ))));
      })
      .catch((error) => setFavoriteError(error instanceof Error ? error.message : String(error)));
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
    loadAvailableModels();
    loadModelFavorites();
  }, [loadOAuthProviders, loadApiKeyProviders, loadAvailableModels, loadModelFavorites]);

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
    setCollapsedProviders((prev) => {
      if (!prev[oldName]) return prev;
      const next = { ...prev };
      next[newName] = true;
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
    setCollapsedProviders((prev) => {
      if (!prev[name]) return prev;
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

  const expandProvider = useCallback((name: string) => {
    setCollapsedProviders((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const toggleProviderExpanded = useCallback((name: string) => {
    setCollapsedProviders((prev) => {
      if (prev[name]) {
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: true };
    });
  }, []);

  const toggleAuthenticatedProviderExpanded = useCallback((key: string) => {
    setExpandedAuthenticatedProviders((prev) => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: true };
    });
  }, []);

  /** Rebuild providers object so insertion order (and models.json key order) matches the UI. */
  const moveProvider = useCallback((name: string, direction: -1 | 1) => {
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const index = entries.findIndex(([key]) => key === name);
      if (index === -1) return prev;
      const target = index + direction;
      if (target < 0 || target >= entries.length) return prev;
      const next = [...entries];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return { ...prev, providers: Object.fromEntries(next) };
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    expandProvider(providerName);
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
  }, [expandProvider]);

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
    expandProvider(providerName);
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
  }, [config.providers, expandProvider]);

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

  const updateFavorite = useCallback(async (provider: string, modelId: string, favorite: boolean) => {
    const normalizedProvider = provider.trim();
    const normalizedModelId = modelId.trim();
    if (!normalizedProvider || !normalizedModelId) return;
    const key = modelPrimaryCandidateKey(normalizedProvider, normalizedModelId);
    setFavoriteError(null);
    setFavoriteBusyKeys((current) => new Set(current).add(key));
    try {
      const response = await fetch("/api/model-favorites", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: normalizedProvider, modelId: normalizedModelId, favorite }),
      });
      const body = await response.json() as ModelFavoritesResponse;
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setFavoriteKeys(new Set((body.favorites ?? []).map((entry) => (
        modelPrimaryCandidateKey(entry.provider, entry.modelId)
      ))));
    } catch (error) {
      setFavoriteError(error instanceof Error ? error.message : String(error));
    } finally {
      setFavoriteBusyKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

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
  const availableModelsByProvider = useMemo(() => {
    const grouped = new Map<string, AvailableModel[]>();
    for (const model of availableModels) {
      const models = grouped.get(model.provider);
      if (models) models.push(model);
      else grouped.set(model.provider, [model]);
    }
    return grouped;
  }, [availableModels]);
  const authenticatedProviders: { key: string; id: string; label: string; selection: Selection }[] = [
    ...activeOAuth.map((provider) => ({
      key: `oauth:${provider.id}`,
      id: provider.id,
      label: provider.name,
      selection: { type: "oauth", providerId: provider.id } as Selection,
    })),
    ...activeApiKey.map((provider) => ({
      key: `apikey:${provider.id}`,
      id: provider.id,
      label: provider.displayName,
      selection: { type: "apikey", providerId: provider.id } as Selection,
    })),
  ];

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={() => { loadOAuthProviders(); loadAvailableModels(); }} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={() => { loadApiKeyProviders(); loadAvailableModels(); }} />;
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
        favorite={favoriteKeys.has(modelPrimaryCandidateKey(selection.providerName, model.id))}
        favoriteBusy={favoriteBusyKeys.has(modelPrimaryCandidateKey(selection.providerName, model.id))}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onAutoAppliedPricingChange={(pricing) => updateAutoAppliedPricing(selection.providerName, selection.index, pricing)}
        onFavoriteChange={(favorite) => { void updateFavorite(selection.providerName, model.id, favorite); }}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
      <div className="pi-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="models-config-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="pi-modal-panel pi-modal-panel-large resource-split-panel models-config-panel">
          <div className="pi-modal-header">
            <div className="pi-modal-header-copy">
              <div id="models-config-title" className="pi-modal-title">Models</div>
              <div className="pi-modal-subtitle resource-path">~/.pi/agent/models.json · model-favorites.json</div>
            </div>
            <SettingsActionRow className="models-header-actions">
              <SettingsButton size="icon" onClick={() => setPricingCatalogOpen(true)} title="View pricing catalog" aria-label="View pricing catalog">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16" /><path d="M4 12h16" /><path d="M4 19h16" /><path d="M8 3v18" /><path d="M16 3v18" /></svg>
              </SettingsButton>
              <PricingSyncStatus />
              <button type="button" onClick={onClose} className="pi-modal-close" aria-label="Close models">×</button>
            </SettingsActionRow>
          </div>

          <div className="pi-modal-split-body resource-split-body">
            <aside className="resource-split-nav models-tree" aria-label="Model providers">
              <div className="resource-split-list">
                {authenticatedProviders.map((provider) => {
                  const providerModels = availableModelsByProvider.get(provider.id) ?? [];
                  const modelsExpanded = providerModels.length > 0 && expandedAuthenticatedProviders[provider.key] === true;
                  const providerActive = selection?.type === provider.selection.type
                    && "providerId" in selection
                    && selection.providerId === provider.id;
                  return (
                    <div key={provider.key} className="resource-nav-group models-provider-group">
                      <div className={`resource-nav-row models-provider-row${providerActive ? " resource-nav-row-active" : ""}`}>
                        {providerModels.length > 0 ? (
                          <button
                            type="button"
                            className="models-provider-expand"
                            aria-expanded={modelsExpanded}
                            aria-label={modelsExpanded ? t("settings.models.collapseModels") : t("settings.models.expandModels")}
                            title={modelsExpanded ? t("settings.models.collapseModels") : t("settings.models.expandModels")}
                            onClick={() => toggleAuthenticatedProviderExpanded(provider.key)}
                          >
                            <span className={`models-provider-chevron${modelsExpanded ? " is-open" : ""}`} aria-hidden="true" />
                          </button>
                        ) : <span className="models-provider-expand" aria-hidden="true" />}
                        <button type="button" className="models-provider-row-main" onClick={() => setSelection(provider.selection)}>
                          <ProviderIcon id={provider.id} size={16} />
                          <span>{provider.label}</span>
                          {providerModels.length > 0 && !modelsExpanded && <SettingsBadge tone="neutral">{providerModels.length}</SettingsBadge>}
                        </button>
                      </div>
                      {modelsExpanded && providerModels.map((model) => {
                        const favoriteKey = modelPrimaryCandidateKey(model.provider, model.id);
                        const favorite = favoriteKeys.has(favoriteKey);
                        const favoriteBusy = favoriteBusyKeys.has(favoriteKey);
                        return (
                          <div key={favoriteKey} className="resource-nav-row models-tree-model">
                            <button
                              type="button"
                              className="models-tree-model-select"
                              title={`${model.provider}/${model.id}`}
                              onClick={() => setSelection(provider.selection)}
                            >
                              <span>{model.name || model.id}</span>
                            </button>
                            <button
                              type="button"
                              className={`models-tree-star-btn${favorite ? " is-active" : ""}`}
                              disabled={favoriteBusy}
                              aria-label={favorite ? t("settings.models.primaryCandidateUnset") : t("settings.models.primaryCandidateSet")}
                              title={favorite ? t("settings.models.primaryCandidateUnset") : t("settings.models.primaryCandidateSet")}
                              onClick={() => { void updateFavorite(model.provider, model.id, !favorite); }}
                            >
                              {favoriteBusy ? "…" : favorite ? "★" : "☆"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && <div className="models-tree-divider" />}
                {loading ? <SettingsState kind="loading" title="Loading models…" /> : providers.length === 0 ? <SettingsState title="No custom providers" /> : providers.map(([providerName, providerData], providerIndex) => {
                  const providerActive = selection?.type === "provider" && selection.name === providerName;
                  const modelsExpanded = !collapsedProviders[providerName];
                  const modelCount = providerData.models?.length ?? 0;
                  return (
                    <div key={providerName} className="resource-nav-group models-provider-group">
                      <div className={`resource-nav-row models-provider-row${providerActive ? " resource-nav-row-active" : ""}`}>
                        <button
                          type="button"
                          className="models-provider-expand"
                          aria-expanded={modelsExpanded}
                          aria-label={modelsExpanded ? t("settings.models.collapseModels") : t("settings.models.expandModels")}
                          title={modelsExpanded ? t("settings.models.collapseModels") : t("settings.models.expandModels")}
                          onClick={() => toggleProviderExpanded(providerName)}
                        >
                          <span className={`models-provider-chevron${modelsExpanded ? " is-open" : ""}`} aria-hidden="true" />
                        </button>
                        <button type="button" className="models-provider-row-main" onClick={() => setSelection({ type: "provider", name: providerName })}>
                          <span className="resource-status-dot" aria-hidden="true" /><span>{providerName}</span>
                          {!modelsExpanded && modelCount > 0 && <SettingsBadge tone="neutral">{modelCount}</SettingsBadge>}
                        </button>
                        <div className="models-provider-reorder">
                          <SettingsButton
                            size="icon"
                            variant="ghost"
                            className="models-provider-reorder-btn"
                            disabled={providerIndex === 0}
                            onClick={() => moveProvider(providerName, -1)}
                            aria-label={t("settings.models.moveUp")}
                            title={t("settings.models.moveUp")}
                          >
                            ↑
                          </SettingsButton>
                          <SettingsButton
                            size="icon"
                            variant="ghost"
                            className="models-provider-reorder-btn"
                            disabled={providerIndex === providers.length - 1}
                            onClick={() => moveProvider(providerName, 1)}
                            aria-label={t("settings.models.moveDown")}
                            title={t("settings.models.moveDown")}
                          >
                            ↓
                          </SettingsButton>
                        </div>
                      </div>
                      {modelsExpanded && (
                        <>
                          {(providerData.models ?? []).map((model, index) => {
                            const modelActive = selection?.type === "model" && selection.providerName === providerName && selection.index === index;
                            const favoriteKey = modelPrimaryCandidateKey(providerName, model.id);
                            const favorite = favoriteKeys.has(favoriteKey);
                            const favoriteBusy = favoriteBusyKeys.has(favoriteKey);
                            return (
                              <div key={`${model.id}-${index}`} className={`resource-nav-row models-tree-model${modelActive ? " resource-nav-row-active" : ""}`}>
                                <button
                                  type="button"
                                  className="models-tree-model-select"
                                  onClick={() => setSelection({ type: "model", providerName, index })}
                                >
                                  <span>{model.id || "new model"}</span>
                                  {model.reasoning && <SettingsBadge tone="accent">T</SettingsBadge>}
                                </button>
                                <button
                                  type="button"
                                  className={`models-tree-star-btn${favorite ? " is-active" : ""}`}
                                  disabled={!model.id.trim() || favoriteBusy}
                                  aria-label={favorite ? t("settings.models.primaryCandidateUnset") : t("settings.models.primaryCandidateSet")}
                                  title={favorite ? t("settings.models.primaryCandidateUnset") : t("settings.models.primaryCandidateSet")}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    void updateFavorite(providerName, model.id, !favorite);
                                    setSelection({ type: "model", providerName, index });
                                  }}
                                >
                                  {favoriteBusy ? "…" : favorite ? "★" : "☆"}
                                </button>
                              </div>
                            );
                          })}
                          <button type="button" className="resource-nav-row models-tree-model models-tree-add" onClick={() => addModel(providerName)}>+ model</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="resource-split-nav-footer"><SettingsButton onClick={() => setPickerOpen(true)}>+ Add provider</SettingsButton></div>
            </aside>

            <main className="resource-split-detail models-detail">
              {loading ? <SettingsState kind="loading" title="Loading models…" /> : detailContent ?? <SettingsState title="Select a provider or model" />}
            </main>
          </div>

          <div className="pi-modal-footer models-footer">
            {saveError && <SettingsNotice tone="danger" className="models-save-error">{saveError}</SettingsNotice>}
            {availableModelsError && <SettingsNotice tone="danger" className="models-save-error">{availableModelsError}</SettingsNotice>}
            {favoriteError && <SettingsNotice tone="danger" className="models-save-error">{favoriteError}</SettingsNotice>}
            {savedOk && <SettingsBadge tone="success">Saved</SettingsBadge>}
            <SettingsButton onClick={onClose}>Cancel</SettingsButton>
            <SettingsButton variant="primary" onClick={handleSave} disabled={savedOk} busy={saving}>{savedOk ? t("settings.models.saved") : saving ? t("settings.models.saving") : t("settings.models.save")}</SettingsButton>
          </div>
        </div>
      </div>
      {pricingCatalogOpen && <ModelPricingCatalog onClose={() => setPricingCatalogOpen(false)} />}
      {pickerOpen && <AddProviderPicker oauthProviders={oauthProviders} apiKeyProviders={apiKeyProviders} onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })} onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })} onAddCustom={addCustomProvider} onClose={() => setPickerOpen(false)} />}
    </>
  );
}
