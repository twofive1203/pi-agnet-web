"use client";

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

function formatSyncedAt(value: number | null): string {
  if (!value) return "Not synced";
  return new Date(value).toLocaleString();
}

export function ModelPricingCatalog({ onClose }: Props) {
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
            <div id="pricing-catalog-title" className="pi-modal-title">Pricing catalog</div>
            <div className="pi-modal-subtitle">
              {providerCount} providers · {modelCount} models · {formatSyncedAt(syncedAt)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close pricing catalog" className="pi-modal-close">×</button>
        </div>

        <div className="pricing-catalog-filters">
          <SettingsInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search provider or model"
            aria-label="Search pricing catalog"
          />
          <SettingsSelect
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label="Filter pricing provider"
          >
            <option value="">All providers</option>
            {providers.map((name) => <option key={name} value={name}>{name}</option>)}
          </SettingsSelect>
        </div>

        <div style={{ minHeight: 0, flex: 1, overflow: "auto" }}>
          {loading ? (
            <SettingsState kind="loading" title="Loading…" className="pricing-catalog-state" />
          ) : error ? (
            <SettingsState kind="error" title={error} className="pricing-catalog-state" />
          ) : items.length === 0 ? (
            <SettingsState title="No synced pricing catalog." className="pricing-catalog-state" />
          ) : (
            <table style={{ width: "100%", minWidth: 860, borderCollapse: "collapse", tableLayout: "fixed", fontSize: 11 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 1, background: "var(--bg-panel)" }}>
                <tr>
                  {[
                    ["Provider", "15%"], ["Model", "29%"], ["Context", "12%"], ["Input", "11%"], ["Output", "11%"], ["Cache read", "11%"], ["Cache write", "11%"],
                  ].map(([label, width]) => (
                    <th key={label} style={{ width, padding: "8px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600, textAlign: label === "Provider" || label === "Model" ? "left" : "right" }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => (
                  <tr key={`${item.provider}:${item.model}`}>
                    <td style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", overflowWrap: "anywhere" }}>{item.provider}</td>
                    <td style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{item.model}</td>
                    <td style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.contextWindow?.toLocaleString() ?? "—"}</td>
                    {[item.input, item.output, item.cacheRead, item.cacheWrite].map((value, index) => (
                      <td key={index} style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatPrice(value)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {!loading && !error && items.length > 0 && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, textAlign: "right", flexShrink: 0 }}>
            {filteredItems.length} / {items.length}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
