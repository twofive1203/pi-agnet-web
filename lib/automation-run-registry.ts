/**
 * In-process registry of active Automation runs for cancel/abort fanout.
 */

export type ActiveAutomationRun = {
  runId: string;
  taskId: string;
  abortController: AbortController;
  startedAt: number;
};

declare global {
  var __piAutomationRunRegistry: Map<string, ActiveAutomationRun> | undefined;
}

function registry(): Map<string, ActiveAutomationRun> {
  if (!globalThis.__piAutomationRunRegistry) {
    globalThis.__piAutomationRunRegistry = new Map();
  }
  return globalThis.__piAutomationRunRegistry;
}

export function registerActiveRun(run: ActiveAutomationRun): void {
  registry().set(run.runId, run);
  notifyObserverBestEffort();
}

export function unregisterActiveRun(runId: string): void {
  registry().delete(runId);
  notifyObserverBestEffort();
}

function notifyObserverBestEffort(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { notifyTaskObserverSourceChange } = require("./task-observer-invalidate") as typeof import("./task-observer-invalidate");
    notifyTaskObserverSourceChange();
  } catch {
    // Observer must never break Automation registry mutations.
  }
}

export function getActiveRun(runId: string): ActiveAutomationRun | undefined {
  return registry().get(runId);
}

export function listActiveRuns(): ActiveAutomationRun[] {
  return [...registry().values()];
}

export function requestCancelRun(runId: string): boolean {
  const active = registry().get(runId);
  if (!active) return false;
  active.abortController.abort();
  return true;
}

export function activeRunCount(): number {
  return registry().size;
}
