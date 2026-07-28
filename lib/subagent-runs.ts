import type { AgentMessage } from "./types";

/**
 * Native pi-subagents tool name plus the legacy serialized Trellis tool name.
 * Keep both so live SSE and persisted JSONL still project into the Subagent panel.
 * This is compatibility only — not active Trellis product support.
 */
export const SUBAGENT_TOOL_NAMES = new Set(["subagent", "trellis_subagent"]);

/** True for current `subagent` and legacy `trellis_subagent` tool names. */
export function isSubagentToolName(name: unknown): boolean {
  return typeof name === "string" && SUBAGENT_TOOL_NAMES.has(name);
}

export type SubagentProgressStatus = "pending" | "running" | "completed" | "failed" | "detached";
export type SubagentActivityState = "active_long_running" | "needs_attention";

export interface SubagentRecentTool {
  tool: string;
  args: string;
  endMs: number;
}

export interface SubagentProgressSnapshot {
  index: number;
  agent: string;
  status: SubagentProgressStatus;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  recentTools: SubagentRecentTool[];
  toolCount: number;
  turnCount?: number;
  tokens: number;
  durationMs: number;
  activityState?: SubagentActivityState;
  error?: string;
  failedTool?: string;
}

export interface SubagentRouting {
  source?: string;
  model?: string;
  thinking?: string;
  modality?: string;
  tier?: string;
  routerModel?: string;
  confidence?: number;
  fallbackReason?: string;
}

export interface SubagentRun {
  id: string;
  agent: string;
  task: string;
  status: "running" | "completed" | "failed";
  partialOutput: string;
  result?: string;
  startedAt: number;
  depth: number;
  parentId?: string;
  routing?: SubagentRouting;
  progress?: SubagentProgressSnapshot;
  sessionFile?: string;
  children?: SubagentRun[];
  loaded?: boolean;
}

export type SubagentResultMetadata = {
  agent?: string;
  sessionFile?: string;
  routing?: SubagentRouting;
  model?: string;
  thinking?: string;
  thinkingLevel?: string;
  exitCode?: number;
  error?: string;
  status?: string;
  success?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function routingFromResult(
  result: SubagentResultMetadata | undefined,
  source = "result",
): SubagentRouting | undefined {
  if (!result) return undefined;
  if (result.routing) return result.routing;
  if (!result.model && !result.thinking && !result.thinkingLevel) return undefined;
  return {
    source,
    model: result.model,
    thinking: result.thinking ?? result.thinkingLevel,
  };
}

function routingFromExecutionArgs(
  local: Record<string, unknown> | undefined,
  root: Record<string, unknown>,
): SubagentRouting | undefined {
  const model = typeof local?.model === "string"
    ? local.model
    : typeof root.model === "string"
      ? root.model
      : undefined;
  const thinking = typeof local?.thinking === "string"
    ? local.thinking
    : typeof root.thinking === "string"
      ? root.thinking
      : undefined;
  if (!model && !thinking) return undefined;
  return { source: "toolCall", model, thinking };
}

/** Expand one execution tool call into the rows shown by the Subagent panel. */
export function extractSubagentRuns(
  toolCallId: string,
  args: Record<string, unknown>,
  fallbackAgent: string,
  startedAt = Date.now(),
): SubagentRun[] {
  const depth = typeof args.parentDepth === "number" ? args.parentDepth : 0;
  const parentId = typeof args.parentRunId === "string" ? args.parentRunId : undefined;

  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    return args.tasks.map((item, index) => {
      const task = isRecord(item) ? item : undefined;
      return {
        id: `${toolCallId}-${index}`,
        agent: String(task?.agent ?? "?"),
        task: String(task?.task ?? task?.prompt ?? "").slice(0, 200),
        status: "running" as const,
        partialOutput: "",
        startedAt: startedAt + index,
        depth,
        parentId,
        routing: routingFromExecutionArgs(task, args),
      };
    });
  }

  if (Array.isArray(args.chain) && args.chain.length > 0) {
    return args.chain.map((item, index) => {
      const step = isRecord(item) ? item : undefined;
      return {
        id: `${toolCallId}-c${index}`,
        agent: String(step?.agent ?? "?"),
        task: String(step?.task ?? step?.prompt ?? "").slice(0, 200),
        status: "running" as const,
        partialOutput: "",
        startedAt: startedAt + index,
        depth,
        parentId,
        routing: routingFromExecutionArgs(step, args),
      };
    });
  }

  const agent = args.agent ?? fallbackAgent;
  if (!agent) return [];
  return [{
    id: toolCallId,
    agent: String(agent),
    task: String(args.task ?? args.prompt ?? "").slice(0, 200),
    status: "running",
    partialOutput: "",
    startedAt,
    depth,
    parentId,
    routing: routingFromExecutionArgs(undefined, args),
  }];
}

