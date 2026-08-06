"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import {
  findWeeklyQuotaTier,
  formatQuotaQueriedAt,
  formatResetCountdown,
  knownQuotaTiers,
  quotaColor,
  QUOTA_TIER_LABELS,
  type QuotaDisplayTier,
} from "@/lib/quota-display";
import type { GrokUsageResult } from "@/lib/grok-usage";

// Grok credentials may live under either provider key; list and activate both stores.
const GROK_ACCOUNT_PROVIDERS = ["grok-cli", "xai"] as const;

interface GrokAccountQuotaCache {
  success: boolean;
  tiers: Array<{ name: string; utilization: number; resetsAt: string | null }>;
  error: string | null;
  queriedAt: number | null;
}

interface GrokAccountSummary {
  accountId: string;
  label?: string;
  extraInfo?: string;
  displayName: string;
  maskedAccountId: string;
  active: boolean;
  provider: string;
  quotaCache?: GrokAccountQuotaCache;
}

interface GrokAccountsResponse {
  provider: string;
  activeAccountId: string | null;
  accounts: Omit<GrokAccountSummary, "provider">[];
  error?: string;
}

interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  lockOwned: boolean;
  nextRunAt: number | null;
  lastRunStartedAt: number | null;
  lastRunFinishedAt: number | null;
  lastError: string | null;
  lastAccountId: string | null;
  lastAccountError: string | null;
  lock: {
    path: string;
    exists: boolean;
    ownedByCurrentProcess: boolean;
    stale: boolean;
    staleAfterMs: number;
    ageMs: number | null;
    error?: string;
  };
  error?: string;
}

const ACCOUNT_CACHE_POLL_INTERVAL_MS = 30_000;

