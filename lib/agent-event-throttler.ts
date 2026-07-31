export interface StreamAgentEvent {
  type: string;
}

/**
 * Caps token-level message snapshots while preserving protocol order.
 * The first snapshot is immediate, the latest pending snapshot is retained, and
 * every non-update event acts as a barrier that flushes text before lifecycle events.
 */
export class AgentEventThrottler<T extends StreamAgentEvent> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDeliveredAt: number | null = null;

  constructor(
    private readonly deliver: (event: T) => void,
    private readonly intervalMs = 50,
    private readonly now: () => number = Date.now,
  ) {}

  handle(event: T): void {
    if (event.type !== "message_update") {
      this.flush();
      this.deliver(event);
      if (event.type === "message_end" || event.type === "agent_end" || event.type === "prompt_settled") {
        this.lastDeliveredAt = null;
      }
      return;
    }

    const currentTime = this.now();
    if (this.lastDeliveredAt === null || currentTime - this.lastDeliveredAt >= this.intervalMs) {
      this.discardPending();
      this.lastDeliveredAt = currentTime;
      this.deliver(event);
      return;
    }

    this.pending = event;
    if (this.timer) return;
    const delay = Math.max(0, this.intervalMs - (currentTime - this.lastDeliveredAt));
    this.timer = setTimeout(() => this.flush(), delay);
    this.timer.unref?.();
  }

  flush(): void {
    if (!this.pending) return;
    const event = this.pending;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastDeliveredAt = this.now();
    this.deliver(event);
  }

  clear(): void {
    this.discardPending();
    this.lastDeliveredAt = null;
  }

  private discardPending(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
