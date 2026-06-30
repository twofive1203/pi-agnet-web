import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OpenAICodexWarmupResult } from "@/lib/openai-codex-warmup";

const HISTORY_FILE = "chatgpt-warmup-history.json";
const MAX_HISTORY_RUNS = 50;

declare global {
  var __piOpenAICodexWarmupHistoryChain: Promise<void> | undefined;
}

export type OpenAICodexWarmupRunSource = "manual" | "scheduled";

export interface OpenAICodexWarmupHistoryRun {
  id: string;
  source: OpenAICodexWarmupRunSource;
  scheduledRunKey: string | null;
  startedAt: string;
  completedAt: string;
  accountIds: string[];
  results: OpenAICodexWarmupResult[];
}

export interface OpenAICodexWarmupHistory {
  version: 1;
  lastScheduledRunKey: string | null;
  runs: OpenAICodexWarmupHistoryRun[];
}

export interface RecordOpenAICodexWarmupRunInput {
  source: OpenAICodexWarmupRunSource;
  scheduledRunKey?: string | null;
  startedAt: string;
  completedAt: string;
  accountIds: string[];
  results: OpenAICodexWarmupResult[];
}

export function getOpenAICodexWarmupHistoryPath(): string {
  return join(getAgentDir(), HISTORY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRun(value: unknown): OpenAICodexWarmupHistoryRun | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  if (value.source !== "manual" && value.source !== "scheduled") return null;
  if (typeof value.startedAt !== "string" || typeof value.completedAt !== "string") return null;
  const accountIds = Array.isArray(value.accountIds)
    ? value.accountIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const results = Array.isArray(value.results)
    ? value.results.filter(isRecord).map((result) => ({
      accountId: typeof result.accountId === "string" ? result.accountId : "",
      success: result.success === true,
      error: typeof result.error === "string" ? result.error : null,
      latencyMs: typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) ? result.latencyMs : null,
      quotaRefreshSuccess: result.quotaRefreshSuccess === true,
      quotaError: typeof result.quotaError === "string" ? result.quotaError : null,
    })).filter((result) => result.accountId)
    : [];
  return {
    id: value.id,
    source: value.source,
    scheduledRunKey: typeof value.scheduledRunKey === "string" && value.scheduledRunKey.trim() ? value.scheduledRunKey : null,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    accountIds,
    results,
  };
}

function normalizeHistory(value: unknown): OpenAICodexWarmupHistory {
  if (!isRecord(value)) return { version: 1, lastScheduledRunKey: null, runs: [] };
  const runs = Array.isArray(value.runs)
    ? value.runs.map(normalizeRun).filter((run): run is OpenAICodexWarmupHistoryRun => Boolean(run)).slice(0, MAX_HISTORY_RUNS)
    : [];
  return {
    version: 1,
    lastScheduledRunKey: typeof value.lastScheduledRunKey === "string" && value.lastScheduledRunKey.trim() ? value.lastScheduledRunKey : null,
    runs,
  };
}

export async function readOpenAICodexWarmupHistory(): Promise<OpenAICodexWarmupHistory> {
  try {
    const raw = await readFile(getOpenAICodexWarmupHistoryPath(), "utf8");
    return normalizeHistory(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { version: 1, lastScheduledRunKey: null, runs: [] };
    }
    throw error;
  }
}

async function writeOpenAICodexWarmupHistory(history: OpenAICodexWarmupHistory): Promise<void> {
  const path = getOpenAICodexWarmupHistoryPath();
  const tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function withHistoryWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = globalThis.__piOpenAICodexWarmupHistoryChain ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  globalThis.__piOpenAICodexWarmupHistoryChain = current.then(() => undefined, () => undefined);
  return current;
}

export async function markScheduledWarmupStarted(scheduledRunKey: string): Promise<void> {
  await withHistoryWriteLock(async () => {
    const history = await readOpenAICodexWarmupHistory();
    await writeOpenAICodexWarmupHistory({ ...history, lastScheduledRunKey: scheduledRunKey });
  });
}

export async function recordOpenAICodexWarmupRun(input: RecordOpenAICodexWarmupRunInput): Promise<OpenAICodexWarmupHistoryRun> {
  return withHistoryWriteLock(async () => {
    const history = await readOpenAICodexWarmupHistory();
    const run: OpenAICodexWarmupHistoryRun = {
      id: randomUUID(),
      source: input.source,
      scheduledRunKey: input.scheduledRunKey ?? null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      accountIds: input.accountIds,
      results: input.results,
    };
    await writeOpenAICodexWarmupHistory({
      version: 1,
      lastScheduledRunKey: input.scheduledRunKey ?? history.lastScheduledRunKey,
      runs: [run, ...history.runs].slice(0, MAX_HISTORY_RUNS),
    });
    return run;
  });
}
