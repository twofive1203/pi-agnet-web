/**
 * Server-side ordinary Agent prompt activity observation (desktop pet U2).
 *
 * Pure state machine driven by wrapper lifecycle edges. Emits only safe fields
 * suitable for TaskObserverActivityInput — never cwd, prompt text, tool args,
 * raw errors, or file paths.
 */

import { createHash } from "node:crypto";
import { classifyChatProviderError } from "./chat-provider-errors";
import { getAgentLifecycleDirective } from "./agent-lifecycle";
import { isSubagentToolName } from "./subagent-runs";
import { getPathBaseName } from "./workspace-title";
import {
  buildAgentActivityId,
  buildAgentTaskKey,
  buildAgentTransitionId,
  resolveSafeTitle,
} from "./task-observer-projection";
import {
  TASK_OBSERVER_BUDGETS,
  type TaskObserverActivityInput,
  type TaskObserverAttention,
  type TaskObserverChildSummaryInput,
  type TaskObserverExecutionState,
  type TaskObserverOutcome,
  type TaskObserverProgress,
} from "./task-observer-types";

/** Extension UI methods that block the agent until the user responds. */
export const BLOCKING_EXTENSION_UI_METHODS = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

export type AgentObserverReasonCode =
  | "provider_auth"
  | "provider_quota"
  | "provider_network"
  | "model_not_found"
  | "empty_response"
  | "provider_error"
  | "aborted"
  | "interrupted"
  | "prompt_error";

export type AgentObserverEvent = {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
  id?: unknown;
  method?: unknown;
  error?: unknown;
  success?: unknown;
  attempt?: unknown;
  willRetry?: unknown;
  name?: unknown;
  [key: string]: unknown;
};

export type AgentObserverIdentity = {
  instanceId: string;
  sessionId: string;
  /** Canonical cwd used only to derive path-free projectKey/displayName. */
  cwd: string;
  explicitTitle?: string | null;
};

type ActiveTool = {
  name: string;
  isSubagent: boolean;
};

type InternalActivity = {
  promptEpoch: number;
  stateVersion: number;
  executionState: TaskObserverExecutionState;
  outcome: TaskObserverOutcome;
  attention: TaskObserverAttention;
  phase?: string;
  reasonCode?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  promptHadAgentLifecycle: boolean;
  /** toolCallId → safe tool metadata */
  activeTools: Map<string, ActiveTool>;
  toolCount: number;
  turnCount: number;
  /** Blocking extension_ui request ids awaiting response. */
  blockingUiIds: Set<string>;
  /** Nested subagent child rows (bounded). */
  children: Map<string, TaskObserverChildSummaryInput>;
  lastFailureReason?: AgentObserverReasonCode;
};

export type AgentTaskObserverSnapshot = {
  promptEpoch: number;
  hasActivity: boolean;
  executionState: TaskObserverExecutionState | null;
  outcome: TaskObserverOutcome | null;
  attention: TaskObserverAttention | null;
  phase?: string;
  reasonCode?: string;
  lastTransitionId: string | null;
  activeToolCount: number;
  activeSubagentCount: number;
  blockingUiCount: number;
  settledForIdle: boolean;
};

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function clampToolName(raw: unknown): string {
  if (typeof raw !== "string") return "tool";
  const trimmed = raw.trim();
  if (!trimmed) return "tool";
  return trimmed.length <= TASK_OBSERVER_BUDGETS.maxToolNameChars
    ? trimmed
    : trimmed.slice(0, TASK_OBSERVER_BUDGETS.maxToolNameChars);
}

/** Path-free stable project key derived from canonical cwd (never emits cwd). */
export function buildProjectKeyFromCwd(cwd: string): string {
  const normalized = cwd.trim() || "unknown";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `p_${digest}`;
}

export function buildProjectDisplayNameFromCwd(cwd: string): string {
  return getPathBaseName(cwd) || "Project";
}

