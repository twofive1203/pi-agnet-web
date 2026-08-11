/**
 * Durable per-session performance aggregates (weighted TPS / TTFT).
 *
 * Samples are recorded from unthrottled AgentSession lifecycle events and stored
 * in a WebUI-owned sidecar. Pi session JSONL is never modified.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { mkdir, readFile, rename, unlink as unlinkAsync, writeFile } from "fs/promises";
import path from "path";
import { homedir } from "os";
import type { SessionPerformanceModelBreakdown, SessionPerformanceSummary } from "./types";

const SIDECAR_VERSION = 1 as const;

export type SessionPerformanceClock = () => number;

export interface SessionPerformanceRecorderOptions {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  /** Injectable monotonic clock (ms). Defaults to performance.now / Date.now. */
  now?: SessionPerformanceClock;
  /** Called after a valid sample is durably written. Failures are swallowed by callers. */
  onSummary?: (summary: SessionPerformanceSummary) => void;
}

interface ActiveCallTiming {
  callStartedAtMs: number;
  firstOutputAtMs: number | null;
}

interface ModelAggregateCounters {
  provider: string;
  model: string;
  sampleCount: number;
  totalOutputTokens: number;
  totalStreamDurationMs: number;
  totalTtftMs: number;
}

interface AggregateTotals {
  sampleCount: number;
  totalOutputTokens: number;
  totalStreamDurationMs: number;
  totalTtftMs: number;
}

interface SessionPerformanceSidecar {
  version: typeof SIDECAR_VERSION;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  updatedAt: string;
  totals: AggregateTotals;
  /** Keyed by stable provider\u0000model pairs. */
  byModel: Record<string, ModelAggregateCounters>;
}

export interface PerformanceSampleInput {
  provider: string;
  model: string;
  outputTokens: number;
  streamDurationMs: number;
  ttftMs: number;
}

interface AssistantDeltaLike {
  type?: unknown;
  delta?: unknown;
}

interface AssistantMessageLike {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  stopReason?: unknown;
  usage?: { output?: unknown } | null;
}

interface AgentLifecycleEvent {
  type?: unknown;
  message?: AssistantMessageLike;
  assistantMessageEvent?: AssistantDeltaLike;
}

const sessionPerformanceQueues = new Map<string, Promise<unknown>>();

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return path.resolve(homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function getSessionPerformanceDir(): string {
  return path.join(getAgentDir(), "session-performance");
}

export function getSessionPerformancePath(sessionId: string): string {
  return path.join(getSessionPerformanceDir(), `${encodeURIComponent(sessionId)}.json`);
}

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function emptyTotals(): AggregateTotals {
  return {
    sampleCount: 0,
    totalOutputTokens: 0,
    totalStreamDurationMs: 0,
    totalTtftMs: 0,
  };
}

function emptySidecar(sessionId: string, cwd: string, sessionFile?: string): SessionPerformanceSidecar {
  return {
    version: SIDECAR_VERSION,
    sessionId,
    sessionFile,
    cwd,
    updatedAt: new Date().toISOString(),
    totals: emptyTotals(),
    byModel: {},
  };
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (!(denominator > 0) || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Project aggregate counters into a client-safe summary. */
export function projectSessionPerformanceSummary(
  totals: AggregateTotals,
  byModel: Record<string, ModelAggregateCounters>,
): SessionPerformanceSummary {
  const rows = Object.values(byModel)
    .filter((row) => row.sampleCount > 0)
    .map((row): SessionPerformanceModelBreakdown => ({
      provider: row.provider,
      model: row.model,
      sampleCount: row.sampleCount,
      totalOutputTokens: row.totalOutputTokens,
      totalStreamDurationMs: row.totalStreamDurationMs,
      totalTtftMs: row.totalTtftMs,
      avgTps: safeDivide(row.totalOutputTokens, row.totalStreamDurationMs / 1000),
      avgTtftMs: safeDivide(row.totalTtftMs, row.sampleCount),
    }))
    .sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return a.model.localeCompare(b.model);
    });

  return {
    sampleCount: totals.sampleCount,
    totalOutputTokens: totals.totalOutputTokens,
    totalStreamDurationMs: totals.totalStreamDurationMs,
    totalTtftMs: totals.totalTtftMs,
    avgTps: safeDivide(totals.totalOutputTokens, totals.totalStreamDurationMs / 1000),
    avgTtftMs: safeDivide(totals.totalTtftMs, totals.sampleCount),
    mixedModels: rows.length > 1,
    byModel: rows,
  };
}

export function emptySessionPerformanceSummary(): SessionPerformanceSummary {
  return projectSessionPerformanceSummary(emptyTotals(), {});
}

function isValidSidecar(value: unknown, sessionId: string): value is SessionPerformanceSidecar {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Partial<SessionPerformanceSidecar>;
  if (parsed.version !== SIDECAR_VERSION) return false;
  if (parsed.sessionId !== sessionId) return false;
  if (!parsed.totals || typeof parsed.totals !== "object") return false;
  if (!parsed.byModel || typeof parsed.byModel !== "object" || Array.isArray(parsed.byModel)) return false;
  const totals = parsed.totals;
  if (
    !isFiniteNonNegativeNumber(totals.sampleCount)
    || !isFiniteNonNegativeNumber(totals.totalOutputTokens)
    || !isFiniteNonNegativeNumber(totals.totalStreamDurationMs)
    || !isFiniteNonNegativeNumber(totals.totalTtftMs)
  ) {
    return false;
  }
  return true;
}

async function readSidecarForWrite(
  sessionId: string,
  cwd: string,
  sessionFile?: string,
): Promise<SessionPerformanceSidecar> {
  const filePath = getSessionPerformancePath(sessionId);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isValidSidecar(parsed, sessionId)) {
      return emptySidecar(sessionId, cwd, sessionFile);
    }
    return {
      version: SIDECAR_VERSION,
      sessionId,
      sessionFile: parsed.sessionFile ?? sessionFile,
      cwd: parsed.cwd ?? cwd,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      totals: { ...parsed.totals },
      byModel: { ...parsed.byModel },
    };
  } catch {
    return emptySidecar(sessionId, cwd, sessionFile);
  }
}

