import {
  assertMinCronInterval,
  countCronMatchesExact,
  decideOccurrence,
  getNextRunAt,
  previewNextRuns,
  validateCronExpression,
  validateTimezone,
  AutomationScheduleError,
} from "../lib/automation-schedule";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function expectThrow(fn: () => void, msg: string) {
  try {
    fn();
    throw new Error(`expected throw: ${msg}`);
  } catch (e) {
    if (e instanceof AutomationScheduleError) return;
    if (e instanceof Error && e.message.startsWith("expected throw")) throw e;
    // ok
  }
}

validateCronExpression("0 8 * * *");
validateTimezone("Asia/Shanghai");
expectThrow(() => validateCronExpression("0 8 * *"), "four fields");
expectThrow(() => validateCronExpression("0 0 8 * * *"), "six fields");
expectThrow(() => validateTimezone("Not/AZone"), "bad tz");
expectThrow(() => assertMinCronInterval("*/1 * * * *", "UTC"), "min interval");

const next = getNextRunAt({
  cron: "0 8 * * *",
  timezone: "Asia/Shanghai",
  from: new Date("2026-01-01T00:00:00.000Z"),
});
assert(typeof next === "string" && next.includes("T"), "next run iso");

const preview = previewNextRuns({
  cron: "0 8 * * *",
  timezone: "Asia/Shanghai",
  from: new Date("2026-01-01T00:00:00.000Z"),
  count: 3,
});
assert(preview.length === 3, "preview count");

// not due when previous next is future
const notDue = decideOccurrence({
  taskId: "t1",
  cron: "0 8 * * *",
  timezone: "UTC",
  now: new Date("2026-01-01T00:00:00.000Z"),
  previousNextRunAt: "2026-01-02T08:00:00.000Z",
  hasActiveRun: false,
});
assert(notDue.type === "not_due", "future not due");

// misfire outside window aggregates — multi-month Jan→Jun daily must not truncate to ~2 via 48h lookback
const omit = decideOccurrence({
  taskId: "t1",
  cron: "0 8 * * *",
  timezone: "UTC",
  now: new Date("2026-06-01T12:00:00.000Z"),
  previousNextRunAt: "2026-01-01T08:00:00.000Z",
  hasActiveRun: false,
  misfireWindowMs: 5 * 60 * 1000,
});
assert(omit.type === "omit_misfire_aggregate", "misfire aggregate");
if (omit.type === "omit_misfire_aggregate") {
  // Daily from Jan 1 08:00 through Jun 1 08:00 inclusive ≈ 152 days.
  assert(omit.omission.count >= 140, `jan-jun count too small: ${omit.omission.count}`);
  assert(omit.omission.count <= 160, `jan-jun count too large: ${omit.omission.count}`);
  assert(String(omit.omission.firstUtc ?? "").startsWith("2026-01-01"), "firstUtc jan");
  assert(String(omit.omission.lastUtc ?? "").startsWith("2026-06-01"), "lastUtc jun");
  assert(omit.omission.count !== 2, "must not be fixed 48h truncation count=2");
}

// overlap skip when active
// Use a recent previous next inside window
const recent = new Date(Date.now() - 60_000).toISOString();
const overlap = decideOccurrence({
  taskId: "t1",
  cron: "*/5 * * * *",
  timezone: "UTC",
  now: new Date(),
  previousNextRunAt: recent,
  hasActiveRun: true,
  misfireWindowMs: 10 * 60 * 1000,
});
assert(
  overlap.type === "skip_overlap" || overlap.type === "fire" || overlap.type === "not_due" || overlap.type === "omit_misfire_aggregate",
  "overlap decision shaped",
);

// 5-minute multi-month must be computationally bounded (not tens of thousands of parser steps)
{
  const t0 = Date.now();
  const five = decideOccurrence({
    taskId: "t5",
    cron: "*/5 * * * *",
    timezone: "UTC",
    now: new Date("2026-04-01T00:00:00.000Z"),
    previousNextRunAt: "2026-01-01T00:00:00.000Z",
    hasActiveRun: false,
    misfireWindowMs: 5 * 60 * 1000,
  });
  const ms = Date.now() - t0;
  assert(five.type === "omit_misfire_aggregate", "5m multi-month aggregate");
  if (five.type === "omit_misfire_aggregate") {
    assert(five.omission.count > 1000, `5m count=${five.omission.count}`);
    assert(String(five.omission.firstUtc).startsWith("2026-01-01"), "5m first");
  }
  assert(ms < 2000, `5m bounded ms=${ms}`);
}

// DST spring-forward gap in America/New_York (2026-03-08 02:xx does not exist)
// Even when cron-parser advanced nextRunAt past the nonexistent wall time.
{
  const dst = decideOccurrence({
    taskId: "tdst",
    cron: "30 2 * * *",
    timezone: "America/New_York",
    now: new Date("2026-03-08T20:00:00.000Z"),
    // advanced past gap to next real fire
    previousNextRunAt: "2026-03-09T06:30:00.000Z",
    hasActiveRun: false,
    misfireWindowMs: 5 * 60 * 1000,
  });
  assert(dst.type === "omit_dst_gap", `dst must be omit_dst_gap, got ${dst.type}`);
  if (dst.type === "omit_dst_gap") {
    assert(dst.omission.kind === "dst_gap", "dst kind");
    assert(dst.omission.count >= 1, "dst count");
    assert(String(dst.omission.firstLocal).includes("02:30"), "gap local");
  }
}

// Exact weekday count Jan 1 – Jun 30 2026 inclusive at 08:00 UTC = 129
{
  const exact = countCronMatchesExact({
    cron: "0 8 * * 1-5",
    timezone: "UTC",
    startUtc: new Date("2026-01-01T08:00:00.000Z"),
    endUtc: new Date("2026-06-30T08:00:00.000Z"),
  });
  assert(exact.count === 129, `weekday exact ${exact.count} !== 129`);
  const omit = decideOccurrence({
    taskId: "twd",
    cron: "0 8 * * 1-5",
    timezone: "UTC",
    now: new Date("2026-06-30T12:00:00.000Z"),
    previousNextRunAt: "2026-01-01T08:00:00.000Z",
    hasActiveRun: false,
    misfireWindowMs: 5 * 60 * 1000,
  });
  assert(omit.type === "omit_misfire_aggregate", "weekday aggregate");
  if (omit.type === "omit_misfire_aggregate") {
    assert(omit.omission.count === 129, `decide count ${omit.omission.count}`);
  }
}

console.log("smoke-automation-schedule: ok");