/** Map provider/SDK failure text to a stable observer reason code (no raw text). */
export function classifyObserverReasonCode(error: unknown): AgentObserverReasonCode {
  if (error == null) return "prompt_error";
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  if (/abort|cancell?ed|interrupted/i.test(text)) {
    return /interrupt/i.test(text) ? "interrupted" : "aborted";
  }
  const category = classifyChatProviderError(error).category;
  switch (category) {
    case "auth":
      return "provider_auth";
    case "quota":
      return "provider_quota";
    case "network":
      return "provider_network";
    case "model_not_found":
      return "model_not_found";
    case "empty_response":
      return "empty_response";
    default:
      return "provider_error";
  }
}

export function isBlockingExtensionUiMethod(method: unknown): boolean {
  return typeof method === "string" && BLOCKING_EXTENSION_UI_METHODS.has(method);
}

/**
 * Whether idle teardown may start. Observer presence is intentionally ignored —
 * only genuine settlement and zero in-flight work matter (U2 / ADR).
 */
export function canScheduleAgentIdleTeardown(input: {
  settledForIdle: boolean;
  activeToolCount: number;
  activeSubagentCount: number;
  blockingUiCount: number;
}): boolean {
  return (
    input.settledForIdle &&
    input.activeToolCount <= 0 &&
    input.activeSubagentCount <= 0 &&
    input.blockingUiCount <= 0
  );
}

export class AgentTaskObserver {
  private promptEpoch = 0;
  private current: InternalActivity | null = null;
  private explicitTitle: string | null;
  private readonly clock: () => number;

  constructor(
    private readonly identity: AgentObserverIdentity,
    options?: { clock?: () => number },
  ) {
    this.explicitTitle = identity.explicitTitle?.trim() || null;
    this.clock = options?.clock ?? Date.now;
  }

  get sessionId(): string {
    return this.identity.sessionId;
  }

  getPromptEpoch(): number {
    return this.promptEpoch;
  }

  setExplicitTitle(title: string | null | undefined): void {
    const next = typeof title === "string" ? title.trim() : "";
    this.explicitTitle = next || null;
  }

  /**
   * User-initiated prompt boundary (wrapper send "prompt").
   * Starts a new activity epoch; unfinished prior work is marked interrupted.
   */
  beginUserPrompt(): void {
    if (this.current && this.current.executionState !== "settled") {
      this.forceSettle("interrupted", "interrupted");
    }
    this.startNewActivity({ phase: "queued", executionState: "queued" });
  }

  /** Steer/follow-up stay inside the current activity when one is live. */
  noteInActivityControl(kind: "steer" | "follow_up"): void {
    if (!this.current || this.current.executionState === "settled") {
      // Control without a live activity — open a minimal running activity.
      this.startNewActivity({ phase: kind, executionState: "running" });
      return;
    }
    this.touch({ phase: kind, executionState: "running" });
  }

