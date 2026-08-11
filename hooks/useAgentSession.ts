"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import { useI18n } from "@/components/I18nProvider";
import type {
  AgentMessage,
  SessionBillingStats,
  SessionInfo,
  SessionPerformanceSummary,
  SessionTreeNode,
} from "@/lib/types";
import { useExtensionUi } from "@/hooks/useExtensionUi";
import {
  hasUrgentSubagentUpdate,
  isRecord,
  latestControlActivityForRun,
  liveResultForRun,
  mapProgressToRunStatus,
  matchProgressForRun,
  normalizeSubagentProgressList,
  readPartialRouting,
  serializeSubagentRunsForFlush,
} from "@/lib/subagent-progress";
import { normalizeToolCalls } from "@/lib/normalize";
import { sendAgentCommand } from "@/lib/agent-client";
import { getAgentLifecycleDirective } from "@/lib/agent-lifecycle";
import {
  buildChatAgentFailure,
  type ChatProviderErrorCategory,
} from "@/lib/chat-provider-errors";
import type { ErrorCode } from "@/lib/i18n/error-codes";
import { getChatSendBlockReason } from "@/lib/chat-send-readiness";
import type { ToolEntry, ToolPreset } from "@/components/ToolPanel";
import {
  boundSubagentOutput,
  extractSubagentRuns,
  isSubagentResultFailure,
  isSubagentToolName,
  mergePersistedSubagentRuns,
  parsePersistedSubagentRuns,
  resultIndexForRun,
  routingFromResult,
  type SubagentResultMetadata,
  type SubagentRun,
} from "@/lib/subagent-runs";
import {
  nowForSubagentClientMetric,
  recordSubagentClientDuration,
  recordSubagentClientMetric,
} from "@/lib/subagent-observability-client";

export type {
  SubagentActivityState,
  SubagentProgressSnapshot,
  SubagentProgressStatus,
  SubagentRecentTool,
  SubagentRun,
} from "@/lib/subagent-runs";

export {
  matchProgressForRun,
  normalizeSubagentProgressList,
  normalizeSubagentProgressSnapshot,
  serializeSubagentRunsForFlush,
} from "@/lib/subagent-progress";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  sessionStats: SessionBillingStats | null;
  /** Durable accurate performance summary; null/absent when no valid samples. */
  sessionPerformance?: SessionPerformanceSummary | null;
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

const SUBAGENT_UI_FLUSH_MS = 300;

export type AgentPhase =
  | { kind: "resolving_vision"; model?: string }
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface AgentFailure {
  provider?: string;
  model?: string;
  errorMessage: string;
  retryAttempts: number;
  maxAttempts?: number;
  technicalDetails: string;
  /** Stable machine code for localized failure copy. */
  code?: ErrorCode;
  /** Coarse category for titles/actions (auth/quota/network/…). */
  category?: ChatProviderErrorCategory;
}

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
  autoScrollEnabled?: boolean;
  setNewSessionModel?: (model: { provider: string; modelId: string } | null) => void;
  setToolPreset?: (preset: ToolPreset) => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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


/**
 * Resolve the assistant snapshot for streaming UI.
 *
 * In-process AgentSession.subscribe (0.84.1) still emits cumulative `message`
 * on message_update. JSON/RPC wire events strip `message` and
 * `assistantMessageEvent.partial` — fall back to `partial` when present so a
 * future protocol alignment does not blank the stream.
 */
function resolveStreamingMessage(event: AgentEvent): Partial<AgentMessage> | undefined {
  const message = event.message;
  if (isRecord(message) && typeof message.role === "string") {
    return message as Partial<AgentMessage>;
  }
  const assistantEvent = event.assistantMessageEvent;
  if (isRecord(assistantEvent) && isRecord(assistantEvent.partial)) {
    const partial = assistantEvent.partial;
    if (typeof partial.role === "string") {
      return partial as Partial<AgentMessage>;
    }
  }
  return undefined;
}

