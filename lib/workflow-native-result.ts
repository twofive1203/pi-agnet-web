import type { WorkflowRunState } from "./workflow-types";

export type NativeToolResultEnvelope = {
  isError: boolean;
  content?: unknown;
  details?: unknown;
  result?: unknown;
};

export type NormalizedWorkflowNativeResult = {
  kind: "pending" | "terminal";
  state?: Extract<WorkflowRunState, "completed" | "failed" | "cancelled">;
  text: string;
  diagnostic: string;
  details: Record<string, unknown> | null;
  child: Record<string, unknown> | null;
  authoritativeChild: boolean;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function errorString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRecord(value)) return optionalString(value.message) ?? optionalString(value.error);
  return null;
}

function stateString(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resultDetails(envelope: NativeToolResultEnvelope): Record<string, unknown> | null {
  if (isRecord(envelope.details)) return envelope.details;
  if (isRecord(envelope.result) && isRecord(envelope.result.details)) return envelope.result.details;
  return null;
}

function firstResult(details: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!details) return null;
  const candidates = Array.isArray(details.results)
    ? details.results
    : Array.isArray(details.steps)
      ? details.steps
      : [];
  return candidates.find(isRecord) ?? null;
}

function finalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = typeof message.content === "string"
      ? message.content
      : textFromContent(message.content);
    if (content.trim()) return content;
  }
  return "";
}

function resultText(
  envelope: NativeToolResultEnvelope,
  details: Record<string, unknown> | null,
  child: Record<string, unknown> | null,
): string {
  const structured = optionalString(child?.finalOutput) ?? finalAssistantText(child?.messages);
  if (structured) return structured;
  const direct = textFromContent(envelope.content);
  if (direct) return direct;
  if (isRecord(envelope.result)) return textFromContent(envelope.result.content);
  return "";
}

function resultShapes(details: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!details) return [];
  const shapes = [details];
  if (isRecord(details.result)) shapes.push(details.result);
  if (Array.isArray(details.results)) shapes.push(...details.results.filter(isRecord));
  if (Array.isArray(details.steps)) shapes.push(...details.steps.filter(isRecord));
  return shapes;
}

function executionShapes(shape: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!shape) return [];
  return isRecord(shape.execution) ? [shape, shape.execution] : [shape];
}

function hasTerminalEvidence(shape: Record<string, unknown>): boolean {
  return [
    "exitCode", "state", "status", "success", "isError", "error", "timedOut", "timeout",
    "stopped", "interrupted", "cancelled", "canceled", "detached",
  ].some((key) => key in shape);
}

export function normalizeWorkflowNativeResult(
  envelope: NativeToolResultEnvelope,
): NormalizedWorkflowNativeResult {
  const details = resultDetails(envelope);
  const child = firstResult(details);
  const childShapes = executionShapes(child);
  const allShapes = resultShapes(details).flatMap((shape) => executionShapes(shape));
  const allStates = allShapes.map((shape) => stateString(shape.state ?? shape.status));
  const childStates = childShapes.map((shape) => stateString(shape.state ?? shape.status));
  const hasAuthoritativeOutput = Boolean(optionalString(child?.finalOutput));
  const authoritativeChild = childShapes.some(hasTerminalEvidence) || hasAuthoritativeOutput;
  const text = resultText(envelope, details, child);
  const decisionShapes = authoritativeChild ? childShapes : allShapes;
  const decisionStates = authoritativeChild ? childStates : allStates;

  const cancelled = decisionShapes.some((shape) =>
    shape.stopped === true ||
    shape.interrupted === true ||
    shape.cancelled === true ||
    shape.canceled === true ||
    shape.detached === true
  ) || decisionStates.some((state) =>
    state === "stopped" || state === "interrupted" || state === "cancelled" ||
    state === "canceled" || state === "paused" || state === "detached"
  );
  const timedOut = decisionShapes.some((shape) => shape.timedOut === true || shape.timeout === true) ||
    decisionStates.some((state) => state === "timed_out" || state === "timed-out" || state === "timeout");
  const failed = timedOut || decisionShapes.some((shape) =>
    (typeof shape.exitCode === "number" && shape.exitCode !== 0) ||
    shape.success === false ||
    shape.isError === true ||
    Boolean(errorString(shape.error))
  ) || decisionStates.some((state) => state === "failed" || state === "error");
  const completed = hasAuthoritativeOutput || decisionShapes.some((shape) =>
    shape.exitCode === 0 || shape.success === true
  ) || decisionStates.some((state) =>
    state === "complete" || state === "completed" || state === "succeeded" || state === "success"
  );
  const detailError = decisionShapes.map((shape) => errorString(shape.error)).find(Boolean);
  const diagnostic = detailError ?? (timedOut ? "Native subagent run timed out" : text.trim());

  if (cancelled) {
    return { kind: "terminal", state: "cancelled", text, diagnostic: diagnostic || "Native subagent run cancelled", details, child, authoritativeChild };
  }
  if (failed) {
    return { kind: "terminal", state: "failed", text, diagnostic: diagnostic || "Native subagent run failed", details, child, authoritativeChild };
  }
  if (completed) {
    return { kind: "terminal", state: "completed", text, diagnostic: text, details, child, authoritativeChild };
  }
  return { kind: "pending", text, diagnostic: text.trim(), details, child, authoritativeChild: false };
}
