"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "@/components/I18nProvider";
import { formatNumber, type Locale } from "@/lib/i18n";
import { SettingsTab, SettingsTabs } from "@/components/ui/SettingsPrimitives";
import type { UsageTotals } from "@/lib/usage-stats";
import {
  USAGE_TOKEN_SERIES,
  clampUsageBucketIndex,
  maxUsageTimelineTokenTotal,
  pickUsageAxisLabelIndices,
  pickUsageAxisScale,
  totalUsageTokens,
  usageTokenSeriesShares,
  usageTokenSeriesValue,
  type UsageTimeline,
  type UsageTokenSeriesId,
} from "@/lib/usage-timeline";

export type UsageChartMode = "absolute" | "percent";

interface UsageTokenChartProps {
  timeline: UsageTimeline;
  mode: UsageChartMode;
  onModeChange: (mode: UsageChartMode) => void;
  locale: Locale;
  /** Optional busy flag while a newer range is loading over retained data. */
  refreshing?: boolean;
}

interface TooltipModel {
  index: number;
  pinned: boolean;
}

const SERIES_CLASS: Record<UsageTokenSeriesId, string> = {
  input: "usage-token-seg-input",
  output: "usage-token-seg-output",
  cacheRead: "usage-token-seg-cache-read",
  cacheWrite: "usage-token-seg-cache-write",
};

/**
 * Format large axis / metric values compactly while keeping exact Tooltip numbers elsewhere.
 */
export function formatCompactTokens(value: number, locale: Locale): string {
  if (!Number.isFinite(value) || value === 0) return formatNumber(0, locale);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${formatNumber(value / 1_000_000_000, locale, { maximumFractionDigits: 1 })}B`;
  }
  if (abs >= 1_000_000) {
    return `${formatNumber(value / 1_000_000, locale, { maximumFractionDigits: 1 })}M`;
  }
  if (abs >= 10_000) {
    return `${formatNumber(value / 1_000, locale, { maximumFractionDigits: 1 })}K`;
  }
  return formatNumber(value, locale);
}

function formatPercent(share: number, locale: Locale): string {
  const pct = share * 100;
  if (!Number.isFinite(pct) || pct <= 0) return `${formatNumber(0, locale, { maximumFractionDigits: 1 })}%`;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${formatNumber(pct, locale, { maximumFractionDigits: 1 })}%`;
}

function seriesLabelKey(series: UsageTokenSeriesId): `panels.usage.${UsageTokenSeriesId}` {
  return `panels.usage.${series}`;
}

function isNodeInside(container: HTMLElement | null, node: EventTarget | null): boolean {
  return Boolean(container && node instanceof Node && container.contains(node));
}

/**
 * Accessible four-series Token structure chart (absolute / 100% stacked).
 * Pointer, touch, and keyboard share one detail model; legends only highlight.
 */