function formatTime(value: number | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function UsagePie({ tier, label, size = 18 }: { tier: QuotaDisplayTier | null; label?: string; size?: number }) {
  const utilization = tier ? Math.min(Math.max(tier.utilization, 0), 100) : 0;
  const color = tier ? quotaColor(utilization) : "var(--text-dim)";
  const background = tier
    ? `conic-gradient(${color} ${utilization * 3.6}deg, rgba(148,163,184,0.18) 0deg)`
    : "conic-gradient(rgba(148,163,184,0.25) 0deg, rgba(148,163,184,0.25) 360deg)";

  return (
    <span title={tier ? `${label ?? tier.name} ${Math.round(utilization)}% used` : "Unknown usage"} className="usage-pie-wrap">
      <span className="usage-pie" style={{ width: size, height: size, background }}>
        <span className="usage-pie-center" style={{ width: Math.max(6, Math.floor(size * 0.48)), height: Math.max(6, Math.floor(size * 0.48)) }} />
      </span>
      {label && <span className="usage-pie-label">{label}</span>}
    </span>
  );
}

function accountQuotaSummary(account: GrokAccountSummary): string {
  const cache = account.quotaCache;
  if (!cache?.queriedAt) return "No quota cache";
  if (cache.error) return cache.error;
  const tiers = knownQuotaTiers(cache.tiers ?? []);
  if (tiers.length === 0) return formatQuotaQueriedAt(cache.queriedAt);
  return tiers.map((tier) => `${QUOTA_TIER_LABELS[tier.name]} ${Math.round(tier.utilization)}%`).join(" · ");
}

function weeklyTierFromUsage(result: GrokUsageResult | null): QuotaDisplayTier | null {
  if (!result?.weekly) return null;
  return {
    name: "seven_day",
    utilization: result.weekly.creditUsagePercent,
    resetsAt: result.weekly.billingPeriodEnd,
  };
}

export function GrokUsagePanel() {
  const { t } = useI18n();
  const appDialog = useAppDialog();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const [usageResult, setUsageResult] = useState<GrokUsageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<GrokAccountSummary[]>([]);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [activatingAccountId, setActivatingAccountId] = useState<string | null>(null);
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [repairingLock, setRepairingLock] = useState(false);

  const updatePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPosition({
      top: rect.bottom,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const lists = await Promise.all(GROK_ACCOUNT_PROVIDERS.map(async (providerId) => {
        const res = await fetch(`/api/auth/accounts/${providerId}`);
        const data = await res.json().catch(() => ({})) as GrokAccountsResponse;
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        return (data.accounts ?? []).map((account) => ({ ...account, provider: providerId }));
      }));
      setAccountsError(null);
      setAccounts(lists.flat());
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to load Grok accounts");
    }
  }, []);

  const loadUsage = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const mode = forceRefresh ? "refresh" : "cache";
      const res = await fetch(`/api/auth/usage/grok-cli?mode=${mode}${forceRefresh ? `&_=${Date.now()}` : ""}`, {
        cache: "no-store",
      });
      const data = await res.json() as GrokUsageResult & { error?: string };
      if (data.success && data.monthly) {
        setError(null);
        setUsageResult(data);
        // Active refresh writes weekly quotaCache onto the active saved account.
        if (forceRefresh) void loadAccounts();
        return;
      }
      // Keep previous successful result in memory on live failure / empty cache.
      if (data.error) setError(data.error);
      setUsageResult((prev) => {
        if (prev?.success && prev.monthly && forceRefresh) return prev;
        return data;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Usage query failed");
      if (!forceRefresh) setUsageResult(null);
    } finally {
      setLoading(false);
    }
  }, [loadAccounts]);

  // Load cache on mount
  useEffect(() => {
    void loadUsage(false);
  }, [loadUsage]);

  const loadSchedulerStatus = useCallback(async (signal?: AbortSignal) => {
    setSchedulerError(null);
    try {
      const res = await fetch("/api/grok/usage-refresh/status", { signal });
      const data = await res.json().catch(() => ({})) as SchedulerStatus;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerStatus(data);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setSchedulerError(err instanceof Error ? err.message : String(err));
      setSchedulerStatus(null);
    }
  }, []);

  const activateAccount = useCallback(async (account: GrokAccountSummary) => {
    setActivatingAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${account.provider}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId }),
      });
      const data = await res.json().catch(() => ({})) as GrokAccountsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadAccounts();
      // The usage cache still holds the previous account; refresh billing for the new one.
      void loadUsage(true);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to activate account");
    } finally {
      setActivatingAccountId(null);
    }
  }, [loadAccounts, loadUsage]);

  const repairLock = useCallback(async () => {
    const ok = await appDialog.confirm({ message: t("panels.grok.fixLockConfirm"), tone: "danger" });
    if (!ok) return;
    setRepairingLock(true);
    setSchedulerError(null);
    try {
      const res = await fetch("/api/grok/usage-refresh/repair-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => ({})) as SchedulerStatus;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerStatus(data);
    } catch (err) {
      setSchedulerError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairingLock(false);
    }
  }, [appDialog, t]);

  useEffect(() => {
    // Models can refresh the shared cache while this long-lived top-bar component stays mounted.
    if (!open) return;
    void loadUsage(false);
    void loadAccounts();
    void loadSchedulerStatus();
  }, [open, loadAccounts, loadUsage, loadSchedulerStatus]);

  useEffect(() => {
    if (!open) return;
    let controller: AbortController | null = null;
    const refreshSilently = () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      void loadAccounts();
      void loadUsage(false);
      void loadSchedulerStatus(controller.signal);
    };
    const interval = window.setInterval(refreshSilently, ACCOUNT_CACHE_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) refreshSilently();
    };
    window.addEventListener("focus", refreshSilently);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      controller?.abort();
      window.removeEventListener("focus", refreshSilently);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [open, loadAccounts, loadUsage, loadSchedulerStatus]);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;

    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    updatePanelPosition();
    document.addEventListener("pointerdown", handleOutsideInteraction, true);
    document.addEventListener("focusin", handleOutsideInteraction, true);
    document.addEventListener("scroll", updatePanelPosition, true);
    window.addEventListener("resize", updatePanelPosition);
    window.visualViewport?.addEventListener("resize", updatePanelPosition);
    window.visualViewport?.addEventListener("scroll", updatePanelPosition);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsideInteraction, true);
      document.removeEventListener("focusin", handleOutsideInteraction, true);
      document.removeEventListener("scroll", updatePanelPosition, true);
      window.removeEventListener("resize", updatePanelPosition);
      window.visualViewport?.removeEventListener("resize", updatePanelPosition);
      window.visualViewport?.removeEventListener("scroll", updatePanelPosition);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updatePanelPosition]);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.active) ?? null,
    [accounts],
  );
  // Prefer live weekly; fall back to active account's cached seven_day tier (same path as GPT).
  const weeklyTier = useMemo(() => {
    const fromLive = weeklyTierFromUsage(usageResult);
    if (fromLive) return fromLive;
    return findWeeklyQuotaTier(activeAccount?.quotaCache?.tiers ?? []) ?? null;
  }, [usageResult, activeAccount]);
  const knownTiers = useMemo(() => (weeklyTier ? [weeklyTier] : []), [weeklyTier]);
  const monthly = usageResult?.monthly ?? null;
  const refreshText = usageResult?.queriedAt
    ? formatQuotaQueriedAt(usageResult.queriedAt)
    : activeAccount?.quotaCache?.queriedAt
      ? formatQuotaQueriedAt(activeAccount.quotaCache.queriedAt)
      : "Not queried";
  const compactStatus = loading ? "Loading" : error ? "Error" : refreshText;

  return (
    <div className="usage-panel-anchor">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) updatePanelPosition();
          setOpen((value) => !value);
        }}
        title="Grok usage"
        aria-label="Grok usage"
        aria-expanded={open}
        aria-controls="grok-usage-popover"
        className="usage-panel-trigger"
      >
        <span className="usage-panel-trigger-name">Grok</span>
        <span className="usage-panel-trigger-status">{compactStatus}</span>
        <span className="usage-panel-pies">
          {knownTiers.length > 0 ? knownTiers.map((tier) => (
            <UsagePie key={tier.name} tier={tier} label={QUOTA_TIER_LABELS[tier.name]} />
          )) : <UsagePie tier={null} />}
        </span>
      </button>

      {open && panelPosition && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          id="grok-usage-popover"
          className="grok-usage-popover usage-popover"
          role="dialog"
          aria-label="Grok usage details"
          style={{ top: panelPosition.top, right: panelPosition.right, maxHeight: `min(650px, calc(100dvh - ${panelPosition.top + 8}px))` }}
        >
          <div className="usage-popover-header">
            <div className="resource-list-copy">
              <div className="usage-popover-title">Grok usage</div>
              <div className="usage-popover-meta">{loading ? "Loading…" : `Updated: ${refreshText}`}</div>
            </div>
            <button
              type="button"
              onClick={() => void loadUsage(true)}
              disabled={loading}
              title="Refresh Grok usage"
              aria-label="Refresh Grok usage"
              className="usage-icon-button"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
                <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
                <path d="M3 4v8h8" />
                <path d="M21 20v-8h-8" />
              </svg>
            </button>
          </div>

          {error && (
            <div className="usage-text-danger">{error}</div>
          )}

          {activeAccount && (
            <div className="usage-card">
              <div className="usage-card-header">
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeAccount.displayName}</span>
                <span style={{ color: "#22c55e", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>Active</span>
              </div>
              <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{activeAccount.provider} · {activeAccount.maskedAccountId}</code>
              {activeAccount.extraInfo && <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{activeAccount.extraInfo}</div>}
            </div>
          )}

          {knownTiers.length === 0 ? (
            <div className="usage-card usage-card-row">
              <UsagePie tier={null} size={34} />
              <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.45 }}>
                Weekly usage unknown. Click refresh to query xAI billing.
                {!usageResult?.configured && !usageResult?.envBypass && (
                  <> Make sure Grok is logged in via Models → xAI or Grok CLI, or set GROK_CLI_OAUTH_TOKEN.</>
                )}
              </div>
            </div>
          ) : (
            <div className="usage-card-list">
              {knownTiers.map((tier) => {
                const utilization = Math.min(Math.max(tier.utilization, 0), 100);
                const color = quotaColor(utilization);
                const countdown = formatResetCountdown(tier.resetsAt);
                return (
                  <div key={tier.name} className="usage-quota-row">
                    <UsagePie tier={tier} label={QUOTA_TIER_LABELS[tier.name]} size={30} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{QUOTA_TIER_LABELS[tier.name]} window</span>
                      <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{countdown ? `Resets in ${countdown}` : "Reset time unknown"}</span>
                    </div>
                    <span style={{ color, fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{Math.round(utilization)}%</span>
                  </div>
                );
              })}
            </div>
          )}

          {monthly && (
            <div className="usage-quota-row">
              <UsagePie
                tier={{ name: "monthly", utilization: monthly.utilization, resetsAt: monthly.billingPeriodEnd }}
                size={30}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Monthly credits</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  Used {monthly.used.toLocaleString()} · Limit {monthly.monthlyLimit.toLocaleString()} · Remaining {monthly.remaining.toLocaleString()}
                  {monthly.billingPeriodEnd && (
                    <> · Resets {new Date(monthly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>
                  )}
                </span>
              </div>
              <span style={{ color: quotaColor(monthly.utilization), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                {Math.round(monthly.utilization)}%
              </span>
            </div>
          )}

          <div className="usage-section">
            <div className="usage-section-title">Accounts</div>
            {accountsError && <div style={{ color: "#f87171", fontSize: 11, lineHeight: 1.45 }}>{accountsError}</div>}
            {accounts.length === 0 ? (
              <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.45 }}>No saved accounts. Add one in Models → Grok CLI / xAI.</div>
            ) : accounts.map((item) => (
              <div key={`${item.provider}:${item.accountId}`} className={`usage-account-row${item.active ? " usage-account-row-active" : ""}`}>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.displayName}</span>
                  <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.provider} · {item.maskedAccountId}</code>
                  {item.extraInfo && <span style={{ color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.extraInfo}</span>}
                  <span style={{ color: item.quotaCache?.error ? "#fb923c" : "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accountQuotaSummary(item)}</span>
                </div>
                {item.active ? <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 800 }}>active</span> : (
                  <button type="button" onClick={() => void activateAccount(item)} disabled={Boolean(activatingAccountId)} style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: activatingAccountId === item.accountId ? "var(--text-dim)" : "var(--accent)", cursor: activatingAccountId ? "default" : "pointer", fontSize: 11, fontWeight: 700 }}>
                    {activatingAccountId === item.accountId ? "Switching…" : "Activate"}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div style={{ padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.06)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 800 }}>Auto refresh</span>
              <button type="button" onClick={() => void loadSchedulerStatus()} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "4px 7px" }}>Reload</button>
            </div>
            {schedulerError && <div style={{ color: "#f87171", fontSize: 11, lineHeight: 1.45 }}>{schedulerError}</div>}
            {schedulerStatus ? (
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.55 }}>
                <div>Enabled: {schedulerStatus.enabled ? "yes" : "no"} · Running: {schedulerStatus.running ? "yes" : "no"} · Lock: {schedulerStatus.lockOwned ? "owned" : schedulerStatus.lock.stale ? "stale" : schedulerStatus.lock.exists ? "held" : "none"}</div>
                <div>Next: {formatTime(schedulerStatus.nextRunAt)} · Last: {formatTime(schedulerStatus.lastRunFinishedAt)}</div>
                {schedulerStatus.lastError && <div style={{ color: "#f87171" }}>Last error: {schedulerStatus.lastError}</div>}
                {schedulerStatus.lastAccountError && <div style={{ color: "#fb923c" }}>Account error: {schedulerStatus.lastAccountError}</div>}
              </div>
            ) : <div style={{ color: "var(--text-dim)", fontSize: 11 }}>Scheduler status unavailable.</div>}
            <button type="button" onClick={() => void repairLock()} disabled={repairingLock} style={{ alignSelf: "flex-start", padding: "5px 9px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.35)", background: "transparent", color: repairingLock ? "var(--text-dim)" : "#f87171", cursor: repairingLock ? "default" : "pointer", fontSize: 11, fontWeight: 700 }}>
              {repairingLock ? "Repairing…" : "故障处理：修复刷新锁"}
            </button>
          </div>

          {usageResult?.envBypass && (
            <div style={{ color: "#fb923c", fontSize: 10, lineHeight: 1.5 }}>Using GROK_CLI_OAUTH_TOKEN environment variable. Env bypass is not auto-refreshed per saved account.</div>
          )}
        </div>
      ), document.body)}
    </div>
  );
}
