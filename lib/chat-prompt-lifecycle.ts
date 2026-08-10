/**
 * Pure prompt-level chat lifecycle used by integration smokes (and as the
 * documented contract for hooks/useAgentSession.ts).
 *
 * Prompt running settles on agent_settled / prompt_error (or non-agent
 * prompt_settled). Bare agent_end keeps the UI busy across retry/compaction.
 */
import { getAgentLifecycleDirective } from "./agent-lifecycle";
import { AgentEventThrottler } from "./agent-event-throttler";

export type ChatPromptPhase =
  | { kind: "resolving_vision"; model?: string }
  | { kind: "waiting_model" }
  | { kind: "running_tools"; tools: Array<{ id: string; name: string }> }
  | null;

export interface ChatPromptRetryInfo {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface ChatPromptFailure {
  provider?: string;
  model?: string;
  errorMessage: string;
  retryAttempts: number;
  maxAttempts?: number;
  technicalDetails: string;
}

export interface ChatPromptStreamState {
  isStreaming: boolean;
  /** Latest assistant snapshot text for ordering assertions (not full message). */
  assistantText: string | null;
}

export interface ChatPromptLifecycleState {
  agentRunning: boolean;
  phase: ChatPromptPhase;
  retryInfo: ChatPromptRetryInfo | null;
  failure: ChatPromptFailure | null;
  pendingFailure: ChatPromptFailure | null;
  promptHadAgentLifecycle: boolean;
  stream: ChatPromptStreamState;
  isCompacting: boolean;
  compactError: string | null;
  /** Completed non-user messages observed via message_end (bounded for smoke). */
  completedAssistantCount: number;
  destroyed: boolean;
}

export type ChatPromptEvent = {
  type: string;
  [key: string]: unknown;
};

export interface ChatPromptEventContext {
  provider?: string;
  model?: string;
}

export function createInitialChatPromptLifecycleState(): ChatPromptLifecycleState {
  return {
    agentRunning: false,
    phase: null,
    retryInfo: null,
    failure: null,
    pendingFailure: null,
    promptHadAgentLifecycle: false,
    stream: { isStreaming: false, assistantText: null },
    isCompacting: false,
    compactError: null,
    completedAssistantCount: 0,
    destroyed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match hooks/useAgentSession resolveStreamingMessage (text extraction only). */
export function extractStreamingAssistantText(event: ChatPromptEvent): string | null {
  const message = event.message;
  if (isRecord(message) && message.role === "user") return null;
  if (isRecord(message) && typeof message.role === "string") {
    return assistantTextFromContent(message.content);
  }
  const assistantEvent = event.assistantMessageEvent;
  if (isRecord(assistantEvent) && isRecord(assistantEvent.partial)) {
    const partial = assistantEvent.partial;
    if (partial.role === "user") return null;
    if (typeof partial.role === "string") {
      return assistantTextFromContent(partial.content);
    }
  }
  return null;
}

function assistantTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : "";
}

function buildFailure(
  errorMessage: string,
  state: ChatPromptLifecycleState,
  context?: ChatPromptEventContext,
  extras?: Partial<ChatPromptFailure>,
): ChatPromptFailure {
  return {
    provider: extras?.provider ?? context?.provider,
    model: extras?.model ?? context?.model,
    errorMessage,
    retryAttempts: extras?.retryAttempts ?? state.retryInfo?.attempt ?? 0,
    maxAttempts: extras?.maxAttempts ?? state.retryInfo?.maxAttempts,
    technicalDetails: extras?.technicalDetails ?? errorMessage,
  };
}

function clearRetry(state: ChatPromptLifecycleState): ChatPromptLifecycleState {
  return { ...state, retryInfo: null };
}

function settleStream(state: ChatPromptLifecycleState): ChatPromptLifecycleState {
  return {
    ...state,
    stream: { isStreaming: false, assistantText: null },
  };
}

function startStream(state: ChatPromptLifecycleState): ChatPromptLifecycleState {
  return {
    ...state,
    stream: { isStreaming: true, assistantText: null },
  };
}

/**
 * Local send() entry before any SSE arrives — mirrors handleSend busy flags.
 * Does not set phase to waiting_model (extension slash commands may never start the model).
 */
export function beginLocalPrompt(state: ChatPromptLifecycleState): ChatPromptLifecycleState {
  if (state.destroyed) return state;
  return {
    ...state,
    agentRunning: true,
    phase: null,
    failure: null,
    pendingFailure: null,
    retryInfo: null,
    promptHadAgentLifecycle: false,
    stream: { isStreaming: true, assistantText: null },
  };
}

/** Abort / HTTP send failure / wrapper teardown — must not leave running sticky. */
export function forceSettlePrompt(
  state: ChatPromptLifecycleState,
  failure?: ChatPromptFailure | null,
): ChatPromptLifecycleState {
  return {
    ...state,
    agentRunning: false,
    phase: null,
    retryInfo: null,
    failure: failure === undefined ? state.failure : failure,
    pendingFailure: failure ?? null,
    stream: { isStreaming: false, assistantText: null },
  };
}

export function markLifecycleDestroyed(state: ChatPromptLifecycleState): ChatPromptLifecycleState {
  return forceSettlePrompt({ ...state, destroyed: true }, state.failure);
}

/**
 * Apply one delivered (post-throttle) SSE-like event to prompt lifecycle state.
 * Subagent projection is intentionally out of scope.
 */
export function applyChatPromptEvent(
  state: ChatPromptLifecycleState,
  event: ChatPromptEvent,
  context?: ChatPromptEventContext,
): ChatPromptLifecycleState {
  if (state.destroyed) return state;

  switch (event.type) {
    case "vision_resolution_start": {
      return {
        ...state,
        agentRunning: true,
        phase: {
          kind: "resolving_vision",
          model: typeof event.model === "string" ? event.model : undefined,
        },
      };
    }
    case "vision_resolution_complete": {
      return { ...state, phase: { kind: "waiting_model" } };
    }
    case "agent_start": {
      return startStream({
        ...state,
        promptHadAgentLifecycle: true,
        agentRunning: true,
        phase: { kind: "waiting_model" },
      });
    }
    case "prompt_settled": {
      if (getAgentLifecycleDirective(event.type, state.promptHadAgentLifecycle) === "ignore") {
        return state;
      }
      return settleStream(clearRetry({
        ...state,
        agentRunning: false,
        phase: null,
      }));
    }
    case "prompt_error": {
      const errorMessage = typeof event.errorMessage === "string"
        ? event.errorMessage
        : typeof event.error === "string"
          ? event.error
          : "Command failed";
      const failure = buildFailure(errorMessage, state, context);
      return settleStream(clearRetry({
        ...state,
        agentRunning: false,
        phase: null,
        failure,
        pendingFailure: failure,
      }));
    }
    case "agent_end": {
      // Low-level run boundary only. Keep busy; willRetry reinforces running.
      if (event.willRetry === true) {
        return { ...state, agentRunning: true };
      }
      return state;
    }
    case "agent_settled": {
      const next = settleStream(clearRetry({
        ...state,
        agentRunning: false,
        phase: null,
      }));
      if (next.pendingFailure) {
        return {
          ...next,
          failure: next.failure ?? next.pendingFailure,
        };
      }
      return next;
    }
    case "message_start":
    case "message_update": {
      const text = extractStreamingAssistantText(event);
      if (text === null && event.type === "message_update") {
        // user snapshot or unresolvable — ignore like the hook
        const message = event.message;
        if (isRecord(message) && message.role === "user") return state;
      }
      if (text === null && !isRecord(event.message) && !isRecord(event.assistantMessageEvent)) {
        return { ...state, phase: null };
      }
      if (text === null) {
        return { ...state, phase: null };
      }
      return {
        ...state,
        phase: null,
        stream: { isStreaming: true, assistantText: text },
      };
    }
    case "message_end": {
      const completed = isRecord(event.message) ? event.message : null;
      let next: ChatPromptLifecycleState = settleStream({
        ...state,
        phase: { kind: "waiting_model" },
      });

      if (completed && completed.role !== "user") {
        next = { ...next, completedAssistantCount: next.completedAssistantCount + 1 };
      }

      if (completed?.role === "assistant") {
        if (completed.stopReason === "error" && typeof completed.errorMessage === "string") {
          const failure = buildFailure(completed.errorMessage, state, context, {
            provider: typeof completed.provider === "string" ? completed.provider : context?.provider,
            model: typeof completed.model === "string" ? completed.model : context?.model,
          });
          next = { ...next, pendingFailure: failure };
        } else if (completed.stopReason !== "error") {
          next = { ...next, pendingFailure: null };
        }
      }
      return next;
    }
    case "tool_execution_start": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      if (!id) return state;
      const tools = state.phase?.kind === "running_tools" ? [...state.phase.tools] : [];
      if (!tools.some((tool) => tool.id === id)) tools.push({ id, name });
      return { ...state, phase: { kind: "running_tools", tools } };
    }
    case "tool_execution_end": {
      const endId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!endId || state.phase?.kind !== "running_tools") return state;
      const tools = state.phase.tools.filter((tool) => tool.id !== endId);
      if (tools.length === 0) return { ...state, phase: { kind: "waiting_model" } };
      return { ...state, phase: { kind: "running_tools", tools } };
    }
    case "auto_retry_start": {
      const progress: ChatPromptRetryInfo = {
        attempt: typeof event.attempt === "number" ? event.attempt : 0,
        maxAttempts: typeof event.maxAttempts === "number" ? event.maxAttempts : 0,
        errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined,
      };
      return {
        ...state,
        retryInfo: progress,
        failure: null,
        agentRunning: true,
      };
    }
    case "auto_retry_end": {
      const success = event.success === true;
      const attempt = typeof event.attempt === "number"
        ? event.attempt
        : state.retryInfo?.attempt ?? 0;
      if (success) {
        return clearRetry({
          ...state,
          pendingFailure: null,
          failure: null,
        });
      }
      const finalError = typeof event.finalError === "string"
        ? event.finalError
        : state.pendingFailure?.errorMessage ?? "Retry failed";
      const failure = buildFailure(finalError, state, context, {
        provider: state.pendingFailure?.provider ?? context?.provider,
        model: state.pendingFailure?.model ?? context?.model,
        retryAttempts: attempt,
        maxAttempts: state.retryInfo?.maxAttempts,
        technicalDetails: state.pendingFailure?.technicalDetails ?? finalError,
      });
      return clearRetry({
        ...state,
        pendingFailure: failure,
        failure,
      });
    }
    case "auto_compaction_start":
    case "compaction_start": {
      return { ...state, isCompacting: true, compactError: null };
    }
    case "auto_compaction_end":
    case "compaction_end": {
      return {
        ...state,
        isCompacting: false,
        compactError: typeof event.errorMessage === "string" ? event.errorMessage : null,
      };
    }
    default:
      return state;
  }
}

