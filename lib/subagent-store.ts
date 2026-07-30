import type { SubagentRun } from "./subagent-runs";

export interface SubagentCounts {
  running: number;
  completed: number;
  failed: number;
}

const EMPTY_RUNS: readonly SubagentRun[] = [];
const EMPTY_COUNTS: SubagentCounts = { running: 0, completed: 0, failed: 0 };

export class SubagentStore {
  private runs: readonly SubagentRun[] = EMPTY_RUNS;
  private counts = EMPTY_COUNTS;
  private readonly runListeners = new Set<() => void>();
  private readonly countListeners = new Set<() => void>();

  readonly subscribeRuns = (listener: () => void): (() => void) => {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  };

  readonly subscribeCounts = (listener: () => void): (() => void) => {
    this.countListeners.add(listener);
    return () => this.countListeners.delete(listener);
  };

  readonly getRunsSnapshot = (): readonly SubagentRun[] => this.runs;
  readonly getCountsSnapshot = (): SubagentCounts => this.counts;
  readonly getServerRunsSnapshot = (): readonly SubagentRun[] => EMPTY_RUNS;
  readonly getServerCountsSnapshot = (): SubagentCounts => EMPTY_COUNTS;

  setRuns(runs: readonly SubagentRun[]): void {
    if (runs === this.runs) return;
    this.runs = runs;

    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const run of runs) {
      if (run.status === "running") running += 1;
      else if (run.status === "failed") failed += 1;
      else completed += 1;
    }

    const previousCounts = this.counts;
    if (
      previousCounts.running !== running
      || previousCounts.completed !== completed
      || previousCounts.failed !== failed
    ) {
      this.counts = { running, completed, failed };
      for (const listener of this.countListeners) listener();
    }
    for (const listener of this.runListeners) listener();
  }

  reset(): void {
    if (this.runs === EMPTY_RUNS && this.counts === EMPTY_COUNTS) return;
    const hadRuns = this.runs !== EMPTY_RUNS;
    const hadCounts = this.counts !== EMPTY_COUNTS;
    this.runs = EMPTY_RUNS;
    this.counts = EMPTY_COUNTS;
    if (hadCounts) for (const listener of this.countListeners) listener();
    if (hadRuns) for (const listener of this.runListeners) listener();
  }
}
