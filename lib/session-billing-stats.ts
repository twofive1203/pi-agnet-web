import type { SessionBillingStats, SessionEntry, TokenUsage } from "@/lib/types";

function addUsage(stats: SessionBillingStats, usage: TokenUsage | undefined): void {
  if (!usage) return;
  stats.tokens.input += usage.input ?? 0;
  stats.tokens.output += usage.output ?? 0;
  stats.tokens.cacheRead += usage.cacheRead ?? 0;
  stats.tokens.cacheWrite += usage.cacheWrite ?? 0;
  stats.cost += usage.cost?.total ?? 0;
}

/**
 * Aggregate every persisted billed call in a parent session.
 *
 * Pi keeps compacted and abandoned-branch entries in the append-only JSONL.
 * Counting only the active context would therefore under-report historical cost.
 */
export function getSessionBillingStats(entries: readonly SessionEntry[]): SessionBillingStats {
  const stats: SessionBillingStats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
        addUsage(stats, entry.message.usage);
      }
      continue;
    }

    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(stats, entry.usage);
    }
  }

  return stats;
}

export function hasSessionBillingUsage(stats: SessionBillingStats): boolean {
  return stats.cost > 0
    || stats.tokens.input > 0
    || stats.tokens.output > 0
    || stats.tokens.cacheRead > 0
    || stats.tokens.cacheWrite > 0;
}
