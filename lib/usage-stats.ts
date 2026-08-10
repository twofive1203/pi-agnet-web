import { readFileSync } from "fs";
import { canonicalizeCwd, expandCwd } from "@/lib/cwd";
import { listSessionUsageFiles, type SessionUsageFile } from "@/lib/session-artifacts";
import type { SessionEntry, SessionInfo, SessionMessageEntry, AssistantMessage } from "@/lib/types";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  calls: number;
}

export interface UsageDaySummary {
  date: string;
  totals: UsageTotals;
}

export interface UsageModelSummary {
  provider: string;
  model: string;
  totals: UsageTotals;
}

export interface UsageSessionSummary {
  sessionId: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  created: string;
  modified: string;
  totals: UsageTotals;
  mainTotals: UsageTotals;
  subagentTotals: UsageTotals;
  subagentSessions: number;
}

export interface UsageStatsResult {
  from: string;
  to: string;
  scope: {
    cwd?: string;
    timezone: string;
    includeArchived: boolean;
  };
  totals: UsageTotals;
  mainTotals: UsageTotals;
  subagentTotals: UsageTotals;
  subagentSessions: number;
  byDay: UsageDaySummary[];
  byModel: UsageModelSummary[];
  byProvider: UsageModelSummary[];
  bySession: UsageSessionSummary[];
  scannedSessions: number;
  matchedSessions: number;
  scannedActiveSessions: number;
  scannedArchivedSessions: number;
  matchedActiveSessions: number;
  matchedArchivedSessions: number;
  skippedEntries: number;
  /** How session candidates were collected (index acceleration vs full scan). */
  scanSource: "index" | "fallback";
  /** Wall time for candidate collection + usage aggregation. */
  durationMs: number;
}

export interface UsageStatsOptions {
  from: Date;
  to: Date;
  cwd?: string;
  includeArchived?: boolean;
}

interface UsageRecord {
  entry: SessionMessageEntry;
  message: AssistantMessage;
  session: SessionInfo;
  source: SessionUsageFile;
}

function cwdKeys(cwd: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (!cwd) return keys;
  for (const candidate of [cwd, expandCwd(cwd), canonicalizeCwd(cwd)]) {
    if (candidate) keys.add(candidate.replace(/[\\/]+$/, ""));
  }
  return keys;
}

function cwdMatches(sessionCwd: string | undefined, filterCwd: string | undefined): boolean {
  if (!filterCwd) return true;
  const targets = cwdKeys(filterCwd);
  for (const key of cwdKeys(sessionCwd)) {
    if (targets.has(key)) return true;
  }
  return false;
}

/**
 * 创建一个空的费用统计汇总对象。
 *
 * @returns 初始化为 0 的 token、费用和调用次数汇总。
 */
function createTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
}

/**
 * 将单条 assistant usage 累加到指定汇总对象。
 *
 * @param totals 需要被累加的目标汇总对象。
 * @param usage assistant 消息中持久化的 usage 信息。
 */
function addUsage(totals: UsageTotals, usage: AssistantMessage["usage"]): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
  totals.calls += 1;
}

/**
 * 判断 session entry 是否为带 usage 的 assistant 消息。
 *
 * @param entry 从 Pi session 文件读取的原始 entry。
 * @returns 若 entry 可参与费用统计则返回 true。
 */
function isUsageMessageEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: AssistantMessage } {
  return entry.type === "message" && entry.message.role === "assistant" && Boolean(entry.message.usage);
}

/**
 * 将日期格式化为本地日粒度字符串。
 *
 * @param date 需要格式化的日期对象。
 * @returns `YYYY-MM-DD` 格式的本地日期。
 */
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 解析 `YYYY-MM-DD` 日期字符串为本地日期范围边界。
 *
 * @param value 查询参数中的日期字符串。
 * @param endOfDay 为 true 时返回当天 23:59:59.999，否则返回当天 00:00:00.000。
 * @returns 解析后的 Date；格式非法时返回 null。
 */
