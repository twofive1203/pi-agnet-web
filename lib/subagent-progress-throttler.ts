export interface ThrottledAgentEvent {
  type: string;
  toolCallId?: unknown;
  partialResult?: unknown;
}

type PendingEvent<T> = {
  event: T;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function immediateProgressSignature(event: ThrottledAgentEvent): string | null {
  const partialResult = isRecord(event.partialResult) ? event.partialResult : undefined;
  const details = isRecord(partialResult?.details) ? partialResult.details : undefined;
  const signatures: string[] = [];
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  for (let index = 0; index < Math.min(progress.length, 64); index += 1) {
    const item = progress[index];
    if (!isRecord(item)) continue;
    if (item.status === "failed" || item.status === "timeout" || item.timedOut === true) {
      signatures.push(`progress:${String(item.index ?? index)}:${String(item.status ?? "timeout")}`);
    } else if (item.activityState === "needs_attention" || item.activityState === "active_long_running") {
      signatures.push(`progress:${String(item.index ?? index)}:${item.activityState}`);
    }
  }
  const controlEvents = Array.isArray(details?.controlEvents) ? details.controlEvents : [];
  for (let index = Math.max(0, controlEvents.length - 64); index < controlEvents.length; index += 1) {
    const item = controlEvents[index];
    if (!isRecord(item)) continue;
    const state = item.to ?? item.status;
    if (state === "needs_attention" || state === "active_long_running" || state === "failed" || state === "timeout") {
      signatures.push(`control:${String(item.index ?? "")}:${String(item.ts ?? index)}:${state}`);
    }
  }
  return signatures.length > 0 ? signatures.join("|") : null;
}

/**
 * Coalesces only ordinary subagent progress. Start/end and attention/error states
 * remain immediate, and a pending latest snapshot is flushed before tool end.
 */
export class SubagentProgressThrottler<T extends ThrottledAgentEvent> {
  private readonly pending = new Map<string, PendingEvent<T>>();
  private readonly lastDeliveredAt = new Map<string, number>();
  private readonly lastImmediateSignature = new Map<string, string>();

  constructor(
    private readonly deliver: (event: T) => void,
    private readonly intervalMs = 300,
    private readonly now: () => number = Date.now,
    private readonly onCoalesced: () => void = () => {},
    private readonly onImmediateProgress: () => void = () => {},
  ) {}

  handle(event: T, isSubagentEvent: boolean): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!isSubagentEvent || !toolCallId || event.type !== "tool_execution_update") {
      if (toolCallId && event.type === "tool_execution_end") {
        this.flush(toolCallId);
        this.deliver(event);
        this.lastDeliveredAt.delete(toolCallId);
        this.lastImmediateSignature.delete(toolCallId);
        return;
      }
      this.deliver(event);
      return;
    }

    const immediateSignature = immediateProgressSignature(event);
    if (immediateSignature && this.lastImmediateSignature.get(toolCallId) !== immediateSignature) {
      this.discardPending(toolCallId);
      this.lastImmediateSignature.set(toolCallId, immediateSignature);
      this.lastDeliveredAt.set(toolCallId, this.now());
      this.onImmediateProgress();
      this.deliver(event);
      return;
    }
    if (!immediateSignature) this.lastImmediateSignature.delete(toolCallId);

    const currentTime = this.now();
    const lastDelivered = this.lastDeliveredAt.get(toolCallId);
    if (lastDelivered === undefined || currentTime - lastDelivered >= this.intervalMs) {
      this.discardPending(toolCallId);
      this.lastDeliveredAt.set(toolCallId, currentTime);
      this.deliver(event);
      return;
    }

    const existing = this.pending.get(toolCallId);
    if (existing) {
      existing.event = event;
    } else {
      const delay = Math.max(0, this.intervalMs - (currentTime - lastDelivered));
      const timer = setTimeout(() => this.flush(toolCallId), delay);
      timer.unref?.();
      this.pending.set(toolCallId, { event, timer });
    }
    this.onCoalesced();
  }

  flush(toolCallId: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
    this.lastDeliveredAt.set(toolCallId, this.now());
    this.deliver(pending.event);
  }

  clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.lastDeliveredAt.clear();
    this.lastImmediateSignature.clear();
  }

  private discardPending(toolCallId: string): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(toolCallId);
  }
}
