import type { UsageDaySummary, UsageTotals } from "@/lib/usage-stats";

/** Auto-selected chart bucket size for a selected inclusive calendar range. */
export type UsageTimelineGranularity = "day" | "week" | "month";

/** Fixed Token series order used by the Usage structure chart. */
export const USAGE_TOKEN_SERIES = ["input", "output", "cacheRead", "cacheWrite"] as const;

export type UsageTokenSeriesId = (typeof USAGE_TOKEN_SERIES)[number];

/** One zero-filled or aggregated chart bucket with clipped display range. */
export interface UsageTimelineBucket {
  /** Stable bucket identity: day `YYYY-MM-DD`, week Monday `YYYY-MM-DD`, month `YYYY-MM`. */
  key: string;
  /** Inclusive display start clipped to the selected range. */
  from: string;
  /** Inclusive display end clipped to the selected range. */
  to: string;
  totals: UsageTotals;
}

/** Self-describing auto timeline returned by the opt-in Usage projection. */
export interface UsageTimeline {
  granularity: UsageTimelineGranularity;
  buckets: UsageTimelineBucket[];
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/**
 * Create an empty additive Usage totals object.
 */
export function createEmptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
}

/**
 * Clone totals so zero-fill rows never share mutable state.
 */
export function cloneUsageTotals(totals: UsageTotals | undefined | null): UsageTotals {
  if (!totals) return createEmptyUsageTotals();
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    cost: totals.cost,
    calls: totals.calls,
  };
}

/**
 * Add every numeric UsageTotals field from source into target.
 */
export function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.calls += source.calls;
}

/**
 * Sum the four Token categories visualized by the chart.
 */
export function totalUsageTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

/**
 * Read one Token series value from totals.
 */
export function usageTokenSeriesValue(totals: UsageTotals, series: UsageTokenSeriesId): number {
  return totals[series];
}

/**
 * Exact series share of total Tokens in [0, 1]. Zero total yields all zeros.
 */
export function usageTokenSeriesShares(totals: UsageTotals): Record<UsageTokenSeriesId, number> {
  const total = totalUsageTokens(totals);
  const shares = {} as Record<UsageTokenSeriesId, number>;
  for (const series of USAGE_TOKEN_SERIES) {
    shares[series] = total > 0 ? totals[series] / total : 0;
  }
  return shares;
}

/**
 * Parse a bare `YYYY-MM-DD` calendar string without UTC reinterpretation.
 */
export function parseUsageCalendarDate(value: string): Ymd | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible civil dates (e.g. 2026-02-30) via local components.
  const probe = new Date(y, m - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== d) return null;
  return { y, m, d };
}

/**
 * Format calendar components as `YYYY-MM-DD`.
 */
export function formatUsageCalendarDate(parts: Ymd): string {
  const month = String(parts.m).padStart(2, "0");
  const day = String(parts.d).padStart(2, "0");
  return `${parts.y}-${month}-${day}`;
}

/**
 * Inclusive calendar-day count between two `YYYY-MM-DD` strings.
 * Uses UTC day arithmetic on calendar components so DST cannot skip/duplicatedays.
 */
export function inclusiveCalendarDays(from: string, to: string): number {
  const start = parseUsageCalendarDate(from);
  const end = parseUsageCalendarDate(to);
  if (!start || !end) return 0;
  const ms =
    Date.UTC(end.y, end.m - 1, end.d) - Date.UTC(start.y, start.m - 1, start.d);
  if (ms < 0) return 0;
  return Math.floor(ms / 86_400_000) + 1;
}

/**
 * Select day / ISO-week / month granularity from an inclusive day span.
 * Thresholds: ≤31 day, 32–180 week, ≥181 month.
 */
export function selectUsageTimelineGranularity(inclusiveDays: number): UsageTimelineGranularity {
  if (inclusiveDays <= 31) return "day";
  if (inclusiveDays <= 180) return "week";
  return "month";
}

function compareYmd(a: Ymd, b: Ymd): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

function maxYmd(a: Ymd, b: Ymd): Ymd {
  return compareYmd(a, b) >= 0 ? a : b;
}

function minYmd(a: Ymd, b: Ymd): Ymd {
  return compareYmd(a, b) <= 0 ? a : b;
}

