"use client";

import { useState, useCallback, useRef, useEffect, useReducer } from "react";
import type {
  AgentMessage,
  ExtensionDialogRequest,
  ExtensionStatusItem,
  ExtensionToastItem,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ToolEntry, ToolPreset } from "@/components/ToolPanel";
import {
  extractSubagentRuns,
  isSubagentResultFailure,
  mergePersistedSubagentRuns,
  parsePersistedSubagentRuns,
  resultIndexForRun,
  routingFromResult,
  type SubagentActivityState,
  type SubagentProgressSnapshot,
  type SubagentProgressStatus,
  type SubagentRecentTool,
  type SubagentResultMetadata,
  type SubagentRun,
} from "@/lib/subagent-runs";

export type {
  SubagentActivityState,
  SubagentProgressSnapshot,
  SubagentProgressStatus,
  SubagentRecentTool,
  SubagentRun,
} from "@/lib/subagent-runs";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

const AUTO_SCROLL_BOTTOM_THRESHOLD = 96;

function isNearScrollBottom(container: HTMLDivElement): boolean {
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= AUTO_SCROLL_BOTTOM_THRESHOLD;
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

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

function isRecord(val: unknown): val is Record<string, unknown> {
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

function latestControlActivityForRun(
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

function mapProgressToRunStatus(
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

function readPartialRouting(details: Record<string, unknown> | undefined): SubagentRun["routing"] | undefined {
  if (!details) return undefined;
  if (isRecord(details.routing)) return details.routing as SubagentRun["routing"];
  const runs = details.runs;
  if (!Array.isArray(runs)) return undefined;
  for (const run of runs) {
    if (isRecord(run) && isRecord(run.routing)) return run.routing as SubagentRun["routing"];
  }
  return undefined;
}

function liveResultForRun(
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

type ExtensionUiRequestEvent = AgentEvent & {
  id: string;
  method: string;
  title?: string;
  message?: string;
  notifyType?: "info" | "warning" | "error";
  options?: string[];
  placeholder?: string;
  prefill?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  titleText?: string;
  text?: string;
  timeout?: number;
};

const EXTENSION_TOAST_TTL_MS = 5000;
const SUBAGENT_UI_FLUSH_MS = 150;

function toDialogRequest(event: ExtensionUiRequestEvent): ExtensionDialogRequest | null {
  if (event.method === "confirm") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "confirm",
      title: event.title ?? "Confirm",
      message: event.message ?? "",
      timeout: event.timeout,
    };
  }
  if (event.method === "select") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "select",
      title: event.title ?? "Select an option",
      options: event.options ?? [],
      timeout: event.timeout,
    };
  }
  if (event.method === "input") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "input",
      title: event.title ?? "Input",
      placeholder: event.placeholder,
      timeout: event.timeout,
    };
  }
  if (event.method === "editor") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "editor",
      title: event.title ?? "Edit",
      prefill: event.prefill,
      timeout: event.timeout,
    };
  }
  return null;
}

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export type OnSubagentChange = (runs: SubagentRun[]) => void;

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSubagentChange?: OnSubagentChange;
  /** Open/reuse Web Terminal when interactive_shell tool starts (avoids TUI overlay dependency). */
  onInteractiveShellRequest?: (request: { cwd: string; command?: string; reason?: string }) => void;
  autoScrollEnabled?: boolean;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addImages: (files: File[]) => void;
  addFiles: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

interface ModelMetadata {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string }[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}

const MODEL_METADATA_CACHE_LIMIT = 8;
const modelMetadataCache = new Map<string, Promise<ModelMetadata>>();

