"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  SettingsBadge,
  SettingsButton,
  SettingsInput,
  SettingsState,
} from "@/components/ui/SettingsPrimitives";
import type { ApiKeyProvider, OAuthProvider } from "./types";
import { ProviderIcon } from "./provider-icons";

// ── Add provider picker ───────────────────────────────────────────────────────

export interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

export function AddProviderPicker({
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

  return (
    <div className="pi-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pi-modal-panel models-provider-picker">
        {/* Search */}
        <div className="models-provider-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <SettingsInput ref={inputRef} type="search" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }} placeholder="Search providers…" />
        </div>

        {/* Card grid */}
        <div className="models-provider-picker-body">
          {totalCount === 0 ? (
            <SettingsState title="No providers match" />
          ) : (
            <div className="models-provider-grid">
              {showCustom && (
                <div className="models-provider-group-label">Custom</div>
              )}
              {showCustom && (
                <button onClick={() => { onAddCustom(); onClose(); }} className="models-provider-card">
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
                <div className="models-provider-group-label">Subscriptions</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }} className="models-provider-card">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div className="models-provider-group-label">API Key</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }} className="models-provider-card">
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

export function PricingSyncStatus() {
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
    <div className="models-pricing-sync" title={label}>
      {phase.kind === "success" && (
        <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          {phase.providerCount}/{phase.modelCount}
        </span>
      )}
      {phase.kind === "error" && <SettingsBadge tone="danger">{phase.message}</SettingsBadge>}
      <SettingsButton size="icon" onClick={handleSync} busy={phase.kind === "loading"} title={phase.kind === "loading" ? "Syncing…" : "Sync pricing from pi.dev"} aria-label={phase.kind === "loading" ? "Syncing pricing" : "Sync pricing"}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
          <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
          <path d="M3 4v8h8" />
          <path d="M21 20v-8h-8" />
        </svg>
      </SettingsButton>
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
