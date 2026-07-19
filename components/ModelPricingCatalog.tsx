"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

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
      style={{ position: "fixed", inset: 0, zIndex: 1250, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{ width: "min(980px, calc(100vw - 32px))", height: "min(760px, calc(100dvh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 16px 48px rgba(0,0,0,0.28)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Pricing catalog</div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>
              {providerCount} providers · {modelCount} models · {formatSyncedAt(syncedAt)}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close pricing catalog" style={{ width: 30, height: 30, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(160px, 240px)", gap: 8, flexShrink: 0 }}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search provider or model"
            aria-label="Search pricing catalog"
            style={{ minWidth: 0, height: 34, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, outline: "none" }}
          />
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            aria-label="Filter pricing provider"
            style={{ minWidth: 0, height: 34, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", fontSize: 12 }}
          >
            <option value="">All providers</option>
            {providers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>

        <div style={{ minHeight: 0, flex: 1, overflow: "auto" }}>
          {loading ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 12 }}>Loading…</div>
          ) : error ? (
            <div style={{ padding: 24, color: "#f87171", fontSize: 12 }}>{error}</div>
          ) : items.length === 0 ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontSize: 12 }}>No synced pricing catalog.</div>
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