/** Add delta civil days using local Date components (calendar-safe for ± range walks). */
function addCalendarDays(parts: Ymd, delta: number): Ymd {
  const date = new Date(parts.y, parts.m - 1, parts.d + delta);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** Monday-based weekday where Monday = 0 … Sunday = 6. */
function mondayBasedWeekday(parts: Ymd): number {
  const js = new Date(parts.y, parts.m - 1, parts.d).getDay(); // 0=Sun
  return js === 0 ? 6 : js - 1;
}

function startOfIsoWeekMonday(parts: Ymd): Ymd {
  return addCalendarDays(parts, -mondayBasedWeekday(parts));
}

function startOfMonth(parts: Ymd): Ymd {
  return { y: parts.y, m: parts.m, d: 1 };
}

function endOfMonth(parts: Ymd): Ymd {
  // Day 0 of next month is the last day of this month.
  const date = new Date(parts.y, parts.m, 0);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

function monthKey(parts: Ymd): string {
  return `${parts.y}-${String(parts.m).padStart(2, "0")}`;
}

function sumDaysInRange(
  dayMap: Map<string, UsageTotals>,
  from: Ymd,
  to: Ymd,
): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (let cursor = from; compareYmd(cursor, to) <= 0; cursor = addCalendarDays(cursor, 1)) {
    const dayTotals = dayMap.get(formatUsageCalendarDate(cursor));
    if (dayTotals) addUsageTotals(totals, dayTotals);
  }
  return totals;
}

/**
 * Project daily Usage totals into a zero-filled auto timeline.
 * Bucket display ranges are clipped to the selected [from, to] calendar dates.
 */
export function projectUsageTimeline(
  from: string,
  to: string,
  byDay: readonly UsageDaySummary[],
): UsageTimeline {
  const start = parseUsageCalendarDate(from);
  const end = parseUsageCalendarDate(to);
  if (!start || !end || compareYmd(start, end) > 0) {
    return { granularity: "day", buckets: [] };
  }

  const inclusiveDays = inclusiveCalendarDays(from, to);
  const granularity = selectUsageTimelineGranularity(inclusiveDays);
  const dayMap = new Map<string, UsageTotals>();
  for (const row of byDay) {
    if (!parseUsageCalendarDate(row.date)) continue;
    dayMap.set(row.date, cloneUsageTotals(row.totals));
  }

  const buckets: UsageTimelineBucket[] = [];

  if (granularity === "day") {
    for (let cursor = start; compareYmd(cursor, end) <= 0; cursor = addCalendarDays(cursor, 1)) {
      const key = formatUsageCalendarDate(cursor);
      buckets.push({
        key,
        from: key,
        to: key,
        totals: cloneUsageTotals(dayMap.get(key)),
      });
    }
    return { granularity, buckets };
  }

  if (granularity === "week") {
    let weekStart = startOfIsoWeekMonday(start);
    while (compareYmd(weekStart, end) <= 0) {
      const weekEnd = addCalendarDays(weekStart, 6);
      const clippedFrom = maxYmd(weekStart, start);
      const clippedTo = minYmd(weekEnd, end);
      if (compareYmd(clippedFrom, clippedTo) <= 0) {
        buckets.push({
          key: formatUsageCalendarDate(weekStart),
          from: formatUsageCalendarDate(clippedFrom),
          to: formatUsageCalendarDate(clippedTo),
          totals: sumDaysInRange(dayMap, clippedFrom, clippedTo),
        });
      }
      weekStart = addCalendarDays(weekStart, 7);
    }
    return { granularity, buckets };
  }

  // month
  let monthCursor = startOfMonth(start);
  while (compareYmd(monthCursor, end) <= 0) {
    const monthEnd = endOfMonth(monthCursor);
    const clippedFrom = maxYmd(monthCursor, start);
    const clippedTo = minYmd(monthEnd, end);
    if (compareYmd(clippedFrom, clippedTo) <= 0) {
      buckets.push({
        key: monthKey(monthCursor),
        from: formatUsageCalendarDate(clippedFrom),
        to: formatUsageCalendarDate(clippedTo),
        totals: sumDaysInRange(dayMap, clippedFrom, clippedTo),
      });
    }
    monthCursor = startOfMonth(addCalendarDays(monthEnd, 1));
  }

  return { granularity, buckets };
}

/**
 * Sum Token fields across timeline buckets (for reconciliation checks).
 */
export function sumUsageTimelineTokens(timeline: UsageTimeline): UsageTotals {
  const totals = createEmptyUsageTotals();
  for (const bucket of timeline.buckets) {
    addUsageTotals(totals, bucket.totals);
  }
  return totals;
}

/**
 * Largest bucket Token total; used for absolute-mode column scale.
 */
export function maxUsageTimelineTokenTotal(timeline: UsageTimeline): number {
  let max = 0;
  for (const bucket of timeline.buckets) {
    max = Math.max(max, totalUsageTokens(bucket.totals));
  }
  return max;
}

/**
 * Largest bucket cost total; used for the cost-mode column scale.
 */
export function maxUsageTimelineCost(timeline: UsageTimeline): number {
  let max = 0;
  for (const bucket of timeline.buckets) {
    max = Math.max(max, bucket.totals.cost);
  }
  return max;
}

/**
 * Clamp a focus index into [0, count-1], or 0 when empty.
 */
export function clampUsageBucketIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

/**
 * Sparse label indices so long ranges stay readable without dropping buckets.
 */
export function pickUsageAxisLabelIndices(bucketCount: number, maxLabels: number): number[] {
  if (bucketCount <= 0) return [];
  if (maxLabels <= 1 || bucketCount === 1) return [0];
  const limit = Math.max(2, Math.min(maxLabels, bucketCount));
  if (bucketCount <= limit) {
    return Array.from({ length: bucketCount }, (_, index) => index);
  }
  const indices = new Set<number>([0, bucketCount - 1]);
  const inner = limit - 2;
  for (let i = 1; i <= inner; i += 1) {
    const ratio = i / (inner + 1);
    indices.add(Math.round(ratio * (bucketCount - 1)));
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Fraction of the plot height occupied by the tallest data bar after headroom.
 * Keeps columns from kissing the top edge of the chart.
 */
const USAGE_AXIS_HEADROOM = 0.92;

const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

/**
 * Nice y-axis scale with headroom above the observed max.
 * `scaleMax` is a round ceiling ≥ maxValue / 0.92 so the tallest bar sits near 90–95% height.
 * Prefers about `preferredTickCount` evenly spaced ticks (e.g. 0/25M/50M/75M/100M).
 */
export function pickUsageAxisScale(
  maxValue: number,
  preferredTickCount = 5,
): { ticks: number[]; scaleMax: number } {
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return { ticks: [0], scaleMax: 0 };
  const padded = maxValue / USAGE_AXIS_HEADROOM;
  const targetDivisions = Math.max(2, preferredTickCount - 1);
  const roughStep = padded / targetDivisions;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, Number.EPSILON)));
  const candidates = new Set<number>();
  for (const base of [magnitude / 10, magnitude, magnitude * 10]) {
    if (!(base > 0) || !Number.isFinite(base)) continue;
    for (const mult of NICE_STEP_MULTIPLIERS) {
      candidates.add(mult * base);
    }
  }

  let bestStep = roughStep;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const step of candidates) {
    if (!(step > 0)) continue;
    const scaleMax = Math.ceil(padded / step - 1e-12) * step;
    const divisions = Math.round(scaleMax / step);
    if (divisions < 2 || divisions > 12) continue;
    // Prefer near-target division count, then less excess headroom.
    const score = Math.abs(divisions - targetDivisions) * 8 + (scaleMax - padded) / padded;
    if (score < bestScore) {
      bestScore = score;
      bestStep = step;
    }
  }

  const scaleMax = Math.ceil(padded / bestStep - 1e-12) * bestStep;
  const ticks: number[] = [];
  for (let value = 0; value <= scaleMax + bestStep * 1e-9; value += bestStep) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return { ticks, scaleMax };
}