async function writeSidecar(sidecar: SessionPerformanceSidecar): Promise<void> {
  const filePath = getSessionPerformancePath(sidecar.sessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(sidecar, null, 2));
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlinkAsync(tmpPath).catch(() => {});
    throw error;
  }
}

function applySample(sidecar: SessionPerformanceSidecar, sample: PerformanceSampleInput): void {
  sidecar.totals.sampleCount += 1;
  sidecar.totals.totalOutputTokens += sample.outputTokens;
  sidecar.totals.totalStreamDurationMs += sample.streamDurationMs;
  sidecar.totals.totalTtftMs += sample.ttftMs;

  const key = modelKey(sample.provider, sample.model);
  const existing = sidecar.byModel[key];
  if (existing) {
    existing.sampleCount += 1;
    existing.totalOutputTokens += sample.outputTokens;
    existing.totalStreamDurationMs += sample.streamDurationMs;
    existing.totalTtftMs += sample.ttftMs;
  } else {
    sidecar.byModel[key] = {
      provider: sample.provider,
      model: sample.model,
      sampleCount: 1,
      totalOutputTokens: sample.outputTokens,
      totalStreamDurationMs: sample.streamDurationMs,
      totalTtftMs: sample.ttftMs,
    };
  }
  sidecar.updatedAt = new Date().toISOString();
}

/** Read the durable summary for a session, or null when missing/invalid/empty. */
export function readSessionPerformanceSummary(sessionId: string): SessionPerformanceSummary | null {
  const filePath = getSessionPerformancePath(sessionId);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isValidSidecar(parsed, sessionId)) return null;
    if (parsed.totals.sampleCount <= 0) return null;
    return projectSessionPerformanceSummary(parsed.totals, parsed.byModel);
  } catch {
    return null;
  }
}

export function deleteSessionPerformanceSidecar(sessionId: string): void {
  try {
    unlinkSync(getSessionPerformancePath(sessionId));
  } catch {
    // Best-effort cleanup only.
  }
}

function enqueueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionPerformanceQueues.get(sessionId) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(() => undefined, () => undefined);
  sessionPerformanceQueues.set(sessionId, settled);
  void settled.finally(() => {
    if (sessionPerformanceQueues.get(sessionId) === settled) {
      sessionPerformanceQueues.delete(sessionId);
    }
  });
  return next;
}

export async function flushSessionPerformance(sessionId: string): Promise<void> {
  await sessionPerformanceQueues.get(sessionId);
}

export async function recordPerformanceSample(input: {
  sessionId: string;
  cwd: string;
  sessionFile?: string;
  sample: PerformanceSampleInput;
}): Promise<SessionPerformanceSummary> {
  return enqueueSessionWrite(input.sessionId, async () => {
    const sidecar = await readSidecarForWrite(input.sessionId, input.cwd, input.sessionFile);
    applySample(sidecar, input.sample);
    if (input.sessionFile) sidecar.sessionFile = input.sessionFile;
    sidecar.cwd = input.cwd;
    await writeSidecar(sidecar);
    return projectSessionPerformanceSummary(sidecar.totals, sidecar.byModel);
  });
}

/** True when an assistant stream delta establishes first effective output. */
export function isFirstEffectiveOutputDelta(event: AssistantDeltaLike | null | undefined): boolean {
  if (!event || typeof event.type !== "string") return false;
  if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") {
    return false;
  }
  return typeof event.delta === "string" && event.delta.length > 0;
}

