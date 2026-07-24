/**
 * Deterministic smoke checks for direct current-chat SnFlow subagent dispatch.
 * Run: npx tsx scripts/smoke-workflow-chat-lifecycle.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { SNFLOW_ASSET_FILES } from "../lib/snflow-assets";
import {
  prepareWorkflowChatDispatch,
  WorkflowChatLifecycleObserver,
} from "../lib/workflow-chat-lifecycle";
import {
  buildPhasePrompt,
  buildWorkflowDispatchMarker,
  parseWorkflowDispatchMarker,
} from "../lib/workflow-prompts";
import {
  createWorkflowTask,
  getWorkflowTaskDetail,
  markWorkflowTaskReady,
  parseRunRecord,
  updateWorkflowTaskProjection,
} from "../lib/workflow-store";
import { setWorkflowCurrentTask } from "../lib/workflow-current";
import { reconcileWorkflowRun } from "../lib/workflow-run-manager";
import {
  getSnflowChatLifecycleLoadDiagnostic,
  isSnflowLifecycleRequired,
} from "../lib/rpc-manager";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readyTask(cwd: string, title: string, id: string) {
  const created = createWorkflowTask(cwd, { title, id });
  return markWorkflowTaskReady(cwd, id, created.revision);
}

function phasePrompt(
  cwd: string,
  task: ReturnType<typeof getWorkflowTaskDetail>,
  phase: "implement" | "check",
): string {
  return buildPhasePrompt({
    taskId: task.id,
    title: task.title,
    cwd,
    phase,
    taskRevision: task.revision,
    pathLabels: {
      taskJson: `.pi/snflows/tasks/${task.id}/task.json`,
      requirements: `.pi/snflows/tasks/${task.id}/requirements.md`,
      design: `.pi/snflows/tasks/${task.id}/design.md`,
      plan: `.pi/snflows/tasks/${task.id}/plan.md`,
    },
  });
}

const project = mkdtempSync(path.join(tmpdir(), "snflow-chat-"));
const otherProject = mkdtempSync(path.join(tmpdir(), "snflow-chat-other-"));

async function main() {
try {
  const lifecyclePath = "<inline:snflow-chat-lifecycle>";
  assert(
    getSnflowChatLifecycleLoadDiagnostic({
      extensions: [{ path: lifecyclePath }],
      errors: [],
    }) === null,
    "loaded lifecycle extension passes startup validation",
  );
  assert(
    getSnflowChatLifecycleLoadDiagnostic({ extensions: [], errors: [] })?.includes("was not loaded"),
    "missing lifecycle extension fails startup validation",
  );
  assert(
    getSnflowChatLifecycleLoadDiagnostic({
      extensions: [{ path: lifecyclePath }],
      errors: [{ path: lifecyclePath, error: "forced inline factory failure" }],
    })?.includes("forced inline factory failure"),
    "absorbed inline lifecycle factory error fails startup validation",
  );
  assert(
    getSnflowChatLifecycleLoadDiagnostic({
      extensions: [{ path: lifecyclePath }],
      errors: [{ path: "/optional/other-extension.ts", error: "unrelated failure" }],
    }) === null,
    "unrelated extension errors do not block a loaded lifecycle validator",
  );

  const snflowRoot = path.join(project, ".pi", "snflows");
  mkdirSync(snflowRoot, { recursive: true });
  writeFileSync(path.join(snflowRoot, "current.json"), "{}\n", "utf8");
  assert(!isSnflowLifecycleRequired(project), "stale current pointer does not activate SnFlow lifecycle");
  const otherSnflowRoot = path.join(otherProject, ".pi", "snflows");
  mkdirSync(otherSnflowRoot, { recursive: true });
  writeFileSync(path.join(otherSnflowRoot, "tasks"), "not a directory\n", "utf8");
  assert(!isSnflowLifecycleRequired(otherProject), "non-directory tasks path does not activate SnFlow lifecycle");

  const observer = new WorkflowChatLifecycleObserver(project);
  const first = readyTask(project, "Direct worker", "direct-worker");
  assert(isSnflowLifecycleRequired(project), "tasks directory activates SnFlow lifecycle");

  const ordinary = observer.beforeToolCall(
    {
      toolCallId: "ordinary-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: "Inspect this code without a SnFlow marker",
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(!ordinary.block, "ordinary native subagent remains untouched");
  assert(getWorkflowTaskDetail(project, first.id).activeRunId === null, "ordinary call creates no run");

  const malformed = observer.beforeToolCall(
    {
      toolCallId: "malformed-call",
      toolName: "subagent",
      input: { task: "SNFLOW_DISPATCH {bad-json" },
    },
    "chat-session",
  );
  assert(malformed.block, "malformed SnFlow marker blocks before launch");

  const staleMarker = buildWorkflowDispatchMarker({
    taskId: first.id,
    phase: "implement",
    revision: "0000000000000000",
    cwd: project,
  });
  const stale = observer.beforeToolCall(
    {
      toolCallId: "stale-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: staleMarker,
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(stale.block, "stale task revision blocks before launch");
  assert(getWorkflowTaskDetail(project, first.id).activeRunId === null, "blocked call holds no lock");

  const wrongCwd = observer.beforeToolCall(
    {
      toolCallId: "wrong-cwd-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: buildWorkflowDispatchMarker({
          taskId: first.id,
          phase: "implement",
          revision: first.revision,
          cwd: otherProject,
        }),
        context: "fresh",
        cwd: otherProject,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(wrongCwd.block, "marker/input cwd mismatch blocks before launch");

  const builtinAgent = observer.beforeToolCall(
    {
      toolCallId: "builtin-agent-call",
      toolName: "subagent",
      input: {
        agent: "worker",
        task: phasePrompt(project, first, "implement"),
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(builtinAgent.block, "marked implement rejects builtin worker");
  assert(builtinAgent.reason?.includes("snflow-implement"), "rejection names required project agent");

  const start = observer.beforeToolCall(
    {
      toolCallId: "worker-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: phasePrompt(project, first, "implement"),
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(!start.block, `valid direct snflow-implement was blocked: ${start.reason ?? ""}`);
  const active = getWorkflowTaskDetail(project, first.id);
  assert(active.status === "implementing", "snflow-implement projects implementing");
  assert(active.activeRunId !== null, "snflow-implement owns active run lock");
  const activeRun = active.runs.find((run) => run.id === active.activeRunId);
  assert(activeRun?.parentSessionId === "chat-session", "parent chat session persisted");
  assert(activeRun?.parentToolCallId === "worker-call", "parent tool call persisted");

  const second = readyTask(project, "Concurrent worker", "concurrent-worker");
  const concurrent = observer.beforeToolCall(
    {
      toolCallId: "concurrent-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: phasePrompt(project, second, "implement"),
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(concurrent.block, "second writer in the same canonical cwd is blocked");

  observer.onToolUpdate(
    {
      toolCallId: "worker-call",
      toolName: "subagent",
      partialResult: {
        details: {
          progress: [{ tokens: 42, toolCount: 3, turnCount: 2 }],
          routing: { model: "test/provider-model", thinking: "high" },
        },
      },
    },
    "chat-session",
  );
  const progressed = observer.getTrackedRun("chat-session", "worker-call");
  assert(progressed?.tokenUsage?.total === 42, "bounded token progress persisted");
  assert(progressed?.toolCount === 3 && progressed.turnCount === 2, "tool/turn progress persisted");
  assert(progressed?.model === "test/provider-model" && progressed.thinking === "high", "routing progress persisted");

  observer.onToolResult(
    {
      toolCallId: "worker-call",
      toolName: "subagent",
      content: [{ type: "text", text: '```json\n{"summary":"implemented","changedFiles":["src/a.ts"],"validation":[],"residualRisks":[]}\n```' }],
      details: { results: [{ model: "native/model", thinking: "medium", sessionFile: "/tmp/child.jsonl" }] },
      isError: false,
    },
    "chat-session",
  );
  const implemented = getWorkflowTaskDetail(project, first.id);
  assert(implemented.status === "review_ready", "successful implement projects review_ready");
  assert(implemented.activeRunId === null, "implement terminal result releases lock");
  const implementRun = implemented.runs.find((run) => run.parentToolCallId === "worker-call");
  assert(implementRun?.state === "completed", "implement run completed");
  assert(implementRun?.implementResult?.changedFiles[0] === "src/a.ts", "implement result normalized");
  assert(implementRun?.model === "native/model", "final native model persisted");

  const checkStart = observer.beforeToolCall(
    {
      toolCallId: "reviewer-call",
      toolName: "subagent",
      input: {
        agent: "snflow-check",
        task: phasePrompt(project, implemented, "check"),
        context: "fresh",
        cwd: project,
        async: false,
        clarify: false,
      },
    },
    "chat-session",
  );
  assert(!checkStart.block, `valid direct snflow-check was blocked: ${checkStart.reason ?? ""}`);
  observer.onToolResult(
    {
      toolCallId: "reviewer-call",
      toolName: "subagent",
      content: [{ type: "text", text: '```json\n{"verdict":"pass","summary":"checked","findings":[],"validation":[]}\n```' }],
      details: {},
      isError: false,
    },
    "chat-session",
  );
  const checked = getWorkflowTaskDetail(project, first.id);
  assert(checked.status === "ready_to_commit", "passing snflow-check projects ready_to_commit");
  assert(checked.activeRunId === null, "review terminal result releases lock");

  const cancelProject = mkdtempSync(path.join(tmpdir(), "snflow-chat-cancel-"));
  try {
    const cancelObserver = new WorkflowChatLifecycleObserver(cancelProject);
    const cancelTask = readyTask(cancelProject, "Cancel worker", "cancel-worker");
    const accepted = cancelObserver.beforeToolCall(
      {
        toolCallId: "cancel-call",
        toolName: "subagent",
        input: {
          agent: "snflow-implement",
          task: phasePrompt(cancelProject, cancelTask, "implement"),
          context: "fresh",
          cwd: cancelProject,
          async: false,
          clarify: false,
        },
      },
      "cancel-session",
    );
    assert(!accepted.block, "cancel fixture starts");
    cancelObserver.onToolResult(
      {
        toolCallId: "cancel-call",
        toolName: "subagent",
        content: [{ type: "text", text: "Operation aborted by user" }],
        isError: true,
      },
      "cancel-session",
    );
    const cancelled = getWorkflowTaskDetail(cancelProject, cancelTask.id);
    assert(cancelled.status === "cancelled", "aborted native run projects cancelled");
    assert(cancelled.activeRunId === null, "cancelled run releases lock");
  } finally {
    rmSync(cancelProject, { recursive: true, force: true });
  }

  const marker = parseWorkflowDispatchMarker(phasePrompt(project, checked, "check"));
  assert(marker?.taskId === checked.id && marker.phase === "check", "phase prompt starts with marker");

  const detailCases = [
    { id: "child-failed", details: { results: [{ exitCode: 1, error: "child failed" }] }, state: "failed", status: "failed" },
    { id: "child-stopped", details: { results: [{ exitCode: 0, stopped: true }] }, state: "cancelled", status: "cancelled" },
    { id: "child-timeout", details: { results: [{ exitCode: 1, timedOut: true }] }, state: "failed", status: "failed" },
    { id: "outer-interrupted", details: { interrupted: true, results: [{ exitCode: 0 }] }, state: "cancelled", status: "cancelled" },
  ] as const;
  for (const fixture of detailCases) {
    const fixtureProject = mkdtempSync(path.join(tmpdir(), `snflow-${fixture.id}-`));
    try {
      const fixtureObserver = new WorkflowChatLifecycleObserver(fixtureProject);
      const fixtureTask = readyTask(fixtureProject, fixture.id, fixture.id);
      const accepted = fixtureObserver.beforeToolCall({
        toolCallId: fixture.id,
        toolName: "subagent",
        input: {
          agent: "snflow-implement",
          task: phasePrompt(fixtureProject, fixtureTask, "implement"),
          context: "fresh",
          cwd: fixtureProject,
          async: false,
          clarify: false,
        },
      }, "sdk-boundary-session");
      assert(!accepted.block, `${fixture.id} fixture starts`);
      fixtureObserver.onToolResult({
        toolCallId: fixture.id,
        toolName: "subagent",
        content: [{ type: "text", text: "outer SDK result" }],
        details: fixture.details,
        isError: false,
      }, "sdk-boundary-session");
      const terminal = getWorkflowTaskDetail(fixtureProject, fixture.id);
      const terminalRun = terminal.runs.find((run) => run.parentToolCallId === fixture.id);
      assert(terminalRun?.state === fixture.state, `${fixture.id} uses native result details`);
      assert(terminal.status === fixture.status && terminal.activeRunId === null, `${fixture.id} repairs task projection`);
    } finally {
      rmSync(fixtureProject, { recursive: true, force: true });
    }
  }

  const dispatchProject = mkdtempSync(path.join(tmpdir(), "snflow-dispatch-bind-"));
  try {
    const taskA = readyTask(dispatchProject, "Task A", "task-a");
    const taskB = readyTask(dispatchProject, "Task B", "task-b");
    setWorkflowCurrentTask(dispatchProject, taskA.id, { source: "agent" });
    const prepared = prepareWorkflowChatDispatch(dispatchProject, taskB.id, "implement", taskB.revision);
    const preparedMarker = parseWorkflowDispatchMarker(prepared.dispatchPrompt.split("```text\n")[1]);
    assert(preparedMarker?.taskId === taskB.id, "selected task B dispatch does not use current pointer task A");
    assert(preparedMarker.revision === taskB.revision, "selected task revision is exact");
  } finally {
    rmSync(dispatchProject, { recursive: true, force: true });
  }

  const repairProject = mkdtempSync(path.join(tmpdir(), "snflow-terminal-repair-"));
  try {
    const repairObserver = new WorkflowChatLifecycleObserver(repairProject);
    const repairTask = readyTask(repairProject, "Repair terminal projection", "repair-terminal");
    const accepted = repairObserver.beforeToolCall({
      toolCallId: "repair-call",
      toolName: "subagent",
      input: { agent: "snflow-implement", task: phasePrompt(repairProject, repairTask, "implement"), context: "fresh", cwd: repairProject, async: false, clarify: false },
    }, "repair-session");
    assert(!accepted.block, "repair fixture starts");
    repairObserver.onToolResult({
      toolCallId: "repair-call",
      toolName: "subagent",
      content: [{ type: "text", text: '{"summary":"done","changedFiles":[],"validation":[],"residualRisks":[]}' }],
      details: { results: [{ exitCode: 0 }] },
      isError: false,
    }, "repair-session");
    const completedRun = getWorkflowTaskDetail(repairProject, repairTask.id).runs.find((run) => run.parentToolCallId === "repair-call");
    assert(completedRun?.state === "completed", "repair fixture has terminal run record");
    updateWorkflowTaskProjection(repairProject, repairTask.id, (task) => ({
      ...task,
      status: "implementing",
      activeRunId: completedRun.id,
      latestImplementRunId: null,
    }));
    const repaired = await reconcileWorkflowRun(repairProject, completedRun.id);
    assert(repaired.task.status === "review_ready", "reconciliation repairs terminal task status");
    assert(repaired.task.activeRunId === null, "reconciliation releases terminal activeRunId");
    assert(repaired.task.latestImplementRunId === completedRun.id, "reconciliation repairs latest run id");
  } finally {
    rmSync(repairProject, { recursive: true, force: true });
  }

  const historical = parseRunRecord({
    schemaVersion: 1,
    id: "legacy-run",
    taskId: first.id,
    phase: "implement",
    agentName: "worker",
    state: "completed",
    requestedCwd: project,
    effectiveCwd: project,
    hostSessionId: "legacy-host",
    taskRevision: first.revision,
    nativeRunId: null,
    asyncDir: null,
    sessionFile: null,
    outputFile: null,
    model: null,
    thinking: null,
    summary: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    lastReconciledAt: null,
    error: null,
    implementResult: null,
    checkResult: null,
  });
  assert(!historical.parentSessionId && !historical.parentToolCallId, "historical runs remain readable");

  const managedGuidance = SNFLOW_ASSET_FILES
    .filter((file) => file.path.includes("extensions/snflow") || file.path.includes("skills/snflow-dev"))
    .map((file) => file.content)
    .join("\n");
  assert(!managedGuidance.includes("scripts/snflow-task.ts implement\n"), "managed guidance removes CLI implement command");
  assert(!managedGuidance.includes("scripts/snflow-task.ts wait\n"), "managed guidance removes CLI wait command");
  assert(managedGuidance.includes("SNFLOW_DISPATCH"), "managed guidance documents direct marker");
  assert(managedGuidance.includes("snflow-implement"), "managed guidance routes implementation to project agent");
  assert(managedGuidance.includes("snflow-check"), "managed guidance routes review to project agent");
  assert(!managedGuidance.includes("builtin worker"), "managed guidance no longer routes to builtin worker");
  assert(!managedGuidance.includes(".trellis/tasks"), "direct path does not require Trellis task storage");

  console.log("OK workflow chat lifecycle smoke");
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(otherProject, { recursive: true, force: true });
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
