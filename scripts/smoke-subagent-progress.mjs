/**
 * Deterministic smoke checks for subagent live-progress projection helpers.
 * Run: node --import tsx scripts/smoke-subagent-progress.mjs
 */
import assert from "node:assert/strict";
import {
  matchProgressForRun,
  normalizeSubagentProgressList,
  normalizeSubagentProgressSnapshot,
  serializeSubagentRunsForFlush,
} from "../lib/subagent-progress.ts";
import {
  formatActivityBadge,
  formatDurationMs,
  formatProgressActivity,
  formatProgressStats,
  formatTokenCount,
  truncateText,
} from "../components/SubagentPanel.tsx";

function pass(name) {
  console.log(`ok - ${name}`);
}

// normalize: valid snapshot
{
  const snap = normalizeSubagentProgressSnapshot({
    index: 0,
    agent: "worker",
    status: "running",
    currentTool: "read",
    currentToolArgs: "a".repeat(300),
    recentTools: [
      { tool: "bash", args: "ls", endMs: 12 },
      { tool: 1, args: "bad" },
      { tool: "edit", args: "x", endMs: -1 },
    ],
    toolCount: 2,
    turnCount: 1,
    tokens: 45200,
    durationMs: 130000,
    activityState: "needs_attention",
  });
  assert.equal(snap?.agent, "worker");
  assert.equal(snap?.currentToolArgs?.length, 240);
  assert.equal(snap?.recentTools.length, 2);
  assert.equal(snap?.recentTools[1].endMs, 0);
  assert.equal(snap?.activityState, "needs_attention");
  pass("normalize valid snapshot with bounds");
}

// normalize: invalid entries dropped
{
  assert.equal(normalizeSubagentProgressSnapshot({ index: 0, agent: "w" }), null);
  assert.equal(normalizeSubagentProgressSnapshot({ index: 0, agent: "w", status: "nope" }), null);
  assert.deepEqual(
    normalizeSubagentProgressList([
      { index: 0, agent: "a", status: "running", toolCount: 1, tokens: 1, durationMs: 1, recentTools: [] },
      { bad: true },
      null,
    ]).map((p) => p.agent),
    ["a"],
  );
  pass("normalize drops malformed entries");
}

// match single / parallel / chain
{
  const list = normalizeSubagentProgressList([
    { index: 0, agent: "worker", status: "running", toolCount: 1, tokens: 1, durationMs: 1, recentTools: [] },
    { index: 1, agent: "reviewer", status: "completed", toolCount: 2, tokens: 2, durationMs: 2, recentTools: [] },
  ]);
  const tc = "call-1";
  assert.equal(matchProgressForRun({ id: tc, agent: "worker" }, tc, list)?.index, 0);
  assert.equal(matchProgressForRun({ id: `${tc}-1`, agent: "reviewer" }, tc, list)?.agent, "reviewer");
  assert.equal(matchProgressForRun({ id: `${tc}-c1`, agent: "reviewer" }, tc, list)?.index, 1);
  assert.equal(matchProgressForRun({ id: `${tc}-c0`, agent: "?" }, tc, list), null);
  pass("match single/parallel/chain by index and ignore chain parallel placeholders");
}

// ambiguous agent fallback must not cross-write
{
  const list = normalizeSubagentProgressList([
    { index: 0, agent: "worker", status: "running", toolCount: 1, tokens: 1, durationMs: 1, recentTools: [] },
    { index: 1, agent: "worker", status: "running", toolCount: 2, tokens: 2, durationMs: 2, recentTools: [] },
  ]);
  // Unknown index 9 with duplicate agent names -> no match
  assert.equal(matchProgressForRun({ id: "call-2-9", agent: "worker" }, "call-2", list), null);
  pass("ambiguous agent fallback fails soft");
}

// unique agent fallback
{
  const list = normalizeSubagentProgressList([
    { index: 5, agent: "reviewer", status: "running", toolCount: 1, tokens: 1, durationMs: 1, recentTools: [] },
  ]);
  assert.equal(matchProgressForRun({ id: "call-3-0", agent: "reviewer" }, "call-3", list)?.index, 5);
  pass("unique agent fallback works");
}

