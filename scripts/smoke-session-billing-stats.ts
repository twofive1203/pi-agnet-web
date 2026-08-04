import assert from "node:assert/strict";
import type { SessionEntry, TokenUsage } from "../lib/types";
import { getSessionBillingStats } from "../lib/session-billing-stats";

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
): TokenUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

const timestamp = "2026-08-04T00:00:00.000Z";
const entries = [
  {
    type: "message",
    id: "old-assistant",
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "old" }],
      provider: "test",
      model: "test",
      usage: usage(100, 10, 1_000, 0, 1),
    },
  },
  {
    type: "message",
    id: "abandoned-branch-assistant",
    parentId: "old-assistant",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "branch" }],
      provider: "test",
      model: "test",
      usage: usage(200, 20, 2_000, 0, 2),
    },
  },
  {
    type: "branch_summary",
    id: "branch-summary",
    parentId: "old-assistant",
    timestamp,
    fromId: "abandoned-branch-assistant",
    summary: "summary",
    usage: usage(30, 3, 300, 0, 0.3),
  },
  {
    type: "compaction",
    id: "compaction",
    parentId: "branch-summary",
    timestamp,
    summary: "compact",
    firstKeptEntryId: "old-assistant",
    tokensBefore: 1_000,
    usage: usage(40, 4, 400, 0, 0.4),
  },
  {
    type: "message",
    id: "tool-result-usage",
    parentId: "compaction",
    timestamp,
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "tool" }],
      usage: usage(50, 5, 500, 6, 0.5),
    },
  },
  {
    type: "message",
    id: "current-assistant",
    parentId: "tool-result-usage",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "current" }],
      provider: "test",
      model: "test",
      usage: usage(60, 6, 600, 7, 0.6),
    },
  },
] satisfies SessionEntry[];

const stats = getSessionBillingStats(entries);
assert.deepEqual(stats.tokens, {
  input: 480,
  output: 48,
  cacheRead: 4_800,
  cacheWrite: 13,
});
assert.ok(Math.abs(stats.cost - 4.8) < Number.EPSILON * 10);

assert.deepEqual(getSessionBillingStats([]), {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
});

console.log("Session billing stats smoke checks passed.");