export interface ChatPromptLifecycleHarnessOptions {
  throttleMs?: number;
  now?: () => number;
  context?: ChatPromptEventContext;
}

/**
 * In-process stand-in for:
 * mock AgentSession events → AgentEventThrottler → client lifecycle apply.
 */
export class ChatPromptLifecycleHarness {
  private state = createInitialChatPromptLifecycleState();
  private readonly delivered: ChatPromptEvent[] = [];
  private readonly throttler: AgentEventThrottler<ChatPromptEvent>;
  private readonly context: ChatPromptEventContext;
  private readonly buffered: ChatPromptEvent[] = [];
  private listenerAttached = false;

  constructor(options: ChatPromptLifecycleHarnessOptions = {}) {
    this.context = options.context ?? {};
    this.throttler = new AgentEventThrottler(
      (event) => this.deliver(event),
      options.throttleMs ?? 50,
      options.now ?? Date.now,
    );
  }

  get snapshot(): ChatPromptLifecycleState {
    return this.state;
  }

  get deliveredEvents(): readonly ChatPromptEvent[] {
    return this.delivered;
  }

  get deliveredTypes(): string[] {
    return this.delivered.map((event) => event.type);
  }

  /** Simulate browser SSE attach; replays buffer like rpc-manager. */
  attachListener(): void {
    this.listenerAttached = true;
    while (this.buffered.length > 0) {
      const event = this.buffered.shift()!;
      this.throttler.handle(event);
    }
  }

