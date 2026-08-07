"use client";

import { useI18n } from "@/components/I18nProvider";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SettingsButton, SettingsNotice, SettingsState, SettingsSurface, SettingsToggle } from "@/components/ui/SettingsPrimitives";
import { formatQuotaQueriedAt, formatResetCountdown, knownQuotaTiers, QUOTA_TIER_LABELS } from "@/lib/quota-display";
import type { OAuthAccountSummary } from "@/lib/oauth-accounts";
import type { OpenAICodexWarmupResponse, OpenAICodexWarmupResult } from "@/lib/openai-codex-warmup";
import type { OpenAICodexWarmupHistory, OpenAICodexWarmupHistoryRun } from "@/lib/openai-codex-warmup-history";
import type { PiWebChatGptConfig, PiWebChatGptWarmupConfig, PiWebConfig } from "@/lib/pi-web-config";

interface Props {
  accounts: OAuthAccountSummary[];
  onClose: () => void;
  onComplete?: () => void | Promise<void>;
}

interface WebConfigResponse {
  config?: PiWebConfig;
  error?: string;
}

const DEFAULT_WARMUP_SCHEDULE: PiWebChatGptWarmupConfig = {
  enabled: false,
  accountIds: [],
  times: ["07:00", "13:00"],
};

function defaultSelectedAccountIds(accounts: OAuthAccountSummary[]): string[] {
  const activeIds = accounts.filter((account) => account.active).map((account) => account.accountId);
  if (activeIds.length > 0) return activeIds;
  return accounts[0] ? [accounts[0].accountId] : [];
}

function normalizeDailyTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function accountQuotaText(account: OAuthAccountSummary, t: (key: string) => string): string {
  const quotaCache = account.quotaCache;
  if (!quotaCache) return t("panels.warmup.quotaNotRefreshed");
  if (quotaCache.error) return quotaCache.error;
  const knownTiers = knownQuotaTiers(quotaCache.tiers);
  if (knownTiers.length === 0) return t("panels.warmup.resetUnknown");
  const resetParts = knownTiers.map((tier) => {
    const label = QUOTA_TIER_LABELS[tier.name] ?? tier.name;
    const countdown = formatResetCountdown(tier.resetsAt);
    return `${label}: ${countdown ? `resets in ${countdown}` : "reset unknown"}`;
  });
  const queriedAt = quotaCache.queriedAt ? ` · ${formatQuotaQueriedAt(quotaCache.queriedAt)}` : "";
  return `${resetParts.join(" · ")}${queriedAt}`;
}

function resultText(result: OpenAICodexWarmupResult | undefined, t: (key: string) => string): { text: string; tone: "neutral" | "danger" | "warning" | "success" } {
  if (!result) return { text: "Ready", tone: "neutral" };
  if (!result.success) return { text: result.error ?? t("panels.warmup.warmupFailed"), tone: "danger" };
  if (!result.quotaRefreshSuccess) return { text: result.quotaError ? `Warmed · quota refresh failed: ${result.quotaError}` : t("panels.warmup.warmedQuotaUnavailable"), tone: "warning" };
  return { text: `Warmed${result.latencyMs !== null ? ` · ${result.latencyMs}ms` : ""} · quota refreshed`, tone: "success" };
}

function schedulesEqual(a: PiWebChatGptWarmupConfig, b: PiWebChatGptWarmupConfig): boolean {
  return a.enabled === b.enabled
    && JSON.stringify([...a.accountIds].sort()) === JSON.stringify([...b.accountIds].sort())
    && JSON.stringify([...a.times].sort()) === JSON.stringify([...b.times].sort());
}

function runSummary(run: OpenAICodexWarmupHistoryRun): string {
  const successCount = run.results.filter((result) => result.success).length;
  return `${successCount}/${run.results.length} warmed`;
}

function formatRunTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function ChatGptWarmupDialog({ accounts, onClose, onComplete }: Props) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => defaultSelectedAccountIds(accounts));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, OpenAICodexWarmupResult>>({});
  const [chatgptConfig, setChatgptConfig] = useState<PiWebChatGptConfig | null>(null);
  const [schedule, setSchedule] = useState<PiWebChatGptWarmupConfig>(DEFAULT_WARMUP_SCHEDULE);
  const [savedSchedule, setSavedSchedule] = useState<PiWebChatGptWarmupConfig>(DEFAULT_WARMUP_SCHEDULE);
  const [newTime, setNewTime] = useState("07:00");
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [history, setHistory] = useState<OpenAICodexWarmupHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedCount = selectedIds.length;
  const resultList = Object.values(results);
  const successCount = resultList.filter((result) => result.success).length;
  const scheduleAccountSet = useMemo(() => new Set(schedule.accountIds), [schedule.accountIds]);
  const scheduleDirty = !schedulesEqual(schedule, savedSchedule);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setHistoryError(null);
    try {
      const res = await fetch("/api/auth/warmup/openai-codex", { signal });
      const data = await res.json().catch(() => ({})) as OpenAICodexWarmupHistory & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setHistory(data);
    } catch (loadError) {
      if ((loadError as { name?: string }).name === "AbortError") return;
      setHistoryError(loadError instanceof Error ? loadError.message : t("panels.warmup.loadHistoryFailed"));
    }
  }, [t]);

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await fetch("/api/web-config", { signal });
      const data = await res.json().catch(() => ({})) as WebConfigResponse;
      if (!res.ok || data.error || !data.config) throw new Error(data.error ?? `HTTP ${res.status}`);
      setChatgptConfig(data.config.chatgpt);
      setSchedule(data.config.chatgpt.warmup);
      setSavedSchedule(data.config.chatgpt.warmup);
    } catch (loadError) {
      if ((loadError as { name?: string }).name === "AbortError") return;
      setConfigError(loadError instanceof Error ? loadError.message : t("panels.warmup.loadScheduleFailed"));
    } finally {
      setConfigLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [loadConfig, loadHistory]);

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

  const toggleScheduleAccount = useCallback((accountId: string) => {
    setSchedule((prev) => ({
      ...prev,
      accountIds: prev.accountIds.includes(accountId)
        ? prev.accountIds.filter((id) => id !== accountId)
        : [...prev.accountIds, accountId],
    }));
  }, []);

  const addScheduleTime = useCallback(() => {
    const normalized = normalizeDailyTime(newTime);
    if (!normalized) {
      setConfigError(t("panels.warmup.invalidTime"));
      return;
    }
    setConfigError(null);
    setSchedule((prev) => prev.times.includes(normalized) ? prev : { ...prev, times: [...prev.times, normalized].sort() });
  }, [newTime, t]);

  const removeScheduleTime = useCallback((time: string) => {
    setSchedule((prev) => {
      const nextTimes = prev.times.filter((item) => item !== time);
      return { ...prev, times: nextTimes.length > 0 ? nextTimes : prev.times };
    });
  }, []);

  const saveSchedule = useCallback(async () => {
    if (!chatgptConfig || scheduleSaving) return;
    setScheduleSaving(true);
    setConfigError(null);
    try {
      const nextChatgpt: PiWebChatGptConfig = { ...chatgptConfig, warmup: schedule };
      const res = await fetch("/api/web-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatgpt: nextChatgpt }),
      });
      const data = await res.json().catch(() => ({})) as WebConfigResponse;
      if (!res.ok || data.error || !data.config) throw new Error(data.error ?? `HTTP ${res.status}`);
      setChatgptConfig(data.config.chatgpt);
      setSchedule(data.config.chatgpt.warmup);
      setSavedSchedule(data.config.chatgpt.warmup);
      await loadHistory();
    } catch (saveError) {
      setConfigError(saveError instanceof Error ? saveError.message : t("panels.warmup.saveFailed"));
    } finally {
      setScheduleSaving(false);
    }
  }, [chatgptConfig, loadHistory, schedule, scheduleSaving, t]);

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
      await loadHistory();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : t("panels.warmup.warmupFailed"));
    } finally {
      setRunning(false);
    }
  }, [loadHistory, onComplete, running, selectedIds, t]);

  return (
    <div className="pi-modal-overlay" onClick={(event) => { if (event.target === event.currentTarget && !running && !scheduleSaving) onClose(); }}>
      <div className="pi-modal-panel warmup-dialog-panel">
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div className="pi-modal-title">{t("panels.warmup.title")}</div>
            <div className="pi-modal-subtitle">{t("panels.warmup.subtitle")}</div>
          </div>
          <button type="button" disabled={running || scheduleSaving} onClick={onClose} className="pi-modal-close">×</button>
        </div>

        <div className="mobile-stack-grid warmup-dialog-grid">
          <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <SettingsNotice tone="info">Warmup sends a tiny real Codex request using a fixed low-cost model. Tokens stay server-side; this dialog only receives per-account results.</SettingsNotice>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 700 }}>{t("panels.warmup.manual")}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" disabled={running || accounts.length === 0} onClick={selectAll} style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running || accounts.length === 0 ? "var(--text-dim)" : "var(--text-muted)", cursor: running || accounts.length === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>{t("panels.warmup.selectAll")}</button>
                <button type="button" disabled={running || selectedCount === 0} onClick={clearSelection} style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running || selectedCount === 0 ? "var(--text-dim)" : "var(--text-muted)", cursor: running || selectedCount === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>{t("panels.warmup.clear")}</button>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {accounts.length} saved · {selectedCount} selected{resultList.length > 0 ? ` · ${successCount}/${resultList.length} warmed` : ""}
            </div>

            {accounts.length === 0 ? (
              <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.5 }}>{t("panels.warmup.noAccounts")}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {accounts.map((account) => {
                  const checked = selectedSet.has(account.accountId);
                  const result = results[account.accountId];
                  const status = resultText(result, t);
                  return (
                    <label key={account.accountId} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, padding: "9px 10px", border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`, borderRadius: 8, background: checked ? "rgba(59,130,246,0.10)" : "var(--bg-panel)", cursor: running ? "default" : "pointer" }}>
                      <input type="checkbox" checked={checked} disabled={running} onChange={() => toggleAccount(account.accountId)} style={{ marginTop: 2 }} />
                      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                          <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                          {account.active && <span style={{ color: "#4ade80", fontSize: 10, fontWeight: 800, flexShrink: 0 }}>{t("panels.warmup.active")}</span>}
                        </span>
                        <code style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{account.maskedAccountId}</code>
                        {account.extraInfo && <span style={{ color: "var(--text-muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.extraInfo}</span>}
                        <span style={{ color: account.quotaCache?.error ? "#fb923c" : "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>{accountQuotaText(account, t)}</span>
                        <span className={`warmup-status warmup-status-${status.tone}`}>{running && checked && !result ? t("panels.warmup.warming") : status.text}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <SettingsSurface className="warmup-schedule-card">
              <div>
                <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 800 }}>{t("panels.warmup.scheduled")}</div>
                <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("panels.warmup.scheduledHint")}</div>
              </div>

              {configLoading ? (
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("panels.warmup.loadingSchedule")}</div>
              ) : (
                <>
                  <SettingsToggle label={t("panels.warmup.enableDaily")} description={schedule.enabled ? "Enabled" : "Disabled"} checked={schedule.enabled} disabled={scheduleSaving} onChange={(enabled) => setSchedule((previous) => ({ ...previous, enabled }))} />

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>{t("panels.warmup.scheduleAccounts")}</div>
                    {accounts.length === 0 ? (
                      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("panels.warmup.noAccountsAvailable")}</div>
                    ) : accounts.map((account) => (
                      <label key={account.accountId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 7px", border: "1px solid var(--border)", borderRadius: 6, background: scheduleAccountSet.has(account.accountId) ? "rgba(59,130,246,0.10)" : "var(--bg)", cursor: scheduleSaving ? "default" : "pointer" }}>
                        <input type="checkbox" checked={scheduleAccountSet.has(account.accountId)} disabled={scheduleSaving} onChange={() => toggleScheduleAccount(account.accountId)} />
                        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                          <span style={{ fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.displayName}</span>
                          <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{account.maskedAccountId}</span>
                        </span>
                      </label>
                    ))}
                    <button type="button" disabled={scheduleSaving || selectedIds.length === 0} onClick={() => setSchedule((prev) => ({ ...prev, accountIds: selectedIds }))} style={{ alignSelf: "flex-start", padding: "5px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: scheduleSaving || selectedIds.length === 0 ? "var(--text-dim)" : "var(--accent)", cursor: scheduleSaving || selectedIds.length === 0 ? "not-allowed" : "pointer", fontSize: 11 }}>{t("panels.warmup.useManualSelection")}</button>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>{t("panels.warmup.dailyTimes")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {schedule.times.map((time) => (
                        <span key={time} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                          {time}
                          <button type="button" disabled={scheduleSaving || schedule.times.length <= 1} onClick={() => removeScheduleTime(time)} style={{ border: "none", background: "none", color: scheduleSaving || schedule.times.length <= 1 ? "var(--text-dim)" : "var(--text-muted)", cursor: scheduleSaving || schedule.times.length <= 1 ? "not-allowed" : "pointer", padding: 0, lineHeight: 1 }}>×</button>
                        </span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input value={newTime} onChange={(event) => setNewTime(event.currentTarget.value)} placeholder="07:00" style={{ minWidth: 0, flex: 1, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none" }} />
                      <button type="button" disabled={scheduleSaving} onClick={addScheduleTime} style={{ padding: "6px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: scheduleSaving ? "var(--text-dim)" : "var(--accent)", cursor: scheduleSaving ? "not-allowed" : "pointer", fontSize: 12 }}>{t("panels.warmup.add")}</button>
                    </div>
                  </div>

                  {configError && <SettingsNotice tone="danger">{configError}</SettingsNotice>}

                  <button type="button" disabled={scheduleSaving || !scheduleDirty} onClick={saveSchedule} style={{ padding: "7px 12px", background: !scheduleSaving && scheduleDirty ? "var(--accent)" : "var(--bg-subtle)", border: "none", borderRadius: 7, color: !scheduleSaving && scheduleDirty ? "#fff" : "var(--text-dim)", cursor: !scheduleSaving && scheduleDirty ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 800 }}>{scheduleSaving ? "Saving…" : scheduleDirty ? t("panels.warmup.saveSchedule") : t("panels.warmup.scheduleSaved")}</button>
                </>
              )}
            </SettingsSurface>

            <SettingsSurface className="warmup-history-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 800 }}>{t("panels.warmup.recentRuns")}</div>
                <button type="button" onClick={() => void loadHistory()} style={{ padding: "4px 7px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{t("panels.warmup.refresh")}</button>
              </div>
              {historyError ? (
                <SettingsNotice tone="danger">{historyError}</SettingsNotice>
              ) : !history ? (
                <SettingsState kind="loading" title={t("panels.warmup.loadingHistory")} />
              ) : history.runs.length === 0 ? (
                <SettingsState title={t("panels.warmup.noHistory")} />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {history.runs.slice(0, 6).map((run) => (
                    <div key={run.id} style={{ padding: 8, border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", display: "flex", flexDirection: "column", gap: 3 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ color: "var(--text)", fontSize: 11, fontWeight: 700 }}>{run.source === "scheduled" ? "Scheduled" : "Manual"}</span>
                        <span style={{ color: run.results.every((result) => result.success) ? "#34d399" : "#fb923c", fontSize: 11, fontWeight: 700 }}>{runSummary(run)}</span>
                      </div>
                      <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{formatRunTime(run.completedAt)} · {run.accountIds.length} account{run.accountIds.length === 1 ? "" : "s"}</span>
                      {run.scheduledRunKey && <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{run.scheduledRunKey}</span>}
                    </div>
                  ))}
                </div>
              )}
            </SettingsSurface>
          </section>
        </div>

        <div className="pi-modal-footer">
          <SettingsButton disabled={running || scheduleSaving} onClick={onClose}>{t("panels.warmup.close")}</SettingsButton>
          <SettingsButton variant="primary" disabled={selectedCount === 0} busy={running} onClick={runWarmup}>{running ? "Warming…" : t("panels.warmup.warmNow")}</SettingsButton>
        </div>
      </div>
    </div>
  );
}
