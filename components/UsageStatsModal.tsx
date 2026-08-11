"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { formatNumber } from "@/lib/i18n";
import {
  SettingsButton,
  SettingsInput,
  SettingsNotice,
  SettingsTab,
  SettingsTabs,
} from "@/components/ui/SettingsPrimitives";
import { formatCompactTokens, UsageTokenChart, type UsageChartMode } from "@/components/UsageTokenChart";
import type { UsageStatsResult, UsageTotals } from "@/lib/usage-stats";
import {
  buildInclusiveUsageRangeEnding,
  totalUsageTokens,
  validateUsageDateRangeDraft,
} from "@/lib/usage-timeline";

interface UsageStatsModalProps {
  cwd?: string | null;
  onClose: () => void;
}

type UsageScope = "all" | "cwd";
type RangePreset = "7" | "30" | "90" | "custom";

interface AppliedQuery {
  from: string;
  to: string;
  scope: UsageScope;
  preset: RangePreset;
}

/**
 * Format a Date as a local `YYYY-MM-DD` date-input value.
 */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayLocalDate(): string {
  return toDateInputValue(new Date());
}

function defaultSevenDayRange(): { from: string; to: string } {
  return buildInclusiveUsageRangeEnding(todayLocalDate(), 7) ?? {
    from: todayLocalDate(),
    to: todayLocalDate(),
  };
}

function formatCost(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number, locale: import("@/lib/i18n").Locale): string {
  return formatNumber(value, locale);
}

function formatTokensExact(value: number, locale: import("@/lib/i18n").Locale): string {
  return formatNumber(value, locale);
}

/**
 * Global Usage statistics modal with Token structure chart and range controls.
 */
