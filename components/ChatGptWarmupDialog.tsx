"use client";

import { useCallback, useMemo, useState } from "react";
import { formatQuotaQueriedAt, formatResetCountdown, knownQuotaTiers, QUOTA_TIER_LABELS } from "@/lib/quota-display";
import type { OAuthAccountSummary } from "@/lib/oauth-accounts";
import type { OpenAICodexWarmupResponse, OpenAICodexWarmupResult } from "@/lib/openai-codex-warmup";

interface Props {
  accounts: OAuthAccountSummary[];
  onClose: () => void;
  onComplete?: () => void | Promise<void>;
}

function defaultSelectedAccountIds(accounts: OAuthAccountSummary[]): string[] {
  const activeIds = accounts.filter((account) => account.active).map((account) => account.accountId);
  if (activeIds.length > 0) return activeIds;
  return accounts[0] ? [accounts[0].accountId] : [];
}

function accountQuotaText(account: OAuthAccountSummary): string {
  const quotaCache = account.quotaCache;
  if (!quotaCache) return "Quota not refreshed yet";
  if (quotaCache.error) return quotaCache.error;
  const knownTiers = knownQuotaTiers(quotaCache.tiers);
  if (knownTiers.length === 0) return "Reset time unknown";
  const resetParts = knownTiers.map((tier) => {
    const label = QUOTA_TIER_LABELS[tier.name] ?? tier.name;
    const countdown = formatResetCountdown(tier.resetsAt);
    return `${label}: ${countdown ? `resets in ${countdown}` : "reset unknown"}`;
  });
  const queriedAt = quotaCache.queriedAt ? ` · ${formatQuotaQueriedAt(quotaCache.queriedAt)}` : "";
  return `${resetParts.join(" · ")}${queriedAt}`;
}

function resultText(result: OpenAICodexWarmupResult | undefined): { text: string; color: string } {
  if (!result) return { text: "Ready", color: "var(--text-dim)" };
  if (!result.success) return { text: result.error ?? "Warmup failed", color: "#f87171" };
  if (!result.quotaRefreshSuccess) return { text: result.quotaError ? `Warmed · quota refresh failed: ${result.quotaError}` : "Warmed · quota refresh unavailable", color: "#fb923c" };
  return { text: `Warmed${result.latencyMs !== null ? ` · ${result.latencyMs}ms` : ""} · quota refreshed`, color: "#34d399" };
}

export function ChatGptWarmupDialog({ accounts, onClose, onComplete }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => defaultSelectedAccountIds(accounts));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, OpenAICodexWarmupResult>>({});

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedCount = selectedIds.length;
  const resultList = Object.values(results);
  const successCount = resultList.filter((result) => result.success).length;

  const toggleAccount = useCallback((accountId: string) => {
    setSelectedIds((prev) => prev.includes(accountId)
      ? prev.filter((id) => id !== accountId)
      : [...prev, accountId]);
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(accounts.map((account) => account.accountId));
  }, [accounts]);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const runWarmup = useCallback(async () => {
    if (running || selectedIds.length === 0) return;
    setRunning(true);
    setError(null);
    setResults({});
    try {
      const res = await fetch("/api/auth/warmup/openai-codex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountIds: selectedIds }),
      });
      const data = await res.json().catch(() => ({})) as OpenAICodexWarmupResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResults(Object.fromEntries(data.results.map((result) => [result.accountId, result])));
      await onComplete?.();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Warmup failed");
    } finally {
      setRunning(false);
    }
  }, [onComplete, running, selectedIds]);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}
    >
      <div style={{ width: 680, maxWidth: "calc(100vw - 32px)", maxHeight: "min(82vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 10px 36px rgba(0,0,0,0.28)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>ChatGPT account warmup</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>Send a tiny real Codex request to selected saved accounts without activating them.</div>
          </div>
          <button type="button" disabled={running} onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: running ? "not-allowed" : "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
        </div>

        <div style={{ padding: 14, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ padding: 10, borderRadius: 8, background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
            First implementation uses a fixed low-cost Codex warmup request. Tokens stay server-side; this dialog only receives per-account results.
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {accounts.length} saved · {selectedCount} selected{resultList.length > 0 ? ` · ${successCount}/${resultList.length} warmed` : ""}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={running || accounts.length === 0} onClick={selectAll} style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running || accounts.length === 0 ? "var(--text-dim)" : "var(--text-muted)", cursor: running || accounts.length === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>Select all</button>
              <button type="button" disabled={running || selectedCount === 0} onClick={clearSelection} style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running || selectedCount === 0 ? "var(--text-dim)" : "var(--text-muted)", cursor: running || selectedCount === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>Clear</button>
            </div>
          </div>

          {accounts.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5 }}>No saved ChatGPT/Codex accounts yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {accounts.map((account) => {
                const checked = selectedSet.has(account.accountId);
                const result = results[account.accountId];
                const status = resultText(result);
                return (
                  <label key={account.accountId} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, padding: "9px 10px", border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`, borderRadius: 8, background: checked ? "rgba(59,130,246,0.10)" : "var(--bg-panel)", cursor: running ? "default" : "pointer" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={running}
                      onChange={() => toggleAccount(account.accountId)}
                      style={{ marginTop: 2 }}
                    />
                    <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                        <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                        {account.active && <span style={{ color: "#4ade80", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>active</span>}
                      </span>
                      <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{account.maskedAccountId}</code>
                      {account.extraInfo && <span style={{ color: "var(--text-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
                      <span style={{ color: account.quotaCache?.error ? "#fb923c" : "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>{accountQuotaText(account)}</span>
                      <span style={{ color: status.color, fontSize: 11, lineHeight: 1.4 }}>{running && checked && !result ? "Warming sequentially…" : status.text}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {error && <div style={{ color: "#f87171", fontSize: 12, lineHeight: 1.5 }}>{error}</div>}
        </div>

        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" disabled={running} onClick={onClose} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running ? "var(--text-dim)" : "var(--text-muted)", cursor: running ? "not-allowed" : "pointer", fontSize: 12 }}>Close</button>
          <button type="button" disabled={running || selectedCount === 0} onClick={runWarmup} style={{ padding: "6px 14px", background: !running && selectedCount > 0 ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 6, color: !running && selectedCount > 0 ? "#fff" : "var(--text-dim)", cursor: !running && selectedCount > 0 ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 800 }}>{running ? "Warming…" : "Warm selected"}</button>
        </div>
      </div>
    </div>
  );
}
