"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsField,
  SettingsInput,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSelect,
  SettingsState,
  SettingsSurface,
} from "@/components/ui/SettingsPrimitives";

type ProviderId =
  | "brave"
  | "tavily"
  | "serper"
  | "exa"
  | "youcom"
  | "jina"
  | "firecrawl"
  | "perplexity"
  | "searxng"
  | "ollama";
type OperationMode = "preserve" | "replace" | "clear";

interface ProviderProjection {
  id: ProviderId;
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

interface WebToolsConfigResponse {
  path: string;
  sourcePath: string;
  sourceKind: "canonical" | "legacy-fallback";
  exists: boolean;
  revision: string;
  parseError?: string;
  persistedProvider: ProviderId;
  effectiveProvider: string;
  effectiveProviderSource: "environment" | "config" | "default";
  effectiveProviderKnown: boolean;
  providerEnvVar: "WEB_SEARCH_PROVIDER";
  providers: ProviderProjection[];
  unknownRootKeys: string[];
  packageVersion: string;
  error?: string;
  code?: string;
}

function operation(mode: OperationMode, value: string): { mode: OperationMode; value?: string } {
  return mode === "replace" ? { mode, value } : { mode };
}

export function WebToolsConfig() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<WebToolsConfigResponse | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<ProviderId>("brave");
  const [credentialProviderId, setCredentialProviderId] = useState<ProviderId>("brave");
  const [keyMode, setKeyMode] = useState<OperationMode>("preserve");
  const [keyValue, setKeyValue] = useState("");
  const [baseUrlMode, setBaseUrlMode] = useState<OperationMode>("preserve");
  const [baseUrlValue, setBaseUrlValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProvider = useMemo(
    () => snapshot?.providers.find((provider) => provider.id === credentialProviderId) ?? null,
    [credentialProviderId, snapshot],
  );

  const resetCredentialDraft = useCallback((data: WebToolsConfigResponse, nextProvider = data.persistedProvider) => {
    const provider = data.providers.find((item) => item.id === nextProvider);
    setCredentialProviderId(nextProvider);
    setKeyMode("preserve");
    setKeyValue("");
    setBaseUrlMode("preserve");
    setBaseUrlValue(provider?.storedBaseUrl ?? provider?.defaultBaseUrl ?? "");
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/web-tools/config", { signal });
      const data = await response.json() as WebToolsConfigResponse;
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshot(data);
      setDefaultProviderId(data.persistedProvider);
      resetCredentialDraft(data);
    } catch (loadError) {
      if ((loadError as { name?: string }).name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [resetCredentialDraft]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const changeCredentialProvider = useCallback((nextProvider: ProviderId) => {
    if (!snapshot) return;
    resetCredentialDraft(snapshot, nextProvider);
    setNotice(null);
  }, [resetCredentialDraft, snapshot]);

  const save = useCallback(async () => {
    if (!snapshot || snapshot.parseError) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/web-tools/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: snapshot.revision,
          provider: defaultProviderId,
          credentialProvider: credentialProviderId,
          apiKey: operation(keyMode, keyValue),
          ...(selectedProvider?.baseUrlEnvVar
            ? { baseUrl: operation(baseUrlMode, baseUrlValue) }
            : {}),
        }),
      });
      const data = await response.json() as WebToolsConfigResponse & { success?: boolean };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSnapshot(data);
      setDefaultProviderId(data.persistedProvider);
      resetCredentialDraft(data, credentialProviderId);
      setNotice(t("settings.webTools.saved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [baseUrlMode, baseUrlValue, credentialProviderId, defaultProviderId, keyMode, keyValue, resetCredentialDraft, selectedProvider?.baseUrlEnvVar, snapshot, t]);

  if (loading) return <SettingsState kind="loading" title={t("settings.webTools.loading")} />;
  if (!snapshot) {
    return (
      <SettingsState
        kind="error"
        title={t("settings.webTools.loadFailed")}
        description={error}
        action={<SettingsButton onClick={() => void load()}>{t("common.retry")}</SettingsButton>}
      />
    );
  }

  return (
    <SettingsSection>
      <SettingsSectionHeader
        title={t("settings.webTools.title")}
        description={t("settings.webTools.description", { version: snapshot.packageVersion })}
        meta={<code className="settings-inline-code">{snapshot.path}</code>}
        action={<SettingsButton onClick={() => void load()} disabled={saving}>{t("common.refresh")}</SettingsButton>}
      />

      {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
      {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
      {snapshot.parseError && (
        <SettingsNotice tone="danger">
          {t("settings.webTools.parseError", { detail: snapshot.parseError })}
        </SettingsNotice>
      )}
      {snapshot.sourceKind === "legacy-fallback" && (
        <SettingsNotice tone="warning">
          {t("settings.webTools.legacyFallback", { path: snapshot.sourcePath })}
        </SettingsNotice>
      )}
      {snapshot.effectiveProviderSource === "environment" && (
        <SettingsNotice tone="warning">
          {t("settings.webTools.providerEnvOverride", {
            env: snapshot.providerEnvVar,
            provider: snapshot.effectiveProvider,
          })}
        </SettingsNotice>
      )}
      {!snapshot.effectiveProviderKnown && (
        <SettingsNotice tone="danger">
          {t("settings.webTools.unknownEffectiveProvider", { provider: snapshot.effectiveProvider })}
        </SettingsNotice>
      )}

      <SettingsField
        label={t("settings.webTools.defaultProvider")}
        description={t("settings.webTools.defaultProviderHint")}
      >
        <SettingsSelect
          value={defaultProviderId}
          onChange={(event) => {
            setDefaultProviderId(event.target.value as ProviderId);
            setNotice(null);
          }}
          disabled={saving || !!snapshot.parseError}
        >
          {snapshot.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} · {provider.roles.join(" + ")}
            </option>
          ))}
        </SettingsSelect>
      </SettingsField>

      <SettingsField
        label={t("settings.webTools.credentialProvider")}
        description={t("settings.webTools.credentialProviderHint")}
      >
        <SettingsSelect
          value={credentialProviderId}
          onChange={(event) => changeCredentialProvider(event.target.value as ProviderId)}
          disabled={saving || !!snapshot.parseError}
        >
          {snapshot.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} · {provider.roles.join(" + ")}
            </option>
          ))}
        </SettingsSelect>
      </SettingsField>

      {selectedProvider && (
        <SettingsSurface>
          <SettingsActionRow>
            <SettingsBadge tone={selectedProvider.keyConfigured ? "success" : "neutral"}>
              {selectedProvider.keyConfigured ? t("settings.webTools.keyConfigured") : t("settings.webTools.keyMissing")}
            </SettingsBadge>
            <SettingsBadge tone={selectedProvider.keySource === "environment" ? "warning" : "neutral"}>
              {t("settings.webTools.keySource", { source: selectedProvider.keySource })}
            </SettingsBadge>
            <SettingsBadge>{selectedProvider.apiKeyEnvVar}</SettingsBadge>
          </SettingsActionRow>

          {selectedProvider.keySource === "environment" && (
            <SettingsNotice tone="warning">
              {t("settings.webTools.keyEnvOverride", { env: selectedProvider.apiKeyEnvVar })}
            </SettingsNotice>
          )}

          <SettingsField
            label={t("settings.webTools.keyAction")}
            description={t("settings.webTools.keyActionHint")}
          >
            <SettingsSelect
              value={keyMode}
              onChange={(event) => {
                setKeyMode(event.target.value as OperationMode);
                setKeyValue("");
              }}
              disabled={saving || !!snapshot.parseError}
            >
              <option value="preserve">{t("settings.webTools.preserve")}</option>
              <option value="replace">{t("settings.webTools.replace")}</option>
              <option value="clear">{t("settings.webTools.clear")}</option>
            </SettingsSelect>
          </SettingsField>

          {keyMode === "replace" && (
            <SettingsField label={t("settings.webTools.newKey")}>
              <SettingsInput
                type="password"
                autoComplete="new-password"
                value={keyValue}
                onChange={(event) => setKeyValue(event.target.value)}
                disabled={saving}
              />
            </SettingsField>
          )}

          {selectedProvider.baseUrlEnvVar && (
            <>
              <SettingsActionRow>
                <SettingsBadge tone={selectedProvider.baseUrlSource === "environment" ? "warning" : "neutral"}>
                  {t("settings.webTools.urlSource", { source: selectedProvider.baseUrlSource ?? "none" })}
                </SettingsBadge>
                <SettingsBadge>{selectedProvider.baseUrlEnvVar}</SettingsBadge>
              </SettingsActionRow>
              {selectedProvider.baseUrlSource === "environment" && (
                <SettingsNotice tone="warning">
                  {t("settings.webTools.urlEnvOverride", { env: selectedProvider.baseUrlEnvVar })}
                </SettingsNotice>
              )}
              <SettingsField label={t("settings.webTools.urlAction")}>
                <SettingsSelect
                  value={baseUrlMode}
                  onChange={(event) => setBaseUrlMode(event.target.value as OperationMode)}
                  disabled={saving || !!snapshot.parseError}
                >
                  <option value="preserve">{t("settings.webTools.preserve")}</option>
                  <option value="replace">{t("settings.webTools.replace")}</option>
                  <option value="clear">{t("settings.webTools.clear")}</option>
                </SettingsSelect>
              </SettingsField>
              {baseUrlMode === "replace" && (
                <SettingsField label={t("settings.webTools.baseUrl")}>
                  <SettingsInput
                    type="url"
                    value={baseUrlValue}
                    onChange={(event) => setBaseUrlValue(event.target.value)}
                    placeholder={selectedProvider.defaultBaseUrl}
                    disabled={saving}
                  />
                </SettingsField>
              )}
              <div className="settings-field-description">
                {t("settings.webTools.effectiveBaseUrl", { url: selectedProvider.baseUrl ?? "—" })}
              </div>
            </>
          )}
        </SettingsSurface>
      )}

      {snapshot.unknownRootKeys.length > 0 && (
        <SettingsNotice>
          {t("settings.webTools.unknownFieldsPreserved", { fields: snapshot.unknownRootKeys.join(", ") })}
        </SettingsNotice>
      )}

      <SettingsActionRow>
        <SettingsButton
          variant="primary"
          busy={saving}
          disabled={!!snapshot.parseError || (keyMode === "replace" && !keyValue.trim()) || (baseUrlMode === "replace" && !baseUrlValue.trim())}
          onClick={() => void save()}
        >
          {t("common.save")}
        </SettingsButton>
        <span className="settings-field-description">{t("settings.webTools.liveApplyHint")}</span>
      </SettingsActionRow>
    </SettingsSection>
  );
}
