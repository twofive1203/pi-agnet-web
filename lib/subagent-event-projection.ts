export interface ProjectableAgentEvent {
  type: string;
  [key: string]: unknown;
}

const MAX_LIVE_SUBAGENT_OUTPUT_CHARS = 8_000;
const MAX_SUBAGENT_PROGRESS_ROWS = 64;
const MAX_SUBAGENT_RECENT_TOOLS = 20;
const MAX_SUBAGENT_CONTROL_EVENTS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedEventString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

function projectRouting(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of ["source", "model", "thinking", "modality", "tier", "routerModel", "fallbackReason"]) {
    const text = boundedEventString(value[key], key === "fallbackReason" ? 400 : 160);
    if (text !== undefined) projected[key] = text;
  }
  if (typeof value.confidence === "number" && Number.isFinite(value.confidence)) projected.confidence = value.confidence;
  return projected;
}

function projectResult(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of ["agent", "sessionFile", "model", "thinking", "thinkingLevel", "status"]) {
    const text = boundedEventString(value[key], key === "sessionFile" ? 1_024 : 200);
    if (text !== undefined) projected[key] = text;
  }
  for (const key of ["exitCode", "success", "timedOut", "cancelled"]) {
    if (value[key] !== undefined) projected[key] = value[key];
  }
  const error = boundedEventString(value.error, 400);
  if (error !== undefined) projected.error = error;
  const routing = projectRouting(value.routing);
  if (routing) projected.routing = routing;
  return projected;
}

function projectProgress(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of ["index", "currentToolStartedAt", "toolCount", "turnCount", "tokens", "durationMs"]) {
    if (value[key] !== undefined) projected[key] = value[key];
  }
  for (const key of ["agent", "status", "currentTool", "activityState", "failedTool"]) {
    const text = boundedEventString(value[key], 120);
    if (text !== undefined) projected[key] = text;
  }
  const args = boundedEventString(value.currentToolArgs, 240);
  if (args !== undefined) projected.currentToolArgs = args;
  const error = boundedEventString(value.error, 400);
  if (error !== undefined) projected.error = error;
  if (Array.isArray(value.recentTools)) {
    projected.recentTools = value.recentTools.slice(-MAX_SUBAGENT_RECENT_TOOLS).map((tool) => {
      if (!isRecord(tool)) return {};
      return {
        tool: boundedEventString(tool.tool, 120),
        args: boundedEventString(tool.args, 240),
        endMs: tool.endMs,
      };
    });
  }
  return projected;
}

function projectControlEvent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of ["index", "ts"]) if (value[key] !== undefined) projected[key] = value[key];
  for (const key of ["agent", "from", "to", "status", "reason"]) {
    const text = boundedEventString(value[key], key === "reason" ? 400 : 120);
    if (text !== undefined) projected[key] = text;
  }
  return projected;
}

function projectDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, unknown> = {};
  if (value.mode !== undefined) projected.mode = boundedEventString(value.mode, 80);
  if (value.totalSteps !== undefined) projected.totalSteps = value.totalSteps;
  const routing = projectRouting(value.routing);
  if (routing) projected.routing = routing;
  if (Array.isArray(value.progress)) {
    projected.progress = value.progress.slice(0, MAX_SUBAGENT_PROGRESS_ROWS).map(projectProgress).filter(Boolean);
  }
  if (Array.isArray(value.controlEvents)) {
    projected.controlEvents = value.controlEvents.slice(-MAX_SUBAGENT_CONTROL_EVENTS).map(projectControlEvent).filter(Boolean);
  }
  if (Array.isArray(value.results)) {
    projected.results = value.results.slice(0, MAX_SUBAGENT_PROGRESS_ROWS).map(projectResult);
  }
  if (Array.isArray(value.runs)) {
    projected.runs = value.runs.slice(0, MAX_SUBAGENT_PROGRESS_ROWS).map((run) => {
      if (!isRecord(run)) return {};
      const routing = projectRouting(run.routing);
      return routing ? { routing } : {};
    });
  }
  return projected;
}

function projectContent(value: unknown): unknown {
  if (!Array.isArray(value)) return [];
  const projected: Record<string, unknown>[] = [];
  let remainingChars = MAX_LIVE_SUBAGENT_OUTPUT_CHARS;
  for (const block of value.slice(-32).reverse()) {
    if (!isRecord(block) || typeof block.text !== "string" || remainingChars <= 0) continue;
    const text = block.text.slice(-remainingChars);
    remainingChars -= text.length;
    projected.unshift({ type: typeof block.type === "string" ? block.type : "text", text });
  }
  return projected;
}

/** Browser-safe summary projection; persisted Pi events remain unchanged. */
export function projectSubagentEvent<T extends ProjectableAgentEvent>(event: T): T {
  const envelope: ProjectableAgentEvent = { type: event.type };
  for (const key of ["toolCallId", "toolName", "isError"]) {
    if (event[key] !== undefined) envelope[key] = event[key];
  }
  if (event.type === "tool_execution_update") {
    const partialResult = isRecord(event.partialResult) ? event.partialResult : undefined;
    if (!partialResult) return event;
    envelope.partialResult = { content: [], details: projectDetails(partialResult.details) };
    return envelope as T;
  }
  if (event.type === "tool_execution_end") {
    const result = isRecord(event.result) ? event.result : undefined;
    if (!result) return event;
    envelope.result = { content: projectContent(result.content), details: projectDetails(result.details) };
    return envelope as T;
  }
  return event;
}