export function resultIndexForRun(runId: string, toolCallId: string): number | null {
  if (runId === toolCallId) return 0;
  if (runId.startsWith(`${toolCallId}-c`)) {
    const index = Number.parseInt(runId.slice(toolCallId.length + 2), 10);
    return Number.isNaN(index) ? null : index;
  }
  if (runId.startsWith(`${toolCallId}-`)) {
    const index = Number.parseInt(runId.slice(toolCallId.length + 1), 10);
    return Number.isNaN(index) ? null : index;
  }
  return null;
}

export function isSubagentResultFailure(result: SubagentResultMetadata | undefined): boolean {
  if (!result) return false;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return true;
  if (typeof result.error === "string" && result.error.trim().length > 0) return true;
  if (result.success === false || result.timedOut === true || result.cancelled === true) return true;
  return result.status === "failed" || result.status === "cancelled" || result.status === "stopped";
}

/**
 * Merge a disk snapshot with newer SSE state. Rows absent from the current
 * branch snapshot are dropped; matching live rows retain progress/output.
 */
export function mergePersistedSubagentRuns(
  persisted: SubagentRun[],
  current: SubagentRun[],
  retainCurrentOnlySince?: number,
): SubagentRun[] {
  const currentById = new Map(current.map((run) => [run.id, run]));
  const merged = persisted.map((diskRun) => {
    const liveRun = currentById.get(diskRun.id);
    if (!liveRun) return diskRun;
    const diskIsTerminal = diskRun.status !== "running";
    const liveIsTerminal = liveRun.status !== "running";
    return {
      ...diskRun,
      ...liveRun,
      status: liveIsTerminal ? liveRun.status : diskIsTerminal ? diskRun.status : liveRun.status,
      result: liveRun.result ?? diskRun.result,
      sessionFile: liveRun.sessionFile ?? diskRun.sessionFile,
      routing: liveRun.routing ?? diskRun.routing,
    };
  });
  if (retainCurrentOnlySince === undefined) return merged;
  const persistedIds = new Set(persisted.map((run) => run.id));
  return [
    ...merged,
    ...current.filter((run) => !persistedIds.has(run.id) && run.startedAt >= retainCurrentOnlySince),
  ];
}

function resultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
    .join("");
  return text || undefined;
}

/** Rebuild panel rows from the tool calls/results persisted in session JSONL. */
export function parsePersistedSubagentRuns(messages: AgentMessage[]): SubagentRun[] {
  const runs: SubagentRun[] = [];
  const pending = new Map<string, SubagentRun[]>();

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const toolName = typeof block.toolName === "string" ? block.toolName : "";
        if (!isSubagentToolName(toolName)) continue;
        const input = isRecord(block.input) ? block.input : {};
        if ("action" in input) continue;
        const toolCallId = typeof block.toolCallId === "string" ? block.toolCallId : "";
        if (!toolCallId) continue;
        const created = extractSubagentRuns(toolCallId, input, toolName, message.timestamp);
        if (created.length === 0) continue;
        runs.push(...created);
        pending.set(toolCallId, created);
      }
      continue;
    }

    if (message.role !== "toolResult") continue;
    const matched = pending.get(message.toolCallId);
    if (!matched) continue;
    if (message.toolName && !isSubagentToolName(message.toolName)) continue;
    pending.delete(message.toolCallId);

    const rawMessage = message as unknown as Record<string, unknown>;
    const details = isRecord(rawMessage.details) ? rawMessage.details : undefined;
    const results = Array.isArray(details?.results) ? details.results : [];
    let fallbackRouting = isRecord(details?.routing) ? details.routing as SubagentRouting : undefined;
    if (!fallbackRouting && Array.isArray(details?.runs)) {
      const routedRun = details.runs.find((run) => isRecord(run) && isRecord(run.routing));
      if (isRecord(routedRun) && isRecord(routedRun.routing)) {
        fallbackRouting = routedRun.routing as SubagentRouting;
      }
    }
    const text = resultText(message.content);

    for (const run of matched) {
      const index = resultIndexForRun(run.id, message.toolCallId);
      const rawMetadata = index === null ? undefined : results[index];
      const metadata = isRecord(rawMetadata) ? rawMetadata as SubagentResultMetadata : undefined;
      run.status = message.isError || isSubagentResultFailure(metadata) ? "failed" : "completed";
      run.result = text;
      run.sessionFile = metadata?.sessionFile;
      run.routing = routingFromResult(metadata) ?? fallbackRouting ?? run.routing;
    }
  }

  return runs;
}