  /** Apply one raw AgentSession / wrapper event at the pre-throttle boundary. */
  observeEvent(event: AgentObserverEvent): void {
    const type = event.type;
    if (!type) return;

    if (type === "session_info_changed") {
      const name = typeof event.name === "string" ? event.name : undefined;
      if (name !== undefined) this.setExplicitTitle(name);
      return;
    }

    if (type === "tool_execution_start") {
      this.onToolStart(event);
      return;
    }
    if (type === "tool_execution_end") {
      this.onToolEnd(event);
      return;
    }
    if (type === "extension_ui_request") {
      this.onExtensionUiRequest(event);
      return;
    }
    if (type === "extension_ui_response") {
      this.onExtensionUiResponse(event);
      return;
    }
    if (type === "auto_retry_start") {
      this.ensureActivity();
      this.touch({
        executionState: "retrying",
        phase: "retrying",
        attention: this.deriveAttention(),
      });
      return;
    }
    if (type === "auto_retry_end") {
      if (!this.current) return;
      const success = event.success === true;
      this.touch({
        executionState: success ? "running" : "retrying",
        phase: success ? "running" : "retrying",
      });
      return;
    }
    if (type === "prompt_error") {
      const reason = classifyObserverReasonCode(event.error);
      this.ensureActivity();
      const outcome: Exclude<TaskObserverOutcome, null> =
        reason === "aborted"
          ? "cancelled"
          : reason === "interrupted"
            ? "interrupted"
            : "failed";
      this.forceSettle(outcome, reason);
      return;
    }

    const directive = getAgentLifecycleDirective(
      type,
      this.current?.promptHadAgentLifecycle ?? false,
    );

    if (type === "agent_start") {
      if (!this.current || this.current.executionState === "settled") {
        this.startNewActivity({ phase: "running", executionState: "running" });
      } else {
        this.touch({
          executionState: this.current.executionState === "retrying" ? "retrying" : "running",
          phase: this.current.executionState === "retrying" ? "retrying" : "running",
        });
      }
      if (this.current) {
        this.current.promptHadAgentLifecycle = true;
        this.current.turnCount += 1;
      }
      return;
    }

    if (directive === "keep-running") {
      // agent_end: stay active across retry/compaction gaps (R4 / chat lifecycle).
      if (this.current && this.current.executionState !== "settled") {
        const willRetry = event.willRetry === true;
        this.touch({
          executionState: willRetry ? "retrying" : this.current.executionState === "retrying" ? "retrying" : "running",
          phase: willRetry ? "retrying" : this.current.phase ?? "running",
        });
      }
      return;
    }

    if (directive === "settle") {
      if (type === "prompt_settled" && this.current?.promptHadAgentLifecycle) {
        return;
      }
      this.ensureActivity();
      if (this.current?.executionState === "settled") return;
      const outcome: TaskObserverOutcome =
        this.current?.lastFailureReason === "aborted"
          ? "cancelled"
          : this.current?.lastFailureReason === "interrupted"
            ? "interrupted"
            : this.current?.lastFailureReason
              ? "failed"
              : "succeeded";
      this.forceSettle(outcome, this.current?.lastFailureReason);
      return;
    }
  }

  /** Clear a blocking UI id when the bridge accepts a response (even without SSE echo). */
  noteExtensionUiResolved(requestId: string): void {
    if (!this.current || !requestId) return;
    if (!this.current.blockingUiIds.delete(requestId)) return;
    this.touch({
      attention: this.deriveAttention(),
      phase: this.current.blockingUiIds.size > 0 ? "needs_input" : this.current.phase === "needs_input" ? "running" : this.current.phase,
    });
  }

  /** True when idle teardown may start for this observation (ignores SSE listeners). */
  isSettledForIdle(): boolean {
    if (!this.current) return true;
    if (this.current.executionState !== "settled") return false;
    if (this.current.activeTools.size > 0) return false;
    if (this.current.blockingUiIds.size > 0) return false;
    return true;
  }

  getIdleEligibility(bridgeBlockingCount = 0): {
    settledForIdle: boolean;
    activeToolCount: number;
    activeSubagentCount: number;
    blockingUiCount: number;
    canSchedule: boolean;
  } {
    const activeToolCount = this.current?.activeTools.size ?? 0;
    let activeSubagentCount = 0;
    if (this.current) {
      for (const tool of this.current.activeTools.values()) {
        if (tool.isSubagent) activeSubagentCount += 1;
      }
    }
    const blockingUiCount = Math.max(this.current?.blockingUiIds.size ?? 0, bridgeBlockingCount);
    const settledForIdle = this.isSettledForIdle() && bridgeBlockingCount <= 0;
    return {
      settledForIdle,
      activeToolCount,
      activeSubagentCount,
      blockingUiCount,
      canSchedule: canScheduleAgentIdleTeardown({
        settledForIdle,
        activeToolCount,
        activeSubagentCount,
        blockingUiCount,
      }),
    };
  }

  getDebugSnapshot(): AgentTaskObserverSnapshot {
    const idle = this.getIdleEligibility();
    return {
      promptEpoch: this.promptEpoch,
      hasActivity: this.current != null,
      executionState: this.current?.executionState ?? null,
      outcome: this.current?.outcome ?? null,
      attention: this.current?.attention ?? null,
      phase: this.current?.phase,
      reasonCode: this.current?.reasonCode,
      lastTransitionId: this.current ? this.transitionIdFor(this.current) : null,
      activeToolCount: idle.activeToolCount,
      activeSubagentCount: idle.activeSubagentCount,
      blockingUiCount: idle.blockingUiCount,
      settledForIdle: idle.settledForIdle,
    };
  }

