import {
  resultIndexForRun,
  type SubagentActivityState,
  type SubagentProgressSnapshot,
  type SubagentProgressStatus,
  type SubagentRecentTool,
  type SubagentResultMetadata,
  type SubagentRun,
} from "./subagent-runs";

/**
 * Client-side normalization and matching for live subagent progress SSE details.
 * Kept SDK-free and pure so smokes can import without React.
 */

const SUBAGENT_PROGRESS_STATUSES = new Set<SubagentProgressStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "detached",
]);
const SUBAGENT_ACTIVITY_STATES = new Set<SubagentActivityState>([
  "active_long_running",
  "needs_attention",
]);
const MAX_PROGRESS_RECENT_TOOLS = 20;
const MAX_PROGRESS_TOOL_NAME_CHARS = 120;
const MAX_PROGRESS_ARGS_CHARS = 240;
const MAX_PROGRESS_ERROR_CHARS = 400;

export function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function readFiniteNumber(val: unknown): number | undefined {
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function readNonNegativeInt(val: unknown): number | undefined {
  const n = readFiniteNumber(val);
  if (n === undefined || n < 0 || !Number.isInteger(n)) return undefined;
  return n;
}

function readBoundedString(val: unknown, maxChars: number): string | undefined {
  if (typeof val !== "string") return undefined;
  if (val.length <= maxChars) return val;
  return val.slice(0, maxChars);
}

function normalizeRecentTools(raw: unknown): SubagentRecentTool[] {
  if (!Array.isArray(raw)) return [];
  const tools: SubagentRecentTool[] = [];
  for (const item of raw) {
    if (tools.length >= MAX_PROGRESS_RECENT_TOOLS) break;
    if (!isRecord(item)) continue;
    const tool = readBoundedString(item.tool, MAX_PROGRESS_TOOL_NAME_CHARS);
    if (!tool) continue;
    const args = readBoundedString(item.args, MAX_PROGRESS_ARGS_CHARS) ?? "";
    const endMs = readFiniteNumber(item.endMs);
    tools.push({
      tool,
      args,
      endMs: endMs !== undefined && endMs >= 0 ? endMs : 0,
    });
  }
  return tools;
}

/** Normalize one external progress entry; invalid entries return null. */
export function normalizeSubagentProgressSnapshot(raw: unknown): SubagentProgressSnapshot | null {
  if (!isRecord(raw)) return null;
  const index = readNonNegativeInt(raw.index);
  const agent = readBoundedString(raw.agent, MAX_PROGRESS_TOOL_NAME_CHARS);
  const statusRaw = typeof raw.status === "string" ? raw.status : "";
  if (index === undefined || !agent || !SUBAGENT_PROGRESS_STATUSES.has(statusRaw as SubagentProgressStatus)) {
    return null;
  }
  const status = statusRaw as SubagentProgressStatus;
  const tokensRaw = readFiniteNumber(raw.tokens);
  const durationRaw = readFiniteNumber(raw.durationMs);
  const activityRaw = typeof raw.activityState === "string" ? raw.activityState : "";
  const activityState = SUBAGENT_ACTIVITY_STATES.has(activityRaw as SubagentActivityState)
    ? (activityRaw as SubagentActivityState)
    : undefined;
  const currentToolStartedAt = readFiniteNumber(raw.currentToolStartedAt);
  const turnCount = readNonNegativeInt(raw.turnCount);

  return {
    index,
    agent,
    status,
    currentTool: readBoundedString(raw.currentTool, MAX_PROGRESS_TOOL_NAME_CHARS),
    currentToolArgs: readBoundedString(raw.currentToolArgs, MAX_PROGRESS_ARGS_CHARS),
    currentToolStartedAt:
      currentToolStartedAt !== undefined && currentToolStartedAt >= 0 ? currentToolStartedAt : undefined,
    recentTools: normalizeRecentTools(raw.recentTools),
    toolCount: readNonNegativeInt(raw.toolCount) ?? 0,
    turnCount,
    tokens: tokensRaw !== undefined && tokensRaw >= 0 ? Math.floor(tokensRaw) : 0,
    durationMs: durationRaw !== undefined && durationRaw >= 0 ? durationRaw : 0,
    activityState,
    error: readBoundedString(raw.error, MAX_PROGRESS_ERROR_CHARS),
    failedTool: readBoundedString(raw.failedTool, MAX_PROGRESS_TOOL_NAME_CHARS),
  };
}

/** Normalize a progress array; skips malformed entries. */
export function normalizeSubagentProgressList(raw: unknown): SubagentProgressSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: SubagentProgressSnapshot[] = [];
  for (const item of raw) {
    const snapshot = normalizeSubagentProgressSnapshot(item);
    if (snapshot) out.push(snapshot);
  }
  return out;
}