// flush serialization includes progress fields
{
  const a = serializeSubagentRunsForFlush([
    {
      id: "r1",
      agent: "worker",
      task: "t",
      status: "running",
      partialOutput: "huge-output-ignored",
      startedAt: 1,
      depth: 0,
      progress: {
        index: 0,
        agent: "worker",
        status: "running",
        currentTool: "bash",
        currentToolArgs: "echo hi",
        recentTools: [{ tool: "bash", args: "echo hi", endMs: 1 }],
        toolCount: 1,
        tokens: 10,
        durationMs: 1000,
        activityState: "active_long_running",
      },
    },
  ]);
  const b = serializeSubagentRunsForFlush([
    {
      id: "r1",
      agent: "worker",
      task: "t",
      status: "running",
      partialOutput: "different-output-still-ignored",
      startedAt: 1,
      depth: 0,
      progress: {
        index: 0,
        agent: "worker",
        status: "running",
        currentTool: "bash",
        currentToolArgs: "echo hi",
        recentTools: [{ tool: "bash", args: "echo hi", endMs: 1 }],
        toolCount: 1,
        tokens: 10,
        durationMs: 1000,
        activityState: "active_long_running",
      },
    },
  ]);
  const c = serializeSubagentRunsForFlush([
    {
      id: "r1",
      agent: "worker",
      task: "t",
      status: "running",
      partialOutput: "",
      startedAt: 1,
      depth: 0,
      progress: {
        index: 0,
        agent: "worker",
        status: "running",
        currentTool: "read",
        recentTools: [],
        toolCount: 2,
        tokens: 10,
        durationMs: 1000,
      },
    },
  ]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /active_long_running/);
  pass("flush key ignores output text and tracks progress");
}

// flush must notify when tool_execution_end attaches result/sessionFile after progress completed
{
  const baseProgress = {
    index: 0,
    agent: "worker",
    status: "completed",
    recentTools: [],
    toolCount: 3,
    tokens: 100,
    durationMs: 5000,
  };
  const afterProgressComplete = serializeSubagentRunsForFlush([
    {
      id: "call-end",
      agent: "worker",
      task: "t",
      status: "completed",
      partialOutput: "",
      startedAt: 1,
      depth: 0,
      progress: baseProgress,
    },
  ]);
  const afterToolEnd = serializeSubagentRunsForFlush([
    {
      id: "call-end",
      agent: "worker",
      task: "t",
      status: "completed", // same top-level status
      partialOutput: "",
      result: "final summary that must not be fully serialized but presence must flush",
      sessionFile: "/tmp/subagent-session.jsonl",
      startedAt: 1,
      depth: 0,
      routing: { source: "result", model: "provider/model", thinking: "low" },
      progress: baseProgress,
    },
  ]);
  assert.notEqual(
    afterProgressComplete,
    afterToolEnd,
    "end-event result/sessionFile/routing must change flush key even when status stays completed",
  );
  assert.match(afterToolEnd, /"hasResult":true/);
  assert.match(afterToolEnd, /subagent-session\.jsonl/);
  assert.doesNotMatch(afterToolEnd, /final summary that must not/);
  pass("flush key tracks end-event result/sessionFile without large output");
}

// UI formatters
{
  assert.equal(formatTokenCount(0), null);
  assert.equal(formatTokenCount(45200), "45.2k tok");
  assert.equal(formatDurationMs(130000), "2m 10s");
  assert.equal(formatProgressStats({ toolCount: 12, turnCount: 3, tokens: 45200, durationMs: 130000 }), "12 tools · 3 turns · 45.2k tok · 2m 10s");
  assert.equal(formatProgressStats({ toolCount: 0, tokens: 0, durationMs: 0 }), null);
  assert.equal(formatActivityBadge("needs_attention")?.label, "Needs attention");
  assert.equal(formatActivityBadge("active_long_running")?.label, "Long-running");
  assert.equal(formatProgressActivity({
    index: 0, agent: "w", status: "detached", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0,
  }, true)?.label, "Detached");
  assert.equal(formatProgressActivity({
    index: 0, agent: "w", status: "running", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0,
  }, true)?.label, "thinking…");
  assert.ok(truncateText("abcdefghij", 5).endsWith("…"));
  pass("panel formatters");
}

console.log("All subagent progress smoke checks passed.");
