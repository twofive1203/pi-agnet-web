import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export type SubagentMetricName =
  | "rawProgress"
  | "coalescedProgress"
  | "immediateProgress"
  | "deliveredProgress"
  | "terminalEvents"
  | "projectionMs"
  | "fileProjectionMs"
  | "handlerMs"
  | "ssePayloads"
  | "sseBytes";

type MetricValue = { count: number; sum: number; max: number };

const METRIC_NAMES: SubagentMetricName[] = [
  "rawProgress",
  "coalescedProgress",
  "immediateProgress",
  "deliveredProgress",
  "terminalEvents",
  "projectionMs",
  "fileProjectionMs",
  "handlerMs",
  "ssePayloads",
  "sseBytes",
];

function emptyValues(): Record<SubagentMetricName, MetricValue> {
  return Object.fromEntries(
    METRIC_NAMES.map((name) => [name, { count: 0, sum: 0, max: 0 }]),
  ) as Record<SubagentMetricName, MetricValue>;
}

/** Fixed-key accumulator: diagnostics never retain events, tool arguments, or output text. */
export class BoundedSubagentMetrics {
  private values = emptyValues();

  record(name: SubagentMetricName, value = 1): void {
    const metric = this.values[name];
    metric.count += 1;
    metric.sum += value;
    metric.max = Math.max(metric.max, value);
  }

  takeSnapshot(): Record<SubagentMetricName, MetricValue> {
    const snapshot = structuredClone(this.values);
    this.values = emptyValues();
    return snapshot;
  }
}

type ObservabilityRuntime = {
  metrics: BoundedSubagentMetrics;
  interval: ReturnType<typeof setInterval>;
  eventLoop: ReturnType<typeof monitorEventLoopDelay>;
};

declare global {
  var __piWebSubagentObservability: ObservabilityRuntime | undefined;
}

const enabled = process.env.PI_WEB_SUBAGENT_OBSERVABILITY === "1";

function ensureRuntime(): ObservabilityRuntime | null {
  if (!enabled) return null;
  if (globalThis.__piWebSubagentObservability) return globalThis.__piWebSubagentObservability;

  const metrics = new BoundedSubagentMetrics();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const interval = setInterval(() => {
    const snapshot = metrics.takeSnapshot();
    const eventLoopDelayMs = {
      mean: Number.isFinite(eventLoop.mean) ? eventLoop.mean / 1e6 : 0,
      max: eventLoop.max / 1e6,
      p95: eventLoop.percentile(95) / 1e6,
    };
    eventLoop.reset();
    console.info("[pi-web:subagent-observability]", JSON.stringify({ snapshot, eventLoopDelayMs }));
  }, 5_000);
  interval.unref?.();

  globalThis.__piWebSubagentObservability = { metrics, interval, eventLoop };
  return globalThis.__piWebSubagentObservability;
}

export function recordSubagentMetric(name: SubagentMetricName, value = 1): void {
  ensureRuntime()?.metrics.record(name, value);
}

export function recordSsePayload(byteLength: number): void {
  const runtime = ensureRuntime();
  if (!runtime) return;
  runtime.metrics.record("ssePayloads");
  runtime.metrics.record("sseBytes", byteLength);
}

export function nowForSubagentMetric(): number {
  return enabled ? performance.now() : 0;
}

export function recordSubagentDuration(name: Extract<SubagentMetricName, `${string}Ms`>, startedAt: number): void {
  if (!enabled) return;
  recordSubagentMetric(name, performance.now() - startedAt);
}