export function UsageTokenChart({
  timeline,
  mode,
  onModeChange,
  locale,
  refreshing = false,
}: UsageTokenChartProps) {
  const { t } = useI18n();
  const labelId = useId();
  const descId = useId();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const bucketRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [highlightSeries, setHighlightSeries] = useState<UsageTokenSeriesId | null>(null);
  const [hoverSeries, setHoverSeries] = useState<UsageTokenSeriesId | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const [bucketFocused, setBucketFocused] = useState(false);
  const [tooltipHovered, setTooltipHovered] = useState(false);

  const buckets = timeline.buckets;
  const bucketCount = buckets.length;
  const maxTokens = maxUsageTimelineTokenTotal(timeline);
  const allZero = maxTokens <= 0;
  const activeHighlight = hoverSeries ?? highlightSeries;

  const labelIndices = useMemo(
    () => new Set(pickUsageAxisLabelIndices(bucketCount, bucketCount > 40 ? 5 : bucketCount > 14 ? 7 : 10)),
    [bucketCount],
  );
  const axisScale = useMemo(
    () => (mode === "percent"
      ? { ticks: [0, 25, 50, 75, 100], scaleMax: 100 }
      : pickUsageAxisScale(maxTokens, 5)),
    [mode, maxTokens],
  );
  const yTicks = axisScale.ticks;
  const scaleMax = axisScale.scaleMax;

  // Reset interaction when the bucket identity set changes (new range/granularity).
  const bucketKeySignature = useMemo(() => buckets.map((b) => b.key).join("|"), [buckets]);
  useEffect(() => {
    setFocusIndex(0);
    setHoverIndex(null);
    setPinnedIndex(null);
    setTooltipPos(null);
    setTooltipHovered(false);
    setHighlightSeries(null);
    bucketRefs.current = [];
  }, [bucketKeySignature]);

  // Show detail for pinned, else hover (including while reading the Tooltip), else focused bucket.
  const shownIndex = pinnedIndex
    ?? (hoverIndex != null && (tooltipHovered || hoverIndex >= 0) ? hoverIndex : null)
    ?? (bucketFocused ? focusIndex : null);

  const tooltip = useMemo<TooltipModel | null>(() => {
    if (shownIndex == null || shownIndex < 0 || shownIndex >= bucketCount) return null;
    return { index: shownIndex, pinned: pinnedIndex === shownIndex };
  }, [shownIndex, bucketCount, pinnedIndex]);

  const tooltipIndex = tooltip?.index ?? null;

  const updateTooltipPosition = useCallback((index: number) => {
    const plot = plotRef.current;
    const button = bucketRefs.current[index];
    if (!plot || !button) {
      setTooltipPos(null);
      return;
    }
    const plotRect = plot.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const tooltipWidth = 220;
    const tooltipHeight = 148;
    let left = btnRect.left - plotRect.left + btnRect.width / 2 - tooltipWidth / 2;
    let top = btnRect.top - plotRect.top - tooltipHeight - 8;
    left = Math.max(4, Math.min(left, plotRect.width - tooltipWidth - 4));
    if (top < 4) {
      top = btnRect.bottom - plotRect.top + 8;
    }
    top = Math.max(4, Math.min(top, Math.max(4, plotRect.height - tooltipHeight - 4)));
    setTooltipPos({ left, top });
  }, []);

  useEffect(() => {
    if (tooltipIndex == null) {
      setTooltipPos(null);
      return;
    }
    updateTooltipPosition(tooltipIndex);
  }, [tooltipIndex, updateTooltipPosition, mode, activeHighlight, bucketKeySignature]);

  const moveFocus = useCallback((next: number) => {
    const index = clampUsageBucketIndex(next, bucketCount);
    setFocusIndex(index);
    setBucketFocused(true);
    window.requestAnimationFrame(() => bucketRefs.current[index]?.focus());
  }, [bucketCount]);

  const clearPinnedDetail = useCallback(() => {
    setPinnedIndex(null);
    setHoverIndex(null);
    setTooltipHovered(false);
  }, []);

  const clearHighlight = useCallback(() => {
    setHighlightSeries(null);
    setHoverSeries(null);
  }, []);

  const handleBucketKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFocus(index + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(index - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      moveFocus(bucketCount - 1);
      return;
    }
    if (event.key === "Escape") {
      if (pinnedIndex != null || highlightSeries != null) {
        event.preventDefault();
        event.stopPropagation();
        clearPinnedDetail();
        clearHighlight();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPinnedIndex((current) => (current === index ? null : index));
    }
  }, [bucketCount, moveFocus, pinnedIndex, highlightSeries, clearPinnedDetail, clearHighlight]);

  const handlePlotPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Blank plot / gaps / grid: unpin. Buckets and the readable Tooltip keep their own handlers.
    if (target.closest(".usage-token-bucket") || target.closest(".usage-token-tooltip")) return;
    clearPinnedDetail();
  }, [clearPinnedDetail]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pinnedIndex == null && highlightSeries == null && hoverIndex == null) return;
      clearPinnedDetail();
      clearHighlight();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pinnedIndex, highlightSeries, hoverIndex, clearPinnedDetail, clearHighlight]);

  const granularityLabel =
    timeline.granularity === "day"
      ? t("panels.usage.granularityDay")
      : timeline.granularity === "week"
        ? t("panels.usage.granularityWeek")
        : t("panels.usage.granularityMonth");

  const renderBucket = (index: number) => {
    const bucket = buckets[index]!;
    const tokenTotal = totalUsageTokens(bucket.totals);
    const heightPct =
      mode === "percent"
        ? tokenTotal > 0
          ? 100
          : 0
        : scaleMax > 0
          ? (tokenTotal / scaleMax) * 100
          : 0;
    const shares = usageTokenSeriesShares(bucket.totals);
    const isActive = tooltip?.index === index;
    const tabIndex = index === focusIndex ? 0 : -1;

    const ariaParts = [
      bucket.from === bucket.to ? bucket.from : `${bucket.from} – ${bucket.to}`,
      t("panels.usage.tooltipTotal", { value: formatNumber(tokenTotal, locale) }),
      ...USAGE_TOKEN_SERIES.map((series) => {
        const value = usageTokenSeriesValue(bucket.totals, series);
        return `${t(seriesLabelKey(series))}: ${formatNumber(value, locale)} (${formatPercent(shares[series], locale)})`;
      }),
    ];

    return (
      <button
        key={bucket.key}
        ref={(el) => {
          bucketRefs.current[index] = el;
        }}
        type="button"
        className={`usage-token-bucket${isActive ? " is-active" : ""}${tokenTotal <= 0 ? " is-empty" : ""}`}
        style={{ ["--usage-bucket-height" as string]: `${Math.max(0, Math.min(100, heightPct))}%` }}
        tabIndex={tabIndex}
        aria-label={ariaParts.join(". ")}
        aria-pressed={pinnedIndex === index}
        onKeyDown={(event) => handleBucketKeyDown(event, index)}
        onFocus={() => {
          setFocusIndex(index);
          setBucketFocused(true);
        }}
        onBlur={(event: FocusEvent<HTMLButtonElement>) => {
          if (
            !isNodeInside(event.currentTarget.parentElement, event.relatedTarget)
            && !isNodeInside(tooltipRef.current, event.relatedTarget)
          ) {
            setBucketFocused(false);
          }
        }}
        onMouseEnter={() => setHoverIndex(index)}
        onMouseLeave={(event) => {
          if (isNodeInside(tooltipRef.current, event.relatedTarget)) return;
          setHoverIndex((current) => (current === index ? null : current));
        }}
        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();
          setPinnedIndex((current) => (current === index ? null : index));
          setFocusIndex(index);
        }}
      >
        <span className="usage-token-bucket-stack" aria-hidden="true">
          {USAGE_TOKEN_SERIES.map((series) => {
            const value = usageTokenSeriesValue(bucket.totals, series);
            if (value <= 0 || tokenTotal <= 0) return null;
            const segPct =
              mode === "percent" ? shares[series] * 100 : (value / tokenTotal) * 100;
            const dimmed = activeHighlight != null && activeHighlight !== series;
            return (
              <span
                key={series}
                className={`usage-token-seg ${SERIES_CLASS[series]}${dimmed ? " is-dimmed" : ""}${activeHighlight === series ? " is-emphasized" : ""}`}
                style={{ flexGrow: segPct, flexBasis: 0 }}
              />
            );
          })}
        </span>
      </button>
    );
  };

  const tooltipBucket = tooltip ? buckets[tooltip.index] : null;
  const tooltipTotals = tooltipBucket?.totals;
  const tooltipShares = tooltipTotals ? usageTokenSeriesShares(tooltipTotals) : null;

  return (
    <section
      className={`usage-token-chart${refreshing ? " is-refreshing" : ""}`}
      aria-labelledby={labelId}
      aria-describedby={descId}
      aria-busy={refreshing || undefined}
    >
      <div className="usage-token-chart-header">
        <div className="usage-token-chart-heading">
          <h3 id={labelId} className="usage-stats-card-title">
            {t("panels.usage.chartTitle")}
          </h3>
          <p id={descId} className="usage-token-chart-desc">
            {t("panels.usage.chartDescription", { granularity: granularityLabel })}
          </p>
        </div>
        <SettingsTabs aria-label={t("panels.usage.modeAria")} className="usage-token-mode-tabs">
          <SettingsTab
            active={mode === "absolute"}
            onClick={() => onModeChange("absolute")}
          >
            {t("panels.usage.modeAbsolute")}
          </SettingsTab>
          <SettingsTab
            active={mode === "percent"}
            onClick={() => onModeChange("percent")}
          >
            {t("panels.usage.modePercent")}
          </SettingsTab>
        </SettingsTabs>
      </div>

      <div className="usage-token-legend" role="group" aria-label={t("panels.usage.legendAria")}>
        {USAGE_TOKEN_SERIES.map((series) => {
          const active = highlightSeries === series;
          const hovered = hoverSeries === series;
          return (
            <button
              key={series}
              type="button"
              className={`usage-token-legend-item${active || hovered ? " is-active" : ""}${activeHighlight != null && activeHighlight !== series ? " is-dimmed" : ""}`}
              aria-pressed={active}
              onMouseEnter={() => setHoverSeries(series)}
              onMouseLeave={() => setHoverSeries(null)}
              onFocus={() => setHoverSeries(series)}
              onBlur={() => setHoverSeries(null)}
              onClick={() => setHighlightSeries((current) => (current === series ? null : series))}
            >
              <span className={`usage-token-legend-swatch ${SERIES_CLASS[series]}`} aria-hidden="true" />
              <span>{t(seriesLabelKey(series))}</span>
            </button>
          );
        })}
      </div>

      {bucketCount === 0 || allZero ? (
        <div className="usage-stats-empty" role="status">
          {t("panels.usage.chartEmpty")}
        </div>
      ) : (
        <div className="usage-token-plot-wrap">
          <div className="usage-token-y-axis" aria-hidden="true">
            {[...yTicks].reverse().map((tick) => (
              <span key={tick} className="usage-token-y-tick">
                {mode === "percent"
                  ? `${formatNumber(tick, locale, { maximumFractionDigits: 0 })}%`
                  : formatCompactTokens(tick, locale)}
              </span>
            ))}
          </div>
          <div
            ref={plotRef}
            className="usage-token-plot"
            onPointerDown={handlePlotPointerDown}
          >
            <div className="usage-token-grid" aria-hidden="true">
              {yTicks.map((tick) => {
                const bottom =
                  mode === "percent"
                    ? tick
                    : scaleMax > 0
                      ? (tick / scaleMax) * 100
                      : 0;
                return (
                  <span
                    key={`grid-${tick}`}
                    className="usage-token-grid-line"
                    style={{ bottom: `${bottom}%` }}
                  />
                );
              })}
            </div>
            <div className="usage-token-buckets" role="list">
              {buckets.map((_, index) => renderBucket(index))}
            </div>
            <div className="usage-token-x-axis" aria-hidden="true">
              {buckets.map((bucket, index) => (
                <span
                  key={`label-${bucket.key}`}
                  className={`usage-token-x-label${labelIndices.has(index) ? " is-visible" : ""}`}
                >
                  {labelIndices.has(index) ? formatBucketAxisLabel(bucket.from, bucket.to, timeline.granularity) : ""}
                </span>
              ))}
            </div>

            {tooltip && tooltipBucket && tooltipTotals && tooltipShares && tooltipPos && (
              <div
                ref={tooltipRef}
                className={`usage-token-tooltip${tooltip.pinned ? " is-pinned" : ""}`}
                role="tooltip"
                style={{ left: tooltipPos.left, top: tooltipPos.top }}
                onMouseEnter={() => {
                  setTooltipHovered(true);
                  if (tooltipIndex != null) setHoverIndex(tooltipIndex);
                }}
                onMouseLeave={(event) => {
                  setTooltipHovered(false);
                  if (isNodeInside(bucketRefs.current[tooltipIndex ?? -1] ?? null, event.relatedTarget)) {
                    return;
                  }
                  if (pinnedIndex == null) setHoverIndex(null);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="usage-token-tooltip-range">
                  {tooltipBucket.from === tooltipBucket.to
                    ? tooltipBucket.from
                    : `${tooltipBucket.from} – ${tooltipBucket.to}`}
                </div>
                <div className="usage-token-tooltip-total">
                  {t("panels.usage.tooltipTotal", {
                    value: formatNumber(totalUsageTokens(tooltipTotals), locale),
                  })}
                </div>
                <ul className="usage-token-tooltip-rows">
                  {USAGE_TOKEN_SERIES.map((series) => (
                    <li key={series}>
                      <span className={`usage-token-legend-swatch ${SERIES_CLASS[series]}`} aria-hidden="true" />
                      <span className="usage-token-tooltip-name">{t(seriesLabelKey(series))}</span>
                      <span className="usage-token-tooltip-value">
                        {formatNumber(usageTokenSeriesValue(tooltipTotals, series), locale)}
                      </span>
                      <span className="usage-token-tooltip-pct">
                        {formatPercent(tooltipShares[series], locale)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="usage-token-chart-hint">{t("panels.usage.chartKeyboardHint")}</p>
    </section>
  );
}

function formatBucketAxisLabel(from: string, to: string, granularity: UsageTimeline["granularity"]): string {
  if (granularity === "day") return from.slice(5);
  if (granularity === "month") return from.slice(0, 7);
  if (from === to) return from.slice(5);
  return `${from.slice(5)}–${to.slice(5)}`;
}

/** Exported for tests that need stable series order without mounting React. */
export function usageChartSeriesOrder(): readonly UsageTokenSeriesId[] {
  return USAGE_TOKEN_SERIES;
}

/** Pure helper: absolute column height percent against a nice axis scale. */
export function absoluteBucketHeightPct(totals: UsageTotals, scaleMax: number): number {
  if (!(scaleMax > 0)) return 0;
  return (totalUsageTokens(totals) / scaleMax) * 100;
}
