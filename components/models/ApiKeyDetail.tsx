"use client";

import { useI18n } from "@/components/I18nProvider";
import { useState, useEffect, useCallback } from "react";
import type { DeepSeekBalanceResult } from "@/lib/deepseek-balance";
import type { ApiKeyProvider } from "./types";
import { Field, SectionTitle, SecretTextInput } from "./form-fields";

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

export function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const { t } = useI18n();
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
            {savedOk ? t("settings.models.saved") : saving ? t("settings.models.saving") : t("settings.models.save")}
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