function loadModelMetadata(cwd: string, refreshGeneration: number): Promise<ModelMetadata> {
  const cacheKey = `${refreshGeneration}\0${cwd}`;
  const cached = modelMetadataCache.get(cacheKey);
  if (cached) {
    modelMetadataCache.delete(cacheKey);
    modelMetadataCache.set(cacheKey, cached);
    return cached;
  }

  const params = new URLSearchParams({ cwd });
  if (refreshGeneration > 0) params.set("refresh", "1");
  const request = fetch(`/api/models?${params.toString()}`).then(async (response) => {
    const data = await response.json() as Partial<ModelMetadata> & { error?: string };
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    return {
      models: data.models ?? {},
      modelList: data.modelList ?? [],
      defaultModel: data.defaultModel ?? null,
      thinkingLevels: data.thinkingLevels ?? {},
      thinkingLevelMaps: data.thinkingLevelMaps ?? {},
    };
  });

  modelMetadataCache.set(cacheKey, request);
  while (modelMetadataCache.size > MODEL_METADATA_CACHE_LIMIT) {
    const oldestKey = modelMetadataCache.keys().next().value;
    if (oldestKey === undefined) break;
    modelMetadataCache.delete(oldestKey);
  }

  void request.catch(() => {
    if (modelMetadataCache.get(cacheKey) === request) modelMetadataCache.delete(cacheKey);
  });
  return request;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSubagentChange,
    onInteractiveShellRequest,
    chatInputRef,
    autoScrollEnabled = true,
  } = opts;
  const onInteractiveShellRequestRef = useRef(onInteractiveShellRequest);
  onInteractiveShellRequestRef.current = onInteractiveShellRequest;
  const sessionCwdRef = useRef<string | null>(session?.cwd ?? newSessionCwd);
  sessionCwdRef.current = session?.cwd ?? newSessionCwd;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("all");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const subagentRunsRef = useRef<SubagentRun[]>([]);
  const subagentFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subagentChangeRef = useRef(onSubagentChange);
  subagentChangeRef.current = onSubagentChange;
  const [sessionChangesRefreshKey, setSessionChangesRefreshKey] = useState(0);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionDialogRequest | null>(null);
  const [extensionToasts, setExtensionToasts] = useState<ExtensionToastItem[]>([]);

  const eventSourceRef = useRef<EventSource | null>(null);
  const extensionStatusMapRef = useRef<Map<string, string>>(new Map());
  const extensionWidgetMapRef = useRef<Map<string, ExtensionWidgetItem>>(new Map());
  const extensionDialogIdRef = useRef<string | null>(null);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const agentRunningRef = useRef(false);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const autoScrollStickyRef = useRef(true);
  const sessionLoadRequestRef = useRef(0);
  const contextLoadRequestRef = useRef(0);

  const setNewSessionModel = opts.setNewSessionModel ?? setNewSessionModelState;
  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const prevRunsJsonRef = useRef("");
  const flushSubagentRuns = useCallback(() => {
    subagentFlushTimerRef.current = null;
    const runs = subagentRunsRef.current;
    const json = serializeSubagentRunsForFlush(runs);
    if (json === prevRunsJsonRef.current) return;
    prevRunsJsonRef.current = json;
    subagentChangeRef.current?.(runs);
  }, []);
  const scheduleSubagentFlush = useCallback(() => {
    if (subagentFlushTimerRef.current) return;
    subagentFlushTimerRef.current = setTimeout(flushSubagentRuns, SUBAGENT_UI_FLUSH_MS);
  }, [flushSubagentRuns]);
  const updateSubagentRuns = useCallback((update: (runs: SubagentRun[]) => SubagentRun[]) => {
    const current = subagentRunsRef.current;
    const next = update(current);
    if (next === current) return;
    subagentRunsRef.current = next;
    scheduleSubagentFlush();
  }, [scheduleSubagentFlush]);

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  const sessionStats = (() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  })();

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    const requestId = ++sessionLoadRequestRef.current;
    const requestedAt = Date.now();
    ++contextLoadRequestRef.current;
    try {
      if (showLoading) setLoading(true);
      const url = includeState
        ? `/api/sessions/${encodeURIComponent(sid)}?includeState`
        : `/api/sessions/${encodeURIComponent(sid)}`;
      const res = await fetch(url);
      if (requestId !== sessionLoadRequestRef.current || sid !== sessionIdRef.current) return null;
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData & { agentState?: { running: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean; contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string; thinkingLevel?: string } } };
      if (requestId !== sessionLoadRequestRef.current || sid !== sessionIdRef.current) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      updateSubagentRuns((current) => mergePersistedSubagentRuns(
        parsePersistedSubagentRuns(d.context.messages),
        current,
        requestedAt,
      ));
      setCurrentModelOverride(null);
      setError(null);
      // If no live agent state, fall back to thinking level from session file
      if (!d.agentState?.state?.thinkingLevel && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }
      return d.agentState ?? null;
    } catch (e) {
      if (requestId === sessionLoadRequestRef.current && sid === sessionIdRef.current) {
        setError(String(e));
      }
      return null;
    } finally {
      if (showLoading && requestId === sessionLoadRequestRef.current) setLoading(false);
    }
  }, [updateSubagentRuns]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    ++sessionLoadRequestRef.current;
    const requestId = ++contextLoadRequestRef.current;
    try {
      const url = leafId
        ? `/api/sessions/${encodeURIComponent(sid)}/context?leafId=${encodeURIComponent(leafId)}`
        : `/api/sessions/${encodeURIComponent(sid)}/context`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[] } };
      if (requestId !== contextLoadRequestRef.current || sid !== sessionIdRef.current) return;
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      updateSubagentRuns((current) => mergePersistedSubagentRuns(
        parsePersistedSubagentRuns(d.context.messages),
        current,
      ));
    } catch (e) {
      if (requestId === contextLoadRequestRef.current) console.error("Failed to load context:", e);
    }
  }, [updateSubagentRuns]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/components/ToolPanel");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const connectEvents = useCallback((sid: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (eventSourceRef.current === es && agentRunningRef.current) {
        es.close();
        eventSourceRef.current = null;
        setTimeout(() => {
          if (agentRunningRef.current) connectEvents(sid);
        }, 1000);
      }
    };
  }, []);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const clearExtensionChrome = useCallback(() => {
    extensionStatusMapRef.current.clear();
    extensionWidgetMapRef.current.clear();
    setExtensionStatuses([]);
    setExtensionWidgets([]);
    setExtensionDialog(null);
    extensionDialogIdRef.current = null;
    for (const timer of toastTimersRef.current.values()) clearTimeout(timer);
    toastTimersRef.current.clear();
    setExtensionToasts([]);
  }, []);

  const dismissExtensionToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setExtensionToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const respondExtensionDialog = useCallback((response: {
    id: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
  }) => {
    if (extensionDialogIdRef.current !== response.id) return;
    extensionDialogIdRef.current = null;
    setExtensionDialog(null);
    const sid = sessionIdRef.current;
    if (!sid) return;
    const payload: Record<string, unknown> = { type: "extension_ui_response", id: response.id };
    if (response.cancelled) payload.cancelled = true;
    if (response.confirmed !== undefined) payload.confirmed = response.confirmed;
    if (response.value !== undefined) payload.value = response.value;
    sendAgentCommand(sid, payload).catch((error) => {
      console.error("Failed to respond to extension UI request:", error);
    });
  }, []);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "extension_ui_request": {
        const request = event as ExtensionUiRequestEvent;

        if (request.method === "notify") {
          const toast: ExtensionToastItem = {
            id: request.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            message: request.message ?? "",
            notifyType: request.notifyType ?? "info",
            createdAt: Date.now(),
          };
          setExtensionToasts((prev) => [...prev, toast].slice(-6));
          const timer = setTimeout(() => dismissExtensionToast(toast.id), EXTENSION_TOAST_TTL_MS);
          toastTimersRef.current.set(toast.id, timer);
          break;
        }

        const dialog = toDialogRequest(request);
        if (dialog) {
          // If a previous dialog is still open, cancel it so the bridge cannot hang forever.
          if (extensionDialogIdRef.current && extensionDialogIdRef.current !== dialog.id) {
            const sid = sessionIdRef.current;
            if (sid) {
              sendAgentCommand(sid, {
                type: "extension_ui_response",
                id: extensionDialogIdRef.current,
                cancelled: true,
              }).catch(() => {});
            }
          }
          extensionDialogIdRef.current = dialog.id;
          setExtensionDialog(dialog);
          break;
        }

        if (request.method === "setTitle" && typeof request.title === "string") {
          document.title = request.title;
          break;
        }
        if (request.method === "set_editor_text" && typeof request.text === "string") {
          chatInputRef?.current?.insertIfEmpty(request.text);
          break;
        }
        if (request.method === "setStatus") {
          const key = request.statusKey;
          if (!key) break;
          const text = request.statusText;
          if (text === undefined || text === "") {
            extensionStatusMapRef.current.delete(key);
          } else {
            extensionStatusMapRef.current.set(key, text);
          }
          setExtensionStatuses(
            Array.from(extensionStatusMapRef.current.entries()).map(([statusKey, statusText]) => ({
              key: statusKey,
              text: statusText,
            })),
          );
          break;
        }
        if (request.method === "setWidget") {
          const key = request.widgetKey;
          if (!key) break;
          // Defense-in-depth: bridge already drops these TUI HUDs.
          if (key === "subagent-fleet-status" || key === "subagent-async") {
            extensionWidgetMapRef.current.delete(key);
            setExtensionWidgets(Array.from(extensionWidgetMapRef.current.values()));
            break;
          }
          if (request.widgetLines === undefined) {
            extensionWidgetMapRef.current.delete(key);
          } else {
            extensionWidgetMapRef.current.set(key, {
              key,
              lines: request.widgetLines,
              placement: request.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
            });
          }
          setExtensionWidgets(Array.from(extensionWidgetMapRef.current.values()));
          break;
        }
        break;
      }
      case "extension_error":
        console.error("Pi extension error", event);
        break;
      case "agent_start":
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "prompt_settled":
        // Extension slash commands return from prompt() without agent_end. Normal model turns
        // also settle after agent_end; clearing again here is harmless.
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
        break;
      case "prompt_error":
        setAgentRunning(false);
        setAgentPhase(null);
        dispatch({ type: "end" });
        console.error("Prompt failed", event.error ?? event);
        break;
      case "agent_end":
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: { contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null; systemPrompt?: string } }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "message_start":
      case "message_update": {
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role !== "user") {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const isSubagent = name === "subagent" || name === "trellis_subagent";
        if (isSubagent) {
          const args = event.args as Record<string, unknown> | undefined;
          // Skip management actions (list, get, doctor, etc.) — only track execution calls
          if (args && !("action" in args)) {
            const runs = extractSubagentRuns(id, args, name);
            if (runs.length > 0) {
              updateSubagentRuns((prev) => {
                const existing = new Set(prev.map((run) => run.id));
                const additions = runs.filter((run) => !existing.has(run.id));
                return additions.length > 0 ? [...prev, ...additions] : prev;
              });
            }
          }
        }
        if (name === "interactive_shell") {
          const args = (event.args ?? event.input ?? {}) as Record<string, unknown>;
          // Ignore pure status/query calls against an existing session id.
          const isQueryOnly = Boolean(args.sessionId || args.listBackground || args.monitorStatus || args.monitorEvents || args.kill || args.attach);
          if (!isQueryOnly) {
            const command = typeof args.command === "string" ? args.command : undefined;
            const cwdArg = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined;
            const reason = typeof args.reason === "string" ? args.reason : undefined;
            const targetCwd = cwdArg ?? sessionCwdRef.current ?? undefined;
            if (targetCwd) {
              onInteractiveShellRequestRef.current?.({
                cwd: targetCwd,
                command,
                reason,
              });
            }
          }
        }
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        const updateId = event.toolCallId as string;
        const partial = isRecord(event.partialResult) ? event.partialResult : undefined;
        const content = Array.isArray(partial?.content) ? partial.content : [];
        const text = content
          .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
          .join("");
        const details = isRecord(partial?.details) ? partial.details : undefined;
        const routing = readPartialRouting(details);
        const progressList = normalizeSubagentProgressList(details?.progress);
        const controlEvents = details?.controlEvents;
        if (!text && !routing && progressList.length === 0 && !Array.isArray(controlEvents)) break;

        updateSubagentRuns((prev) => {
          let changed = false;
          const next = prev.map((r) => {
            const related = r.id === updateId || r.id.startsWith(`${updateId}-`);
            if (!related) return r;

            let updated = r;
            if (text && text !== updated.partialOutput) {
              // pi-subagents publishes the current full output snapshot, not a text delta.
              updated = { ...updated, partialOutput: text };
              changed = true;
            }
            const liveResult = liveResultForRun(details?.results, updated, updateId);
            const liveRouting = routingFromResult(liveResult, "liveResult");
            const nextRouting = liveRouting ?? routing;
            if (nextRouting) {
              updated = { ...updated, routing: nextRouting };
              changed = true;
            }

            const matched = matchProgressForRun(updated, updateId, progressList);
            if (matched) {
              let progress = matched;
              if (!progress.activityState) {
                const fromControl = latestControlActivityForRun(updated, updateId, controlEvents);
                if (fromControl) progress = { ...progress, activityState: fromControl };
              }
              const status = mapProgressToRunStatus(updated.status, progress.status);
              updated = { ...updated, progress, status };
              changed = true;
            } else if (updated.progress && !updated.progress.activityState) {
              const fromControl = latestControlActivityForRun(updated, updateId, controlEvents);
              if (fromControl) {
                updated = {
                  ...updated,
                  progress: { ...updated.progress, activityState: fromControl },
                };
                changed = true;
              }
            }

            return updated;
          });
          return changed ? next : prev;
        });
        break;
      }
      case "tool_execution_end": {
        const endId = event.toolCallId as string;
        const isError = !!event.isError;
        const resultText =
          (event.result as { content?: { text?: string }[] } | undefined)
            ?.content?.map((c) => c.text ?? "")
            .join("") ?? undefined;
        // Extract sessionFile/routing metadata from subagent tool-call details.
        const details = (event.result as { details?: { results?: SubagentResultMetadata[]; routing?: SubagentRun["routing"]; runs?: { routing?: SubagentRun["routing"] }[] } } | undefined)?.details;
        const fallbackRouting = details?.routing ?? details?.runs?.find((run) => run.routing)?.routing;
        updateSubagentRuns((prev) =>
          prev.map((r) => {
            const resultIndex = resultIndexForRun(r.id, endId);
            if (resultIndex !== null) {
              const result = details?.results?.[resultIndex];
              const sessionFile = result?.sessionFile;
              const routing = routingFromResult(result) ?? fallbackRouting;
              return { ...r, status: isError || isSubagentResultFailure(result) ? "failed" : "completed", result: resultText, partialOutput: "", sessionFile: sessionFile ?? r.sessionFile, routing: routing ?? r.routing };
            }
            return r;
          }),
        );
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== endId);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
        } else if (!event.aborted) {
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "session_file_changes_update":
        if (event.sessionId === sessionIdRef.current) {
          setSessionChangesRefreshKey((value) => value + 1);
        }
        break;
    }
  }, [chatInputRef, dismissExtensionToast, loadSession, onAgentEnd, updateSubagentRuns]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunning) return;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    // Mark busy immediately so the send button disables, but do not show
    // "Waiting for model..." until agent_start — extension slash commands never start the model.
    setAgentRunning(true);
    setAgentPhase(null);
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        if (selectedModel) setPendingModel(selectedModel);
        const res = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cwd: newSessionCwd,
            type: "prompt",
            message,
            toolPreset,
            ...(piImages?.length ? { images: piImages } : {}),
            ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
            ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json() as { sessionId: string };
        const realId = result.sessionId;
        sessionIdRef.current = realId;
        connectEvents(realId);
        onSessionCreated?.({
          id: realId,
          path: "",
          cwd: newSessionCwd,
          name: undefined,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 1,
          firstMessage: message,
        });
      } else if (session) {
        connectEvents(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, agentRunning, connectEvents, onSessionCreated]);

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    try {
      await sendAgentCommand(sid, { type: "compact" });
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: `[steer] ${message}`, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
    }
  }, []);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setMessages((prev) => [...prev, { role: "user", content: message, timestamp: Date.now() } as AgentMessage]);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
    }
  }, []);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, []);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    setToolPresetState(preset);
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolPreset: preset });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior });
    }
    autoScrollStickyRef.current = true;
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    container.scrollTo({ top: elAbsTop - 16, behavior: "smooth" });
  }, []);

  // Load session on mount — keep SSE connected so extension commands/UI are not dropped
  // in the window between send() and EventSource onopen.
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      connectEvents(session.id);
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming) {
            setAgentRunning(true);
            setAgentPhase({ kind: "waiting_model" });
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
        }
      });
    }
    const toastTimers = toastTimersRef.current;
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      for (const timer of toastTimers.values()) clearTimeout(timer);
      toastTimers.clear();
      if (subagentFlushTimerRef.current) {
        clearTimeout(subagentFlushTimerRef.current);
        subagentFlushTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  const hasMessages = messages.length > 0;

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled;
    if (!autoScrollEnabled) return;
    autoScrollStickyRef.current = true;
    const frame = requestAnimationFrame(() => scrollToBottom("smooth"));
    return () => cancelAnimationFrame(frame);
  }, [autoScrollEnabled, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (!autoScrollEnabledRef.current) return;
      autoScrollStickyRef.current = isNearScrollBottom(container);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMessages]);

  useEffect(() => {
    if (!hasMessages) return;

    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      if (autoScrollEnabledRef.current) {
        autoScrollStickyRef.current = true;
        scrollToBottom("smooth");
      } else {
        scrollUserMsgToTop();
      }
      return;
    }

    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
      return;
    }

    if (autoScrollEnabledRef.current && autoScrollStickyRef.current) {
      scrollToBottom(agentRunningRef.current ? "auto" : "smooth");
    }
  }, [hasMessages, messages.length, agentRunning, streamState.isStreaming, streamState.streamingMessage, autoScrollEnabled, scrollToBottom, scrollUserMsgToTop]);

  // Model metadata is workspace-scoped because project extensions and settings can
  // change both the available models and the default selection.
  useEffect(() => {
    const cwd = session?.cwd ?? newSessionCwd;
    if (!cwd) return;

    let active = true;
    const refreshGeneration = modelsRefreshKey ?? 0;
    setModelNames({});
    setModelList([]);
    setModelThinkingLevels({});
    setModelThinkingLevelMaps({});

    loadModelMetadata(cwd, refreshGeneration)
      .then((metadata) => {
        if (!active) return;
        setModelNames(metadata.models);
        setModelList(metadata.modelList);
        setModelThinkingLevels(metadata.thinkingLevels);
        setModelThinkingLevelMaps(metadata.thinkingLevelMaps);
        if (isNew && metadata.modelList.length > 0) {
          const match = metadata.defaultModel && metadata.modelList.find(
            (model) => model.id === metadata.defaultModel?.modelId && model.provider === metadata.defaultModel.provider,
          );
          const selected = match
            ? { provider: match.provider, modelId: match.id }
            : { provider: metadata.modelList[0].provider, modelId: metadata.modelList[0].id };
          setNewSessionModel(selected);
        }
      })
      .catch(() => {
        if (!active) return;
        setModelNames({});
        setModelList([]);
        setModelThinkingLevels({});
        setModelThinkingLevelMaps({});
      });

    return () => { active = false; };
  }, [isNew, modelsRefreshKey, newSessionCwd, session?.cwd, setNewSessionModel]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, currentModel, displayModel, sessionStats,
    agentPhase, subagentRuns: subagentRunsRef.current,
    sessionChangesRefreshKey,
    extensionStatuses,
    extensionWidgets,
    extensionDialog,
    extensionToasts,
    isNew,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    respondExtensionDialog,
    dismissExtensionToast,
    clearExtensionChrome,
    // Subscriptions
    handleAgentEventRef,
  };
}