export function parseLocalDateParam(value: string | null, endOfDay: boolean): Date | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function sessionInfoFromIndexEntry(entry: {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  archived: boolean;
}): SessionInfo {
  return {
    path: entry.path,
    id: entry.id,
    cwd: entry.cwd,
    name: entry.name,
    created: entry.created,
    modified: entry.modified,
    messageCount: entry.messageCount,
    firstMessage: entry.firstMessage || "(no messages)",
    parentSessionId: entry.parentSessionId,
    archived: entry.archived || undefined,
  };
}

/**
 * Collect usage session candidates via session index (preferred) or full scan.
 * When cwd is set, index filters before any JSONL usage parse.
 */
async function listSessionsForUsage(options: {
  cwd?: string;
  includeArchived?: boolean;
}): Promise<{ sessions: SessionInfo[]; scanSource: "index" | "fallback" }> {
  const includeArchived = options.includeArchived !== false;
  try {
    const {
      getSessionIndexEntries,
      getSessionIndexEntriesForCwd,
    } = await import("@/lib/session-index");

    const archivedFilter = includeArchived ? undefined : false;
    const entries = options.cwd
      ? await getSessionIndexEntriesForCwd(options.cwd, { archived: archivedFilter })
      : await getSessionIndexEntries({ archived: archivedFilter });

    // Index refresh already scanned disk. Empty is a valid result (no sessions).
    return {
      sessions: entries.map(sessionInfoFromIndexEntry),
      scanSource: "index",
    };
  } catch {
    // Fall through to full reader scans.
  }

  // Lazy-import reader so the index-accelerated path stays free of SessionManager.
  const { listAllArchivedSessions, listAllSessions } = await import("@/lib/session-reader");
  const activeSessions = await listAllSessions();
  const archivedSessions = includeArchived ? await listAllArchivedSessions() : [];
  const sessions = [...activeSessions, ...archivedSessions].filter((session) =>
    cwdMatches(session.cwd, options.cwd),
  );
  return { sessions, scanSource: "fallback" };
}

/**
 * SDK-free JSONL scan for assistant usage entries.
 * Avoids SessionManager.open cost on large transcripts and keeps Usage smokes
 * runnable without the pi-coding-agent CJS export surface.
 */
function readUsageMessageEntries(filePath: string): {
  entries: Array<SessionMessageEntry & { message: AssistantMessage }>;
  skipped: number;
} {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { entries: [], skipped: 1 };
  }

  const entries: Array<SessionMessageEntry & { message: AssistantMessage }> = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      skipped += 1;
      continue;
    }
    const entry = parsed as SessionEntry;
    if (!isUsageMessageEntry(entry)) continue;
    entries.push(entry);
  }
  return { entries, skipped };
}

/**
 * 按日期范围聚合所有 Pi session 的 assistant usage 费用信息。
 *
 * @param options 日期范围和可选 cwd 过滤条件。
 * @returns 费用统计总览以及按日、模型、供应商、会话拆分的汇总。
 */
