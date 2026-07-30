"use client";

export type SubagentClientMetricName =
  | "sseEvents"
  | "eventHandlerMs"
  | "serializeMs"
  | "appShellSubagentUpdates"
  | "appShellSubagentRenders"
  | "panelRenderMs";

type MetricValue = { count: number; sum: number; max: number };

type ClientRuntime = {
  values: Map<SubagentClientMetricName, MetricValue>;
  timer: ReturnType<typeof setInterval>;
};

declare global {
  interface Window {
    __piWebSubagentBrowserObservability?: ClientRuntime;
  }
}

export const SUBAGENT_BROWSER_OBSERVABILITY_ENABLED =
  process.env.NEXT_PUBLIC_PI_WEB_SUBAGENT_OBSERVABILITY === "1";

function ensureRuntime(): ClientRuntime | null {
  if (!SUBAGENT_BROWSER_OBSERVABILITY_ENABLED || typeof window === "undefined") return null;
  if (window.__piWebSubagentBrowserObservability) return window.__piWebSubagentBrowserObservability;

  const values = new Map<SubagentClientMetricName, MetricValue>();
  const timer = setInterval(() => {
    const snapshot = Object.fromEntries(values.entries());
    values.clear();
    console.info("[pi-web:subagent-observability:browser]", snapshot);
  }, 5_000);
  const runtime = { values, timer };
  window.__piWebSubagentBrowserObservability = runtime;
  return runtime;
}

export function recordSubagentClientMetric(name: SubagentClientMetricName, value = 1): void {
  const runtime = ensureRuntime();
  if (!runtime) return;
  const metric = runtime.values.get(name) ?? { count: 0, sum: 0, max: 0 };
  metric.count += 1;
  metric.sum += value;
  metric.max = Math.max(metric.max, value);
  runtime.values.set(name, metric);
}

export function nowForSubagentClientMetric(): number {
  return SUBAGENT_BROWSER_OBSERVABILITY_ENABLED && typeof performance !== "undefined" ? performance.now() : 0;
}

export function recordSubagentClientDuration(
  name: Extract<SubagentClientMetricName, `${string}Ms`>,
  startedAt: number,
): void {
  if (!SUBAGENT_BROWSER_OBSERVABILITY_ENABLED || typeof performance === "undefined") return;
  recordSubagentClientMetric(name, performance.now() - startedAt);
}