/**
 * Nice y-axis tick values from 0 to a rounded ceiling above max.
 */
export function pickUsageAxisTicks(maxValue: number, tickCount = 5): number[] {
  return pickUsageAxisScale(maxValue, tickCount).ticks;
}

/**
 * Shift a local calendar date string by delta days (client preset helpers).
 */
export function shiftUsageCalendarDate(value: string, deltaDays: number): string | null {
  const parts = parseUsageCalendarDate(value);
  if (!parts) return null;
  return formatUsageCalendarDate(addCalendarDays(parts, deltaDays));
}

/**
 * Build an inclusive local range ending on `end` covering `inclusiveDays` days.
 */
export function buildInclusiveUsageRangeEnding(
  end: string,
  inclusiveDays: number,
): { from: string; to: string } | null {
  if (!Number.isFinite(inclusiveDays) || inclusiveDays < 1) return null;
  const toParts = parseUsageCalendarDate(end);
  if (!toParts) return null;
  const from = formatUsageCalendarDate(addCalendarDays(toParts, -(Math.trunc(inclusiveDays) - 1)));
  return { from, to: end };
}

/**
 * Validate a custom draft date range without network I/O.
 * Returns null when valid.
 */
export function validateUsageDateRangeDraft(
  from: string,
  to: string,
): "empty" | "malformed" | "order" | null {
  if (!from.trim() || !to.trim()) return "empty";
  const start = parseUsageCalendarDate(from);
  const end = parseUsageCalendarDate(to);
  if (!start || !end) return "malformed";
  if (compareYmd(start, end) > 0) return "order";
  return null;
}