export function UsageStatsModal({ cwd, onClose }: UsageStatsModalProps) {
  const { t, locale } = useI18n();
  const initialRange = useMemo(() => defaultSevenDayRange(), []);
  const initialScope: UsageScope = cwd ? "cwd" : "all";

  const [preset, setPreset] = useState<RangePreset>("7");
  const [draftFrom, setDraftFrom] = useState(initialRange.from);
  const [draftTo, setDraftTo] = useState(initialRange.to);
  const [scope, setScope] = useState<UsageScope>(initialScope);
  const [applied, setApplied] = useState<AppliedQuery>({
    from: initialRange.from,
    to: initialRange.to,
    scope: initialScope,
    preset: "7",
  });
  const [chartMode, setChartMode] = useState<UsageChartMode>("absolute");

  const [stats, setStats] = useState<UsageStatsResult | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const statsRef = useRef<UsageStatsResult | null>(null);
  statsRef.current = stats;

  // Drop cwd scope when the active workspace disappears.
  useEffect(() => {
    if (!cwd && scope === "cwd") {
      setScope("all");
      setApplied((prev) => (prev.scope === "cwd" ? { ...prev, scope: "all" } : prev));
    }
  }, [cwd, scope]);

  const draftValidation = validateUsageDateRangeDraft(draftFrom, draftTo);
  const canApplyCustom = draftValidation == null;
  const customMatchesApplied =
    draftFrom === applied.from && draftTo === applied.to && applied.preset === "custom";

  const applyPreset = useCallback((next: Exclude<RangePreset, "custom">) => {
    const days = next === "7" ? 7 : next === "30" ? 30 : 90;
    const range = buildInclusiveUsageRangeEnding(todayLocalDate(), days);
    if (!range) return;
    setPreset(next);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setApplied((prev) => ({
      from: range.from,
      to: range.to,
      scope: prev.scope,
      preset: next,
    }));
  }, []);

  const applyCustomRange = useCallback(() => {
    if (validateUsageDateRangeDraft(draftFrom, draftTo) != null) return;
    setPreset("custom");
    setApplied((prev) => ({
      from: draftFrom,
      to: draftTo,
      scope: prev.scope,
      preset: "custom",
    }));
  }, [draftFrom, draftTo]);

  const applyScope = useCallback((next: UsageScope) => {
    if (next === "cwd" && !cwd) return;
    setScope(next);
    setApplied((prev) => ({ ...prev, scope: next }));
  }, [cwd]);

  const loadStats = useCallback(async (query: AppliedQuery, opts?: { isRefresh?: boolean }) => {
    const seq = ++requestSeqRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const hasStats = statsRef.current != null;
    if (hasStats || opts?.isRefresh) {
      setRefreshing(true);
      setRefreshError(null);
    } else {
      setInitialLoading(true);
      setInitialError(null);
    }

    try {
      const params = new URLSearchParams({
        from: query.from,
        to: query.to,
        timeline: "auto",
      });
      // Never emit cwd-scoped requests without a real workspace path.
      if (query.scope === "cwd" && cwd) params.set("cwd", cwd);
      const res = await fetch(`/api/usage?${params.toString()}`, { signal: controller.signal });
      const data = await res.json() as UsageStatsResult & { error?: string };
      if (seq !== requestSeqRef.current) return;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStats(data);
      setInitialError(null);
      setRefreshError(null);
    } catch (err) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (statsRef.current != null) {
        setRefreshError(message);
      } else {
        setStats(null);
        setInitialError(message);
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [cwd]);

  // Fetch whenever the applied query identity changes.
  useEffect(() => {
    void loadStats(applied);
    return () => {
      abortRef.current?.abort();
    };
  }, [applied, loadStats]);

  const handleRefresh = useCallback(() => {
    void loadStats(applied, { isRefresh: true });
  }, [applied, loadStats]);

  const customValidationMessage =
    preset === "custom" || draftFrom !== applied.from || draftTo !== applied.to
      ? draftValidation === "empty"
        ? t("panels.usage.rangeInvalidEmpty")
        : draftValidation === "malformed"
          ? t("panels.usage.rangeInvalidMalformed")
          : draftValidation === "order"
            ? t("panels.usage.rangeInvalidOrder")
            : null
      : null;

  const showBlockingError = !stats && Boolean(initialError);
  const showInitialSkeleton = !stats && initialLoading && !initialError;

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
      <div className="pi-modal-panel pi-modal-panel-wide usage-modal-panel">
        <div className="pi-modal-header usage-modal-header">
          <div className="usage-modal-title-row">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6" />
            </svg>
            <div className="pi-modal-title">{t("panels.usage.shortTitle")}</div>
          </div>

          <div className="usage-modal-controls">
            <SettingsTabs aria-label={t("panels.usage.presetAria")}>
              {([
                ["7", t("panels.usage.preset7")],
                ["30", t("panels.usage.preset30")],
                ["90", t("panels.usage.preset90")],
                ["custom", t("panels.usage.presetCustom")],
              ] as const).map(([id, label]) => (
                <SettingsTab
                  key={id}
                  active={preset === id}
                  onClick={() => {
                    if (id === "custom") {
                      setPreset("custom");
                      return;
                    }
                    applyPreset(id);
                  }}
                >
                  {label}
                </SettingsTab>
              ))}
            </SettingsTabs>

            {preset === "custom" ? (
              <div className="usage-custom-range">
                <label className="usage-filter-label">
                  {t("panels.usage.from")}
                  <SettingsInput
                    type="date"
                    value={draftFrom}
                    onChange={(e) => {
                      setDraftFrom(e.target.value);
                      setPreset("custom");
                    }}
                    className="usage-date-input"
                  />
                </label>
                <label className="usage-filter-label">
                  {t("panels.usage.to")}
                  <SettingsInput
                    type="date"
                    value={draftTo}
                    onChange={(e) => {
                      setDraftTo(e.target.value);
                      setPreset("custom");
                    }}
                    className="usage-date-input"
                  />
                </label>
                <SettingsButton
                  size="sm"
                  variant="secondary"
                  disabled={!canApplyCustom || customMatchesApplied}
                  onClick={applyCustomRange}
                >
                  {t("panels.usage.applyRange")}
                </SettingsButton>
              </div>
            ) : (
              <span className="usage-range-summary" title={`${applied.from} – ${applied.to}`}>
                {t("panels.usage.rangeSummary", { from: applied.from, to: applied.to })}
              </span>
            )}

            <SettingsTabs aria-label={t("panels.usage.scopeAria")}>
              {(["all", "cwd"] as UsageScope[]).map((item) => (
                <SettingsTab
                  key={item}
                  active={scope === item}
                  disabled={item === "cwd" && !cwd}
                  onClick={() => applyScope(item)}
                >
                  {item === "all" ? t("panels.usage.scopeAll") : t("panels.usage.scopeCwd")}
                </SettingsTab>
              ))}
            </SettingsTabs>

            <SettingsButton
              size="icon"
              onClick={handleRefresh}
              disabled={initialLoading || refreshing}
              busy={refreshing}
              title={t("panels.usage.refresh")}
              aria-label={t("panels.usage.refreshAria")}
            >
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
          {customValidationMessage && (
            <SettingsNotice tone="warning">{customValidationMessage}</SettingsNotice>
          )}

          {showBlockingError ? (
            <SettingsNotice tone="danger">
              <div>{initialError}</div>
              <div style={{ marginTop: 8 }}>
                <SettingsButton size="sm" onClick={handleRefresh}>
                  {t("panels.usage.retry")}
                </SettingsButton>
              </div>
            </SettingsNotice>
          ) : showInitialSkeleton ? (
            <div className="usage-stats-empty" role="status" aria-live="polite">
              {t("panels.usage.loading")}
            </div>
          ) : stats ? (
            <div className={`usage-stats-live${refreshing ? " is-refreshing" : ""}`} aria-busy={refreshing || undefined}>
              {(refreshing || refreshError) && (
                <div className="usage-refresh-status" role="status" aria-live="polite">
                  {refreshing ? (
                    <SettingsNotice tone="info">{t("panels.usage.refreshing")}</SettingsNotice>
                  ) : (
                    <SettingsNotice tone="danger">
                      {t("panels.usage.refreshError", { error: refreshError ?? "" })}
                    </SettingsNotice>
                  )}
                </div>
              )}

              <div className="usage-metric-grid">
                <Metric label={t("panels.usage.totalCost")} value={formatCost(stats.totals.cost)} strong />
                <Metric
                  label={t("panels.usage.tokens")}
                  value={formatCompactTokens(totalUsageTokens(stats.totals), locale)}
                  detail={formatTokensExact(totalUsageTokens(stats.totals), locale)}
                />
                <Metric label={t("panels.usage.calls")} value={formatTokens(stats.totals.calls, locale)} />
                <Metric
                  label={t("panels.usage.sessionsWithUsageMatched")}
                  value={`${stats.bySession.length}/${stats.matchedSessions}`}
                  detail={t("panels.usage.sessionsWithUsageHint")}
                />
                <Metric label={t("panels.usage.mainCost")} value={formatCost(stats.mainTotals.cost)} />
                <Metric label={t("panels.usage.subagentCost")} value={formatCost(stats.subagentTotals.cost)} />
              </div>

              <div className="usage-diagnostics" aria-label={t("panels.usage.diagnosticsAria")}>
                <span>{t("panels.usage.subagentSessions")}: {formatTokens(stats.subagentSessions, locale)}</span>
                <span>{t("panels.usage.scannedActiveArchive")}: {stats.scannedActiveSessions}/{stats.scannedArchivedSessions}</span>
                <span>{t("panels.usage.matchedActiveArchive")}: {stats.matchedActiveSessions}/{stats.matchedArchivedSessions}</span>
                <span>
                  {stats.scanSource === "index"
                    ? t("panels.usage.scanSourceIndex")
                    : t("panels.usage.scanSourceFallback")}
                  {" · "}
                  {t("panels.usage.durationMs", { ms: String(stats.durationMs ?? 0) })}
                  {" · "}
                  {stats.scope.timezone}
                </span>
              </div>

              <section className="usage-stats-card usage-chart-card">
                <div className="usage-stats-card-header">
                  <div className="usage-stats-card-meta usage-chart-meta">
                    {t("panels.usage.chartMeta", {
                      from: stats.from,
                      to: stats.to,
                      granularity:
                        stats.timeline?.granularity === "week"
                          ? t("panels.usage.granularityWeek")
                          : stats.timeline?.granularity === "month"
                            ? t("panels.usage.granularityMonth")
                            : t("panels.usage.granularityDay"),
                      archive: stats.scope.includeArchived
                        ? t("panels.usage.withArchive")
                        : t("panels.usage.activeOnly"),
                    })}
                  </div>
                </div>
                {stats.timeline ? (
                  <UsageTokenChart
                    timeline={stats.timeline}
                    mode={chartMode}
                    onModeChange={setChartMode}
                    locale={locale}
                    refreshing={refreshing}
                  />
                ) : (
                  <div className="usage-stats-empty">{t("panels.usage.chartEmpty")}</div>
                )}
              </section>

              <div className="usage-content-grid usage-content-grid-spaced">
                <section className="usage-stats-card">
                  <SectionTitle title={t("panels.usage.tokens")} right={t("panels.usage.detailRangeNote")} />
                  <TokenRows totals={stats.totals} locale={locale} />
                </section>
              </div>

              <div className="usage-content-grid usage-content-grid-spaced">
                <Breakdown
                  title={t("panels.usage.models")}
                  rows={stats.byModel.slice(0, 8).map((row) => ({
                    label: `${row.provider}/${row.model}`,
                    totals: row.totals,
                  }))}
                />
                <Breakdown
                  title={t("panels.usage.providers")}
                  rows={stats.byProvider.map((row) => ({
                    label: row.provider,
                    totals: row.totals,
                  }))}
                />
              </div>

              <section className="usage-stats-card usage-stats-card-spaced">
                <SectionTitle title={t("panels.usage.sessions")} right={t("panels.usage.skipped", { count: stats.skippedEntries })} />
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {stats.bySession.length === 0 ? (
                    <EmptyState />
                  ) : (
                    stats.bySession.slice(0, 12).map((session) => (
                      <div
                        key={session.sessionId}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) 90px 90px",
                          gap: 10,
                          padding: "8px 0",
                          borderTop: "1px solid var(--border)",
                          alignItems: "center",
                        }}
                      >
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
                        <span style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {formatTokens(totalUsageTokens(session.totals), locale)}
                        </span>
                        <span style={{ fontSize: 12, color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {formatCost(session.totals.cost)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  strong,
}: {
  label: string;
  value: string;
  detail?: string;
  strong?: boolean;
}) {
  return (
    <div className="usage-stats-card usage-metric">
      <div className="usage-metric-label">{label}</div>
      <div className={`usage-metric-value${strong ? " usage-metric-value-strong" : ""}`}>{value}</div>
      {detail ? <div className="usage-metric-detail">{detail}</div> : null}
    </div>
  );
}

function SectionTitle({ title, right }: { title: string; right?: string }) {
  return (
    <div className="usage-stats-card-header">
      <div className="usage-stats-card-title">{title}</div>
      {right && <div className="usage-stats-card-meta">{right}</div>}
    </div>
  );
}

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
        <div
          key={label}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 72px minmax(96px, auto)",
            gap: 8,
            alignItems: "center",
            padding: "6px 0",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
          <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 650 }}>
            {formatCompactTokens(value, locale)}
          </span>
          <span style={{ color: "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {formatTokensExact(value, locale)}
          </span>
        </div>
      ))}
    </div>
  );
}

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
            <div
              key={row.label}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 72px 72px",
                gap: 8,
                alignItems: "center",
                padding: "7px 0",
                borderTop: "1px solid var(--border)",
                fontSize: 11,
              }}
            >
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.label}
              </span>
              <span style={{ color: "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {formatTokens(row.totals.calls, locale)}
              </span>
              <span style={{ color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {formatCost(row.totals.cost)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyState() {
  const { t } = useI18n();
  return <div className="usage-stats-empty">{t("panels.usage.noUsageInRange")}</div>;
}