  beginPrompt(): void {
    this.state = beginLocalPrompt(this.state);
  }

  /** Push a raw session event (pre-throttle), optionally before listener attach. */
  push(event: ChatPromptEvent): void {
    if (this.state.destroyed) return;
    if (!this.listenerAttached) {
      this.buffered.push(event);
      return;
    }
    this.throttler.handle(event);
  }

  flush(): void {
    this.throttler.flush();
  }

  /** Wrapper teardown: drop pending throttle + force settle. */
  destroy(): void {
    this.throttler.clear();
    this.buffered.length = 0;
    this.state = markLifecycleDestroyed(this.state);
  }

  abort(errorMessage = "aborted"): void {
    this.throttler.clear();
    this.state = forceSettlePrompt(this.state, buildFailure(errorMessage, this.state, this.context));
  }

  private deliver(event: ChatPromptEvent): void {
    this.delivered.push(event);
    this.state = applyChatPromptEvent(this.state, event, this.context);
  }
}

/** Helpers for building smoke events without repeating shapes. */
export function messageUpdate(text: string): ChatPromptEvent {
  return {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

export function messageEnd(text: string, extras?: Record<string, unknown>): ChatPromptEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      ...extras,
    },
  };
}

export function toolStart(id: string, name: string): ChatPromptEvent {
  return { type: "tool_execution_start", toolCallId: id, toolName: name };
}

export function toolEnd(id: string, isError = false): ChatPromptEvent {
  return { type: "tool_execution_end", toolCallId: id, isError };
}
