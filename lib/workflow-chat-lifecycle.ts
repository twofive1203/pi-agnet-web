import { canonicalizeCwd } from "./cwd";
import {
  beginWorkflowRun,
  getWorkflowTaskDetail,
  getWorkflowTaskDocumentsPaths,
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
  normalizeCheckResult,
  normalizeImplementResult,
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
  type WorkflowRunState,
  type WorkflowTaskDetail,
} from "./workflow-types";
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

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function resultText(event: NativeToolResult): string {
  const direct = textFromContent(event.content);
  if (direct) return direct;
  if (isRecord(event.result)) return textFromContent(event.result.content);
  return "";
}

function resultDetails(event: NativeToolResult): Record<string, unknown> | null {
  if (isRecord(event.details)) return event.details;
  if (isRecord(event.result) && isRecord(event.result.details)) return event.result.details;
  return null;
}

function firstResult(details: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!details || !Array.isArray(details.results)) return null;
  return details.results.find(isRecord) ?? null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stateString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function errorString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value)) {
    return optionalString(value.message) ?? optionalString(value.error);
  }
  return null;
}

function resultShapes(details: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!details) return [];
  const shapes = [details];
  if (isRecord(details.result)) shapes.push(details.result);
  if (Array.isArray(details.results)) shapes.push(...details.results.filter(isRecord));
  return shapes;
}

function classifyTerminalResult(
  isError: boolean,
  text: string,
  details: Record<string, unknown> | null,
): { state: Extract<WorkflowRunState, "completed" | "failed" | "cancelled">; diagnostic: string } {
  const shapes = resultShapes(details);
  const states = shapes.map((shape) => stateString(shape.state ?? shape.status));
  const cancelled = /\b(abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b/i.test(text) || shapes.some((shape) =>
    shape.stopped === true ||
    shape.interrupted === true ||
    shape.cancelled === true ||
    shape.canceled === true ||
    shape.detached === true
  ) || states.some((state) =>
    state === "stopped" || state === "interrupted" || state === "cancelled" ||
    state === "canceled" || state === "paused" || state === "detached"
  );
  const timedOut = shapes.some((shape) => shape.timedOut === true || shape.timeout === true) ||
    states.some((state) => state === "timed_out" || state === "timed-out" || state === "timeout");
  const failure = isError || timedOut || shapes.some((shape) =>
    (typeof shape.exitCode === "number" && shape.exitCode !== 0) ||
    shape.success === false ||
    shape.isError === true ||
    Boolean(errorString(shape.error)) ||
    (isRecord(shape.acceptance) && shape.acceptance.status === "rejected")
  ) || states.some((state) => state === "failed" || state === "error");
  const detailError = shapes.map((shape) => errorString(shape.error)).find(Boolean);
  const diagnostic = detailError ?? (timedOut ? "Native subagent run timed out" : text.trim());

  if (cancelled) return { state: "cancelled", diagnostic: diagnostic || "Native subagent run cancelled" };
  if (failure) return { state: "failed", diagnostic: diagnostic || "Native subagent run failed" };
  return { state: "completed", diagnostic: text };
}

function terminalRun(
  run: WorkflowRunRecord,
  state: Extract<WorkflowRunState, "completed" | "failed" | "cancelled">,
  text: string,
  details: Record<string, unknown> | null,
): WorkflowRunRecord {
  const child = firstResult(details);
  const endedAt = new Date().toISOString();
  const summaryText = text.trim();
  const implementResult =
    state === "completed" && run.phase === "implement"
      ? normalizeImplementResult(summaryText)
      : run.implementResult;
  const checkResult =
    state === "completed" && run.phase === "check"
      ? normalizeCheckResult(summaryText)
      : run.checkResult;
  const summary =
    run.phase === "implement"
      ? implementResult?.summary ?? summaryText
      : checkResult?.summary ?? summaryText;
  return {
    ...run,
    state,
    nativeRunId:
      optionalString(details?.runId) ?? optionalString(details?.id) ?? run.nativeRunId,
    asyncDir: optionalString(details?.asyncDir) ?? run.asyncDir,
    sessionFile:
      optionalString(child?.sessionFile) ?? optionalString(details?.sessionFile) ?? run.sessionFile,
    outputFile: optionalString(details?.outputFile) ?? run.outputFile,
    model: optionalString(child?.model) ?? optionalString(details?.model) ?? run.model,
    thinking:
      optionalString(child?.thinking) ??
      optionalString(child?.thinkingLevel) ??
      optionalString(details?.thinking) ??
      run.thinking,
    summary: summary || run.summary,
    implementResult,
    checkResult,
    error:
      state === "completed"
        ? null
        : {
            code: state,
            message: summaryText || `Native subagent run ${state}`,
          },
    endedAt: run.endedAt ?? endedAt,
    lastReconciledAt: endedAt,
  };
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
  input: { isError: boolean; text: string; details?: unknown },
): WorkflowRunRecord {
  const details = isRecord(input.details) ? input.details : null;
  const classification = classifyTerminalResult(input.isError, input.text, details);
  const finalized = WORKFLOW_TERMINAL_RUN_STATES.has(run.state)
    ? run
    : terminalRun(run, classification.state, classification.diagnostic, details);
  if (!WORKFLOW_TERMINAL_RUN_STATES.has(run.state)) {
    writeWorkflowRunRecord(cwd, run.taskId, finalized);
  }
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
  const paths = getWorkflowTaskDocumentsPaths(canonical, task.id);
  const implementSummary = phase === "check"
    ? task.runs.find((run) => run.id === task.latestImplementRunId)?.summary ?? null
    : null;
  return {
    task,
    dispatchPrompt: buildDirectSubagentInstruction({
      taskId: task.id,
      title: task.title,
      cwd: canonical,
      pathLabels: paths.pathLabels,
      phase,
      implementSummary,
      taskRevision: task.revision,
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
        agentName: agent,
        hostSessionId: sessionId,
        requestedCwd: markerCwd,
        effectiveCwd: this.cwd,
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
      finalizeWorkflowChatRun(this.cwd, run, {
        isError: event.isError,
        text: resultText(event),
        details: resultDetails(event),
      });
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

export function createWorkflowChatLifecycleExtension(cwd: string): InlineExtension {
  const observer = new WorkflowChatLifecycleObserver(cwd);
  return {
    name: "snflow-chat-lifecycle",
    factory(pi) {
      pi.on("tool_call", (event, ctx) => {
        const result = observer.beforeToolCall(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input as Record<string, unknown>,
          },
          ctx.sessionManager.getSessionId(),
        );
        return result.block ? { block: true, reason: result.reason } : undefined;
      });
      pi.on("tool_execution_update", (event, ctx) => {
        observer.onToolUpdate(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            partialResult: event.partialResult,
          },
          ctx.sessionManager.getSessionId(),
        );
      });
      pi.on("tool_result", (event, ctx) => {
        observer.onToolResult(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
            content: event.content,
            details: event.details,
            isError: event.isError,
          },
          ctx.sessionManager.getSessionId(),
        );
      });
      pi.on("tool_execution_end", (event, ctx) => {
        observer.onToolResult(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          ctx.sessionManager.getSessionId(),
        );
      });
    },
  };
}
