import { canonicalizeCwd } from "./cwd";
import {
  beginWorkflowRun,
  computeWorkflowSpecRevision,
  createWorkflowRunId,
  getWorkflowRunSnapshotIntegrityError,
  getWorkflowRunSnapshotPathLabels,
  getWorkflowTaskDetail,
  hasActiveWorkflowRunInCwd,
  readWorkflowRunRecord,
  repairWorkflowTerminalProjection,
  writeWorkflowRunRecord,
  WorkflowConflictError,
  WorkflowStoreError,
} from "./workflow-store";
import {
  agentNameForPhase,
  buildDirectSubagentInstruction,
  parseWorkflowDispatchMarker,
  WorkflowDispatchMarkerError,
  type WorkflowDispatchMarker,
} from "./workflow-prompts";
import {
  canStartCheck,
  canStartImplement,
  WORKFLOW_TERMINAL_RUN_STATES,
  type WorkflowRunPhase,
  type WorkflowRunRecord,
  type WorkflowTaskDetail,
} from "./workflow-types";
import {
  normalizeWorkflowNativeResult,
  type NativeToolResultEnvelope,
} from "./workflow-native-result";
import { applyWorkflowNativeTerminal } from "./workflow-run-terminal";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

type NativeToolCall = {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};

type NativeToolUpdate = {
  toolCallId: string;
  toolName: string;
  partialResult?: unknown;
};

type NativeToolResult = {
  toolCallId: string;
  toolName: string;
  input?: Record<string, unknown>;
  content?: unknown;
  details?: unknown;
  result?: unknown;
  isError: boolean;
};

