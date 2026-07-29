/**
 * Cron validation, next-run preview, DST/misfire/overlap occurrence engine.
 * Uses cron-parser; product layer enforces five fields and >=5 minute interval.
 */

import cronParser from "cron-parser";
import {
  AUTOMATION_MAX_MAX_RUNTIME_MS,
  AUTOMATION_MIN_CRON_INTERVAL_MS,
  AUTOMATION_MIN_MAX_RUNTIME_MS,
  AUTOMATION_MISFIRE_WINDOW_MS,
  AUTOMATION_SCHEDULE_POLICY_VERSION,
  type AutomationOccurrenceMeta,
  type AutomationOmissionRecord,
  type AutomationScheduleConfig,
} from "./automation-types";

export class AutomationScheduleError extends Error {
  readonly code = "validation" as const;

  constructor(message: string) {
    super(message);
    this.name = "AutomationScheduleError";
  }
}

const FIVE_FIELD_RE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/;

function isValidIanaTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Product supports standard five-field cron only.
 * Explicitly reject cron-parser extensions outside the supported grammar (L, #, W, ?, etc.).
 * These must fail validation consistently — never silently count as zero matches.
 */
const UNSUPPORTED_CRON_TOKEN_RE = /(?:^|[,\-\/\s])(?:L|W|#|\?)(?:$|[,\-\/\s])/i;
const HASH_NTH_DOW_RE = /#\d/;
const LAST_DOM_OR_DOW_RE = /(?:^|[,\-\/\s])L(?:$|[,\-\/\s#-])/i;

export function validateCronExpression(cron: string): void {
  if (!FIVE_FIELD_RE.test(cron)) {
    throw new AutomationScheduleError("Cron must be exactly five fields (m h dom mon dow)");
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new AutomationScheduleError("Cron must be exactly five fields");
  }
  // Reject seconds-style six-field leftovers and known unsupported tokens.
  if (cron.includes("?")) {
    throw new AutomationScheduleError("Cron character '?' is not supported");
  }
  // Reject cron-parser extensions: L (last), # (nth weekday), W (nearest weekday).
  if (HASH_NTH_DOW_RE.test(cron) || /#/.test(cron)) {
    throw new AutomationScheduleError(
      "Cron character '#' (nth weekday) is not supported; use standard five-field syntax only",
    );
  }
  if (LAST_DOM_OR_DOW_RE.test(cron) || /(?:^|\s)L(?:\s|$)/i.test(cron) || /\dL\b/i.test(cron) || /L\d/i.test(cron)) {
    throw new AutomationScheduleError(
      "Cron character 'L' (last day/weekday) is not supported; use standard five-field syntax only",
    );
  }
  if (/(?:^|[,\-\/\s])W(?:$|[,\-\/\s])/i.test(cron) || /\dW\b/i.test(cron)) {
    throw new AutomationScheduleError(
      "Cron character 'W' (nearest weekday) is not supported; use standard five-field syntax only",
    );
  }
  if (UNSUPPORTED_CRON_TOKEN_RE.test(cron)) {
    throw new AutomationScheduleError(
      "Cron contains unsupported extension tokens; use standard five-field syntax only",
    );
  }
  // Per-field: no L/#/W inside any field.
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i]!;
    if (/[L#W?]/i.test(f)) {
      throw new AutomationScheduleError(
        `Cron field ${i + 1} contains unsupported extension token in "${f}"`,
      );
    }
  }
  try {
    cronParser.parseExpression(cron, { tz: "UTC" });
  } catch (error) {
    throw new AutomationScheduleError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateTimezone(timezone: string): void {
  if (!timezone || !isValidIanaTimeZone(timezone)) {
    throw new AutomationScheduleError(`Invalid IANA timezone: ${timezone || "(empty)"}`);
  }
}

export function validateMaxRuntimeMs(maxRuntimeMs: number): void {
  if (!Number.isFinite(maxRuntimeMs)) {
    throw new AutomationScheduleError("maxRuntimeMs must be a number");
  }
  if (maxRuntimeMs < AUTOMATION_MIN_MAX_RUNTIME_MS || maxRuntimeMs > AUTOMATION_MAX_MAX_RUNTIME_MS) {
    throw new AutomationScheduleError(
      `maxRuntimeMs must be between ${AUTOMATION_MIN_MAX_RUNTIME_MS} and ${AUTOMATION_MAX_MAX_RUNTIME_MS}`,
    );
  }
}

export function assertMinCronInterval(cron: string, timezone: string, minIntervalMs = AUTOMATION_MIN_CRON_INTERVAL_MS): void {
  validateCronExpression(cron);
  validateTimezone(timezone);
  const start = new Date("2024-01-01T00:00:00.000Z");
  const it = cronParser.parseExpression(cron, { currentDate: start, tz: timezone });
  const a = it.next().toDate().getTime();
  const b = it.next().toDate().getTime();
  if (b - a < minIntervalMs) {
    throw new AutomationScheduleError(
      `Cron interval must be at least ${Math.round(minIntervalMs / 60000)} minutes`,
    );
  }
}

export function validateScheduleConfig(schedule: Pick<AutomationScheduleConfig, "cron" | "timezone"> & {
  minIntervalMs?: number;
}): void {
  validateCronExpression(schedule.cron);
  validateTimezone(schedule.timezone);
  assertMinCronInterval(schedule.cron, schedule.timezone, schedule.minIntervalMs ?? AUTOMATION_MIN_CRON_INTERVAL_MS);
}

function formatLocalWallTime(date: Date, timezone: string): { localWallTime: string; offsetMinutes: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const localWallTime = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  let offsetMinutes = 0;
  if (match) {
    const sign = match[1] === "-" ? -1 : 1;
    const hh = Number(match[2] ?? 0);
    const mm = Number(match[3] ?? 0);
    offsetMinutes = sign * (hh * 60 + mm);
  }
  return { localWallTime, offsetMinutes };
}

export function buildOccurrenceMeta(input: {
  taskId: string;
  cron: string;
  timezone: string;
  utcDate: Date;
}): AutomationOccurrenceMeta {
  const { localWallTime, offsetMinutes } = formatLocalWallTime(input.utcDate, input.timezone);
  const scheduledForUtc = input.utcDate.toISOString();
  const occurrenceKey = [
    input.taskId,
    scheduledForUtc,
    input.timezone,
    `spv${AUTOMATION_SCHEDULE_POLICY_VERSION}`,
  ].join("@");
  return {
    occurrenceKey,
    scheduledForUtc,
    localWallTime,
    localOffsetMinutes: offsetMinutes,
    timezone: input.timezone,
    schedulePolicyVersion: AUTOMATION_SCHEDULE_POLICY_VERSION,
    cron: input.cron,
  };
}

export function getNextOccurrences(input: {
  cron: string;
  timezone: string;
  from?: Date;
  count?: number;
}): Date[] {
  validateScheduleConfig({ cron: input.cron, timezone: input.timezone });
  const count = input.count ?? 5;
  const currentDate = input.from ?? new Date();
  const it = cronParser.parseExpression(input.cron, {
    currentDate,
    tz: input.timezone,
  });
  const out: Date[] = [];
  // cron-parser yields the next fire after currentDate.
  for (let i = 0; i < count; i += 1) {
    out.push(it.next().toDate());
  }
  return out;
}

export function getNextRunAt(input: {
  cron: string;
  timezone: string;
  from?: Date;
}): string {
  return getNextOccurrences({ ...input, count: 1 })[0]!.toISOString();
}

export type OccurrenceDecision =
  | { type: "fire"; occurrence: AutomationOccurrenceMeta; nextRunAt: string }
  | { type: "skip_overlap"; occurrence: AutomationOccurrenceMeta; nextRunAt: string }
  | {
      type: "omit_misfire_aggregate";
      omission: Omit<AutomationOmissionRecord, "schemaVersion" | "id" | "createdAt">;
      fire?: { occurrence: AutomationOccurrenceMeta };
      nextRunAt: string;
    }
  | {
      type: "omit_dst_gap";
      omission: Omit<AutomationOmissionRecord, "schemaVersion" | "id" | "createdAt">;
      nextRunAt: string;
    }
  | { type: "not_due"; nextRunAt: string | null };

/**
 * Decide what to materialize for a due scan.
 * - misfire within 5 minutes: fire-once-now for latest eligible
 * - older omissions: single aggregate record
 * - DST fold: first UTC instant only (cron-parser first hit)
 * - overlap: caller supplies hasActiveRun
 */
/** Stable omission identity for DST-gap/misfire dedup across ticks. */
export function buildOmissionKey(
  omission: Pick<
    AutomationOmissionRecord,
    "kind" | "firstLocal" | "timezone" | "taskId"
  >,
): string {
  return `${omission.taskId}@${omission.kind}@${omission.firstLocal}@${omission.timezone}`;
}

export function decideOccurrence(input: {
  taskId: string;
  cron: string;
  timezone: string;
  now?: Date;
  lastMaterializedOccurrenceKey?: string | null;
  /** Persisted last omission key — identical gap ticks must not re-emit. */
  lastOmissionKey?: string | null;
  previousNextRunAt?: string | null;
  hasActiveRun: boolean;
  misfireWindowMs?: number;
  /**
   * Activation / approved-revision boundary. Occurrences and omissions scheduled
   * strictly before this instant must never be emitted (post-gap activation = not_due).
   */
  activatedAt?: string | null;
  approvedAt?: string | null;
}): OccurrenceDecision {
  validateScheduleConfig({ cron: input.cron, timezone: input.timezone });
  const now = input.now ?? new Date();
  const misfireWindowMs = input.misfireWindowMs ?? AUTOMATION_MISFIRE_WINDOW_MS;
  const activationBoundaryMs = resolveActivationBoundaryMs(input.activatedAt, input.approvedAt);

  // DST gap MUST be checked before the future-nextRunAt short-circuit.
  // cron-parser often advances past a nonexistent wall time (e.g. 02:30 EDT spring gap)
  // so previousNextRunAt may already point at the following day while the gap was never recorded.
  const dstGapEarly = detectDstGapOmission({
    taskId: input.taskId,
    cron: input.cron,
    timezone: input.timezone,
    now,
    previousNextRunAt: input.previousNextRunAt ?? null,
    lastOmissionKey: input.lastOmissionKey ?? null,
    activationBoundaryMs,
  });
  if (dstGapEarly) {
    return {
      type: "omit_dst_gap",
      omission: dstGapEarly.omission,
      nextRunAt: dstGapEarly.nextRunAt,
    };
  }

  // If previous next is still in the future, not due.
  if (input.previousNextRunAt) {
    const prev = Date.parse(input.previousNextRunAt);
    if (Number.isFinite(prev) && prev > now.getTime()) {
      return { type: "not_due", nextRunAt: input.previousNextRunAt };
    }
  }

  // Also compute true next after now.
  const upcoming = getNextOccurrences({
    cron: input.cron,
    timezone: input.timezone,
    from: now,
    count: 1,
  })[0]!;
  const nextRunAt = upcoming.toISOString();

  // Bounded multi-month misfire aggregation WITHOUT enumerating every occurrence and
  // WITHOUT a fixed 48-hour lookback truncation. Prefer the persisted previousNextRunAt
  // (or last materialized key) as the first missed boundary; count with cron step math.
  const missed = collectMissedOccurrencesBounded({
    cron: input.cron,
    timezone: input.timezone,
    now,
    previousNextRunAt: input.previousNextRunAt ?? null,
    lastMaterializedOccurrenceKey: input.lastMaterializedOccurrenceKey ?? null,
    taskId: input.taskId,
  });

  // Drop any missed candidates strictly before activation/approved revision.
  const filteredCandidates =
    activationBoundaryMs == null
      ? missed.candidates
      : missed.candidates.filter((d) => d.getTime() >= activationBoundaryMs);
  const filteredCount =
    activationBoundaryMs == null
      ? missed.aggregateCount
      : filteredCandidates.length
        ? // Preserve estimated count when endpoints remain; otherwise shrink to filtered length.
          Math.min(missed.aggregateCount, Math.max(filteredCandidates.length, missed.aggregateCount))
        : 0;
  // When activation clips the window, prefer exact filtered length for safety.
  const effectiveCount =
    activationBoundaryMs == null
      ? missed.aggregateCount
      : filteredCandidates.length === missed.candidates.length
        ? missed.aggregateCount
        : filteredCandidates.length;

  if (filteredCandidates.length === 0) {
    return { type: "not_due", nextRunAt };
  }

  const uniq = filteredCandidates;
  void filteredCount;
  const latest = uniq[uniq.length - 1]!;
  const latestMeta = buildOccurrenceMeta({
    taskId: input.taskId,
    cron: input.cron,
    timezone: input.timezone,
    utcDate: latest,
  });

  if (
    input.lastMaterializedOccurrenceKey &&
    input.lastMaterializedOccurrenceKey === latestMeta.occurrenceKey
  ) {
    return { type: "not_due", nextRunAt };
  }

  const age = now.getTime() - latest.getTime();
  // When count was estimated without full enumeration, older/latest still use first/last anchors.
  const aggregateCount = effectiveCount;
  const olderCount = Math.max(0, aggregateCount - 1);

  const maybeOverlap = (occurrence: AutomationOccurrenceMeta): OccurrenceDecision => {
    if (input.hasActiveRun) {
      return { type: "skip_overlap", occurrence, nextRunAt };
    }
    return { type: "fire", occurrence, nextRunAt };
  };

  if (age > misfireWindowMs) {
    // Latest is too old to fire; aggregate all missed including latest.
    const first = uniq[0]!;
    return {
      type: "omit_misfire_aggregate",
      omission: {
        taskId: input.taskId,
        kind: "misfire_aggregate",
        timezone: input.timezone,
        firstLocal: formatLocalWallTime(first, input.timezone).localWallTime,
        lastLocal: formatLocalWallTime(latest, input.timezone).localWallTime,
        firstUtc: first.toISOString(),
        lastUtc: latest.toISOString(),
        count: aggregateCount,
        reason: "misfire_outside_window",
      },
      nextRunAt,
    };
  }

  // Latest is within window. Older ones (if any) become one aggregate omission; fire latest once.
  if (olderCount > 0) {
    const first = uniq[0]!;
    // Last older = previous tick before latest when we only retained endpoints.
    const lastOlder =
      uniq.length >= 2 ? uniq[uniq.length - 2]! : first;
    return {
      type: "omit_misfire_aggregate",
      omission: {
        taskId: input.taskId,
        kind: "misfire_aggregate",
        timezone: input.timezone,
        firstLocal: formatLocalWallTime(first, input.timezone).localWallTime,
        lastLocal: formatLocalWallTime(lastOlder, input.timezone).localWallTime,
        firstUtc: first.toISOString(),
        lastUtc: lastOlder.toISOString(),
        count: olderCount,
        reason: "misfire_catch_up_collapsed",
      },
      fire: { occurrence: latestMeta },
      nextRunAt,
    };
  }

  return maybeOverlap(latestMeta);
}

const MONTH_ALIASES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_ALIASES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

/** Resolve a single numeric or alias token (e.g. MON, JAN, 5). */
function resolveCronAtom(token: string, kind: "month" | "dow" | "num"): number | null {
  const upper = token.trim().toUpperCase();
  if (!upper) return null;
  if (/^\d+$/.test(upper)) {
    const n = Number(upper);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "month" && MONTH_ALIASES[upper] != null) return MONTH_ALIASES[upper]!;
  if (kind === "dow" && DOW_ALIASES[upper] != null) return DOW_ALIASES[upper]!;
  return null;
}

/**
 * Parse a single five-field cron token into a set of matching integers.
 * Supports standard aliases (MON-FRI, JAN-DEC), lists, ranges, and steps
 * consistently with cron-parser acceptance.
 */
function expandCronField(
  field: string,
  min: number,
  max: number,
  kind: "month" | "dow" | "num" = "num",
): number[] {
  const out = new Set<number>();
  const pushRange = (lo: number, hi: number, step: number) => {
    for (let v = lo; v <= hi; v += step) {
      if (v >= min && v <= max) out.add(v);
    }
  };
  for (const part of field.split(",")) {
    const token = part.trim();
    if (!token) continue;
    if (token === "*") {
      pushRange(min, max, 1);
      continue;
    }
    // */step or lo-hi/step or alias-alias/step
    const stepMatch = token.match(/^([A-Za-z]+|\*|\d+)(?:-([A-Za-z]+|\d+))?\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[3]);
      if (!Number.isFinite(step) || step <= 0) continue;
      if (stepMatch[1] === "*") {
        pushRange(min, max, step);
      } else {
        const lo = resolveCronAtom(stepMatch[1]!, kind);
        const hi =
          stepMatch[2] != null ? resolveCronAtom(stepMatch[2], kind) : max;
        if (lo == null || hi == null) continue;
        pushRange(lo, hi, step);
      }
      continue;
    }
    // lo-hi including aliases (MON-FRI, JAN-MAR)
    const rangeMatch = token.match(/^([A-Za-z]+|\d+)-([A-Za-z]+|\d+)$/);
    if (rangeMatch) {
      const lo = resolveCronAtom(rangeMatch[1]!, kind);
      const hi = resolveCronAtom(rangeMatch[2]!, kind);
      if (lo == null || hi == null) continue;
      pushRange(lo, hi, 1);
      continue;
    }
    const single = resolveCronAtom(token, kind);
    if (single != null && single >= min && single <= max) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

/** Normalize DOW: cron 0 and 7 both mean Sunday; Intl uses 0=Sun..6=Sat. */
function expandDowField(field: string): Set<number> {
  const raw = expandCronField(field, 0, 7, "dow");
  const out = new Set<number>();
  for (const v of raw) {
    if (v === 7) out.add(0);
    else out.add(v);
  }
  return out;
}

function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function localYmdParts(date: Date, timezone: string): { y: number; m: number; d: number; dow: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));
  const wd = get("weekday");
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { y, m, d, dow: map[wd] ?? 0 };
}

/**
 * Exact count of matching wall-calendar occurrences between [startUtc, endUtc] inclusive
 * for a five-field cron, using per-day combinatorial minute/hour counts with DOM/DOW/month.
 * Dense schedules (many minute/hour slots) use per-day arithmetic + boundary refinement
 * rather than per-occurrence UTC conversion.
 */
export function countCronMatchesExact(input: {
  cron: string;
  timezone: string;
  startUtc: Date;
  endUtc: Date;
}): { count: number; firstUtc: Date | null; lastUtc: Date | null } {
  // Reject unsupported grammar up-front — never silently return zero for L/#/etc.
  validateCronExpression(input.cron);
  const fields = input.cron.trim().split(/\s+/);
  if (fields.length !== 5) return { count: 0, firstUtc: null, lastUtc: null };
  const minutes = expandCronField(fields[0]!, 0, 59, "num");
  const hours = expandCronField(fields[1]!, 0, 23, "num");
  const doms = expandCronField(fields[2]!, 1, 31, "num");
  const months = expandCronField(fields[3]!, 1, 12, "month");
  const dows = expandDowField(fields[4]!);
  const domStar = fields[2] === "*";
  const dowStar = fields[4] === "*";
  const perDayHits = minutes.length * hours.length;
  if (!minutes.length || !hours.length || !months.length || !perDayHits) {
    return { count: 0, firstUtc: null, lastUtc: null };
  }

  const startMs = input.startUtc.getTime();
  const endMs = input.endUtc.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { count: 0, firstUtc: null, lastUtc: null };
  }

  const startLocal = localYmdParts(input.startUtc, input.timezone);
  const endLocal = localYmdParts(input.endUtc, input.timezone);
  let y = startLocal.y;
  let m = startLocal.m;
  let d = startLocal.d;
  let count = 0;
  let firstUtc: Date | null = null;
  let lastUtc: Date | null = null;

  // Dense: avoid O(slots×days) Intl conversion. Enumerate slots only on boundary days
  // and any day that might contain a DST transition; middle full days use perDayHits.
  const dense = perDayHits > 24;
  const isUtcZone = input.timezone === "UTC" || input.timezone === "Etc/UTC";

  const maxDays = Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)) + 4;
  let dayIndex = 0;
  for (let i = 0; i < maxDays; i += 1) {
    if (y > endLocal.y || (y === endLocal.y && (m > endLocal.m || (m === endLocal.m && d > endLocal.d)))) {
      break;
    }
    const isStartDay = y === startLocal.y && m === startLocal.m && d === startLocal.d;
    const isEndDay = y === endLocal.y && m === endLocal.m && d === endLocal.d;
    if (months.includes(m)) {
      const dim = daysInMonth(y, m);
      if (d >= 1 && d <= dim) {
        const ymd = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const noonGuess = approximateLocalToUtc(input.timezone, `${ymd}T12:00:00`);
        const { dow } = localYmdParts(noonGuess, input.timezone);
        const domOk = domStar || doms.includes(d);
        const dowOk = dowStar || dows.has(dow);
        let dayMatches = false;
        if (domStar && dowStar) dayMatches = true;
        else if (domStar) dayMatches = dowOk;
        else if (dowStar) dayMatches = domOk;
        else dayMatches = domOk || dowOk;

        if (dayMatches) {
          const enumerateSlots = !dense || isStartDay || isEndDay || !isUtcZone;
          // For non-UTC dense schedules, still only fully enumerate boundary days;
          // middle days: perDayHits minus gap slots if spring-forward day.
          if (dense && !isStartDay && !isEndDay) {
            let dayCount = perDayHits;
            if (!isUtcZone) {
              // Subtract DST gap slots cheaply (fixed hour:minute checks only for gap hours 1-3).
              for (const hh of hours) {
                if (hh < 1 || hh > 3) continue;
                for (const mm of minutes) {
                  const localWall = `${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
                  if (isLocalWallInDstGap(input.timezone, localWall)) dayCount -= 1;
                }
              }
            }
            count += dayCount;
            // first/last refined only on boundaries; approximate with noon for middle.
            if (!firstUtc) firstUtc = approximateLocalToUtc(input.timezone, `${ymd}T${String(hours[0]!).padStart(2, "0")}:${String(minutes[0]!).padStart(2, "0")}:00`);
            lastUtc = approximateLocalToUtc(
              input.timezone,
              `${ymd}T${String(hours[hours.length - 1]!).padStart(2, "0")}:${String(minutes[minutes.length - 1]!).padStart(2, "0")}:00`,
            );
          } else if (enumerateSlots) {
            for (const hh of hours) {
              for (const mm of minutes) {
                const localWall = `${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
                if (!isUtcZone && isLocalWallInDstGap(input.timezone, localWall)) continue;
                const utc = isUtcZone
                  ? new Date(`${localWall}.000Z`)
                  : approximateLocalToUtc(input.timezone, localWall);
                if (!isUtcZone) {
                  const rt = formatLocalWallTime(utc, input.timezone).localWallTime.slice(0, 16);
                  if (rt !== localWall.slice(0, 16)) continue;
                }
                const t = utc.getTime();
                if (t >= startMs && t <= endMs) {
                  count += 1;
                  if (!firstUtc || t < firstUtc.getTime()) firstUtc = utc;
                  if (!lastUtc || t > lastUtc.getTime()) lastUtc = utc;
                }
              }
            }
          }
        }
      }
    }
    d += 1;
    dayIndex += 1;
    const dim = daysInMonth(y, m);
    if (d > dim) {
      d = 1;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  void dayIndex;
  return { count, firstUtc, lastUtc };
}

/**
 * Collect missed scheduled instants from a persisted anchor through `now`.
 * Exact combinatorial count (no sampled interval). Tiny recent tail via parser for fire-once-now.
 */
function collectMissedOccurrencesBounded(input: {
  cron: string;
  timezone: string;
  now: Date;
  previousNextRunAt: string | null;
  lastMaterializedOccurrenceKey: string | null;
  taskId: string;
}): { candidates: Date[]; aggregateCount: number } {
  const MAX_PARSER_STEPS = 48;
  const RECENT_TAIL = 8;
  const nowMs = input.now.getTime();

  let start: Date | null = null;
  if (input.previousNextRunAt) {
    const prev = Date.parse(input.previousNextRunAt);
    if (Number.isFinite(prev) && prev <= nowMs) {
      start = new Date(prev);
    }
  }
  if (!start) {
    start = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  }

  const exact = countCronMatchesExact({
    cron: input.cron,
    timezone: input.timezone,
    startUtc: start,
    endUtc: input.now,
  });
  if (exact.count === 0 || !exact.firstUtc || !exact.lastUtc) {
    return { candidates: [], aggregateCount: 0 };
  }

  // Recent candidates for fire-once-now / lastOlder — tiny bounded walk near now.
  const recent: Date[] = [];
  try {
    const recentFrom = new Date(Math.max(exact.firstUtc.getTime(), nowMs - 2 * 60 * 60 * 1000));
    const rit = cronParser.parseExpression(input.cron, {
      currentDate: new Date(recentFrom.getTime() - 1),
      tz: input.timezone,
    });
    for (let i = 0; i < MAX_PARSER_STEPS; i += 1) {
      const d = rit.next().toDate();
      if (d.getTime() > nowMs) break;
      if (d.getTime() >= exact.firstUtc.getTime()) recent.push(d);
      if (recent.length > RECENT_TAIL) recent.shift();
    }
  } catch {
    // ignore
  }

  const candidates: Date[] = [];
  const seen = new Set<number>();
  const push = (d: Date) => {
    const t = d.getTime();
    if (seen.has(t)) return;
    seen.add(t);
    candidates.push(d);
  };
  push(exact.firstUtc);
  for (const d of recent) push(d);
  push(exact.lastUtc);
  candidates.sort((a, b) => a.getTime() - b.getTime());

  void input.taskId;
  void input.lastMaterializedOccurrenceKey;
  return { candidates, aggregateCount: exact.count };
}

/**
 * Detect a single DST spring-forward gap omission for fixed hour:minute crons.
 * Computationally bounded day walk with a hard cap — never scans month-by-minute.
 */
/** Earliest instant from which omissions/fires may be emitted. */
export function resolveActivationBoundaryMs(
  activatedAt?: string | null,
  approvedAt?: string | null,
): number | null {
  const candidates: number[] = [];
  for (const raw of [activatedAt, approvedAt]) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) candidates.push(ms);
  }
  if (!candidates.length) return null;
  return Math.max(...candidates);
}

function detectDstGapOmission(input: {
  taskId: string;
  cron: string;
  timezone: string;
  now: Date;
  previousNextRunAt: string | null;
  lastOmissionKey?: string | null;
  activationBoundaryMs?: number | null;
}): {
  omission: Omit<AutomationOmissionRecord, "schemaVersion" | "id" | "createdAt">;
  nextRunAt: string;
} | null {
  const fields = input.cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = fields[0]!;
  const hour = fields[1]!;
  // Only fixed wall-clock minute/hour (e.g. "30 2 * * *").
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const hh = Number(hour);
  const mm = Number(minute);
  if (hh > 23 || mm > 59) return null;
  // No previous scheduled pointer → nothing to reconcile; never invent historical gaps
  // for tasks activated AFTER a DST transition.
  if (!input.previousNextRunAt) return null;

  const prevMs = Date.parse(input.previousNextRunAt);
  if (!Number.isFinite(prevMs)) return null;

  // Never emit an omission whose wall/UTC instant is before activation/approved revision.
  const activationMs = input.activationBoundaryMs ?? null;

  // Bound detection strictly to the actual previous scheduled interval:
  // [previousNextRunAt − 1 interval, previousNextRunAt + 1 interval] ∩ (−∞, now].
  // Do NOT scan unbounded historical spring-forward calendars (false Mar 8 gap for a
  // task activated Mar 10 with nextRunAt Mar 10+).
  let intervalMs = AUTOMATION_MIN_CRON_INTERVAL_MS;
  try {
    const it = cronParser.parseExpression(input.cron, {
      currentDate: new Date(prevMs - 1),
      tz: input.timezone,
    });
    const a = it.next().toDate().getTime();
    const b = it.next().toDate().getTime();
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      intervalMs = Math.max(AUTOMATION_MIN_CRON_INTERVAL_MS, b - a);
    }
  } catch {
    // keep default
  }

  const windowStart = prevMs - intervalMs;
  const windowEnd = Math.min(input.now.getTime(), prevMs + intervalMs);
  if (windowEnd < windowStart) return null;

  // Only consider local calendar days that intersect the previous scheduled interval.
  const daySet = new Set<string>();
  for (const t of [windowStart, prevMs, windowEnd]) {
    daySet.add(formatLocalWallTime(new Date(t), input.timezone).localWallTime.slice(0, 10));
  }
  // Also include the day immediately after prev if the interval spans midnight.
  daySet.add(
    formatLocalWallTime(new Date(prevMs + Math.min(intervalMs, 36 * 3600_000)), input.timezone)
      .localWallTime.slice(0, 10),
  );

  const gapDays: Array<{ local: string; utcProbe: string }> = [];
  for (const localDate of [...daySet].sort()) {
    const localWall = `${localDate}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
    if (!isLocalWallInDstGap(input.timezone, localWall)) continue;
    const dayStartUtc = approximateLocalToUtc(input.timezone, `${localDate}T00:00:00`);
    const gapUtcMs = dayStartUtc.getTime() + hh * 3600_000 + mm * 60_000;
    // Gap must fall inside the previous scheduled interval window and not after now.
    if (gapUtcMs < windowStart - 12 * 3600_000) continue;
    if (gapUtcMs > windowEnd + 12 * 3600_000) continue;
    if (dayStartUtc.getTime() > input.now.getTime() + 12 * 3600_000) continue;
    // previousNextRunAt must itself be the gap wall time OR the parser-advanced next after gap.
    const prevLocal = formatLocalWallTime(new Date(prevMs), input.timezone).localWallTime;
    const prevDay = prevLocal.slice(0, 10);
    const prevHm = prevLocal.slice(11, 16);
    const gapHm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const isPrevTheGap = prevDay === localDate && prevHm === gapHm;
    // Parser often advances past the nonexistent wall time to the next real slot.
    const prevWasAdvancedPastGap =
      prevMs >= gapUtcMs - intervalMs && prevMs <= gapUtcMs + intervalMs * 2;
    if (!isPrevTheGap && !prevWasAdvancedPastGap) continue;
    // If previousNextRunAt is still in the future far beyond the gap and the task was
    // never due for the gap day, skip (activated-after-gap case).
    if (prevMs > input.now.getTime() && gapUtcMs < prevMs - intervalMs) continue;
    // Hard activation boundary: gap before activate/approve must never materialize.
    if (activationMs != null && gapUtcMs < activationMs) continue;
    if (activationMs != null && dayStartUtc.getTime() < activationMs - 12 * 3600_000) continue;
    gapDays.push({ local: localWall, utcProbe: new Date(Math.max(gapUtcMs, dayStartUtc.getTime())).toISOString() });
  }

  if (!gapDays.length) return null;

  const focused = gapDays.sort((a, b) => a.local.localeCompare(b.local))[0]!;

  const omission = {
    taskId: input.taskId,
    kind: "dst_gap" as const,
    timezone: input.timezone,
    firstLocal: focused.local,
    lastLocal: focused.local,
    firstUtc: focused.utcProbe,
    lastUtc: focused.utcProbe,
    count: 1,
    reason: "dst_gap_skipped",
  };

  // Persist dedup: identical gap must emit once across scheduler ticks.
  const omissionKey = buildOmissionKey(omission);
  if (input.lastOmissionKey && input.lastOmissionKey === omissionKey) {
    return null;
  }

  const nextRunAt = getNextRunAt({
    cron: input.cron,
    timezone: input.timezone,
    from: input.now,
  });

  return {
    nextRunAt,
    omission,
  };
}

/** Build manual-run occurrence metadata using the task IANA timezone (never host offset). */
export function buildManualOccurrenceMeta(input: {
  taskId: string;
  cron: string;
  timezone: string;
  now?: Date;
}): AutomationOccurrenceMeta {
  const now = input.now ?? new Date();
  const { localWallTime, offsetMinutes } = formatLocalWallTime(now, input.timezone);
  return {
    occurrenceKey: `${input.taskId}@manual@${now.toISOString()}@spv${AUTOMATION_SCHEDULE_POLICY_VERSION}`,
    scheduledForUtc: now.toISOString(),
    localWallTime,
    localOffsetMinutes: offsetMinutes,
    timezone: input.timezone,
    schedulePolicyVersion: AUTOMATION_SCHEDULE_POLICY_VERSION,
    cron: input.cron,
  };
}

function isLocalWallInDstGap(timezone: string, localWall: string): boolean {
  // Probe: if no UTC instant formats back to this local wall time, it's a gap.
  try {
    const base = approximateLocalToUtc(timezone, localWall);
    const formatted = formatLocalWallTime(base, timezone).localWallTime;
    // Exact hour:minute must match; gap times jump forward (e.g. 02:30 → 03:30).
    if (formatted.slice(0, 16) === localWall.slice(0, 16)) return false;
    // Also try neighboring hour offsets.
    for (const delta of [-3600_000, 3600_000, -7200_000, 7200_000]) {
      const probe = new Date(base.getTime() + delta);
      if (formatLocalWallTime(probe, timezone).localWallTime.slice(0, 16) === localWall.slice(0, 16)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function approximateLocalToUtc(timezone: string, localWall: string): Date {
  // localWall: YYYY-MM-DDTHH:mm:ss (no offset). Binary-search UTC that formats to it.
  const [datePart, timePart = "00:00:00"] = localWall.split("T");
  const [ys, ms, ds] = (datePart ?? "").split("-").map(Number);
  const [hs, mins, ss] = timePart.split(":").map(Number);
  // Initial guess: treat as UTC then correct via offset.
  let guess = Date.UTC(ys!, (ms! || 1) - 1, ds! || 1, hs || 0, mins || 0, ss || 0);
  for (let i = 0; i < 4; i += 1) {
    const formatted = formatLocalWallTime(new Date(guess), timezone);
    const offsetMin = formatted.offsetMinutes;
    // local = utc + offset => utc = local - offset
    const asUtc = Date.UTC(ys!, (ms! || 1) - 1, ds! || 1, hs || 0, mins || 0, ss || 0);
    guess = asUtc - offsetMin * 60_000;
  }
  return new Date(guess);
}

export function previewNextRuns(input: {
  cron: string;
  timezone: string;
  from?: Date;
  count?: number;
}): Array<{ utc: string; localWallTime: string; offsetMinutes: number }> {
  return getNextOccurrences(input).map((d) => {
    const local = formatLocalWallTime(d, input.timezone);
    return {
      utc: d.toISOString(),
      localWallTime: local.localWallTime,
      offsetMinutes: local.offsetMinutes,
    };
  });
}

/** Detect whether a wall-time would fall in a DST gap by comparing formatter round-trip. */
export function isLikelyDstGapLocal(input: {
  timezone: string;
  localIsoWithoutOffset: string;
}): boolean {
  // Best-effort helper for UI messaging; occurrence engine relies on cron-parser skips.
  try {
    const probe = new Date(`${input.localIsoWithoutOffset}Z`);
    if (Number.isNaN(probe.getTime())) return false;
    const formatted = formatLocalWallTime(probe, input.timezone).localWallTime;
    return !formatted.startsWith(input.localIsoWithoutOffset.slice(0, 16));
  } catch {
    return false;
  }
}

// Re-export parser access for tests that need fixed currentDate.
export function parseCronForTests(cron: string, timezone: string, currentDate: Date) {
  return cronParser.parseExpression(cron, { currentDate, tz: timezone });
}
