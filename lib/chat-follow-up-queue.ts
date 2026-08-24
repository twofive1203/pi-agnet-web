import type { AgentMessage } from "@/lib/types";

/** Queue controls are valid only after a live prompt has a real session target. */
export function canSubmitQueuedMessage(input: {
  agentRunning: boolean;
  writeLocked: boolean;
  sessionId: string | null | undefined;
}): boolean {
  return input.agentRunning && !input.writeLocked && Boolean(input.sessionId);
}

/** Normalize the SDK's queue snapshot at the browser event/API boundary. */
export function normalizeFollowUpQueue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Return items removed from a queue snapshot while preserving duplicates and order. */
export function removedFollowUpItems(previous: readonly string[], next: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of next) remaining.set(item, (remaining.get(item) ?? 0) + 1);

  const removed: string[] = [];
  for (const item of previous) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) {
      remaining.set(item, count - 1);
    } else {
      removed.push(item);
    }
  }
  return removed;
}

export function agentMessageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}
