"use client";

import { useI18n } from "@/components/I18nProvider";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SettingsInput, SettingsSelect, SettingsState } from "@/components/ui/SettingsPrimitives";

interface PricingCatalogItem {
  provider: string;
  model: string;
  contextWindow?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface PricingCatalogResponse {
  ok: boolean;
  syncedAt?: number | null;
  providerCount?: number;
  modelCount?: number;
  items?: PricingCatalogItem[];
  error?: string;
}

interface Props {
  onClose: () => void;
}

const catalogCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function formatPrice(value: number): string {
  return `$${value}`;
}

function formatSyncedAt(value: number | null, t: (key: string) => string): string {
  if (!value) return t("panels.pricing.notSynced");
  return new Date(value).toLocaleString();
}

export function ModelPricingCatalog({ onClose }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<PricingCatalogItem[]>([]);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [providerCount, setProviderCount] = useState(0);
  const [modelCount, setModelCount] = useState(0);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/model-pricing?catalog=1")
      .then(async (response) => {
        const data = await response.json() as PricingCatalogResponse;
        if (!response.ok || !data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setItems(data.items ?? []);
        setSyncedAt(data.syncedAt ?? null);
        setProviderCount(data.providerCount ?? 0);
        setModelCount(data.modelCount ?? 0);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const providers = useMemo(
    () => [...new Set(items.map((item) => item.provider))].sort(catalogCollator.compare),
    [items],
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (provider && item.provider !== provider) return false;
      if (!normalizedQuery) return true;
      return item.provider.toLowerCase().includes(normalizedQuery)
        || item.model.toLowerCase().includes(normalizedQuery);
    });
  }, [items, provider, query]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="pi-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pricing-catalog-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="pi-modal-panel pi-modal-panel-wide pricing-catalog-panel">
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id="pricing-catalog-title" className="pi-modal-title">{t("panels.pricing.title")}</div>
            <div className="pi-modal-subtitle">
              {providerCount} providers · {modelCount} models · {formatSyncedAt(syncedAt, t)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("panels.pricing.closeAria")} className="pi-modal-close">×</button>
        </div>

        <div className="pricing-catalog-filters">
          <SettingsInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("panels.pricing.searchPlaceholder")}
            aria-label={t("panels.pricing.searchAria")}
          />
          <SettingsSelect
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label={t("panels.pricing.filterAria")}
          >
            <option value="">{t("panels.pricing.allProviders")}</option>
            {providers.map((name) => <option key={name} value={name}>{name}</option>)}
          </SettingsSelect>
        </div>

        <div className="pricing-catalog-table-wrap">
          {loading ? (
            <SettingsState kind="loading" title={t("panels.pricing.loading")} className="pricing-catalog-state" />
          ) : error ? (
            <SettingsState kind="error" title={error} className="pricing-catalog-state" />
          ) : items.length === 0 ? (
            <SettingsState title={t("panels.pricing.empty")} className="pricing-catalog-state" />
          ) : (
            <table className="pricing-catalog-table">
              <thead>
                <tr>
                  {[
                    ["Provider", "15%"], ["Model", "29%"], ["Context", "12%"], ["Input", "11%"], ["Output", "11%"], ["Cache read", "11%"], ["Cache write", "11%"],
                  ].map(([label, width]) => (
                    <th key={label} style={{ width }} className={label === "Provider" || label === "Model" ? "pricing-cell-left" : "pricing-cell-number"}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={`${item.provider}:${item.model}`}>
                    <td className="pricing-cell-provider">{item.provider}</td>
                    <td className="pricing-cell-model">{item.model}</td>
                    <td className="pricing-cell-number">{item.contextWindow?.toLocaleString() ?? "—"}</td>
                    {[item.input, item.output, item.cacheRead, item.cacheWrite].map((value, index) => (
                      <td key={index} className="pricing-cell-number">{formatPrice(value)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {!loading && !error && items.length > 0 && (
          <div className="pricing-catalog-footer">
            {filteredItems.length} / {items.length}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
