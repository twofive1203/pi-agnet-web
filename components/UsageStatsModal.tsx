"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { formatNumber } from "@/lib/i18n";
import { SettingsButton, SettingsInput, SettingsNotice, SettingsTab, SettingsTabs } from "@/components/ui/SettingsPrimitives";
import type { UsageStatsResult, UsageTotals } from "@/lib/usage-stats";

interface UsageStatsModalProps {
  cwd?: string | null;
  onClose: () => void;
}

type UsageScope = "all" | "cwd";

/**
 * 将日期对象格式化为日期输入框需要的本地日期字符串。
 *
 * @param date 需要格式化的日期对象。
 * @returns `YYYY-MM-DD` 格式的本地日期。
 */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 生成默认的统计日期范围。
 *
 * @returns 默认近 7 天的日期输入框值。
 */
function getDefaultInputRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  return { from: toDateInputValue(from), to: toDateInputValue(to) };
}

/**
 * 格式化美元费用，保留小额费用的可读性。
 *
 * @param value 需要格式化的费用数字。
 * @returns 美元格式字符串。
 */
function formatCost(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * 格式化 token 数量。
 *
 * @param value 需要格式化的 token 数。
 * @returns 带千分位的 token 字符串。
 */
function formatTokens(value: number, locale: import("@/lib/i18n").Locale): string {
  return formatNumber(value, locale);
}

function formatTokensM(value: number, locale: import("@/lib/i18n").Locale): string {
  return `${formatNumber(Math.round(value / 1_000_000), locale)}M`;
}

/**
 * 计算 token 汇总总数。
 *
 * @param totals token 和费用汇总对象。
 * @returns input、output、cacheRead、cacheWrite 的总和。
 */
function totalTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * 渲染日期范围费用统计弹窗。
 *
 * @param props cwd 为当前项目目录，onClose 用于关闭弹窗。
 * @returns 用于查看费用统计的 React 节点。
 */
export function UsageStatsModal({ cwd, onClose }: UsageStatsModalProps) {
  const { t, locale } = useI18n();
  const defaults = useMemo(() => getDefaultInputRange(), []);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [scope, setScope] = useState<UsageScope>(cwd ? "cwd" : "all");
  const [stats, setStats] = useState<UsageStatsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCwd = scope === "cwd" ? cwd : null;
  const largestDailyCost = Math.max(0, ...(stats?.byDay.map((day) => day.totals.cost) ?? []));

  const loadStats = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (activeCwd) params.set("cwd", activeCwd);
      const res = await fetch(`/api/usage?${params.toString()}`, { signal });
      const data = await res.json() as UsageStatsResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStats(data);
    } catch (err) {
      if (signal?.aborted) return;
      setStats(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [activeCwd, from, to]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStats(controller.signal);
    return () => controller.abort();
  }, [loadStats]);

  useEffect(() => {
    if (!cwd && scope === "cwd") setScope("all");
  }, [cwd, scope]);

  return (
    <div
      className="pi-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("panels.usage.ariaLabel")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="pi-modal-panel pi-modal-panel-wide usage-modal-panel"
      >
        <div className="pi-modal-header usage-modal-header">
          <div className="usage-modal-title-row">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6" />
            </svg>
            <div className="pi-modal-title">{t("panels.usage.shortTitle")}</div>
          </div>

          <div className="usage-modal-controls">
            <label className="usage-filter-label">
              {t("panels.usage.from")}
              <SettingsInput
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="usage-date-input"
              />
            </label>
            <label className="usage-filter-label">
              {t("panels.usage.to")}
              <SettingsInput
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="usage-date-input"
              />
            </label>
            <SettingsTabs aria-label={t("panels.usage.scopeAria")}>
              {(["all", "cwd"] as UsageScope[]).map((item) => <SettingsTab key={item} active={scope === item} disabled={item === "cwd" && !cwd} onClick={() => setScope(item)}>{item === "all" ? t("panels.usage.scopeAll") : t("panels.usage.scopeCwd")}</SettingsTab>)}
            </SettingsTabs>
            <SettingsButton size="icon" onClick={() => void loadStats()} disabled={loading} busy={loading} title={t("panels.usage.refresh")} aria-label={t("panels.usage.refreshAria")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </SettingsButton>
            <button type="button" onClick={onClose} className="pi-modal-close" title={t("panels.usage.close")} aria-label={t("panels.usage.closeAria")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div className="pi-modal-body usage-modal-body">
          {error ? (
            <SettingsNotice tone="danger">{error}</SettingsNotice>
          ) : (
            <>
              <div className="usage-metric-grid">
                <Metric label={t("panels.usage.totalCost")} value={formatCost(stats?.totals.cost ?? 0)} strong />
                <Metric label={t("panels.usage.mainCost")} value={formatCost(stats?.mainTotals.cost ?? 0)} />
                <Metric label={t("panels.usage.subagentCost")} value={formatCost(stats?.subagentTotals.cost ?? 0)} />
                <Metric label={t("panels.usage.tokens")} value={`${formatTokens(totalTokens(stats?.totals ?? zeroTotals), locale)} (${formatTokensM(totalTokens(stats?.totals ?? zeroTotals), locale)})`} />
                <Metric label={t("panels.usage.calls")} value={formatTokens(stats?.totals.calls ?? 0, locale)} />
                <Metric label={t("panels.usage.sessions")} value={`${stats?.bySession.length ?? 0}/${stats?.matchedSessions ?? 0}`} />
                <Metric label={t("panels.usage.subagentSessions")} value={formatTokens(stats?.subagentSessions ?? 0, locale)} />
                <Metric label={t("panels.usage.scannedActiveArchive")} value={`${stats?.scannedActiveSessions ?? 0}/${stats?.scannedArchivedSessions ?? 0}`} />
                <Metric label={t("panels.usage.matchedActiveArchive")} value={`${stats?.matchedActiveSessions ?? 0}/${stats?.matchedArchivedSessions ?? 0}`} />
              </div>

              <div className="usage-content-grid">
                <section className="usage-stats-card">
                  <SectionTitle
                    title={t("panels.usage.daily")}
                    right={loading
                      ? t("panels.usage.loading")
                      : stats
                        ? `${stats.from} - ${stats.to} · ${stats.scope.includeArchived ? t("panels.usage.withArchive") : t("panels.usage.activeOnly")} · ${stats.scanSource === "index" ? t("panels.usage.scanSourceIndex") : t("panels.usage.scanSourceFallback")} · ${t("panels.usage.durationMs", { ms: String(stats.durationMs ?? 0) })}`
                        : ""}
                  />
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {(stats?.byDay ?? []).length === 0 ? (
                      <EmptyState />
                    ) : stats!.byDay.map((day) => {
                      const width = largestDailyCost > 0 ? Math.max(3, (day.totals.cost / largestDailyCost) * 100) : 0;
                      return (
                        <div key={day.date} style={{ display: "grid", gridTemplateColumns: "82px minmax(0, 1fr) 72px", alignItems: "center", gap: 8, fontSize: 11 }}>
                          <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{day.date.slice(5)}</span>
                          <div style={{ height: 7, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 999, overflow: "hidden" }}>
                            <div className="usage-daily-bar-fill" style={{ width: `${width}%` }} />
                          </div>
                          <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCost(day.totals.cost)}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="usage-stats-card">
                  <SectionTitle title={t("panels.usage.tokens")} />
                  <TokenRows totals={stats?.totals ?? zeroTotals} locale={locale} />
                </section>
              </div>

              <div className="usage-content-grid usage-content-grid-spaced">
                <Breakdown title={t("panels.usage.models")} rows={(stats?.byModel ?? []).slice(0, 8).map((row) => ({ label: `${row.provider}/${row.model}`, totals: row.totals }))} />
                <Breakdown title={t("panels.usage.providers")} rows={(stats?.byProvider ?? []).map((row) => ({ label: row.provider, totals: row.totals }))} />
              </div>

              <section className="usage-stats-card usage-stats-card-spaced">
                <SectionTitle title={t("panels.usage.sessions")} right={t("panels.usage.skipped", { count: stats?.skippedEntries ?? 0 })} />
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {(stats?.bySession ?? []).length === 0 ? (
                    <EmptyState />
                  ) : stats!.bySession.slice(0, 12).map((session) => (
                    <div key={session.sessionId} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 90px 90px", gap: 10, padding: "8px 0", borderTop: "1px solid var(--border)", alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {session.name || session.firstMessage || session.sessionId}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                          {session.cwd}
                        </div>
                        {session.subagentSessions > 0 && (
                          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                            {t("panels.usage.mainSubagents", {
                              main: formatCost(session.mainTotals.cost),
                              sub: formatCost(session.subagentTotals.cost),
                              count: session.subagentSessions,
                            })}
                          </div>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatTokens(totalTokens(session.totals), locale)}</span>
                      <span style={{ fontSize: 12, color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCost(session.totals.cost)}</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const zeroTotals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };

/**
 * 渲染统计指标块。
 *
 * @param props label 为指标名，value 为指标值，strong 控制高亮样式。
 * @returns 指标块 React 节点。
 */
function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="usage-stats-card usage-metric">
      <div className="usage-metric-label">{label}</div>
      <div className={`usage-metric-value${strong ? " usage-metric-value-strong" : ""}`}>{value}</div>
    </div>
  );
}

/**
 * 渲染面板标题。
 *
 * @param props title 为左侧标题，right 为右侧辅助文本。
 * @returns 标题 React 节点。
 */
function SectionTitle({ title, right }: { title: string; right?: string }) {
  return (
    <div className="usage-stats-card-header">
      <div className="usage-stats-card-title">{title}</div>
      {right && <div className="usage-stats-card-meta">{right}</div>}
    </div>
  );
}

/**
 * 渲染 token 类型拆分行。
 *
 * @param props totals 为 token 汇总对象。
 * @returns token 明细 React 节点。
 */
function TokenRows({ totals, locale }: { totals: UsageTotals; locale: import("@/lib/i18n").Locale }) {
  const { t } = useI18n();
  const rows = [
    [t("panels.usage.input"), totals.input],
    [t("panels.usage.output"), totals.output],
    [t("panels.usage.cacheRead"), totals.cacheRead],
    [t("panels.usage.cacheWrite"), totals.cacheWrite],
  ] as const;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px 54px", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)", fontSize: 12 }}>
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
          <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatTokens(value, locale)}</span>
          <span style={{ color: "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatTokensM(value, locale)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 渲染费用拆分列表。
 *
 * @param props title 为标题，rows 为带汇总数据的拆分行。
 * @returns 拆分面板 React 节点。
 */
function Breakdown({ title, rows }: { title: string; rows: { label: string; totals: UsageTotals }[] }) {
  const { locale } = useI18n();
  return (
    <section className="usage-stats-card">
      <SectionTitle title={title} />
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((row) => (
            <div key={row.label} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 72px 72px", gap: 8, alignItems: "center", padding: "7px 0", borderTop: "1px solid var(--border)", fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
              <span style={{ color: "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatTokens(row.totals.calls, locale)}</span>
              <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatCost(row.totals.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 渲染空统计状态。
 *
 * @returns 空状态 React 节点。
 */
function EmptyState() {
  const { t } = useI18n();
  return <div className="usage-stats-empty">{t("panels.usage.noUsageInRange")}</div>;
}
