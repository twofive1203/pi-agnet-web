import assert from "node:assert/strict";
import { SubagentStore } from "../lib/subagent-store";
import type { SubagentRun } from "../lib/subagent-runs";

function run(id: string, status: SubagentRun["status"]): SubagentRun {
  return {
    id,
    agent: "worker",
    task: id,
    status,
    partialOutput: "",
    startedAt: 1,
    depth: 0,
  };
}

const store = new SubagentStore();
let runNotifications = 0;
let countNotifications = 0;
const unsubscribeRuns = store.subscribeRuns(() => { runNotifications += 1; });
const unsubscribeCounts = store.subscribeCounts(() => { countNotifications += 1; });
const emptyCounts = store.getCountsSnapshot();

const running = [run("a", "running")];
store.setRuns(running);
assert.deepEqual(store.getCountsSnapshot(), { running: 1, completed: 0, failed: 0 });
assert.equal(runNotifications, 1);
assert.equal(countNotifications, 1);

store.setRuns([{
  ...running[0]!,
  progress: { index: 0, agent: "worker", status: "running", recentTools: [], toolCount: 1, tokens: 1, durationMs: 1 },
}]);
assert.equal(runNotifications, 2, "row subscribers receive progress changes");
assert.equal(countNotifications, 1, "count subscribers ignore progress-only changes");
assert.equal(store.getCountsSnapshot().running, 1);

store.setRuns([run("a", "failed"), run("b", "completed")]);
assert.deepEqual(store.getCountsSnapshot(), { running: 0, completed: 1, failed: 1 });
assert.equal(countNotifications, 2);

store.reset();
assert.deepEqual(store.getRunsSnapshot(), []);
assert.strictEqual(store.getCountsSnapshot(), emptyCounts, "reset restores stable empty count snapshot");
assert.equal(runNotifications, 4);
assert.equal(countNotifications, 3);

unsubscribeRuns();
unsubscribeCounts();
store.setRuns([run("c", "running")]);
assert.equal(runNotifications, 4);
assert.equal(countNotifications, 3);

console.log("smoke-subagent-store: OK");
