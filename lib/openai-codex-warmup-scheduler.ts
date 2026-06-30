import { readPiWebConfig } from "@/lib/pi-web-config";
import { markScheduledWarmupStarted, readOpenAICodexWarmupHistory, recordOpenAICodexWarmupRun } from "@/lib/openai-codex-warmup-history";
import { warmOpenAICodexAccounts } from "@/lib/openai-codex-warmup";

const SCHEDULER_INTERVAL_MS = 60_000;

interface OpenAICodexWarmupSchedulerState {
  timer: NodeJS.Timeout | null;
  inFlightRunKeys: Set<string>;
}

declare global {
  var __piOpenAICodexWarmupScheduler: OpenAICodexWarmupSchedulerState | undefined;
}

function schedulerState(): OpenAICodexWarmupSchedulerState {
  globalThis.__piOpenAICodexWarmupScheduler ??= {
    timer: null,
    inFlightRunKeys: new Set<string>(),
  };
  return globalThis.__piOpenAICodexWarmupScheduler;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTimeKey(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function scheduledRunKey(date: Date): string {
  return `${localDateKey(date)}T${localTimeKey(date)}`;
}

async function runDueWarmup(now = new Date()): Promise<void> {
  const config = readPiWebConfig().chatgpt.warmup;
  if (!config.enabled || config.accountIds.length === 0) return;

  const time = localTimeKey(now);
  if (!config.times.includes(time)) return;

  const runKey = scheduledRunKey(now);
  const state = schedulerState();
  if (state.inFlightRunKeys.size > 0 || state.inFlightRunKeys.has(runKey)) return;

  const history = await readOpenAICodexWarmupHistory();
  if (history.lastScheduledRunKey === runKey || history.runs.some((run) => run.scheduledRunKey === runKey)) return;

  state.inFlightRunKeys.add(runKey);
  await markScheduledWarmupStarted(runKey);

  const startedAt = new Date().toISOString();
  try {
    const response = await warmOpenAICodexAccounts(config.accountIds);
    await recordOpenAICodexWarmupRun({
      source: "scheduled",
      scheduledRunKey: runKey,
      startedAt,
      completedAt: new Date().toISOString(),
      accountIds: config.accountIds,
      results: response.results,
    });
  } finally {
    state.inFlightRunKeys.delete(runKey);
  }
}

export function ensureOpenAICodexWarmupScheduler(): void {
  const state = schedulerState();
  if (state.timer) return;

  state.timer = setInterval(() => {
    void runDueWarmup().catch(() => {});
  }, SCHEDULER_INTERVAL_MS);
  state.timer.unref?.();
  void runDueWarmup().catch(() => {});
}