/**
 * Build a valid sample from completed-call boundaries, or null when ineligible.
 * Never fabricates duration or clamps zero/negative timings.
 */
export function buildPerformanceSample(input: {
  message: AssistantMessageLike | null | undefined;
  callStartedAtMs: number | null | undefined;
  firstOutputAtMs: number | null | undefined;
  completedAtMs: number;
}): PerformanceSampleInput | null {
  const message = input.message;
  if (!message || message.role !== "assistant") return null;

  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  if (stopReason === "error" || stopReason === "aborted") return null;

  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!provider || !model) return null;

  const outputTokens = message.usage?.output;
  if (!isFinitePositiveNumber(outputTokens)) return null;

  const callStartedAtMs = input.callStartedAtMs;
  const firstOutputAtMs = input.firstOutputAtMs;
  if (!isFiniteNonNegativeNumber(callStartedAtMs) || !isFiniteNonNegativeNumber(firstOutputAtMs)) {
    return null;
  }
  if (!isFinitePositiveNumber(input.completedAtMs) && input.completedAtMs !== 0) {
    // completedAtMs may be 0 in deterministic tests; allow any finite number.
    if (!Number.isFinite(input.completedAtMs)) return null;
  }

  const ttftMs = firstOutputAtMs - callStartedAtMs;
  const streamDurationMs = input.completedAtMs - firstOutputAtMs;
  // Require strictly positive measured windows; never clamp or fabricate duration.
  if (!isFinitePositiveNumber(ttftMs) || !isFinitePositiveNumber(streamDurationMs)) return null;

  return {
    provider,
    model,
    outputTokens,
    streamDurationMs,
    ttftMs,
  };
}

/**
 * In-memory timing recorder bound to one live AgentSessionWrapper.
 * Persistence happens only after a valid Assistant completion.
 */
export class SessionPerformanceRecorder {
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly sessionFile?: string;
  private readonly now: SessionPerformanceClock;
  private readonly onSummary?: (summary: SessionPerformanceSummary) => void;
  private active: ActiveCallTiming | null = null;
  private closed = false;
  /** Local chain of accepted sample writes so flush can wait before they hit the shared queue. */
  private pendingWrites: Promise<unknown> = Promise.resolve();

  constructor(options: SessionPerformanceRecorderOptions) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.sessionFile = options.sessionFile;
    this.now = options.now ?? defaultNow;
    this.onSummary = options.onSummary;
  }

  /** Observe one raw AgentSession event (before SSE throttling). */
  observe(event: unknown): void {
    if (this.closed) return;
    if (!event || typeof event !== "object") return;
    const lifecycle = event as AgentLifecycleEvent;
    const type = lifecycle.type;
    if (typeof type !== "string") return;

    if (type === "turn_start") {
      this.active = {
        callStartedAtMs: this.now(),
        firstOutputAtMs: null,
      };
      return;
    }

    if (type === "message_update") {
      if (!this.active || this.active.firstOutputAtMs !== null) return;
      if (isFirstEffectiveOutputDelta(lifecycle.assistantMessageEvent)) {
        this.active.firstOutputAtMs = this.now();
      }
      return;
    }

    if (type === "message_end") {
      // Only ordinary Assistant completions close a timing window. User/toolResult
      // message_end events must not clear an in-flight assistant call.
      if (lifecycle.message?.role !== "assistant") return;
      const completedAtMs = this.now();
      const active = this.active;
      this.active = null;
      const sample = buildPerformanceSample({
        message: lifecycle.message,
        callStartedAtMs: active?.callStartedAtMs,
        firstOutputAtMs: active?.firstOutputAtMs,
        completedAtMs,
      });
      if (!sample) return;
      // Enqueue synchronously inside the event handler so destroy/flush cannot
      // miss a write that has not yet entered the shared per-session queue.
      this.queueSample(sample);
      return;
    }

    // Clear stale timing on terminal agent boundaries so later calls cannot inherit it.
    if (type === "agent_end" || type === "agent_settled") {
      this.active = null;
    }
  }

  private queueSample(sample: PerformanceSampleInput): void {
    const write = recordPerformanceSample({
      sessionId: this.sessionId,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      sample,
    }).then((summary) => {
      if (this.closed) return;
      try {
        this.onSummary?.(summary);
      } catch {
        // Callback failures must never interrupt agent delivery.
      }
    }, () => {
      // Persistence is diagnostic-only.
    });
    this.pendingWrites = this.pendingWrites.then(() => write, () => write);
  }

  /** Wait for queued writes and drop in-memory timing (no incomplete samples). */
  async flush(): Promise<void> {
    this.active = null;
    await this.pendingWrites;
    await flushSessionPerformance(this.sessionId);
  }

  /**
   * Stop accepting new lifecycle observations and suppress summary callbacks.
   * In-flight writes from samples already accepted continue until flush().
   */
  close(): void {
    this.closed = true;
    this.active = null;
  }
}
