/**
 * Pure Usage timeline projection + range-draft helper smoke.
 * Covers day/week/month thresholds, zero-fill, reconciliation, and client helpers.
 */
import assert from "node:assert/strict";
import type { UsageDaySummary, UsageTotals } from "../lib/usage-stats";
import {
  buildInclusiveUsageRangeEnding,
  clampUsageBucketIndex,
  createEmptyUsageTotals,
  inclusiveCalendarDays,
  maxUsageTimelineCost,
  maxUsageTimelineTokenTotal,
  parseUsageCalendarDate,
  pickUsageAxisLabelIndices,
  pickUsageAxisScale,
  pickUsageAxisTicks,
  projectUsageTimeline,
  selectUsageTimelineGranularity,
  sumUsageTimelineTokens,
  totalUsageTokens,
  usageTokenSeriesShares,
  validateUsageDateRangeDraft,
} from "../lib/usage-timeline";

function totals(partial: Partial<UsageTotals>): UsageTotals {
  return {
    input: partial.input ?? 0,
    output: partial.output ?? 0,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: partial.cacheWrite ?? 0,
    cost: partial.cost ?? 0,
    calls: partial.calls ?? 0,
  };
}

function day(date: string, partial: Partial<UsageTotals> = {}): UsageDaySummary {
  return { date, totals: totals(partial) };
}

function assertTokenEqual(actual: UsageTotals, expected: UsageTotals, label: string) {
  assert.equal(actual.input, expected.input, `${label}.input`);
  assert.equal(actual.output, expected.output, `${label}.output`);
  assert.equal(actual.cacheRead, expected.cacheRead, `${label}.cacheRead`);
  assert.equal(actual.cacheWrite, expected.cacheWrite, `${label}.cacheWrite`);
  assert.equal(actual.cost, expected.cost, `${label}.cost`);
  assert.equal(actual.calls, expected.calls, `${label}.calls`);
}