export async function getUsageStats(options: UsageStatsOptions): Promise<UsageStatsResult> {
  const startedAt = Date.now();
  const { sessions: matchedSessions, scanSource } = await listSessionsForUsage({
    cwd: options.cwd,
    includeArchived: options.includeArchived,
  });
  const matchedActiveSessions = matchedSessions.filter((session) => !session.archived);
  const matchedArchivedSessions = matchedSessions.filter((session) => session.archived);
  // scanned* mirrors matched* when index/cwd scoped; keeps UI counters meaningful.
  const activeSessions = matchedActiveSessions;
  const archivedSessions = matchedArchivedSessions;
  const sessions = matchedSessions;
  const records: UsageRecord[] = [];
  const matchedSubagentFilesByParent = new Map<string, Set<string>>();
  let skippedEntries = 0;

  for (const session of matchedSessions) {
    const usageFiles = listSessionUsageFiles(session.path);

    for (const source of usageFiles) {
      const { entries, skipped } = readUsageMessageEntries(source.path);
      skippedEntries += skipped;
      if (entries.length === 0 && skipped > 0) continue;

      for (const entry of entries) {
        const at = new Date(entry.timestamp).getTime();
        if (!Number.isFinite(at)) {
          skippedEntries += 1;
          continue;
        }
        if (at < options.from.getTime() || at > options.to.getTime()) continue;
        records.push({ entry, message: entry.message, session, source });
        if (source.kind === "subagent") {
          if (!matchedSubagentFilesByParent.has(session.id)) {
            matchedSubagentFilesByParent.set(session.id, new Set());
          }
          matchedSubagentFilesByParent.get(session.id)!.add(source.path);
        }
      }
    }
  }

  const totals = createTotals();
  const mainTotals = createTotals();
  const subagentTotals = createTotals();
  const byDay = new Map<string, UsageTotals>();
  const byModel = new Map<string, UsageModelSummary>();
  const byProvider = new Map<string, UsageModelSummary>();
  const bySession = new Map<string, UsageSessionSummary>();

  for (const record of records) {
    const usage = record.message.usage;
    addUsage(totals, usage);
    addUsage(record.source.kind === "subagent" ? subagentTotals : mainTotals, usage);

    const dayKey = formatLocalDate(new Date(record.entry.timestamp));
    if (!byDay.has(dayKey)) byDay.set(dayKey, createTotals());
    addUsage(byDay.get(dayKey)!, usage);

    const provider = record.message.provider || "unknown";
    const model = record.message.model || "unknown";
    const modelKey = `${provider}/${model}`;
    if (!byModel.has(modelKey)) byModel.set(modelKey, { provider, model, totals: createTotals() });
    addUsage(byModel.get(modelKey)!.totals, usage);

    if (!byProvider.has(provider)) byProvider.set(provider, { provider, model: "all", totals: createTotals() });
    addUsage(byProvider.get(provider)!.totals, usage);

    if (!bySession.has(record.session.id)) {
      bySession.set(record.session.id, {
        sessionId: record.session.id,
        cwd: record.session.cwd,
        name: record.session.name,
        firstMessage: record.session.firstMessage,
        created: record.session.created,
        modified: record.session.modified,
        totals: createTotals(),
        mainTotals: createTotals(),
        subagentTotals: createTotals(),
        subagentSessions: matchedSubagentFilesByParent.get(record.session.id)?.size ?? 0,
      });
    }
    const sessionSummary = bySession.get(record.session.id)!;
    addUsage(sessionSummary.totals, usage);
    addUsage(record.source.kind === "subagent" ? sessionSummary.subagentTotals : sessionSummary.mainTotals, usage);
  }

  return {
    from: formatLocalDate(options.from),
    to: formatLocalDate(options.to),
    scope: {
      cwd: options.cwd,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      includeArchived: options.includeArchived !== false,
    },
    totals,
    mainTotals,
    subagentTotals,
    subagentSessions: [...matchedSubagentFilesByParent.values()].reduce((sum, files) => sum + files.size, 0),
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayTotals]) => ({ date, totals: dayTotals })),
    byModel: [...byModel.values()].sort((a, b) => b.totals.cost - a.totals.cost),
    byProvider: [...byProvider.values()].sort((a, b) => b.totals.cost - a.totals.cost),
    bySession: [...bySession.values()].sort((a, b) => b.totals.cost - a.totals.cost),
    scannedSessions: sessions.length,
    matchedSessions: matchedSessions.length,
    scannedActiveSessions: activeSessions.length,
    scannedArchivedSessions: archivedSessions.length,
    matchedActiveSessions: matchedActiveSessions.length,
    matchedArchivedSessions: matchedArchivedSessions.length,
    skippedEntries,
    scanSource,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