type TrackedDispatch = {
  marker: WorkflowDispatchMarker;
  runId: string;
  sessionId: string;
  lastProgressWriteAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function progressMetadata(partialResult: unknown): Partial<WorkflowRunRecord> | null {
  if (!isRecord(partialResult) || !isRecord(partialResult.details)) return null;
  const details = partialResult.details;
  const progress = Array.isArray(details.progress) ? details.progress.find(isRecord) : null;
  const routing = isRecord(details.routing) ? details.routing : null;
  const tokenTotal = progress && typeof progress.tokens === "number" ? progress.tokens : undefined;
  const toolCount = progress && typeof progress.toolCount === "number" ? progress.toolCount : undefined;
  const turnCount = progress && typeof progress.turnCount === "number" ? progress.turnCount : undefined;
  const model = optionalString(routing?.model);
  const thinking = optionalString(routing?.thinking);
  if (tokenTotal === undefined && toolCount === undefined && turnCount === undefined && !model && !thinking) {
    return null;
  }
  return {
    ...(tokenTotal === undefined ? {} : { tokenUsage: { total: tokenTotal } }),
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(turnCount === undefined ? {} : { turnCount }),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

export function finalizeWorkflowChatRun(
  cwd: string,
  run: WorkflowRunRecord,
  input: NativeToolResultEnvelope & { text?: string },
): WorkflowRunRecord {
  const normalized = normalizeWorkflowNativeResult({
    ...input,
    content: input.content ?? (input.text ? [{ type: "text", text: input.text }] : undefined),
  });
  // Wrapper-only events are display/progress data. They cannot release the run lock.
  if (normalized.kind !== "terminal" || !normalized.state) return run;
  const finalized = applyWorkflowNativeTerminal(run, {
    ...normalized,
    kind: "terminal",
    state: normalized.state,
    snapshotIntegrityError: getWorkflowRunSnapshotIntegrityError(cwd, run.taskId, run),
  });
  writeWorkflowRunRecord(cwd, run.taskId, finalized);
  repairWorkflowTerminalProjection(cwd, run.taskId, finalized);
  return finalized;
}

export interface WorkflowChatDispatchPreparation {
  task: WorkflowTaskDetail;
  dispatchPrompt: string;
}

/** Build a task/revision-bound main-chat instruction without starting a hidden run. */
export function prepareWorkflowChatDispatch(
  cwd: string,
  taskId: string,
  phase: WorkflowRunPhase,
  expectedRevision: string,
): WorkflowChatDispatchPreparation {
  const canonical = canonicalizeCwd(cwd);
  const task = getWorkflowTaskDetail(canonical, taskId);
  if (task.revision !== expectedRevision) {
    throw new WorkflowConflictError(
      `Revision mismatch: expected ${expectedRevision} but current is ${task.revision}`,
    );
  }
  if (task.archived) {
    throw new WorkflowStoreError("Archived tasks are read-only", { status: 409, code: "archived" });
  }
  const activeRunId = hasActiveWorkflowRunInCwd(canonical);
  if (activeRunId) {
    throw new WorkflowConflictError(`Workspace already has active workflow run ${activeRunId}`);
  }
  if (phase === "implement" ? !canStartImplement(task.status) : !canStartCheck(task.status)) {
    throw new WorkflowStoreError(`Cannot start ${phase} from status ${task.status}`, {
      status: 409,
      code: "invalid_transition",
    });
  }
  if (!task.hasDocuments.requirements || !task.hasDocuments.design || !task.hasDocuments.plan) {
    throw new WorkflowStoreError("Task is missing requirements.md, design.md, or plan.md", {
      status: 409,
      code: "missing_documents",
    });
  }
  const runId = createWorkflowRunId(phase);
  const specRevision = computeWorkflowSpecRevision(task.documents);
  const pathLabels = getWorkflowRunSnapshotPathLabels(canonical, task.id, runId);
  const implementSummary = phase === "check"
    ? task.runs.find((run) => run.id === task.latestImplementRunId)?.summary ?? null
    : null;
  return {
    task,
    dispatchPrompt: buildDirectSubagentInstruction({
      taskId: task.id,
      title: task.title,
      cwd: canonical,
      pathLabels,
      phase,
      implementSummary,
      taskRevision: task.revision,
      runId,
      specRevision,
    }),
  };
}

export class WorkflowChatLifecycleObserver {
  private readonly cwd: string;
  private readonly tracked = new Map<string, TrackedDispatch>();

  constructor(cwd: string) {
    this.cwd = canonicalizeCwd(cwd);
  }

  private key(sessionId: string, toolCallId: string): string {
    return `${sessionId}:${toolCallId}`;
  }

  beforeToolCall(event: NativeToolCall, sessionId: string): { block: boolean; reason?: string } {
    if (event.toolName !== "subagent" || "action" in event.input) return { block: false };

    let marker: WorkflowDispatchMarker | null;
    try {
      marker = parseWorkflowDispatchMarker(event.input.task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { block: true, reason: message };
    }
    if (!marker) return { block: false };

    try {
      const markerCwd = canonicalizeCwd(marker.cwd);
      const inputCwd =
        typeof event.input.cwd === "string" ? canonicalizeCwd(event.input.cwd) : "";
      if (markerCwd !== this.cwd || inputCwd !== this.cwd) {
        throw new WorkflowDispatchMarkerError(
          `SnFlow cwd mismatch: expected ${this.cwd}, marker=${marker.cwd}, input=${String(event.input.cwd ?? "(missing)")}`,
        );
      }
      const agent = agentNameForPhase(marker.phase);
      if (event.input.agent !== agent) {
        throw new WorkflowDispatchMarkerError(
          `SnFlow ${marker.phase} must use project agent ${agent}`,
        );
      }
      if (event.input.context !== "fresh") {
        throw new WorkflowDispatchMarkerError("SnFlow dispatch requires context=fresh");
      }
      if ("agentContract" in event.input &&
        (!isRecord(event.input.agentContract) || event.input.agentContract.version !== 1)) {
        throw new WorkflowDispatchMarkerError("SnFlow agentContract must be {version:1} when provided");
      }
      if (event.input.async !== false) {
        throw new WorkflowDispatchMarkerError("SnFlow dispatch must run in the foreground with async=false");
      }
      if (event.input.clarify !== false) {
        throw new WorkflowDispatchMarkerError("SnFlow dispatch requires clarify=false");
      }
      if (!sessionId.trim()) {
        throw new WorkflowDispatchMarkerError("SnFlow dispatch is missing the parent chat session id");
      }

      const begun = beginWorkflowRun(this.cwd, marker.taskId, {
        phase: marker.phase,
        expectedRevision: marker.revision,
        expectedSpecRevision: marker.specRevision,
        agentName: agent,
        hostSessionId: sessionId,
        requestedCwd: markerCwd,
        effectiveCwd: this.cwd,
        runId: marker.runId,
        parentSessionId: sessionId,
        parentToolCallId: event.toolCallId,
      });
      const startedAt = new Date().toISOString();
      const running: WorkflowRunRecord = {
        ...begun.run,
        state: "running",
        startedAt,
        lastReconciledAt: startedAt,
      };
      writeWorkflowRunRecord(this.cwd, marker.taskId, running);
      this.tracked.set(this.key(sessionId, event.toolCallId), {
        marker,
        runId: running.id,
        sessionId,
        lastProgressWriteAt: 0,
      });
      return { block: false };
    } catch (error) {
      return {
        block: true,
        reason: `SnFlow dispatch blocked: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  onToolUpdate(event: NativeToolUpdate, sessionId: string): void {
    if (event.toolName !== "subagent") return;
    const tracked = this.tracked.get(this.key(sessionId, event.toolCallId));
    if (!tracked || Date.now() - tracked.lastProgressWriteAt < 1000) return;
    const metadata = progressMetadata(event.partialResult);
    if (!metadata) return;
    try {
      const run = readWorkflowRunRecord(this.cwd, tracked.marker.taskId, tracked.runId);
      if (WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) return;
      const now = new Date().toISOString();
      writeWorkflowRunRecord(this.cwd, tracked.marker.taskId, {
        ...run,
        ...metadata,
        lastReconciledAt: now,
      });
      tracked.lastProgressWriteAt = Date.now();
    } catch {
      // Progress persistence is best-effort and must not interrupt the native run.
    }
  }

  onToolResult(event: NativeToolResult, sessionId: string): void {
    if (event.toolName !== "subagent") return;
    const tracked = this.tracked.get(this.key(sessionId, event.toolCallId));
    if (!tracked) return;
    try {
      const run = readWorkflowRunRecord(this.cwd, tracked.marker.taskId, tracked.runId);
      finalizeWorkflowChatRun(this.cwd, run, event);
    } catch {
      // Final result delivery to the chat must not be replaced by persistence errors.
    }
  }

  getTrackedRun(sessionId: string, toolCallId: string): WorkflowRunRecord | null {
    const tracked = this.tracked.get(this.key(sessionId, toolCallId));
    if (!tracked) return null;
    try {
      return readWorkflowRunRecord(this.cwd, tracked.marker.taskId, tracked.runId);
    } catch {
      return null;
    }
  }
}

function sessionIdFromExtensionCtx(ctx: { sessionManager: { getSessionId(): string } }): string | null {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    // Session replacement/reload/dispose can invalidate ctx mid-handler.
    if (
      error instanceof Error
      && (/extension ctx is stale|Extension context no longer active/i.test(error.message))
    ) {
      return null;
    }
    throw error;
  }
}

export function createWorkflowChatLifecycleExtension(cwd: string): InlineExtension {
  const observer = new WorkflowChatLifecycleObserver(cwd);
  return {
    name: "snflow-chat-lifecycle",
    factory(pi) {
      pi.on("tool_call", (event, ctx) => {
        const sessionId = sessionIdFromExtensionCtx(ctx);
        if (!sessionId) return undefined;
        const result = observer.beforeToolCall(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input as Record<string, unknown>,
          },
          sessionId,
        );
        return result.block ? { block: true, reason: result.reason } : undefined;
      });
      pi.on("tool_execution_update", (event, ctx) => {
        const sessionId = sessionIdFromExtensionCtx(ctx);
        if (!sessionId) return;
        observer.onToolUpdate(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          },
          sessionId,
        );
      });
      pi.on("tool_result", (event, ctx) => {
        const sessionId = sessionIdFromExtensionCtx(ctx);
        if (!sessionId) return;
        observer.onToolResult(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            content: event.content,
            details: event.details,
            isError: event.isError,
          },
          sessionId,
        );
      });
      pi.on("tool_execution_end", (event, ctx) => {
        const sessionId = sessionIdFromExtensionCtx(ctx);
        if (!sessionId) return;
        observer.onToolResult(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          sessionId,
        );
      });
    },
  };
}
