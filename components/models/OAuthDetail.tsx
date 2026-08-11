"use client";

import { useI18n } from "@/components/I18nProvider";
import { localizeError } from "@/lib/i18n";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  SettingsActionRow,
  SettingsButton,
  SettingsField,
  SettingsNotice,
  SettingsSurface,
} from "@/components/ui/SettingsPrimitives";
import type { GrokUsageResult } from "@/lib/grok-usage";
import { ACCOUNT_JSON_CONVERTERS, RAW_ACCOUNT_JSON_EXAMPLE, validateRawOAuthCredentialImport, type OAuthAccountImportMode } from "@/lib/oauth-account-converters";
import { earliestResetCreditExpiration, formatQuotaQueriedAt, formatResetCountdown, knownQuotaTiers, quotaColor, QUOTA_TIER_LABELS } from "@/lib/quota-display";
import { ChatGptWarmupDialog } from "@/components/ChatGptWarmupDialog";
import type {
  OAuthAccountSummary,
  OAuthAccountsResponse,
  OAuthLoginState,
  OAuthProvider,
  SubscriptionQuota,
} from "./types";
import { SectionTitle } from "./form-fields";
import { ProviderIcon } from "./provider-icons";

/**
 * 渲染 OAuth 订阅额度查询结果。
 *
 * @param props.quota 当前订阅额度结果。
 * @param props.loading 是否正在刷新额度。
 * @param props.onRefresh 手动刷新额度的回调。
 * @returns 订阅额度展示内容。
 */
