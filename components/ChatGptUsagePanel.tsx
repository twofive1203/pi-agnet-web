"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import { earliestResetCreditExpiration, formatQuotaQueriedAt, formatResetCountdown, knownQuotaTiers, quotaColor, QUOTA_TIER_LABELS, type CodexResetCreditDisplay, type QuotaDisplayTier } from "@/lib/quota-display";

type CredentialStatus = "valid" | "expired" | "not_found" | "parse_error";

interface OAuthAccountQuotaCache {
  success: boolean;
  tiers: QuotaDisplayTier[];
  error: string | null;
  queriedAt: number | null;
  resetCreditsAvailableCount: number | null;
  resetCredits: CodexResetCreditDisplay[];
  resetCreditsError: string | null;
}

interface OAuthAccountSummary {
  accountId: string;
  label?: string;
  extraInfo?: string;
  quotaCache?: OAuthAccountQuotaCache;
  displayName: string;
  maskedAccountId: string;
  active: boolean;
}

interface OAuthAccountsResponse {
  provider: string;
  activeAccountId: string | null;
  accounts: OAuthAccountSummary[];
  error?: string;
}

interface SubscriptionQuota {
  tool: string;
  credentialStatus: CredentialStatus;
  credentialMessage: string | null;
  success: boolean;
  tiers: QuotaDisplayTier[];
  error: string | null;
  queriedAt: number | null;
  resetCreditsAvailableCount: number | null;
  resetCredits: CodexResetCreditDisplay[];
  resetCreditsError: string | null;
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

function UsagePie({ tier, label, size = 18, title }: { tier: QuotaDisplayTier | null; label?: string; size?: number; title?: string }) {
  const utilization = tier ? Math.min(Math.max(tier.utilization, 0), 100) : 0;
  const color = tier ? quotaColor(utilization) : "var(--text-dim)";
  const background = tier
    ? `conic-gradient(${color} ${utilization * 3.6}deg, rgba(148,163,184,0.18) 0deg)`
    : "conic-gradient(rgba(148,163,184,0.25) 0deg, rgba(148,163,184,0.25) 360deg)";

  return (
    <span title={title} className="usage-pie-wrap">
      <span className="usage-pie" style={{ width: size, height: size, background }}>
        <span className="usage-pie-center" style={{ width: Math.max(6, Math.floor(size * 0.48)), height: Math.max(6, Math.floor(size * 0.48)) }} />
      </span>
      {label && <span className="usage-pie-label">{label}</span>}
    </span>
  );
}

function selectActiveAccount(data: OAuthAccountsResponse): OAuthAccountSummary | null {
  return data.accounts.find((account) => account.active) ?? data.accounts.find((account) => account.accountId === data.activeAccountId) ?? null;
}

function accountQuotaSummary(
  account: OAuthAccountSummary,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const cache = account.quotaCache;
  if (!cache?.queriedAt) return t("panels.chatgpt.noQuotaCache");
  if (cache.error) return cache.error;
  const resetCreditsText = typeof cache.resetCreditsAvailableCount === "number"
    ? t("panels.chatgpt.credits", { count: cache.resetCreditsAvailableCount })
    : null;
  const tiers = knownQuotaTiers(cache.tiers ?? []);
  if (tiers.length === 0) return resetCreditsText ? `${formatQuotaQueriedAt(cache.queriedAt)} · ${resetCreditsText}` : formatQuotaQueriedAt(cache.queriedAt);
  const tiersText = tiers.map((tier) => `${QUOTA_TIER_LABELS[tier.name]} ${Math.round(tier.utilization)}%`).join(" · ");
  return resetCreditsText ? `${tiersText} · ${resetCreditsText}` : tiersText;
}

function formatTime(value: number | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function ChatGptUsagePanel() {
  const { t } = useI18n();
  const appDialog = useAppDialog();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const [account, setAccount] = useState<OAuthAccountSummary | null>(null);
  const [accounts, setAccounts] = useState<OAuthAccountSummary[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [activatingAccountId, setActivatingAccountId] = useState<string | null>(null);
  const [quotaResult, setQuotaResult] = useState<SubscriptionQuota | null>(null);
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

  const loadAccounts = useCallback(async (signal?: AbortSignal, options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!silent) {
      setAccountsLoading(true);
      setAccountsError(null);
    }
    try {
      const res = await fetch("/api/auth/accounts/openai-codex", { signal });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccountsError(null);
      setAccounts(data.accounts ?? []);
      setAccount(selectActiveAccount(data));
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      if (!silent) {
        setAccountsError(error instanceof Error ? error.message : String(error));
        setAccounts([]);
        setAccount(null);
      }
    } finally {
      if (!silent) setAccountsLoading(false);
    }
  }, []);

  const loadSchedulerStatus = useCallback(async (signal?: AbortSignal) => {
    setSchedulerError(null);
    try {
      const res = await fetch("/api/chatgpt/usage-refresh/status", { signal });
      const data = await res.json().catch(() => ({})) as SchedulerStatus;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerStatus(data);
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      setSchedulerError(error instanceof Error ? error.message : String(error));
      setSchedulerStatus(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadAccounts(controller.signal);
    return () => controller.abort();
  }, [loadAccounts]);

  useEffect(() => {
    let controller: AbortController | null = null;
    const refreshSilently = () => {
      if (document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      void loadAccounts(controller.signal, { silent: true });
    };

    const interval = window.setInterval(refreshSilently, ACCOUNT_CACHE_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (!document.hidden) refreshSilently();
    };
    window.addEventListener("focus", refreshSilently);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshSilently);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      controller?.abort();
    };
  }, [loadAccounts]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadAccounts(controller.signal);
    void loadSchedulerStatus(controller.signal);
    return () => controller.abort();
  }, [open, loadAccounts, loadSchedulerStatus]);

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

  const refreshQuota = useCallback(async () => {
    if (resetting) return;
    setRefreshing(true);
    setQuotaResult(null);
    try {
      const res = await fetch("/api/auth/quota/openai-codex");
      const data = await res.json() as SubscriptionQuota;
      setQuotaResult(data);
      await loadAccounts();
    } catch (error) {
      setQuotaResult({
        tool: "openai-codex",
        credentialStatus: "valid",
        credentialMessage: error instanceof Error ? error.message : String(error),
        success: false,
        tiers: [],
        error: error instanceof Error ? error.message : "Usage query failed",
        queriedAt: Date.now(),
        resetCreditsAvailableCount: null,
        resetCredits: [],
        resetCreditsError: null,
      });
    } finally {
      setRefreshing(false);
    }
  }, [loadAccounts, resetting]);

  const resetQuota = useCallback(async () => {
    if (!account || resetting) return;
    const ok = await appDialog.confirm({ message: t("panels.chatgpt.resetConfirm"), tone: "danger" });
    if (!ok) return;

    setResetting(true);
    setQuotaResult(null);
    try {
      const res = await fetch("/api/auth/quota/openai-codex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId }),
      });
      const data = await res.json().catch(() => ({})) as SubscriptionQuota & { error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? data.credentialMessage ?? `HTTP ${res.status}`);
      setQuotaResult(data);
      await loadAccounts();
    } catch (error) {
      setQuotaResult({
        tool: "openai-codex",
        credentialStatus: "valid",
        credentialMessage: error instanceof Error ? error.message : String(error),
        success: false,
        tiers: [],
        error: error instanceof Error ? error.message : "Reset failed",
        queriedAt: Date.now(),
        resetCreditsAvailableCount: null,
        resetCredits: [],
        resetCreditsError: null,
      });
    } finally {
      setResetting(false);
    }
  }, [account, loadAccounts, resetting, appDialog, t]);

  const activateAccount = useCallback(async (accountId: string) => {
    setActivatingAccountId(accountId);
    setAccountsError(null);
    try {
      const res = await fetch("/api/auth/accounts/openai-codex/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setAccount(selectActiveAccount(data));
      setQuotaResult(null);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivatingAccountId(null);
    }
  }, []);

  const repairLock = useCallback(async () => {
    const ok = await appDialog.confirm({ message: t("panels.chatgpt.fixLockConfirm"), tone: "danger" });
    if (!ok) return;
    setRepairingLock(true);
    setSchedulerError(null);
    try {
      const res = await fetch("/api/chatgpt/usage-refresh/repair-lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      const data = await res.json().catch(() => ({})) as SchedulerStatus;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSchedulerStatus(data);
    } catch (error) {
      setSchedulerError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairingLock(false);
    }
  }, [appDialog, t]);

  const quotaCache = account?.quotaCache ?? null;
  const displayedQuota = quotaResult?.success ? quotaResult : quotaCache;
  const knownTiers = useMemo(() => knownQuotaTiers(displayedQuota?.tiers ?? []), [displayedQuota?.tiers]);
  const refreshText = displayedQuota?.queriedAt ? formatQuotaQueriedAt(displayedQuota.queriedAt) : t("panels.chatgpt.unknown");
  const compactStatus = accountsLoading
    ? t("panels.chatgpt.loading")
    : accountsError
      ? t("panels.chatgpt.error")
      : !account
        ? t("panels.chatgpt.noAccount")
        : displayedQuota?.error
          ? t("panels.chatgpt.error")
          : refreshText;
  const resetCreditsAvailableCount = displayedQuota?.resetCreditsAvailableCount ?? null;
  const resetCredits = displayedQuota?.resetCredits ?? [];
  const resetCreditsError = displayedQuota?.resetCreditsError ?? null;
  const resetExpiresAt = earliestResetCreditExpiration(resetCredits);
  const resetExpiresCountdown = formatResetCountdown(resetExpiresAt);

  return (
    <div className="usage-panel-anchor">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) updatePanelPosition();
          setOpen((value) => !value);
        }}
        title={t("panels.chatgpt.title")}
        aria-label={t("panels.chatgpt.title")}
        aria-expanded={open}
        aria-controls="chatgpt-usage-popover"
        className="usage-panel-trigger"
      >
        <span className="usage-panel-trigger-name">GPT</span>
        <span className="usage-panel-trigger-status">{compactStatus}</span>
        <span className="usage-panel-pies">
          {knownTiers.length > 0 ? knownTiers.map((tier) => (
            <UsagePie
              key={tier.name}
              tier={tier}
              label={QUOTA_TIER_LABELS[tier.name]}
              title={t("panels.chatgpt.usedPercent", { label: QUOTA_TIER_LABELS[tier.name], n: Math.round(tier.utilization) })}
            />
          )) : <UsagePie tier={null} title={t("panels.chatgpt.unknownUsage")} />}
        </span>
      </button>

      {open && panelPosition && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          id="chatgpt-usage-popover"
          className="chatgpt-usage-popover usage-popover"
          role="dialog"
          aria-label={t("panels.chatgpt.detailsAria")}
          style={{ top: panelPosition.top, right: panelPosition.right, maxHeight: `min(680px, calc(100dvh - ${panelPosition.top + 8}px))` }}
        >
          <div className="usage-popover-header">
            <div className="resource-list-copy">
              <div className="usage-popover-title">{t("panels.chatgpt.title")}</div>
              <div className="usage-popover-meta">{t("panels.chatgpt.updated", { time: refreshText })}</div>
            </div>
            <div className="settings-action-group">
              {account && (resetCreditsAvailableCount ?? 0) > 0 && (
                <button type="button" onClick={resetQuota} disabled={refreshing || resetting} title={resetExpiresCountdown ? t("panels.chatgpt.resetCreditCountdown", { countdown: resetExpiresCountdown }) : t("panels.chatgpt.resetCreditTitle")} style={{ height: 30, padding: "0 9px", border: "1px solid rgba(34,197,94,0.45)", borderRadius: 7, background: "var(--bg)", color: refreshing || resetting ? "var(--text-dim)" : "#22c55e", cursor: refreshing || resetting ? "default" : "pointer", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                  {resetting ? t("panels.chatgpt.resetting") : t("panels.chatgpt.resetLimit")}
                </button>
              )}
              <button type="button" onClick={refreshQuota} disabled={refreshing || resetting} title={t("panels.chatgpt.refreshActive")} aria-label={t("panels.chatgpt.refreshActive")} className="usage-icon-button">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" /><path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" /><path d="M3 4v8h8" /><path d="M21 20v-8h-8" /></svg>
              </button>
            </div>
          </div>

          {accountsLoading ? <div className="usage-popover-meta">{t("panels.chatgpt.loadingAccounts")}</div> : accountsError ? <div className="usage-text-danger">{accountsError}</div> : !account ? <div className="usage-popover-empty">{t("panels.chatgpt.noActiveAccount")}</div> : (
            <>
              <div className="usage-card">
                <div className="usage-card-header">
                  <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                  <span style={{ color: "#22c55e", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{t("panels.chatgpt.active")}</span>
                </div>
                <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{account.maskedAccountId}</code>
                {account.label && <div style={{ color: "var(--text-muted)", fontSize: 11, lineHeight: 1.4 }}>{t("panels.chatgpt.noteLabel", { label: account.label })}</div>}
                {account.extraInfo && <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{account.extraInfo}</div>}
              </div>

              {quotaResult && !quotaResult.success && <div style={{ color: quotaResult.credentialStatus === "expired" ? "#fb923c" : "#f87171", fontSize: 12, lineHeight: 1.45 }}>{quotaResult.error ?? quotaResult.credentialMessage ?? t("panels.chatgpt.usageQueryFailed")}</div>}
              {quotaCache?.error && <div style={{ color: "#fb923c", fontSize: 12, lineHeight: 1.45 }}>{quotaCache.error}</div>}
              {resetCreditsAvailableCount !== null && (
                <div style={{ padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.08)", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 800 }}>{t("panels.chatgpt.resetCreditsCount", { count: resetCreditsAvailableCount })}</span>
                  <span style={{ color: resetCreditsError ? "#fb923c" : "var(--text-dim)", fontSize: 10, lineHeight: 1.4 }}>
                    {resetCreditsError
                      ? resetCreditsError
                      : resetExpiresCountdown
                        ? t("panels.chatgpt.earliestExpiresIn", { countdown: resetExpiresCountdown })
                        : resetExpiresAt
                          ? t("panels.chatgpt.earliestExpiresAt", { date: new Date(resetExpiresAt).toLocaleDateString() })
                          : t("panels.chatgpt.noCreditExpiry")}
                  </span>
                </div>
              )}

              {knownTiers.length === 0 ? (
                <div className="usage-card usage-card-row">
                  <UsagePie tier={null} size={34} title={t("panels.chatgpt.unknownUsage")} />
                  <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.45 }}>{t("panels.chatgpt.usageUnknownHint")}</div>
                </div>
              ) : (
                <div className="usage-card-list">
                  {knownTiers.map((tier) => {
                    const utilization = Math.min(Math.max(tier.utilization, 0), 100);
                    const color = quotaColor(utilization);
                    const countdown = formatResetCountdown(tier.resetsAt);
                    return (
                      <div key={tier.name} className="usage-quota-row">
                        <UsagePie
                          tier={tier}
                          label={QUOTA_TIER_LABELS[tier.name]}
                          size={30}
                          title={t("panels.chatgpt.usedPercent", { label: QUOTA_TIER_LABELS[tier.name], n: Math.round(utilization) })}
                        />
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{t("panels.chatgpt.windowLabel", { label: QUOTA_TIER_LABELS[tier.name] })}</span>
                          <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{countdown ? t("panels.chatgpt.resetsIn", { countdown }) : t("panels.chatgpt.resetTimeUnknown")}</span>
                        </div>
                        <span style={{ color, fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{Math.round(utilization)}%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          <div className="usage-section">
            <div className="usage-section-title">{t("panels.chatgpt.accounts")}</div>
            {accounts.length === 0 && !accountsLoading ? <div style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("panels.chatgpt.noSavedAccounts")}</div> : accounts.map((item) => (
              <div key={item.accountId} className={`usage-account-row${item.active ? " usage-account-row-active" : ""}`}>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.displayName}</span>
                  <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.maskedAccountId}</code>
                  <span style={{ color: item.quotaCache?.error ? "#fb923c" : "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{accountQuotaSummary(item, t)}</span>
                </div>
                {item.active ? <span style={{ color: "#22c55e", fontSize: 11, fontWeight: 800 }}>{t("panels.chatgpt.active")}</span> : (
                  <button type="button" onClick={() => void activateAccount(item.accountId)} disabled={Boolean(activatingAccountId)} style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: activatingAccountId === item.accountId ? "var(--text-dim)" : "var(--accent)", cursor: activatingAccountId ? "default" : "pointer", fontSize: 11, fontWeight: 700 }}>
                    {activatingAccountId === item.accountId ? t("panels.chatgpt.switching") : t("panels.chatgpt.activate")}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div style={{ padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.06)", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 800 }}>{t("panels.chatgpt.autoRefresh")}</span>
              <button type="button" onClick={() => void loadSchedulerStatus()} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "4px 7px" }}>{t("panels.chatgpt.reload")}</button>
            </div>
            {schedulerError && <div style={{ color: "#f87171", fontSize: 11, lineHeight: 1.45 }}>{schedulerError}</div>}
            {schedulerStatus ? (
              <div style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.55 }}>
                <div>{t("panels.chatgpt.enabled")}: {schedulerStatus.enabled ? t("panels.chatgpt.yes") : t("panels.chatgpt.no")} · {t("panels.chatgpt.running")}: {schedulerStatus.running ? t("panels.chatgpt.yes") : t("panels.chatgpt.no")} · {t("panels.chatgpt.lock")}: {schedulerStatus.lockOwned ? t("panels.chatgpt.lockOwned") : schedulerStatus.lock.stale ? t("panels.chatgpt.lockStale") : schedulerStatus.lock.exists ? t("panels.chatgpt.lockHeld") : t("panels.chatgpt.lockNone")}</div>
                <div>{t("panels.chatgpt.next")}: {formatTime(schedulerStatus.nextRunAt)} · {t("panels.chatgpt.last")}: {formatTime(schedulerStatus.lastRunFinishedAt)}</div>
                {schedulerStatus.lastError && <div style={{ color: "#f87171" }}>{t("panels.chatgpt.lastError", { error: schedulerStatus.lastError })}</div>}
                {schedulerStatus.lastAccountError && <div style={{ color: "#fb923c" }}>{t("panels.chatgpt.accountError", { error: schedulerStatus.lastAccountError })}</div>}
              </div>
            ) : <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("panels.chatgpt.schedulerUnavailable")}</div>}
            <button type="button" onClick={() => void repairLock()} disabled={repairingLock} style={{ alignSelf: "flex-start", padding: "5px 9px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.35)", background: "transparent", color: repairingLock ? "var(--text-dim)" : "#f87171", cursor: repairingLock ? "default" : "pointer", fontSize: 11, fontWeight: 700 }}>
              {repairingLock ? t("panels.chatgpt.repairing") : t("panels.chatgpt.fixLock")}
            </button>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