  /**
   * Public observer activity for the current prompt cycle, or null when the
   * wrapper has never started an activity.
   */
  toActivityInput(): TaskObserverActivityInput | null {
    if (!this.current) return null;
    const activity = this.current;
    const projectKey = buildProjectKeyFromCwd(this.identity.cwd);
    const projectName = buildProjectDisplayNameFromCwd(this.identity.cwd);
    const sessionId = this.identity.sessionId;
    const instanceId = this.identity.instanceId;

    return {
      taskKey: buildAgentTaskKey(sessionId),
      activityId: buildAgentActivityId(instanceId, sessionId, activity.promptEpoch),
      source: "agent",
      projectKey,
      projectName,
      title: resolveSafeTitle("agent", this.explicitTitle),
      executionState: activity.executionState,
      outcome: activity.outcome,
      attention: activity.attention,
      phase: activity.phase,
      reasonCode: activity.reasonCode,
      progress: this.buildProgress(activity),
      startedAt: activity.startedAt,
      updatedAt: activity.updatedAt,
      endedAt: activity.endedAt,
      children: Array.from(activity.children.values()),
      deepLink: `/?session=${encodeURIComponent(sessionId)}`,
      lastTransitionId: this.transitionIdFor(activity),
      stateVersion: activity.stateVersion,
    };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private transitionIdFor(activity: InternalActivity): string {
    return buildAgentTransitionId(
      this.identity.instanceId,
      this.identity.sessionId,
      activity.promptEpoch,
      activity.stateVersion,
    );
  }

  private startNewActivity(init: {
    phase: string;
    executionState: TaskObserverExecutionState;
  }): void {
    this.promptEpoch += 1;
    const ts = nowIso(this.clock);
    this.current = {
      promptEpoch: this.promptEpoch,
      stateVersion: 1,
      executionState: init.executionState,
      outcome: null,
      attention: "none",
      phase: init.phase,
      startedAt: ts,
      updatedAt: ts,
      promptHadAgentLifecycle: false,
      activeTools: new Map(),
      toolCount: 0,
      turnCount: 0,
      blockingUiIds: new Set(),
      children: new Map(),
    };
  }

  private ensureActivity(): void {
    if (!this.current) {
      this.startNewActivity({ phase: "running", executionState: "running" });
    }
  }

  private touch(
    patch: Partial<{
      executionState: TaskObserverExecutionState;
      outcome: TaskObserverOutcome;
      attention: TaskObserverAttention;
      phase: string | undefined;
      reasonCode: string | undefined;
      endedAt: string | undefined;
    }>,
  ): void {
    if (!this.current) return;
    const next = this.current;
    let changed = false;
    if (patch.executionState !== undefined && patch.executionState !== next.executionState) {
      next.executionState = patch.executionState;
      changed = true;
    }
    if (patch.outcome !== undefined && patch.outcome !== next.outcome) {
      next.outcome = patch.outcome;
      changed = true;
    }
    if (patch.attention !== undefined && patch.attention !== next.attention) {
      next.attention = patch.attention;
      changed = true;
    }
    if (patch.phase !== undefined && patch.phase !== next.phase) {
      next.phase = patch.phase;
      changed = true;
    }
    if (patch.reasonCode !== undefined && patch.reasonCode !== next.reasonCode) {
      next.reasonCode = patch.reasonCode;
      changed = true;
    }
    if (patch.endedAt !== undefined && patch.endedAt !== next.endedAt) {
      next.endedAt = patch.endedAt;
      changed = true;
    }
    next.updatedAt = nowIso(this.clock);
    if (changed) {
      next.stateVersion += 1;
    }
  }

  private forceSettle(
    outcome: Exclude<TaskObserverOutcome, null>,
    reasonCode?: string,
  ): void {
    this.ensureActivity();
    if (!this.current) return;
    // Drop in-flight tool tracking on settle — tools should have ended, but be defensive.
    this.current.activeTools.clear();
    this.current.blockingUiIds.clear();
    this.touch({
      executionState: "settled",
      outcome,
      attention: "none",
      phase: "settled",
      reasonCode,
      endedAt: nowIso(this.clock),
    });
  }

  private deriveAttention(): TaskObserverAttention {
    if (!this.current) return "none";
    if (this.current.blockingUiIds.size > 0) return "needs_input";
    for (const child of this.current.children.values()) {
      if (child.attention === "needs_input") return "needs_input";
      if (child.attention === "blocked") return "blocked";
    }
    return "none";
  }

  private onToolStart(event: AgentObserverEvent): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!toolCallId) return;
    this.ensureActivity();
    if (!this.current || this.current.executionState === "settled") {
      // Tool after settle — reopen as running (defensive).
      if (this.current?.executionState === "settled") {
        this.startNewActivity({ phase: "tool", executionState: "running" });
      } else {
        this.ensureActivity();
      }
    }
    if (!this.current) return;
    const name = clampToolName(event.toolName);
    const isSubagent = isSubagentToolName(event.toolName);
    this.current.activeTools.set(toolCallId, { name, isSubagent });
    this.current.toolCount += 1;
    if (isSubagent) {
      this.current.children.set(toolCallId, {
        childId: toolCallId,
        title: name,
        executionState: "running",
        outcome: null,
        attention: "none",
        phase: "running",
        updatedAt: nowIso(this.clock),
      });
      // Bound children map
      if (this.current.children.size > TASK_OBSERVER_BUDGETS.maxChildrenPerActivity) {
        const first = this.current.children.keys().next().value;
        if (first) this.current.children.delete(first);
      }
    }
    this.touch({
      executionState: this.current.executionState === "retrying" ? "retrying" : "running",
      phase: isSubagent ? "subagent" : "tool",
      attention: this.deriveAttention(),
    });
  }

  private onToolEnd(event: AgentObserverEvent): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    if (!toolCallId || !this.current) return;
    const prior = this.current.activeTools.get(toolCallId);
    this.current.activeTools.delete(toolCallId);
    if (prior?.isSubagent) {
      const child = this.current.children.get(toolCallId);
      if (child) {
        const isError = event.isError === true;
        this.current.children.set(toolCallId, {
          ...child,
          executionState: "settled",
          outcome: isError ? "failed" : "succeeded",
          phase: "settled",
          updatedAt: nowIso(this.clock),
        });
      }
    }
    if (this.current.executionState === "settled") return;
    this.touch({
      phase: this.current.activeTools.size > 0 ? this.current.phase : "running",
      attention: this.deriveAttention(),
    });
  }

  private onExtensionUiRequest(event: AgentObserverEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id || !isBlockingExtensionUiMethod(event.method)) {
      return;
    }
    this.ensureActivity();
    if (!this.current) return;
    if (this.current.executionState === "settled") {
      this.startNewActivity({ phase: "needs_input", executionState: "running" });
    }
    if (!this.current) return;
    this.current.blockingUiIds.add(id);
    this.touch({
      executionState: "running",
      attention: "needs_input",
      phase: "needs_input",
    });
  }

  private onExtensionUiResponse(event: AgentObserverEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return;
    this.noteExtensionUiResolved(id);
  }

  private buildProgress(activity: InternalActivity): TaskObserverProgress {
    let activeSubagents = 0;
    let completedSubagents = 0;
    let currentToolName: string | undefined;
    for (const tool of activity.activeTools.values()) {
      if (tool.isSubagent) activeSubagents += 1;
      else if (!currentToolName) currentToolName = tool.name;
    }
    for (const child of activity.children.values()) {
      if (child.executionState === "settled") completedSubagents += 1;
    }
    if (
      activity.toolCount === 0 &&
      activity.turnCount === 0 &&
      activeSubagents === 0 &&
      !currentToolName
    ) {
      return { kind: "indeterminate" };
    }
    return {
      kind: "counters",
      toolCount: activity.toolCount,
      turnCount: activity.turnCount > 0 ? activity.turnCount : undefined,
      activeSubagents: activeSubagents > 0 ? activeSubagents : undefined,
      completedSubagents: completedSubagents > 0 ? completedSubagents : undefined,
      currentToolName,
    };
  }
}