function uniqueProgressByAgent(
  progressList: SubagentProgressSnapshot[],
  agent: string,
): SubagentProgressSnapshot | null {
  const matches = progressList.filter((item) => item.agent === agent);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Match a progress snapshot to one local run.
 * Prefer index (single/parallel/chain id forms); agent-name fallback only when unique.
 */
export function matchProgressForRun(
  run: Pick<SubagentRun, "id" | "agent">,
  toolCallId: string,
  progressList: SubagentProgressSnapshot[],
): SubagentProgressSnapshot | null {
  if (progressList.length === 0) return null;
  const related = run.id === toolCallId || run.id.startsWith(`${toolCallId}-`);
  if (!related) return null;
  // Chain parallel groups are represented by an unknown placeholder run; do not
  // attach one flattened child snapshot to that synthetic row.
  if (run.agent === "?") return null;

  // Single-agent run id equals the tool call id.
  if (run.id === toolCallId) {
    const byZero = progressList.find((item) => item.index === 0);
    if (byZero) return byZero;
    if (progressList.length === 1) return progressList[0];
    return uniqueProgressByAgent(progressList, run.agent);
  }

  const runIndex = resultIndexForRun(run.id, toolCallId);
  if (runIndex !== null) {
    const byIndex = progressList.find((item) => item.index === runIndex);
    if (byIndex) return byIndex;
  }

  return uniqueProgressByAgent(progressList, run.agent);
}

export function hasUrgentSubagentUpdate(
  progressList: SubagentProgressSnapshot[],
  controlEvents: unknown,
): boolean {
  if (progressList.some((item) => item.status === "failed" || item.activityState !== undefined)) {
    return true;
  }
  if (!Array.isArray(controlEvents)) return false;
  return controlEvents.some((item) => isRecord(item) && (
    item.to === "needs_attention"
    || item.to === "active_long_running"
    || item.status === "failed"
    || item.status === "timeout"
  ));
}

export function latestControlActivityForRun(
  run: Pick<SubagentRun, "id" | "agent">,
  toolCallId: string,
  controlEvents: unknown,
): SubagentActivityState | undefined {
  if (!Array.isArray(controlEvents)) return undefined;
  const runIndex = resultIndexForRun(run.id, toolCallId);

  type Candidate = { ts: number; to: SubagentActivityState; byIndex: boolean; agent?: string };
  const candidates: Candidate[] = [];

  for (const event of controlEvents) {
    if (!isRecord(event)) continue;
    const toRaw = typeof event.to === "string" ? event.to : "";
    if (!SUBAGENT_ACTIVITY_STATES.has(toRaw as SubagentActivityState)) continue;
    const to = toRaw as SubagentActivityState;
    const eventIndex = readNonNegativeInt(event.index);
    const eventAgent = typeof event.agent === "string" ? event.agent : undefined;
    const ts = readFiniteNumber(event.ts) ?? 0;

    if (eventIndex !== undefined && runIndex !== null && eventIndex === runIndex) {
      candidates.push({ ts, to, byIndex: true, agent: eventAgent });
      continue;
    }
    // Agent-name fallback only for single-agent runs (id === toolCallId) to avoid
    // cross-writing parallel/chain siblings that share an agent name.
    if (
      eventIndex === undefined
      && run.id === toolCallId
      && eventAgent
      && eventAgent === run.agent
    ) {
      candidates.push({ ts, to, byIndex: false, agent: eventAgent });
    }
  }

  if (candidates.length === 0) return undefined;

  const indexHits = candidates.filter((c) => c.byIndex);
  if (indexHits.length > 0) {
    return indexHits.reduce((best, cur) => (cur.ts >= best.ts ? cur : best)).to;
  }

  // Agent-name fallback only when exactly one agent-only candidate family exists for this agent.
  const agentHits = candidates.filter((c) => !c.byIndex && c.agent === run.agent);
  if (agentHits.length === 0) return undefined;
  return agentHits.reduce((best, cur) => (cur.ts >= best.ts ? cur : best)).to;
}

export function mapProgressToRunStatus(
  current: SubagentRun["status"],
  progressStatus: SubagentProgressStatus,
): SubagentRun["status"] {
  // Never regress a terminal top-level status from a later non-terminal snapshot.
  if (current === "completed" || current === "failed") return current;
  if (progressStatus === "completed") return "completed";
  if (progressStatus === "failed") return "failed";
  // pending / running / detached stay "running" at the top-level three-state.
  return "running";
}

export function readPartialRouting(details: Record<string, unknown> | undefined): SubagentRun["routing"] | undefined {
  if (!details) return undefined;
  if (isRecord(details.routing)) return details.routing as SubagentRun["routing"];
  const runs = details.runs;
  if (!Array.isArray(runs)) return undefined;
  for (const run of runs) {
    if (isRecord(run) && isRecord(run.routing)) return run.routing as SubagentRun["routing"];
  }
  return undefined;
}

export function liveResultForRun(
  rawResults: unknown,
  run: Pick<SubagentRun, "id" | "agent">,
  toolCallId: string,
): SubagentResultMetadata | undefined {
  if (!Array.isArray(rawResults)) return undefined;
  const results = rawResults.filter(isRecord);
  const runIndex = resultIndexForRun(run.id, toolCallId);
  if (runIndex !== null) {
    const indexed = results.find((result) => {
      const progress = isRecord(result.progress) ? result.progress : undefined;
      return readNonNegativeInt(progress?.index) === runIndex;
    });
    if (indexed) return indexed as SubagentResultMetadata;
  }
  if (run.id === toolCallId && results.length === 1) {
    return results[0] as SubagentResultMetadata;
  }
  const byAgent = results.filter((result) => result.agent === run.agent);
  return byAgent.length === 1 ? byAgent[0] as SubagentResultMetadata : undefined;
}

/** Lightweight projection used to decide whether AppShell should re-render the panel. */
export function serializeSubagentRunsForFlush(runs: SubagentRun[]): string {
  return JSON.stringify(
    runs.map((r) => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      // Lightweight end-event markers: do not serialize full result/partialOutput text.
      // Needed when progress already set completed/failed and tool_execution_end only
      // attaches authoritative result/sessionFile/routing without changing status.
      hasResult: Boolean(r.result),
      sessionFile: r.sessionFile ?? null,
      routing: r.routing
        ? {
            source: r.routing.source,
            model: r.routing.model,
            thinking: r.routing.thinking,
          }
        : undefined,
      progress: r.progress
        ? {
            status: r.progress.status,
            currentTool: r.progress.currentTool,
            currentToolArgs: r.progress.currentToolArgs,
            toolCount: r.progress.toolCount,
            turnCount: r.progress.turnCount,
            tokens: r.progress.tokens,
            durationMs: r.progress.durationMs,
            activityState: r.progress.activityState,
            error: r.progress.error,
            recentTools: r.progress.recentTools.map((t) => `${t.tool}\0${t.args}\0${t.endMs}`),
          }
        : undefined,
    })),
  );
}

