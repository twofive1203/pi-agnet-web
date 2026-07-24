import assert from "node:assert/strict";
import { mergePersistedSubagentRuns, parsePersistedSubagentRuns } from "../lib/subagent-runs";
import type { AgentMessage } from "../lib/types";

const messages = [
  {
    role: "assistant",
    timestamp: 1000,
    content: [
      { type: "toolCall", toolCallId: "manage", toolName: "subagent", input: { action: "list" } },
      { type: "toolCall", toolCallId: "single", toolName: "subagent", input: { agent: "worker", task: "fix it", model: "provider/model" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "single",
    toolName: "subagent",
    content: [{ type: "text", text: "single done" }],
    details: { results: [{ sessionFile: "/tmp/single.jsonl", model: "resolved/model", thinking: "high" }] },
  },
  {
    role: "assistant",
    timestamp: 2000,
    content: [{
      type: "toolCall",
      toolCallId: "parallel",
      toolName: "subagent",
      input: { tasks: [{ agent: "scout", task: "one" }, { agent: "reviewer", task: "two", model: "review/model" }] },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "parallel",
    toolName: "subagent",
    content: [{ type: "text", text: "parallel done" }],
    details: { results: [{ sessionFile: "/tmp/one.jsonl", exitCode: 0 }, { sessionFile: "/tmp/two.jsonl", exitCode: 1, error: "review failed", routing: { source: "settings", model: "review/resolved" } }] },
  },
  {
    role: "assistant",
    timestamp: 3000,
    content: [{
      type: "toolCall",
      toolCallId: "chain",
      toolName: "subagent",
      input: { chain: [{ agent: "planner", task: "plan" }, { agent: "worker", task: "build" }] },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "chain",
    toolName: "subagent",
    content: [{ type: "text", text: "chain failed" }],
    details: { results: [{}, {}] },
    isError: true,
  },
] as unknown as AgentMessage[];

const runs = parsePersistedSubagentRuns(messages);
assert.equal(runs.length, 5, "management calls must be excluded and execution calls expanded");

assert.deepEqual(
  runs.map((run) => [run.id, run.agent, run.status]),
  [
    ["single", "worker", "completed"],
    ["parallel-0", "scout", "completed"],
    ["parallel-1", "reviewer", "failed"],
    ["chain-c0", "planner", "failed"],
    ["chain-c1", "worker", "failed"],
  ],
);
assert.equal(runs[0]?.result, "single done");
assert.equal(runs[0]?.sessionFile, "/tmp/single.jsonl");
assert.equal(runs[0]?.routing?.model, "resolved/model");
assert.equal(runs[2]?.routing?.model, "review/resolved");
assert.equal(runs[4]?.result, "chain failed");
assert.deepEqual(runs.map((run) => run.startedAt), [1000, 2000, 2001, 3000, 3001]);

const liveOnly = {
  ...runs[0]!,
  id: "live-only",
  status: "running" as const,
  startedAt: 4000,
  progress: { index: 0, agent: "worker", status: "running" as const, recentTools: [], toolCount: 1, tokens: 10, durationMs: 20 },
};
const liveUpdated = { ...runs[0]!, progress: liveOnly.progress };
const mergedSession = mergePersistedSubagentRuns(runs, [liveUpdated, liveOnly], 3500);
assert.equal(mergedSession[0]?.progress?.toolCount, 1, "newer SSE progress must survive disk replay");
assert.equal(mergedSession.at(-1)?.id, "live-only", "an SSE start newer than the disk snapshot must survive session load");
assert.equal(mergePersistedSubagentRuns(runs, [liveOnly]).some((run) => run.id === "live-only"), false, "branch replacement must drop rows outside that branch");
assert.equal(mergePersistedSubagentRuns(runs, [{ ...liveOnly, startedAt: 3000 }], 3500).some((run) => run.id === "live-only"), false, "session replay must not retain current-only rows older than the request");

console.log("smoke-subagent-session-runs: OK");