interface ModelMetadata {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; primaryCandidate?: boolean }[];
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
    chatInputRef,
    autoScrollEnabled = true,
  } = opts;
  const { t } = useI18n();
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
  const [modelList, setModelList] = useState<{ id: string; name: string; provider: string; primaryCandidate?: boolean }[]>([]);
  const [modelsReady, setModelsReady] = useState(false);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModelState] = useState<{ provider: string; modelId: string } | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("all");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [agentFailure, setAgentFailure] = useState<AgentFailure | null>(null);
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

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenMessageUpdateRef = useRef<AgentEvent | null>(null);
  const hiddenMessageUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const {
    extensionStatuses,
    extensionWidgets,
    extensionDialog,
    extensionToasts,
    respondExtensionDialog,
    dismissExtensionToast,
    clearExtensionChrome,
    handleExtensionUiRequest,
  } = useExtensionUi({ sessionIdRef, chatInputRef });
  const agentRunningRef = useRef(false);
  const promptHadAgentLifecycleRef = useRef(false);
  const pendingAgentErrorRef = useRef<AgentFailure | null>(null);
  const retryProgressRef = useRef<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
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
    const serializeStartedAt = nowForSubagentClientMetric();
    const json = serializeSubagentRunsForFlush(runs);
    recordSubagentClientDuration("serializeMs", serializeStartedAt);
    if (json === prevRunsJsonRef.current) return;
    prevRunsJsonRef.current = json;
    subagentChangeRef.current?.(runs);
  }, []);
  const scheduleSubagentFlush = useCallback(() => {
    if (subagentFlushTimerRef.current) return;
    subagentFlushTimerRef.current = setTimeout(flushSubagentRuns, SUBAGENT_UI_FLUSH_MS);
  }, [flushSubagentRuns]);
  const updateSubagentRuns = useCallback((
    update: (runs: SubagentRun[]) => SubagentRun[],
    flushImmediately = false,
  ) => {
    const current = subagentRunsRef.current;
    const next = update(current);
    if (next === current) return;
    subagentRunsRef.current = next;
    if (flushImmediately) {
      if (subagentFlushTimerRef.current) {
        clearTimeout(subagentFlushTimerRef.current);
        subagentFlushTimerRef.current = null;
      }
      flushSubagentRuns();
    } else {
      scheduleSubagentFlush();
    }
  }, [flushSubagentRuns, scheduleSubagentFlush]);

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? newSessionModel : currentModel;

  const currentContextStats = useMemo(() => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const usage = msg.usage;
      if (!usage) continue;
      tokens.input += usage.input ?? 0;
      tokens.output += usage.output ?? 0;
      tokens.cacheRead += usage.cacheRead ?? 0;
      tokens.cacheWrite += usage.cacheWrite ?? 0;
      cost += usage.cost?.total ?? 0;
    }
    const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    return total > 0 ? { tokens, cost } : null;
  }, [messages]);
  const sessionStats = data?.sessionStats ?? currentContextStats;
  const sessionPerformance = data?.sessionPerformance ?? null;

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

  const flushHiddenMessageUpdate = useCallback(() => {
    if (hiddenMessageUpdateTimerRef.current) {
      clearTimeout(hiddenMessageUpdateTimerRef.current);
      hiddenMessageUpdateTimerRef.current = null;
    }
    const pending = hiddenMessageUpdateRef.current;
    hiddenMessageUpdateRef.current = null;
    if (pending) handleAgentEventRef.current?.(pending);
  }, []);

  const connectEvents = useCallback((sid: string) => {
    if (eventReconnectTimerRef.current) {
      clearTimeout(eventReconnectTimerRef.current);
      eventReconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      if (eventSourceRef.current !== es || sessionIdRef.current !== sid) return;
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        recordSubagentClientMetric("sseEvents");
        if (event.type === "message_update" && document.hidden) {
          hiddenMessageUpdateRef.current = event;
          if (!hiddenMessageUpdateTimerRef.current) {
            hiddenMessageUpdateTimerRef.current = setTimeout(flushHiddenMessageUpdate, 500);
          }
          return;
        }
        if (event.type !== "message_update") {
          flushHiddenMessageUpdate();
        } else {
          hiddenMessageUpdateRef.current = null;
          if (hiddenMessageUpdateTimerRef.current) {
            clearTimeout(hiddenMessageUpdateTimerRef.current);
            hiddenMessageUpdateTimerRef.current = null;
          }
        }
        handleAgentEventRef.current?.(event);
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      if (eventSourceRef.current === es && agentRunningRef.current) {
        es.close();
        eventSourceRef.current = null;
        eventReconnectTimerRef.current = setTimeout(() => {
          eventReconnectTimerRef.current = null;
          if (agentRunningRef.current && sessionIdRef.current === sid) connectEvents(sid);
        }, 1000);
      }
    };
  }, [flushHiddenMessageUpdate]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) flushHiddenMessageUpdate();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [flushHiddenMessageUpdate]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    const handlerStartedAt = nowForSubagentClientMetric();
    switch (event.type) {
      case "extension_ui_request": {
        handleExtensionUiRequest(event);
        break;
      }
      case "extension_error":
        console.error("Pi extension error", event);
        break;
      case "vision_resolution_start":
        setAgentRunning(true);
        setAgentPhase({ kind: "resolving_vision", model: typeof event.model === "string" ? event.model : undefined });
        break;
      case "vision_resolution_complete":
        setAgentPhase({ kind: "waiting_model" });
        break;
      case "agent_start":
        promptHadAgentLifecycleRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "prompt_settled":
        // Slash commands can finish without an Agent lifecycle. Model turns are finalized by
        // agent_settled, so their trailing prompt_settled event must not end the UI twice.
        if (getAgentLifecycleDirective(event.type, promptHadAgentLifecycleRef.current) === "ignore") break;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        retryProgressRef.current = null;
        dispatch({ type: "end" });
        break;
      case "prompt_error": {
        const errorMessage = typeof event.errorMessage === "string"
          ? event.errorMessage
          : typeof event.error === "string"
            ? event.error
            : "Command failed";
        const failure: AgentFailure = buildChatAgentFailure({
          error: errorMessage,
          provider: currentModel?.provider,
          model: currentModel?.modelId,
          retryAttempts: retryProgressRef.current?.attempt ?? 0,
          maxAttempts: retryProgressRef.current?.maxAttempts,
        });
        pendingAgentErrorRef.current = failure;
        setAgentFailure(failure);
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        retryProgressRef.current = null;
        dispatch({ type: "end" });
        console.error("Prompt failed", errorMessage);
        break;
      }
      case "agent_end":
        // agent_end is a low-level run boundary. Pi may still back off, retry, compact, or
        // process a queued continuation; only agent_settled is terminal for the prompt.
        if (event.willRetry === true) setAgentRunning(true);
        break;
      case "agent_settled":
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        retryProgressRef.current = null;
        dispatch({ type: "end" });
        if (pendingAgentErrorRef.current) {
          setAgentFailure((current) => current ?? pendingAgentErrorRef.current);
        }
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
        const msg = resolveStreamingMessage(event);
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
        if (completed?.role === "assistant") {
          if (completed.stopReason === "error" && completed.errorMessage) {
            pendingAgentErrorRef.current = buildChatAgentFailure({
              error: completed.errorMessage,
              provider: completed.provider,
              model: completed.model,
              retryAttempts: retryProgressRef.current?.attempt ?? 0,
              maxAttempts: retryProgressRef.current?.maxAttempts,
            });
          } else if (completed.stopReason !== "error") {
            pendingAgentErrorRef.current = null;
          }
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const isSubagent = isSubagentToolName(name);
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
        const flushImmediately = hasUrgentSubagentUpdate(progressList, controlEvents);

        updateSubagentRuns((prev) => {
          let changed = false;
          const next = prev.map((r) => {
            const related = r.id === updateId || r.id.startsWith(`${updateId}-`);
            if (!related) return r;

            let updated = r;
            if (text) {
              // Compatibility for older servers that still send live output. New servers
              // omit it from ordinary summary events and details load on expansion.
              const bounded = boundSubagentOutput(text);
              if (bounded.text !== updated.partialOutput || bounded.truncated !== updated.outputTruncated) {
                updated = {
                  ...updated,
                  partialOutput: bounded.text ?? "",
                  outputTruncated: bounded.truncated,
                };
                changed = true;
              }
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
        }, flushImmediately);
        break;
      }
      case "tool_execution_end": {
        const endId = event.toolCallId as string;
        const isError = !!event.isError;
        const resultOutput = boundSubagentOutput(
          (event.result as { content?: { text?: string }[] } | undefined)
            ?.content?.map((c) => c.text ?? "")
            .join("") || undefined,
        );
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
              return {
                ...r,
                status: isError || isSubagentResultFailure(result) ? "failed" : "completed",
                result: resultOutput.text,
                partialOutput: "",
                outputTruncated: resultOutput.truncated,
                sessionFile: sessionFile ?? r.sessionFile,
                routing: routing ?? r.routing,
              };
            }
            return r;
          }),
          true,
        );
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== endId);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "auto_retry_start": {
        const progress = {
          attempt: event.attempt as number,
          maxAttempts: event.maxAttempts as number,
          errorMessage: event.errorMessage as string | undefined,
        };
        retryProgressRef.current = progress;
        setRetryInfo(progress);
        setAgentFailure(null);
        setAgentRunning(true);
        break;
      }
      case "auto_retry_end": {
        const success = event.success === true;
        const attempt = typeof event.attempt === "number"
          ? event.attempt
          : retryProgressRef.current?.attempt ?? 0;
        if (success) {
          pendingAgentErrorRef.current = null;
          setAgentFailure(null);
        } else {
          const finalError = typeof event.finalError === "string"
            ? event.finalError
            : pendingAgentErrorRef.current?.technicalDetails
              ?? pendingAgentErrorRef.current?.errorMessage
              ?? "Retry failed";
          const failure: AgentFailure = buildChatAgentFailure({
            error: finalError,
            provider: pendingAgentErrorRef.current?.provider ?? currentModel?.provider,
            model: pendingAgentErrorRef.current?.model ?? currentModel?.modelId,
            retryAttempts: attempt,
            maxAttempts: retryProgressRef.current?.maxAttempts,
          });
          pendingAgentErrorRef.current = failure;
          setAgentFailure(failure);
        }
        retryProgressRef.current = null;
        setRetryInfo(null);
        break;
      }
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
      case "session_performance_update":
        if (event.sessionId === sessionIdRef.current && event.sessionPerformance) {
          const summary = event.sessionPerformance as SessionPerformanceSummary;
          setData((prev) => prev ? { ...prev, sessionPerformance: summary } : prev);
        }
        break;
    }
    recordSubagentClientDuration("eventHandlerMs", handlerStartedAt);
  }, [currentModel, handleExtensionUiRequest, loadSession, onAgentEnd, updateSubagentRuns]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    if (!message.trim() && !images?.length) return;
    if (agentRunning) return;

    const sendBlock = getChatSendBlockReason({
      cwd: session?.cwd ?? newSessionCwd,
      modelsReady,
      modelList,
      selectedModel: isNew ? newSessionModel : currentModel,
    });
    if (sendBlock && sendBlock !== "models_loading") {
      const failure: AgentFailure = buildChatAgentFailure({
        error: sendBlock === "no_models"
          ? "No models available"
          : sendBlock === "no_model_selected"
            ? "Model not found: none selected"
            : "No workspace selected",
        provider: currentModel?.provider ?? newSessionModel?.provider,
        model: currentModel?.modelId ?? newSessionModel?.modelId,
      });
      pendingAgentErrorRef.current = failure;
      setAgentFailure(failure);
      return;
    }

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
    promptHadAgentLifecycleRef.current = false;
    pendingAgentErrorRef.current = null;
    retryProgressRef.current = null;
    setAgentFailure(null);
    setRetryInfo(null);
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
      const failure: AgentFailure = buildChatAgentFailure({
        error: e,
        provider: currentModel?.provider ?? newSessionModel?.provider,
        model: currentModel?.modelId ?? newSessionModel?.modelId,
        retryAttempts: 0,
      });
      pendingAgentErrorRef.current = failure;
      setAgentFailure(failure);
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, toolPreset, thinkingLevel, session, agentRunning, connectEvents, onSessionCreated, currentModel, modelsReady, modelList]);

  const handleContinueAfterFailure = useCallback(() => {
    if (agentRunning) return;
    void handleSend(t("chat.continuePrompt"));
  }, [agentRunning, handleSend, t]);

  const dismissAgentFailure = useCallback(() => {
    pendingAgentErrorRef.current = null;
    setAgentFailure(null);
  }, []);

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
    return () => {
      agentRunningRef.current = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (eventReconnectTimerRef.current) {
        clearTimeout(eventReconnectTimerRef.current);
        eventReconnectTimerRef.current = null;
      }
      hiddenMessageUpdateRef.current = null;
      if (hiddenMessageUpdateTimerRef.current) {
        clearTimeout(hiddenMessageUpdateTimerRef.current);
        hiddenMessageUpdateTimerRef.current = null;
      }
      clearExtensionChrome();
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
    setModelsReady(false);
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
        setModelsReady(true);
      })
      .catch(() => {
        if (!active) return;
        setModelNames({});
        setModelList([]);
        setModelThinkingLevels({});
        setModelThinkingLevelMaps({});
        setModelsReady(true);
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
    agentRunning, modelNames, modelList, modelsReady, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, agentFailure, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, currentModel, displayModel, sessionStats,
    sessionPerformance,
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
    handleSend, handleContinueAfterFailure, dismissAgentFailure,
    handleAbort, handleFork, handleNavigate, handleModelChange,
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
