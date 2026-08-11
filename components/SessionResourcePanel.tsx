"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import type { SessionBillingStats, SessionPerformanceSummary } from "@/lib/types";

export interface SessionResourceContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

interface Props {
  sessionStats: (Pick<SessionBillingStats, "tokens"> & { cost?: number }) | null;
  sessionPerformance: SessionPerformanceSummary | null;
  contextUsage: SessionResourceContextUsage | null;
  onOpenGlobalUsage: () => void;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

function formatTps(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatTtft(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function performanceKey(summary: SessionPerformanceSummary | null): string | null {
  if (!summary) return null;
  return [
    summary.sampleCount,
    summary.totalOutputTokens,
    summary.totalStreamDurationMs,
    summary.totalTtftMs,
    ...summary.byModel.map((row) => `${row.provider}:${row.model}:${row.sampleCount}:${row.totalOutputTokens}`),
  ].join("|");
}

export const SessionResourcePanel = memo(function SessionResourcePanel({
  sessionStats,
  sessionPerformance,
  contextUsage,
  onOpenGlobalUsage,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const panelId = useId();

  const tokens = sessionStats?.tokens;
  const cost = sessionStats?.cost ?? 0;
  const totalTokens = tokens
    ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
    : 0;
  const usageSummary = cost > 0
    ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`)
    : totalTokens > 0
      ? formatCompact(totalTokens)
      : null;

  let contextTone = "";
  let contextSummary: string | null = null;
  if (contextUsage?.contextWindow) {
    const percent = contextUsage.percent;
    if (percent !== null && percent > 90) contextTone = " is-danger";
    else if (percent !== null && percent > 70) contextTone = " is-warning";
    contextSummary = percent !== null ? `${percent.toFixed(0)}%` : "?";
  }

  const avgTpsLabel = formatTps(sessionPerformance?.avgTps ?? null);
  const avgTtftLabel = formatTtft(sessionPerformance?.avgTtftMs ?? null);
  const hasPerformance = Boolean(sessionPerformance && sessionPerformance.sampleCount > 0 && avgTpsLabel);
  const perfKey = performanceKey(sessionPerformance);

  const updatePanelPosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPanelPosition({
      top: Math.min(rect.bottom + 6, window.innerHeight - 16),
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleOutsideInteraction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
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

  // Keep panel geometry in sync when the compact trigger contents change.
  useEffect(() => {
    if (open) updatePanelPosition();
  }, [open, usageSummary, contextSummary, avgTpsLabel, perfKey, updatePanelPosition]);

  const triggerLabel = useMemo(() => {
    const parts: string[] = [t("app.sessionUsage")];
    if (hasPerformance && avgTpsLabel) {
      parts.push(t("app.sessionAvgTpsValue", { value: avgTpsLabel }));
    }
    return parts.join(" · ");
  }, [avgTpsLabel, hasPerformance, t]);

  if (!contextSummary && !usageSummary && !hasPerformance) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="app-resource-session"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (!open) updatePanelPosition();
          setOpen((value) => !value);
        }}
      >
        {contextSummary && (
          <span className={`app-resource-context${contextTone}`}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 13V8a6 6 0 0 1 12 0v5" />
              <path d="M2 13h12" />
            </svg>
            <span className="app-resource-context-label">{t("app.contextUsage")}</span>
            <strong>{contextSummary}</strong>
          </span>
        )}
        {usageSummary && <span className="app-resource-cost">{usageSummary}</span>}
        {hasPerformance && avgTpsLabel && (
          <span className="app-resource-tps" title={t("app.sessionAvgTpsTitle")}>
            <span className="app-resource-tps-label">{t("app.sessionAvgTps")}</span>
            <strong>{avgTpsLabel}</strong>
            <span className="app-resource-tps-unit">t/s</span>
          </span>
        )}
      </button>

      {open && panelPosition && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t("app.sessionResourceDetails")}
          className="usage-popover session-resource-popover"
          style={{ top: panelPosition.top, right: panelPosition.right }}
        >
          <div className="usage-popover-header">
            <div>
              <div className="usage-popover-title">{t("app.sessionResourceDetails")}</div>
              <div className="usage-popover-meta">{t("app.sessionResourceDetailsMeta")}</div>
            </div>
          </div>

          <section className="session-resource-section" aria-label={t("app.sessionPerformance")}>
            <div className="usage-section-title">{t("app.sessionPerformance")}</div>
            {hasPerformance && sessionPerformance ? (
              <div className="session-resource-metrics">
                <div className="session-resource-metric">
                  <span className="session-resource-metric-label">{t("app.sessionAvgTps")}</span>
                  <strong>{avgTpsLabel} t/s</strong>
                </div>
                <div className="session-resource-metric">
                  <span className="session-resource-metric-label">{t("app.sessionAvgTtft")}</span>
                  <strong>{avgTtftLabel ?? "—"}</strong>
                </div>
                <div className="session-resource-metric">
                  <span className="session-resource-metric-label">{t("app.sessionSampleCount")}</span>
                  <strong>{sessionPerformance.sampleCount}</strong>
                </div>
                {sessionPerformance.mixedModels && (
                  <p className="session-resource-note">{t("app.sessionMixedModelsNote")}</p>
                )}
                {sessionPerformance.byModel.length > 0 && (
                  <div className="session-resource-model-list" aria-label={t("app.sessionModelBreakdown")}>
                    {sessionPerformance.byModel.map((row) => {
                      const rowTps = formatTps(row.avgTps);
                      const rowTtft = formatTtft(row.avgTtftMs);
                      return (
                        <div key={`${row.provider}:${row.model}`} className="session-resource-model-row">
                          <div className="session-resource-model-name">
                            <span>{row.provider}</span>
                            <strong>{row.model}</strong>
                          </div>
                          <div className="session-resource-model-stats">
                            <span>{rowTps ? `${rowTps} t/s` : "—"}</span>
                            <span>{rowTtft ? `TTFT ${rowTtft}` : "—"}</span>
                            <span>{t("app.sessionSamplesShort", { count: row.sampleCount })}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="session-resource-note">{t("app.sessionPerformanceFootnote")}</p>
              </div>
            ) : (
              <p className="usage-popover-empty">{t("app.sessionNoAccurateSamples")}</p>
            )}
          </section>

          {(tokens || contextUsage?.contextWindow) && (
            <section className="session-resource-section" aria-label={t("app.sessionBillingContext")}>
              <div className="usage-section-title">{t("app.sessionBillingContext")}</div>
              <div className="session-resource-metrics">
                {tokens && (
                  <>
                    <div className="session-resource-metric">
                      <span className="session-resource-metric-label">{t("panels.usage.input")}</span>
                      <strong>{tokens.input.toLocaleString()}</strong>
                    </div>
                    <div className="session-resource-metric">
                      <span className="session-resource-metric-label">{t("panels.usage.output")}</span>
                      <strong>{tokens.output.toLocaleString()}</strong>
                    </div>
                    <div className="session-resource-metric">
                      <span className="session-resource-metric-label">{t("panels.usage.cacheRead")}</span>
                      <strong>{tokens.cacheRead.toLocaleString()}</strong>
                    </div>
                    <div className="session-resource-metric">
                      <span className="session-resource-metric-label">{t("panels.usage.cacheWrite")}</span>
                      <strong>{tokens.cacheWrite.toLocaleString()}</strong>
                    </div>
                    {cost > 0 && (
                      <div className="session-resource-metric">
                        <span className="session-resource-metric-label">{t("panels.usage.totalCost")}</span>
                        <strong>${cost.toFixed(4)}</strong>
                      </div>
                    )}
                  </>
                )}
                {contextUsage?.contextWindow && (
                  <div className="session-resource-metric">
                    <span className="session-resource-metric-label">{t("app.contextUsage")}</span>
                    <strong>
                      {contextUsage.percent !== null
                        ? `${contextUsage.percent.toFixed(1)}%`
                        : "—"}
                      {" / "}
                      {contextUsage.contextWindow.toLocaleString()}
                    </strong>
                  </div>
                )}
              </div>
            </section>
          )}

          <div className="session-resource-actions">
            <button
              type="button"
              className="session-resource-global-usage"
              onClick={() => {
                setOpen(false);
                onOpenGlobalUsage();
              }}
            >
              {t("app.openGlobalUsage")}
            </button>
          </div>
        </div>
      ), document.body)}
    </>
  );
});