function OAuthQuotaView({
  quota,
  loading,
  account,
  resetting,
  onRefresh,
  onReset,
}: {
  quota: SubscriptionQuota | null;
  loading: boolean;
  account: OAuthAccountSummary | null;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  if (!quota && !loading && !account) return null;

  const displayedQuota = quota?.success ? quota : account?.quotaCache;
  const knownTiers = knownQuotaTiers(displayedQuota?.tiers ?? []);
  const resetCreditsAvailableCount = displayedQuota?.resetCreditsAvailableCount ?? null;
  const resetCredits = displayedQuota?.resetCredits ?? [];
  const resetCreditsError = displayedQuota?.resetCreditsError ?? null;
  const resetExpiresAt = earliestResetCreditExpiration(resetCredits);
  const resetExpiresCountdown = formatResetCountdown(resetExpiresAt);
  const canReset = Boolean(account) && (resetCreditsAvailableCount ?? 0) > 0;

  return (
    <SettingsSurface className="models-account-card">
      <SettingsActionRow>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Usage</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {loading ? "Refreshing…" : `Updated ${formatQuotaQueriedAt(displayedQuota?.queriedAt ?? null)}`}
          </span>
        </div>
        <SettingsButton size="icon" onClick={() => onRefresh()} disabled={resetting} busy={loading} title={t("settings.models.refreshUsage")} aria-label={t("settings.models.refreshUsage")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
            <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
            <path d="M3 4v8h8" />
            <path d="M21 20v-8h-8" />
          </svg>
        </SettingsButton>
      </SettingsActionRow>

      {account && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, minWidth: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: account.active ? "#4ade80" : "var(--border)", flexShrink: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.maskedAccountId}</span>
            {account.extraInfo && <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
          </div>
          <span style={{ fontSize: 11, color: account.active ? "#4ade80" : "var(--text-dim)", fontWeight: 600, flexShrink: 0 }}>
            {account.active ? "active account" : "temporary view"}
          </span>
        </div>
      )}

      {resetCreditsAvailableCount !== null && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>Reset credits: {resetCreditsAvailableCount}</span>
            <span style={{ fontSize: 10, color: resetCreditsError ? "#fb923c" : "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {resetCreditsError
                ? resetCreditsError
                : resetExpiresCountdown
                  ? t("settings.models.earliestExpiresIn", { countdown: resetExpiresCountdown })
                  : resetExpiresAt
                    ? t("settings.models.earliestExpiresAt", { date: new Date(resetExpiresAt).toLocaleDateString() })
                    : t("settings.models.noCreditExpiry")}
            </span>
          </div>
          {canReset && (
            <button
              type="button"
              onClick={() => onReset()}
              disabled={loading || resetting}
              title={resetExpiresCountdown ? `Consumes one reset credit. Earliest expires in ${resetExpiresCountdown}` : t("settings.models.resetCreditTitle")}
              style={{ padding: "5px 10px", border: "1px solid rgba(34,197,94,0.45)", borderRadius: 5, background: "transparent", color: loading || resetting ? "var(--text-dim)" : "#22c55e", cursor: loading || resetting ? "default" : "pointer", fontSize: 11, fontWeight: 700, flexShrink: 0 }}
            >
              {resetting ? t("settings.models.resetting") : t("settings.models.resetLimit")}
            </button>
          )}
        </div>
      )}

      {quota && quota.credentialStatus === "expired" && !quota.success && <SettingsNotice tone="warning">{quota.error ?? t("settings.models.tokenExpired")}</SettingsNotice>}
      {quota && quota.credentialStatus === "parse_error" && <SettingsNotice tone="danger">{quota.error ?? t("settings.models.oauthCredsFailed")}</SettingsNotice>}
      {quota && quota.credentialStatus === "not_found" && <SettingsNotice tone="info">No OAuth credential found.</SettingsNotice>}
      {quota && quota.credentialStatus === "valid" && !quota.success && <SettingsNotice tone="danger">{quota.error ?? t("settings.models.usageQueryFailed")}</SettingsNotice>}

      {quota?.success && knownTiers.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No quota windows returned.</div>
      )}

      {knownTiers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {knownTiers.map((tier) => {
            const color = quotaColor(tier.utilization);
            const countdown = formatResetCountdown(tier.resetsAt);
            return (
              <div key={tier.name} style={{ display: "grid", gridTemplateColumns: "46px 1fr 84px", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{QUOTA_TIER_LABELS[tier.name]}</span>
                <div style={{ height: 6, borderRadius: 99, background: "var(--bg)", border: "1px solid var(--border)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(Math.max(tier.utilization, 0), 100)}%`, background: color }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{Math.round(tier.utilization)}%</span>
                  {countdown && <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{countdown}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSurface>
  );
}

function GrokUsageView({
  result,
  loading,
  onRefresh,
}: {
  result: GrokUsageResult | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const monthly = result?.monthly ?? null;
  const monthlyUtilization = monthly?.utilization ?? null;
  const weekly = result?.weekly ?? null;
  const weeklyUtilization = weekly?.creditUsagePercent ?? null;
  const weeklyCountdown = weekly ? formatResetCountdown(weekly.billingPeriodEnd) : null;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Usage</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {loading ? "Refreshing…" : result?.queriedAt ? `Updated ${formatQuotaQueriedAt(result.queriedAt)}` : t("settings.models.notQueriedYet")}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh Grok CLI usage"
          aria-label="Refresh Grok CLI usage"
          style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading ? "var(--text-dim)" : "var(--text-muted)", cursor: loading ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
            <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
            <path d="M3 4v8h8" />
            <path d="M21 20v-8h-8" />
          </svg>
        </button>
      </div>

      {result?.error && (
        <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{result.error}</div>
      )}

      {/* Weekly first — same primary window emphasis as ChatGPT's 7d tier. */}
      {weekly ? (
        <div style={{
          display: "grid", gridTemplateColumns: "36px 1fr auto", alignItems: "center", gap: 10,
          padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.08)",
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: `conic-gradient(${quotaColor(weeklyUtilization ?? 0)} ${(weeklyUtilization ?? 0) * 3.6}deg, rgba(148,163,184,0.18) 0deg)`,
            border: "1px solid rgba(148,163,184,0.35)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
          }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--bg-panel)", opacity: 0.92 }} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>{QUOTA_TIER_LABELS.seven_day} window</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
              {weeklyCountdown ? `Resets in ${weeklyCountdown}` : "Reset time unknown"}
            </span>
          </div>
          <span style={{ color: quotaColor(weeklyUtilization ?? 0), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(weeklyUtilization ?? 0)}%
          </span>
        </div>
      ) : !loading && !result?.error && !monthly ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
          Click refresh to query Grok CLI billing.
          {!result?.configured && !result?.envBypass && <> Make sure Grok CLI is logged in.</>}
        </div>
      ) : null}

      {monthly && (
        <div style={{
          display: "grid", gridTemplateColumns: "36px 1fr auto", alignItems: "center", gap: 10,
          padding: 9, borderRadius: 9, border: "1px solid var(--border)", background: "rgba(148,163,184,0.08)",
        }}>
          <span style={{
            width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
            background: `conic-gradient(${quotaColor(monthlyUtilization ?? 0)} ${(monthlyUtilization ?? 0) * 3.6}deg, rgba(148,163,184,0.18) 0deg)`,
            border: "1px solid rgba(148,163,184,0.35)",
            display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box",
          }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "var(--bg-panel)", opacity: 0.92 }} />
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700 }}>Monthly credits</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
              Used: {monthly.used.toLocaleString()} · Limit: {monthly.monthlyLimit.toLocaleString()} · Remaining: {monthly.remaining.toLocaleString()}
              {monthly.billingPeriodEnd && <> · Reset: {new Date(monthly.billingPeriodEnd).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
            </span>
          </div>
          <span style={{ color: quotaColor(monthlyUtilization ?? 0), fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {Math.round(monthlyUtilization ?? 0)}%
          </span>
        </div>
      )}

      {result?.envBypass && (
        <div style={{ fontSize: 11, color: "#fb923c" }}>Using GROK_CLI_OAUTH_TOKEN env variable.</div>
      )}
    </div>
  );
}


function accountQuotaResetText(account: OAuthAccountSummary, options?: { grokWeeklyOnly?: boolean }): string {
  const cache = account.quotaCache;
  if (cache?.error) return cache.error;

  const resetCreditsAvailableCount = cache?.resetCreditsAvailableCount;
  const resetCreditsText = typeof resetCreditsAvailableCount === "number" ? `Credits ${resetCreditsAvailableCount}` : null;
  const tiers = knownQuotaTiers(cache?.tiers ?? []).filter((tier) => tier.resetsAt);
  if (tiers.length === 0) {
    if (options?.grokWeeklyOnly) {
      if (cache?.queriedAt) return "Weekly unavailable — click refresh to retry";
      return "Weekly not queried — click refresh";
    }
    return resetCreditsText ?? (cache?.queriedAt ? "No reset time" : "No quota cache");
  }
  const windowsText = tiers.map((tier) => {
    const countdown = formatResetCountdown(tier.resetsAt);
    const usage = options?.grokWeeklyOnly ? ` ${Math.round(tier.utilization)}%` : "";
    return `${QUOTA_TIER_LABELS[tier.name]}${usage} ${countdown ?? "due"}`;
  }).join(" · ");
  return resetCreditsText ? `${windowsText} · ${resetCreditsText}` : windowsText;
}

function AccountQuotaMiniCharts({ account }: { account: OAuthAccountSummary }) {
  const tiers = knownQuotaTiers(account.quotaCache?.tiers ?? []);
  if (tiers.length === 0) return null;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, verticalAlign: "middle" }}>
      {tiers.map((tier) => {
        const utilization = Math.min(Math.max(tier.utilization, 0), 100);
        const color = quotaColor(utilization);
        const label = QUOTA_TIER_LABELS[tier.name];
        return (
          <span key={tier.name} title={`${label} quota ${Math.round(utilization)}% used`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: 16, height: 16, borderRadius: "50%", background: `conic-gradient(${color} ${utilization * 3.6}deg, var(--bg-panel) 0deg)`, border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--bg)" }} />
            </span>
            <span style={{ fontSize: 9, color: "var(--text-dim)", fontWeight: 600 }}>{label}</span>
          </span>
        );
      })}
    </span>
  );
}

function OAuthAccountsView({
  accounts,
  loading,
  error,
  supportsQuota,
  supportsAccountUsage,
  activatingAccountId,
  savingLabelAccountId,
  savingExtraInfoAccountId,
  refreshingQuotaAccountId,
  quotaResetting,
  deletingAccountId,
  selectedAccountId,
  onRefresh,
  onSelect,
  onActivate,
  onEditLabel,
  onEditExtraInfo,
  onRefreshQuota,
  onDelete,
  onWarmup,
}: {
  accounts: OAuthAccountSummary[];
  loading: boolean;
  error: string | null;
  supportsQuota: boolean;
  /** Per-account usage pies/refresh without Codex warmup/view/reset chrome. */
  supportsAccountUsage: boolean;
  activatingAccountId: string | null;
  savingLabelAccountId: string | null;
  savingExtraInfoAccountId: string | null;
  refreshingQuotaAccountId: string | null;
  quotaResetting: boolean;
  deletingAccountId: string | null;
  selectedAccountId: string | null;
  onRefresh: () => void;
  onSelect: (account: OAuthAccountSummary) => void;
  onActivate: (accountId: string) => void;
  onEditLabel: (account: OAuthAccountSummary) => void;
  onEditExtraInfo: (account: OAuthAccountSummary) => void;
  onRefreshQuota: (account: OAuthAccountSummary) => void;
  onDelete: (account: OAuthAccountSummary) => void;
  onWarmup: () => void;
}) {
  const { t } = useI18n();
  const showAccountUsage = supportsQuota || supportsAccountUsage;
  return (
    <SettingsSurface className="models-account-card">
      <SettingsActionRow>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0 }}>Accounts</span>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{loading ? "Loading…" : `${accounts.length} saved`}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {supportsQuota && (
            <button
              onClick={onWarmup}
              disabled={loading || accounts.length === 0}
              style={{ padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: loading || accounts.length === 0 ? "var(--text-dim)" : "var(--accent)", cursor: loading || accounts.length === 0 ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700 }}
            >
              Warm up
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh accounts"
            aria-label="Refresh accounts"
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
      </SettingsActionRow>

      {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
      {!loading && !error && accounts.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>No saved accounts yet.</div>
      )}

      {accounts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map((account) => {
            const quotaRefreshing = refreshingQuotaAccountId === account.accountId;
            const selected = selectedAccountId === account.accountId;
            return (
              <div key={account.accountId} className={`models-account-row${selected ? " models-account-row-selected" : ""}`}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: account.active ? "#4ade80" : "var(--border)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.maskedAccountId}</span>
                  {account.extraInfo && <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
                  {showAccountUsage && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, fontSize: 10, color: account.quotaCache?.error ? "#fb923c" : "var(--text-dim)" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={accountQuotaResetText(account, { grokWeeklyOnly: supportsAccountUsage && !supportsQuota })}>
                        {supportsQuota
                          ? <>Reset: {accountQuotaResetText(account)}{account.quotaCache?.queriedAt ? ` · ${formatQuotaQueriedAt(account.quotaCache.queriedAt)}` : ""}</>
                          : <>{accountQuotaResetText(account, { grokWeeklyOnly: true })}{account.quotaCache?.queriedAt ? ` · ${formatQuotaQueriedAt(account.quotaCache.queriedAt)}` : ""}</>}
                      </span>
                      <AccountQuotaMiniCharts account={account} />
                    </div>
                  )}
                </div>
                {supportsQuota && (
                  <button
                    onClick={() => onSelect(account)}
                    disabled={selected || Boolean(refreshingQuotaAccountId) || quotaResetting}
                    style={{ padding: "4px 9px", background: selected ? "var(--accent)" : "none", border: selected ? "1px solid var(--accent)" : "1px solid var(--border)", borderRadius: 4, color: selected ? "#fff" : quotaResetting ? "var(--text-dim)" : "var(--accent)", cursor: selected || refreshingQuotaAccountId || quotaResetting ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                  >
                    {selected ? "Viewing" : "View"}
                  </button>
                )}
                <button
                  onClick={() => onEditLabel(account)}
                  disabled={savingLabelAccountId === account.accountId}
                  style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: savingLabelAccountId === account.accountId ? "var(--text-dim)" : "var(--text-muted)", cursor: savingLabelAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {savingLabelAccountId === account.accountId ? "Saving…" : "Remark"}
                </button>
                <button
                  onClick={() => onEditExtraInfo(account)}
                  disabled={savingExtraInfoAccountId === account.accountId}
                  style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: savingExtraInfoAccountId === account.accountId ? "var(--text-dim)" : "var(--text-muted)", cursor: savingExtraInfoAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                >
                  {savingExtraInfoAccountId === account.accountId ? "Saving…" : "Details"}
                </button>
                {account.active ? (
                  <span style={{ fontSize: 11, color: "#4ade80", fontWeight: 600 }}>active</span>
                ) : (
                  <>
                    <button
                      onClick={() => onActivate(account.accountId)}
                      disabled={Boolean(activatingAccountId) || deletingAccountId === account.accountId}
                      style={{ padding: "4px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: activatingAccountId === account.accountId ? "var(--text-dim)" : "var(--accent)", cursor: activatingAccountId || deletingAccountId === account.accountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                    >
                      {activatingAccountId === account.accountId ? "Activating…" : "Activate"}
                    </button>
                    <button
                      onClick={() => onDelete(account)}
                      disabled={Boolean(deletingAccountId) || Boolean(activatingAccountId)}
                      style={{ padding: "4px 9px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: deletingAccountId === account.accountId ? "var(--text-dim)" : "#ef4444", cursor: deletingAccountId || activatingAccountId ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
                    >
                      {deletingAccountId === account.accountId ? t("settings.models.deleting") : t("settings.models.delete")}
                    </button>
                  </>
                )}
                {showAccountUsage && (
                  <button
                    onClick={() => onRefreshQuota(account)}
                    disabled={Boolean(refreshingQuotaAccountId) || quotaResetting}
                    title={supportsQuota ? "Refresh this account quota reset time" : "Refresh this account weekly usage"}
                    aria-label={supportsQuota ? "Refresh this account quota reset time" : "Refresh this account weekly usage"}
                    style={{ width: 28, height: 28, padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: quotaRefreshing || quotaResetting ? "var(--text-dim)" : "var(--accent)", cursor: refreshingQuotaAccountId || quotaResetting ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6.36-2.64" />
                      <path d="M3 12a9 9 0 0 1 9-9 8.8 8.8 0 0 1 6.36 2.64" />
                      <path d="M3 4v8h8" />
                      <path d="M21 20v-8h-8" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsSurface>
  );
}

function ExtraInfoDialog({
  account,
  saving,
  onSave,
  onClose,
}: {
  account: OAuthAccountSummary;
  saving: boolean;
  onSave: (account: OAuthAccountSummary, extraInfo: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(account.extraInfo ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(account.extraInfo ?? "");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [account]);

  return (
    <div className="pi-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="pi-modal-panel">
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy"><div className="pi-modal-title">Account details</div><div className="pi-modal-subtitle">{account.displayName}</div></div>
          <button type="button" disabled={saving} onClick={onClose} className="pi-modal-close">×</button>
        </div>
        <div className="pi-modal-body">
          <SettingsField label="Extra information" description="Leave empty to clear this account's extra information.">
            <textarea ref={textareaRef} value={value} onChange={(event) => setValue(event.target.value)} disabled={saving} placeholder="Add notes such as subscription owner, renewal notes, usage hints…" className="settings-control settings-textarea models-account-notes" />
          </SettingsField>
        </div>
        <div className="pi-modal-footer"><SettingsButton disabled={saving} onClick={onClose}>Cancel</SettingsButton><SettingsButton variant="primary" busy={saving} onClick={() => onSave(account, value)}>{saving ? t("settings.models.saving") : t("settings.models.save")}</SettingsButton></div>
      </div>
    </div>
  );
}

function AddAccountDialog({
  provider,
  view,
  onViewChange,
  onCodexAuth,
  onImported,
  onClose,
}: {
  provider: OAuthProvider;
  view: "method" | "json";
  onViewChange: (view: "method" | "json") => void;
  onCodexAuth: () => void;
  onImported: (accounts: OAuthAccountSummary[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<OAuthAccountImportMode>("raw");
  const [jsonText, setJsonText] = useState("");
  const [convertedJsonText, setConvertedJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const converter = mode === "raw" ? undefined : ACCOUNT_JSON_CONVERTERS[mode];
  const finalJsonText = converter ? convertedJsonText : jsonText;

  useEffect(() => {
    if (view === "json") setTimeout(() => textareaRef.current?.focus(), 50);
  }, [view]);

  const parseFinalCredential = useCallback((): unknown | null => {
    try {
      return JSON.parse(finalJsonText);
    } catch (parseError) {
      setValidationMessage({ type: "error", text: parseError instanceof Error ? t("settings.models.finalJsonInvalidDetail", { message: parseError.message }) : t("settings.models.finalJsonInvalid") });
      return null;
    }
  }, [finalJsonText, t]);

  const validateFinalJson = useCallback((): unknown | null => {
    setError(null);
    const credential = parseFinalCredential();
    if (!credential) return null;
    const validationError = validateRawOAuthCredentialImport(credential);
    if (validationError) {
      setValidationMessage({ type: "error", text: validationError });
      return null;
    }
    setValidationMessage({ type: "success", text: Array.isArray(credential) ? t("settings.models.validateOkCount", { count: credential.length }) : t("settings.models.validateOk") });
    return credential;
  }, [parseFinalCredential, t]);

  const convertSourceJson = useCallback(() => {
    if (!converter) return;
    setError(null);
    setValidationMessage(null);

    let source: unknown;
    try {
      source = JSON.parse(jsonText);
    } catch (parseError) {
      setError(parseError instanceof Error ? t("settings.models.sourceJsonInvalidDetail", { message: parseError.message }) : t("settings.models.sourceJsonInvalid"));
      return;
    }

    try {
      const converted = converter.convert(source);
      setConvertedJsonText(JSON.stringify(converted, null, 2));
      setValidationMessage({ type: "success", text: t("settings.models.convertDone") });
    } catch (convertError) {
      const code = convertError && typeof convertError === "object" && "code" in convertError
        ? (convertError as { code?: unknown }).code
        : undefined;
      setError(localizeError(t, {
        code,
        message: convertError instanceof Error ? convertError.message : undefined,
        fallback: t("settings.models.convertFailed"),
      }));
    }
  }, [converter, jsonText, t]);

  const submitRawJson = useCallback(async () => {
    if (submitting) return;
    const credential = validateFinalJson();
    if (!credential) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "raw", credential }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onImported(data.accounts ?? []);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("settings.models.importFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [onClose, onImported, provider.id, submitting, validateFinalJson, t]);

  const modeButton = (value: OAuthAccountImportMode, label: string, disabled = false) => {
    const active = mode === value;
    return (
      <button
        type="button"
        disabled={disabled || submitting}
        onClick={() => {
          if (disabled) return;
          setMode(value);
          setError(null);
          setValidationMessage(null);
        }}
        style={{
          padding: "6px 9px",
          borderRadius: 6,
          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
          background: active ? "rgba(59,130,246,0.12)" : "var(--bg-panel)",
          color: disabled ? "var(--text-dim)" : active ? "var(--accent)" : "var(--text-muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {label}{disabled ? t("settings.models.laterSupport") : ""}
      </button>
    );
  };

  return (
    <div className="pi-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <div className={`pi-modal-panel models-account-dialog${view === "json" ? " models-account-dialog-wide" : ""}`}>
        <div className="pi-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <ProviderIcon id={provider.id} size={18} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("settings.models.addAccountTitle", { name: provider.name })}</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{t("settings.models.addAccountHint")}</div>
            </div>
          </div>
          <button type="button" disabled={submitting} onClick={onClose} className="pi-modal-close">×</button>
        </div>

        {view === "method" ? (
          <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 10 }}>
            <button type="button" onClick={onCodexAuth} style={{ padding: 14, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{provider.id === "openai-codex" ? t("settings.models.codexAuth") : t("settings.models.oauthAuth")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{provider.id === "openai-codex" ? t("settings.models.codexAuthHint") : t("settings.models.oauthAuthHint")}</div>
            </button>
            <button type="button" onClick={() => onViewChange("json")} style={{ padding: 14, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{t("settings.models.pasteJson")}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("settings.models.pasteJsonHint")}</div>
            </button>
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {t("settings.models.rawJsonGuide")}
                </div>
                <pre style={{ margin: 0, padding: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 11, lineHeight: 1.5, overflow: "auto", fontFamily: "var(--font-mono)" }}>{RAW_ACCOUNT_JSON_EXAMPLE}</pre>
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                  {t("settings.models.rawJsonAccountIdHint")}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {modeButton("raw", t("settings.models.sourceJson"))}
                  {modeButton("cpa", t("settings.models.cpaFormat"))}
                  {modeButton("sub2api", t("settings.models.sub2apiFormat"))}
                </div>
                {converter ? (
                  <>
                    <textarea
                      ref={textareaRef}
                      value={jsonText}
                      onChange={(e) => { setJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                      placeholder={converter.sourcePlaceholder}
                      spellCheck={false}
                      style={{ minHeight: 150, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                    />
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <button type="button" disabled={submitting || !jsonText.trim()} onClick={convertSourceJson} style={{ padding: "6px 12px", background: !submitting && jsonText.trim() ? "var(--accent)" : "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, color: !submitting && jsonText.trim() ? "#fff" : "var(--text-dim)", cursor: !submitting && jsonText.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}>{t("settings.models.convertDown")}</button>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("settings.models.convertToRaw", { label: converter.label })}</span>
                    </div>
                    <textarea
                      value={convertedJsonText}
                      onChange={(e) => { setConvertedJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                      placeholder={RAW_ACCOUNT_JSON_EXAMPLE}
                      spellCheck={false}
                      style={{ minHeight: 150, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                    />
                  </>
                ) : (
                  <textarea
                    ref={textareaRef}
                    value={jsonText}
                    onChange={(e) => { setJsonText(e.target.value); setError(null); setValidationMessage(null); }}
                    placeholder={RAW_ACCOUNT_JSON_EXAMPLE}
                    spellCheck={false}
                    style={{ minHeight: 260, resize: "vertical", padding: "9px 10px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box", lineHeight: 1.5 }}
                  />
                )}
                {error && <div style={{ fontSize: 12, color: "#f87171", lineHeight: 1.5 }}>{error}</div>}
                {validationMessage && <div style={{ fontSize: 12, color: validationMessage.type === "success" ? "#34d399" : "#f87171", lineHeight: 1.5 }}>{validationMessage.text}</div>}
              </div>
            </div>

            <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 8 }}>
              <button type="button" disabled={submitting} onClick={() => onViewChange("method")} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 12 }}>{t("settings.models.back")}</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={submitting} onClick={onClose} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: submitting ? "not-allowed" : "pointer", fontSize: 12 }}>{t("common.cancel")}</button>
                <button type="button" disabled={submitting || !finalJsonText.trim()} onClick={validateFinalJson} style={{ padding: "6px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: !submitting && finalJsonText.trim() ? "var(--text-muted)" : "var(--text-dim)", cursor: !submitting && finalJsonText.trim() ? "pointer" : "not-allowed", fontSize: 12 }}>{t("settings.models.validate")}</button>
                <button type="button" disabled={submitting || !finalJsonText.trim()} onClick={submitRawJson} style={{ padding: "6px 14px", background: !submitting && finalJsonText.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 6, color: !submitting && finalJsonText.trim() ? "#fff" : "var(--text-dim)", cursor: !submitting && finalJsonText.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}>{submitting ? t("settings.models.savingAccount") : t("settings.models.saveAccount")}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const { t } = useI18n();
  const isGrokProvider = provider.id === "grok-cli" || provider.id === "xai";
  // Multi-account store is available for codex and grok; Codex owns full quota chrome,
  // while Grok/xAI only shows per-account weekly usage pies.
  const supportsAccounts = provider.id === "openai-codex" || isGrokProvider;
  const supportsQuota = provider.id === "openai-codex";
  const supportsAccountUsage = isGrokProvider;
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const [inputValue, setInputValue] = useState("");
  const [quota, setQuota] = useState<SubscriptionQuota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [grokUsage, setGrokUsage] = useState<GrokUsageResult | null>(null);
  const [grokUsageLoading, setGrokUsageLoading] = useState(false);
  const [quotaResetting, setQuotaResetting] = useState(false);
  const [accounts, setAccounts] = useState<OAuthAccountSummary[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedQuotaAccountId, setSelectedQuotaAccountId] = useState<string | null>(null);
  const [activatingAccountId, setActivatingAccountId] = useState<string | null>(null);
  const [savingLabelAccountId, setSavingLabelAccountId] = useState<string | null>(null);
  const [savingExtraInfoAccountId, setSavingExtraInfoAccountId] = useState<string | null>(null);
  const [editingExtraInfoAccount, setEditingExtraInfoAccount] = useState<OAuthAccountSummary | null>(null);
  const [refreshingQuotaAccountId, setRefreshingQuotaAccountId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);
  const [addAccountDialogView, setAddAccountDialogView] = useState<"method" | "json" | null>(null);
  const [warmupDialogOpen, setWarmupDialogOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    setQuota(null);
    setQuotaLoading(false);
    setQuotaResetting(false);
    setGrokUsage(null);
    setGrokUsageLoading(false);
    setAccounts([]);
    setAccountsLoading(false);
    setAccountsError(null);
    setSelectedQuotaAccountId(null);
    setActivatingAccountId(null);
    setSavingLabelAccountId(null);
    setSavingExtraInfoAccountId(null);
    setEditingExtraInfoAccount(null);
    setRefreshingQuotaAccountId(null);
    setDeletingAccountId(null);
    setAddAccountDialogView(null);
    setWarmupDialogOpen(false);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const loadAccounts = useCallback(async () => {
    if (!supportsAccounts) return;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`);
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
    } catch (error) {
      setAccountsError(error instanceof Error ? error.message : "Failed to load accounts");
    } finally {
      setAccountsLoading(false);
    }
  }, [provider.id, supportsAccounts]);

  useEffect(() => {
    if (supportsAccounts) {
      void loadAccounts();
    }
  }, [supportsAccounts, provider.loggedIn, loadAccounts]);

  useEffect(() => {
    if (provider.id !== "openai-codex") return;
    setSelectedQuotaAccountId((current) => {
      if (accounts.length === 0) return null;
      if (current && accounts.some((account) => account.accountId === current)) return current;
      return accounts.find((account) => account.active)?.accountId ?? null;
    });
  }, [accounts, provider.id]);

  const loadQuota = useCallback(async (force = false, accountIdOverride?: string | null) => {
    if (provider.id !== "openai-codex" || (!provider.loggedIn && !force)) return;
    const quotaAccountId = accountIdOverride !== undefined ? accountIdOverride : selectedQuotaAccountId;
    setQuotaLoading(true);
    try {
      const accountQuery = quotaAccountId ? `?accountId=${encodeURIComponent(quotaAccountId)}` : "";
      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}${accountQuery}`);
      const data = await res.json() as SubscriptionQuota;
      setQuota(data);
      void loadAccounts();
    } catch (error) {
      setQuota({
        tool: provider.id,
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
      setQuotaLoading(false);
    }
  }, [provider.id, provider.loggedIn, selectedQuotaAccountId, loadAccounts]);

  useEffect(() => {
    if (provider.id === "openai-codex" && provider.loggedIn) {
      void loadQuota();
    }
  }, [provider.id, provider.loggedIn, loadQuota]);

  const loadGrokUsage = useCallback(async (forceRefresh = false) => {
    if ((provider.id !== "grok-cli" && provider.id !== "xai") || !provider.loggedIn) return;

    setGrokUsageLoading(true);
    try {
      const mode = forceRefresh ? "refresh" : "cache";
      const res = await fetch(`/api/auth/usage/grok-cli?mode=${mode}${forceRefresh ? `&_=${Date.now()}` : ""}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({})) as GrokUsageResult & { error?: string };
      if (data.success && data.monthly) {
        setGrokUsage(data);
        // Active refresh also writes weekly quotaCache onto the active saved account.
        if (forceRefresh) void loadAccounts();
        return;
      }
      // Keep previous successful result in memory when a live refresh fails.
      setGrokUsage((prev) => {
        if (forceRefresh && prev?.success && prev.monthly) {
          return { ...prev, error: data.error ?? prev.error, source: data.source ?? prev.source };
        }
        return data.provider
          ? data
          : {
              provider: "grok-cli",
              configured: true,
              success: false,
              source: forceRefresh ? "live" : "cache",
              monthly: null,
              weekly: null,
              error: data.error ?? "Grok CLI usage query failed",
              queriedAt: Date.now(),
              envBypass: false,
            };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grok CLI usage query failed";
      setGrokUsage((prev) => {
        if (forceRefresh && prev?.success && prev.monthly) {
          return { ...prev, error: message, source: "live" };
        }
        return {
          provider: "grok-cli",
          configured: true,
          success: false,
          source: "live",
          monthly: null,
          weekly: null,
          error: message,
          queriedAt: Date.now(),
          envBypass: false,
        };
      });
    } finally {
      setGrokUsageLoading(false);
    }
  }, [provider.id, provider.loggedIn, loadAccounts]);

  useEffect(() => {
    setGrokUsage(null);
    setGrokUsageLoading(false);
    if ((provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn) void loadGrokUsage();
  }, [provider.id, provider.loggedIn, loadGrokUsage]);

  const handleLogin = useCallback((accountMode: "login" | "add" = "login") => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const loginUrl = `/api/auth/login/${encodeURIComponent(provider.id)}${accountMode === "add" ? "?accountMode=add" : ""}`;
    const es = new EventSource(loginUrl);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
        account?: OAuthAccountSummary; activeAccountId?: string | null;
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success", message: data.message ?? (accountMode === "add" ? "Account saved successfully." : "Connected successfully.") });
        onRefresh();
        void loadAccounts();
        if (provider.loggedIn) void loadQuota();
        if ((provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn) void loadGrokUsage();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: "Connection lost" });
    };
  }, [provider.id, provider.loggedIn, onRefresh, loadAccounts, loadQuota, loadGrokUsage]);

  const handleLogout = useCallback(async () => {
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
    setLoginState({ phase: "idle" });
    setQuota(null);
    setGrokUsage(null);
    setGrokUsageLoading(false);
    setSelectedQuotaAccountId(null);
    onRefresh();
    void loadAccounts();
  }, [provider.id, onRefresh, loadAccounts]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: "Verifying…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: "Continuing…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const handleSelectQuotaAccount = useCallback((account: OAuthAccountSummary) => {
    setSelectedQuotaAccountId(account.accountId);
    void loadQuota(true, account.accountId);
  }, [loadQuota]);

  const handleActivateAccount = useCallback(async (accountId: string) => {
    setActivatingAccountId(accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setSelectedQuotaAccountId(accountId);
      setLoginState({ phase: "success", message: "Account activated." });
      onRefresh();
      if (supportsQuota) {
        await loadQuota(true, accountId);
      } else if (isGrokProvider) {
        await loadGrokUsage(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to activate account";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setActivatingAccountId(null);
    }
  }, [provider.id, onRefresh, loadQuota, loadGrokUsage, supportsQuota, isGrokProvider]);

  const appDialog = useAppDialog();

  const handleEditAccountLabel = useCallback(async (account: OAuthAccountSummary) => {
    const nextLabel = await appDialog.prompt({ message: t("settings.models.editAccountLabelPrompt"), defaultValue: account.label ?? "" });
    if (nextLabel === null) return;

    setSavingLabelAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId, label: nextLabel }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setLoginState({ phase: "success", message: nextLabel.trim() ? "Account remark saved." : "Account remark cleared." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save account remark";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setSavingLabelAccountId(null);
    }
  }, [provider.id, appDialog, t]);

  const handleEditAccountExtraInfo = useCallback((account: OAuthAccountSummary) => {
    setEditingExtraInfoAccount(account);
  }, []);

  const handleSaveAccountExtraInfo = useCallback(async (account: OAuthAccountSummary, nextExtraInfo: string) => {
    setSavingExtraInfoAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId, extraInfo: nextExtraInfo }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setEditingExtraInfoAccount(null);
      setLoginState({ phase: "success", message: nextExtraInfo.trim() ? "Account extra info saved." : "Account extra info cleared." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save account extra info";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setSavingExtraInfoAccountId(null);
    }
  }, [provider.id]);

  const handleRefreshAccountQuota = useCallback(async (account: OAuthAccountSummary) => {
    if (quotaResetting) return;
    setRefreshingQuotaAccountId(account.accountId);
    setAccountsError(null);
    try {
      if (isGrokProvider) {
        // cache: 'no-store' avoids browser reusing an empty/error GET body and looking like a cache hit.
        const res = await fetch(
          `/api/auth/usage/grok-cli?mode=refresh&provider=${encodeURIComponent(provider.id)}&accountId=${encodeURIComponent(account.accountId)}&_=${Date.now()}`,
          { cache: "no-store" },
        );
        const data = await res.json().catch(() => ({})) as GrokUsageResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (account.active && data.success && data.monthly) setGrokUsage(data);
        await loadAccounts();
        setLoginState({
          phase: data.success && data.weekly ? "success" : "error",
          message: data.success
            ? (data.weekly ? "Account weekly usage refreshed." : "Live refresh ok, but weekly usage was unavailable.")
            : (data.error ?? "Grok usage query failed."),
        });
        return;
      }

      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}?accountId=${encodeURIComponent(account.accountId)}`);
      const data = await res.json().catch(() => ({})) as SubscriptionQuota & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (selectedQuotaAccountId ? account.accountId === selectedQuotaAccountId : account.active) setQuota(data);
      await loadAccounts();
      setLoginState({ phase: data.success ? "success" : "error", message: data.success ? "Account quota refreshed." : (data.error ?? "Quota query failed.") });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to refresh account quota";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setRefreshingQuotaAccountId(null);
    }
  }, [isGrokProvider, loadAccounts, provider.id, quotaResetting, selectedQuotaAccountId]);

  const handleResetQuota = useCallback(async () => {
    const quotaAccountId = selectedQuotaAccountId;
    if (!quotaAccountId || quotaResetting) return;
    const ok = await appDialog.confirm({ message: t("settings.models.resetConfirm"), tone: "danger" });
    if (!ok) return;

    setQuotaResetting(true);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/quota/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: quotaAccountId }),
      });
      const data = await res.json().catch(() => ({})) as SubscriptionQuota & { error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? data.credentialMessage ?? `HTTP ${res.status}`);
      setQuota(data);
      await loadAccounts();
      setLoginState({ phase: "success", message: "Codex rate limit reset." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset Codex rate limit";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setQuotaResetting(false);
    }
  }, [loadAccounts, provider.id, quotaResetting, selectedQuotaAccountId, t, appDialog]);

  const handleDeleteAccount = useCallback(async (account: OAuthAccountSummary) => {
    const confirmed = await appDialog.confirm({ message: t("settings.models.deleteAccountConfirm", { name: account.displayName }), tone: "danger" });
    if (!confirmed) return;

    setDeletingAccountId(account.accountId);
    setAccountsError(null);
    try {
      const res = await fetch(`/api/auth/accounts/${encodeURIComponent(provider.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.accountId }),
      });
      const data = await res.json().catch(() => ({})) as OAuthAccountsResponse & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAccounts(data.accounts ?? []);
      setLoginState({ phase: "success", message: "Account deleted." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account";
      setAccountsError(message);
      setLoginState({ phase: "error", message });
    } finally {
      setDeletingAccountId(null);
    }
  }, [provider.id, appDialog, t]);

  const selectedQuotaAccount = accounts.find((account) => account.accountId === selectedQuotaAccountId)
    ?? accounts.find((account) => account.active)
    ?? null;

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Subscription</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
            {provider.loggedIn ? "connected" : "not connected"}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {provider.loggedIn ? "Already connected. You can re-login or disconnect." : `Connect your ${provider.name} account.`}
          </p>
        )}
        {loginState.phase === "connecting" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Opening browser…</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? "Complete sign-in in the browser, then copy the redirect URL from the address bar and paste it below."
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
                If the browser window did not open,{" "}
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  click here to open the login page
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
                placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? "Enter value…")}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: 5, color: inputValue.trim() ? "#fff" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
              >
                Submit
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Open the verification page and enter this code:
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` Expires in ${Math.ceil(loginState.expiresInSeconds / 60)} minutes.` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
          <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{loginState.message ?? "Connected successfully."}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
          >
            Cancel
          </button>
        ) : (
          <>
            <button
              onClick={() => handleLogin()}
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {provider.loggedIn ? "Re-login" : "Login"}
            </button>
            {supportsAccounts && provider.loggedIn && (
              <button
                onClick={() => setAddAccountDialogView("method")}
                style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                Add Account
              </button>
            )}
            {provider.loggedIn && (
              <button
                onClick={handleLogout}
                style={{ padding: "5px 12px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", cursor: "pointer", fontSize: 12 }}
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>

      {provider.id === "openai-codex" && provider.loggedIn && (
        <OAuthQuotaView quota={quota} loading={quotaLoading} account={selectedQuotaAccount} resetting={quotaResetting} onRefresh={loadQuota} onReset={handleResetQuota} />
      )}

      {(provider.id === "grok-cli" || provider.id === "xai") && provider.loggedIn && (
        <GrokUsageView result={grokUsage} loading={grokUsageLoading} onRefresh={() => void loadGrokUsage(true)} />
      )}

      {supportsAccounts && (
        <OAuthAccountsView
          accounts={accounts}
          loading={accountsLoading}
          error={accountsError}
          supportsQuota={supportsQuota}
          supportsAccountUsage={supportsAccountUsage}
          activatingAccountId={activatingAccountId}
          savingLabelAccountId={savingLabelAccountId}
          savingExtraInfoAccountId={savingExtraInfoAccountId}
          refreshingQuotaAccountId={refreshingQuotaAccountId}
          quotaResetting={quotaResetting}
          deletingAccountId={deletingAccountId}
          selectedAccountId={selectedQuotaAccount?.accountId ?? null}
          onRefresh={loadAccounts}
          onSelect={handleSelectQuotaAccount}
          onActivate={handleActivateAccount}
          onEditLabel={handleEditAccountLabel}
          onEditExtraInfo={handleEditAccountExtraInfo}
          onRefreshQuota={handleRefreshAccountQuota}
          onDelete={handleDeleteAccount}
          onWarmup={() => setWarmupDialogOpen(true)}
        />
      )}

      {provider.id === "openai-codex" && warmupDialogOpen && (
        <ChatGptWarmupDialog
          accounts={accounts}
          onComplete={loadAccounts}
          onClose={() => setWarmupDialogOpen(false)}
        />
      )}

      {supportsAccounts && editingExtraInfoAccount && (
        <ExtraInfoDialog
          account={editingExtraInfoAccount}
          saving={savingExtraInfoAccountId === editingExtraInfoAccount.accountId}
          onSave={handleSaveAccountExtraInfo}
          onClose={() => { if (!savingExtraInfoAccountId) setEditingExtraInfoAccount(null); }}
        />
      )}

      {supportsAccounts && addAccountDialogView && (
        <AddAccountDialog
          provider={provider}
          view={addAccountDialogView}
          onViewChange={setAddAccountDialogView}
          onCodexAuth={() => { setAddAccountDialogView(null); handleLogin("add"); }}
          onImported={(nextAccounts) => {
            setAccounts(nextAccounts);
            setLoginState({ phase: "success", message: t("settings.models.accountSaved") });
            onRefresh();
            if (supportsQuota && provider.loggedIn) void loadQuota();
          }}
          onClose={() => setAddAccountDialogView(null)}
        />
      )}
    </div>
  );
}