function main() {
  // Threshold selection (inclusive day counts).
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-01-01"), 1);
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-01-07"), 7);
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-01-31"), 31);
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-02-01"), 32);
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-06-29"), 180);
  assert.equal(inclusiveCalendarDays("2026-01-01", "2026-06-30"), 181);
  assert.equal(selectUsageTimelineGranularity(31), "day");
  assert.equal(selectUsageTimelineGranularity(32), "week");
  assert.equal(selectUsageTimelineGranularity(180), "week");
  assert.equal(selectUsageTimelineGranularity(181), "month");

  // 7-day happy path with chronological zero-fill and token reconciliation.
  const weekDays = [
    day("2026-03-02", { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 1, calls: 1 }),
    day("2026-03-04", { input: 50, output: 10, cost: 0.5, calls: 1 }),
    day("2026-03-08", { input: 450, output: 170, cacheRead: 140, cacheWrite: 45, cost: 2, calls: 2 }),
  ];
  const seven = projectUsageTimeline("2026-03-02", "2026-03-08", weekDays);
  assert.equal(seven.granularity, "day");
  assert.equal(seven.buckets.length, 7);
  assert.deepEqual(
    seven.buckets.map((bucket) => bucket.key),
    ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"],
  );
  assertTokenEqual(seven.buckets[1]!.totals, createEmptyUsageTotals(), "zero Mar 3");
  const sevenSum = sumUsageTimelineTokens(seven);
  assert.equal(sevenSum.input, 600);
  assert.equal(sevenSum.output, 200);
  assert.equal(sevenSum.cacheRead, 150);
  assert.equal(sevenSum.cacheWrite, 50);
  assert.equal(totalUsageTokens(sevenSum), 1000);
  const shares = usageTokenSeriesShares(sevenSum);
  assert.equal(shares.input, 0.6);
  assert.equal(shares.output, 0.2);
  assert.equal(shares.cacheRead, 0.15);
  assert.equal(shares.cacheWrite, 0.05);

  // AE2: 90-day range uses Monday weeks and keeps a zero gap week.
  // 2026-01-01 is Thursday; first week Monday is 2025-12-29.
  const ninetyFrom = "2026-01-01";
  const ninetyTo = "2026-03-31"; // 90 inclusive days
  assert.equal(inclusiveCalendarDays(ninetyFrom, ninetyTo), 90);
  const ninetyDays = [
    day("2026-01-02", { input: 10, calls: 1 }),
    // Skip the ISO week starting 2026-01-12 entirely.
    day("2026-01-20", { input: 20, calls: 1 }),
  ];
  const ninety = projectUsageTimeline(ninetyFrom, ninetyTo, ninetyDays);
  assert.equal(ninety.granularity, "week");
  assert.ok(ninety.buckets.length >= 12 && ninety.buckets.length <= 15);
  assert.equal(ninety.buckets[0]!.key, "2025-12-29");
  assert.equal(ninety.buckets[0]!.from, "2026-01-01");
  assert.equal(ninety.buckets[0]!.to, "2026-01-04");
  const gapWeek = ninety.buckets.find((bucket) => bucket.key === "2026-01-12");
  assert.ok(gapWeek, "missing zero-filled week 2026-01-12");
  assertTokenEqual(gapWeek!.totals, createEmptyUsageTotals(), "gap week");
  assert.equal(sumUsageTimelineTokens(ninety).input, 30);

  // Partial midweek custom range clips first/last labels.
  const partial = projectUsageTimeline("2026-02-04", "2026-02-12", [
    day("2026-02-05", { output: 3, calls: 1 }),
    day("2026-02-11", { output: 7, calls: 1 }),
  ]);
  assert.equal(partial.granularity, "day");
  assert.equal(partial.buckets[0]!.from, "2026-02-04");
  assert.equal(partial.buckets.at(-1)!.to, "2026-02-12");
  // Force week granularity via longer span that still clips:
  const partialWeek = projectUsageTimeline("2026-01-01", "2026-02-15", [
    day("2026-01-07", { input: 1, calls: 1 }),
  ]);
  assert.equal(partialWeek.granularity, "week");
  assert.equal(partialWeek.buckets[0]!.from, "2026-01-01");
  assert.equal(partialWeek.buckets.at(-1)!.to, "2026-02-15");

  // Monthly across year boundary + leap day preserved in daily source.
  const monthly = projectUsageTimeline("2024-02-10", "2024-08-20", [
    day("2024-02-29", { input: 29, calls: 1 }),
    day("2024-08-01", { input: 8, calls: 1 }),
  ]);
  assert.equal(monthly.granularity, "month");
  assert.equal(monthly.buckets[0]!.key, "2024-02");
  assert.equal(monthly.buckets[0]!.from, "2024-02-10");
  assert.equal(monthly.buckets[0]!.to, "2024-02-29");
  assert.equal(monthly.buckets[0]!.totals.input, 29);
  assert.equal(monthly.buckets.at(-1)!.key, "2024-08");
  assert.equal(monthly.buckets.at(-1)!.from, "2024-08-01");
  assert.equal(monthly.buckets.at(-1)!.to, "2024-08-20");
  assert.equal(sumUsageTimelineTokens(monthly).input, 37);

  // Empty / single-day edges.
  const empty = projectUsageTimeline("2026-05-01", "2026-05-03", []);
  assert.equal(empty.granularity, "day");
  assert.equal(empty.buckets.length, 3);
  for (const bucket of empty.buckets) {
    assertTokenEqual(bucket.totals, createEmptyUsageTotals(), bucket.key);
  }
  const single = projectUsageTimeline("2026-05-01", "2026-05-01", [
    day("2026-05-01", { input: 4, output: 1, calls: 1 }),
  ]);
  assert.equal(single.buckets.length, 1);
  assert.equal(single.buckets[0]!.totals.input, 4);

  // Invalid range yields empty day timeline.
  assert.deepEqual(projectUsageTimeline("2026-05-03", "2026-05-01", []).buckets, []);
  assert.equal(parseUsageCalendarDate("2026-02-30"), null);
  assert.equal(parseUsageCalendarDate("2026-13-01"), null);

  // Draft validation + preset range helpers.
  assert.equal(validateUsageDateRangeDraft("", "2026-01-02"), "empty");
  assert.equal(validateUsageDateRangeDraft("2026-02-30", "2026-03-01"), "malformed");
  assert.equal(validateUsageDateRangeDraft("2026-03-02", "2026-03-01"), "order");
  assert.equal(validateUsageDateRangeDraft("2026-03-01", "2026-03-01"), null);
  assert.deepEqual(buildInclusiveUsageRangeEnding("2026-03-08", 7), {
    from: "2026-03-02",
    to: "2026-03-08",
  });
  assert.deepEqual(buildInclusiveUsageRangeEnding("2026-03-08", 1), {
    from: "2026-03-08",
    to: "2026-03-08",
  });

  // Client geometry helpers stay finite.
  assert.equal(maxUsageTimelineTokenTotal(seven), totalUsageTokens(seven.buckets[6]!.totals));
  assert.equal(maxUsageTimelineCost(seven), seven.buckets[6]!.totals.cost);
  assert.equal(clampUsageBucketIndex(-2, 7), 0);
  assert.equal(clampUsageBucketIndex(99, 7), 6);
  assert.equal(clampUsageBucketIndex(3, 0), 0);
  assert.deepEqual(pickUsageAxisLabelIndices(1, 5), [0]);
  assert.deepEqual(pickUsageAxisLabelIndices(4, 10), [0, 1, 2, 3]);
  const sparse = pickUsageAxisLabelIndices(90, 6);
  assert.equal(sparse[0], 0);
  assert.equal(sparse.at(-1), 89);
  assert.ok(sparse.length <= 6);
  assert.deepEqual(pickUsageAxisTicks(0), [0]);
  const ticks = pickUsageAxisTicks(1000, 5);
  assert.equal(ticks[0], 0);
  assert.ok((ticks.at(-1) ?? 0) >= 1000, "axis ceiling should cover data max");
  assert.ok(ticks.every((value) => Number.isFinite(value) && value >= 0));

  // Nice scale with headroom: 83.1M → 100M ticks, tallest bar under the top edge.
  const largeScale = pickUsageAxisScale(83_100_000, 5);
  assert.equal(largeScale.scaleMax, 100_000_000);
  assert.deepEqual(largeScale.ticks, [0, 25_000_000, 50_000_000, 75_000_000, 100_000_000]);
  assert.ok(83_100_000 / largeScale.scaleMax <= 0.95);
  assert.ok(83_100_000 / largeScale.scaleMax >= 0.8);

  // All-zero shares never produce NaN.
  const zeroShares = usageTokenSeriesShares(createEmptyUsageTotals());
  for (const value of Object.values(zeroShares)) {
    assert.equal(value, 0);
  }

  console.log("Usage timeline projection smoke checks passed.");
}

main();
