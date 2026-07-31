/**
 * Deterministic smoke checks for direct current-chat SnFlow subagent dispatch.
 * Run: npx tsx scripts/smoke-workflow-chat-lifecycle.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
  beginWorkflowRun,
  createWorkflowTask,
  getWorkflowTaskDetail,
  markWorkflowTaskReady,
  parseRunRecord,
  updateWorkflowTaskProjection,
  writeWorkflowRunRecord,
} from "../lib/workflow-store";
import { setWorkflowCurrentTask } from "../lib/workflow-current";
import { reconcileWorkflowRun } from "../lib/workflow-run-manager";
import {
  getSnflowChatLifecycleLoadDiagnostic,
  isSnflowLifecycleRequired,
} from "../lib/workflow-lifecycle-load";

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
        agentContract: { version: 1 },
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
        agentContract: { version: 1 },
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
        agentContract: { version: 1 },
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
        agentContract: { version: 1 },
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
        agentContract: { version: 1 },
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
  assert(activeRun?.taskRevision === first.revision, "run preserves the approved dispatch revision");
  assert(active.revision !== first.revision, "live task revision changes when lifecycle state starts");

  const second = readyTask(project, "Concurrent worker", "concurrent-worker");
  const concurrent = observer.beforeToolCall(
    {
      toolCallId: "concurrent-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: phasePrompt(project, second, "implement"),
        context: "fresh",
        agentContract: { version: 1 },
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
      content: [{ type: "text", text: "Wrapper mentions cancel test, aborted request test, context.Canceled, and interrupt handler" }],
      details: { results: [{
        exitCode: 0,
        execution: { status: "completed", success: true, exitCode: 0 },
        acceptance: { status: "checked" },
        finalOutput: '```json\n{"summary":"implemented cancel test, aborted request test, and interrupt handler safely","outcome":"changed","acceptanceSatisfied":true,"changedFiles":["src/a.ts"],"validation":[],"residualRisks":[]}\n```',
        model: "native/model",
        thinking: "medium",
        sessionFile: "/tmp/child.jsonl",
      }] },
      isError: true,
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
        agentContract: { version: 1 },
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
      content: [{ type: "text", text: "Subagent completed without making edits for an implementation task." }],
      details: { results: [{
        exitCode: 0,
        execution: { status: "completed", success: true, exitCode: 0 },
        effects: { fileMutation: { status: "not-applicable", expected: false, attempted: false } },
        finalOutput: '```json\n{"verdict":"pass","summary":"checked","findings":[],"validation":[]}\n```',
      }] },
      isError: true,
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
          agentContract: { version: 1 },
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
    const wrapperOnly = getWorkflowTaskDetail(cancelProject, cancelTask.id);
    assert(wrapperOnly.status === "implementing", "wrapper cancellation prose cannot terminate a run");
    assert(wrapperOnly.activeRunId !== null, "wrapper-only result keeps the run lock");
    cancelObserver.onToolResult(
      {
        toolCallId: "cancel-call",
        toolName: "subagent",
        details: { results: [{ exitCode: 0, stopped: true }] },
        isError: true,
      },
      "cancel-session",
    );
    const cancelled = getWorkflowTaskDetail(cancelProject, cancelTask.id);
    assert(cancelled.status === "cancelled", "structured stopped result projects cancelled");
    assert(cancelled.activeRunId === null, "structured cancellation releases lock");
  } finally {
    rmSync(cancelProject, { recursive: true, force: true });
  }

  const orderedProject = mkdtempSync(path.join(tmpdir(), "snflow-chat-event-order-"));
  try {
    const orderedObserver = new WorkflowChatLifecycleObserver(orderedProject);
    const orderedTask = readyTask(orderedProject, "Event order", "event-order");
    const accepted = orderedObserver.beforeToolCall({
      toolCallId: "ordered-call",
      toolName: "subagent",
      input: {
        agent: "snflow-implement",
        task: phasePrompt(orderedProject, orderedTask, "implement"),
        context: "fresh",
        cwd: orderedProject,
        async: false,
        clarify: false,
      },
    }, "ordered-session");
    assert(!accepted.block, "legacy marked dispatch without agentContract remains compatible");
    orderedObserver.onToolResult({
      toolCallId: "ordered-call",
      toolName: "subagent",
      content: [{ type: "text", text: "Operation cancelled by wrapper" }],
      isError: true,
    }, "ordered-session");
    assert(getWorkflowTaskDetail(orderedProject, orderedTask.id).status === "implementing", "wrapper-only event remains non-terminal");
    orderedObserver.onToolResult({
      toolCallId: "ordered-call",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "wrapper" }],
        details: { results: [{
          exitCode: 0,
          execution: { status: "completed", success: true, exitCode: 0 },
          finalOutput: '```json\n{"summary":"completed after wrapper","outcome":"changed","acceptanceSatisfied":true,"changedFiles":["src/a.ts"],"validation":[],"residualRisks":[]}\n```',
        }] },
      },
      isError: false,
    }, "ordered-session");
    assert(getWorkflowTaskDetail(orderedProject, orderedTask.id).status === "review_ready", "later structured child result repairs wrapper projection");
  } finally {
    rmSync(orderedProject, { recursive: true, force: true });
  }

  const checkedPrompt = phasePrompt(project, checked, "check");
  const marker = parseWorkflowDispatchMarker(checkedPrompt);
  assert(marker?.taskId === checked.id && marker.phase === "check", "phase prompt starts with marker");
  assert(checkedPrompt.includes("Legacy dispatch"), "legacy prompt keeps explicit-path compatibility");

  const detailCases = [
    { id: "child-failed", details: { results: [{ exitCode: 1, error: "child failed" }] }, state: "failed", status: "failed" },
    { id: "child-stopped", details: { results: [{ exitCode: 0, stopped: true }] }, state: "cancelled", status: "cancelled" },
    { id: "child-timeout", details: { results: [{ exitCode: 1, timedOut: true }] }, state: "failed", status: "failed" },
    { id: "child-outranks-wrapper", details: { interrupted: true, results: [{ exitCode: 0 }] }, state: "completed", status: "review_ready" },
    { id: "legacy-final-output", details: { results: [{ finalOutput: '{"summary":"legacy complete","outcome":"changed","acceptanceSatisfied":true,"changedFiles":["example.ts"],"validation":[],"residualRisks":[]}' }] }, state: "completed", status: "review_ready" },
    { id: "invalid-no-change", details: { results: [{ exitCode: 0, effects: { fileMutation: { status: "missing", expected: true, attempted: false } } }] }, state: "failed", status: "failed" },
    { id: "v1-acceptance-separate", details: { results: [{ exitCode: 0, execution: { status: "completed", success: true, exitCode: 0 }, acceptance: { status: "rejected" } }] }, state: "completed", status: "review_ready" },
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
          agentContract: { version: 1 },
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
    const preparedTask = prepared.dispatchPrompt.split("```text\n")[1]?.split("\n```")[0] ?? "";
    const preparedMarker = parseWorkflowDispatchMarker(preparedTask);
    assert(preparedMarker?.taskId === taskB.id, "selected task B dispatch does not use current pointer task A");
    assert(preparedMarker.revision === taskB.revision, "selected task state revision is exact");
    assert(Boolean(preparedMarker.runId && preparedMarker.specRevision), "new dispatch binds run id and specification revision");
    writeFileSync(
      path.join(dispatchProject, ".pi", "snflows", "tasks", taskB.id, "requirements.md"),
      "# changed after prepare\n",
      "utf8",
    );
    const drifted = new WorkflowChatLifecycleObserver(dispatchProject).beforeToolCall({
      toolCallId: "drifted-spec",
      toolName: "subagent",
      input: { agent: "snflow-implement", task: preparedTask, context: "fresh", agentContract: { version: 1 }, cwd: dispatchProject, async: false, clarify: false },
    }, "dispatch-session");
    assert(drifted.block && drifted.reason?.includes("Specification changed"), "document drift blocks before run reservation");
    assert(getWorkflowTaskDetail(dispatchProject, taskB.id).activeRunId === null, "drifted dispatch holds no run lock");

    const taskC = readyTask(dispatchProject, "Task C", "task-c");
    const bound = prepareWorkflowChatDispatch(dispatchProject, taskC.id, "implement", taskC.revision);
    const boundTask = bound.dispatchPrompt.split("```text\n")[1]?.split("\n```")[0] ?? "";
    const boundMarker = parseWorkflowDispatchMarker(boundTask);
    assert(boundTask.includes("run record's taskRevision/specRevision"), "bound prompt explains run-snapshot validation");
    const boundObserver = new WorkflowChatLifecycleObserver(dispatchProject);
    const accepted = boundObserver.beforeToolCall({
      toolCallId: "bound-spec",
      toolName: "subagent",
      input: { agent: "snflow-implement", task: boundTask, context: "fresh", agentContract: { version: 1 }, cwd: dispatchProject, async: false, clarify: false },
    }, "dispatch-session");
    assert(!accepted.block, `bound dispatch starts: ${accepted.reason ?? ""}`);
    const boundRun = getWorkflowTaskDetail(dispatchProject, taskC.id).runs.find((run) => run.id === boundMarker?.runId);
    assert(boundRun, "bound run record exists");
    assert(boundRun.specRevision === boundMarker?.specRevision, "run preserves approved specification revision");
    assert(Boolean(boundRun.snapshotPaths), "run owns immutable document snapshot paths");
    writeFileSync(
      path.join(dispatchProject, ".pi", "snflows", "tasks", taskC.id, "requirements.md"),
      "# live document changed after reservation\n",
      "utf8",
    );
    const requirementSnapshot = boundRun?.snapshotPaths?.requirements;
    assert(
      requirementSnapshot && readFileSync(path.join(dispatchProject, ...requirementSnapshot.split("/")), "utf8") === taskC.documents.requirements,
      "run snapshot preserves approved requirements bytes",
    );
    writeFileSync(
      path.join(dispatchProject, ...requirementSnapshot.split("/")),
      "# tampered run snapshot\n",
      "utf8",
    );
    boundObserver.onToolResult({
      toolCallId: "bound-spec",
      toolName: "subagent",
      details: { results: [{ exitCode: 0, finalOutput: '{"summary":"done","outcome":"changed","acceptanceSatisfied":true,"changedFiles":["example.ts"],"validation":[],"residualRisks":[]}' }] },
      isError: false,
    }, "dispatch-session");
    const tampered = getWorkflowTaskDetail(dispatchProject, taskC.id);
    const tamperedRun = tampered.runs.find((run) => run.id === boundRun.id);
    assert(tamperedRun?.state === "failed" && tamperedRun.error?.code === "snapshot_integrity", "snapshot tampering fails terminal projection closed");
    assert(tampered.activeRunId === null, "snapshot-integrity failure releases the run lock");
  } finally {
    rmSync(dispatchProject, { recursive: true, force: true });
  }

  for (const fixture of [
    {
      id: "status-steps-effects",
      status: {
        state: "completed",
        steps: [{ status: "complete", exitCode: 0, effects: { fileMutation: { status: "missing", expected: true } } }],
      },
    },
    {
      id: "nested-result-details",
      status: {
        state: "completed",
        result: { details: { results: [{ exitCode: 0, effects: { fileMutation: { status: "missing", expected: true } } }] } },
      },
    },
  ]) {
    const reconciliationProject = mkdtempSync(path.join(tmpdir(), `snflow-${fixture.id}-`));
    try {
      const task = readyTask(reconciliationProject, fixture.id, fixture.id);
      const begun = beginWorkflowRun(reconciliationProject, task.id, {
        phase: "implement",
        expectedRevision: task.revision,
        agentName: "snflow-implement",
        hostSessionId: "compat-host",
        requestedCwd: reconciliationProject,
        effectiveCwd: reconciliationProject,
      });
      const asyncDir = path.join(reconciliationProject, `.async-${fixture.id}`);
      mkdirSync(asyncDir, { recursive: true });
      writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(fixture.status), "utf8");
      writeWorkflowRunRecord(reconciliationProject, task.id, {
        ...begun.run,
        state: "running",
        startedAt: new Date().toISOString(),
        asyncDir,
      });
      const reconciled = await reconcileWorkflowRun(reconciliationProject, begun.run.id);
      assert(reconciled.run.state === "failed", `${fixture.id} applies structured mutation effects during reconciliation`);
      assert(reconciled.run.error?.code === "invalid_no_change", `${fixture.id} uses the shared terminal reducer`);
    } finally {
      rmSync(reconciliationProject, { recursive: true, force: true });
    }
  }

  const repairProject = mkdtempSync(path.join(tmpdir(), "snflow-terminal-repair-"));
  try {
    const repairObserver = new WorkflowChatLifecycleObserver(repairProject);
    const repairTask = readyTask(repairProject, "Repair terminal projection", "repair-terminal");
    const accepted = repairObserver.beforeToolCall({
      toolCallId: "repair-call",
      toolName: "subagent",
      input: { agent: "snflow-implement", task: phasePrompt(repairProject, repairTask, "implement"), context: "fresh", agentContract: { version: 1 }, cwd: repairProject, async: false, clarify: false },
    }, "repair-session");
    assert(!accepted.block, "repair fixture starts");
    repairObserver.onToolResult({
      toolCallId: "repair-call",
      toolName: "subagent",
      content: [{ type: "text", text: "completion guard wrapper" }],
      details: { results: [{
        exitCode: 0,
        effects: { fileMutation: { status: "missing", expected: true, attempted: false } },
        finalOutput: '```json\n{"summary":"already satisfied","outcome":"validated_no_change","acceptanceSatisfied":true,"changedFiles":[],"validation":[{"command":"npm test","ok":true,"summary":"pass"}],"residualRisks":[]}\n```',
      }] },
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
  assert(!historical.specRevision && !historical.snapshotPaths, "legacy runs remain valid without snapshot binding");

  const managedGuidance = SNFLOW_ASSET_FILES
    .filter((file) =>
      file.path.includes("extensions/snflow") ||
      file.path.includes("skills/snflow-dev") ||
      file.path.includes("agents/snflow"),
    )
    .map((file) => file.content)
    .join("\n");
  assert(!managedGuidance.includes("scripts/snflow-task.ts implement\n"), "managed guidance removes CLI implement command");
  assert(!managedGuidance.includes("scripts/snflow-task.ts wait\n"), "managed guidance removes CLI wait command");
  assert(managedGuidance.includes("SNFLOW_DISPATCH"), "managed guidance documents direct marker");
  assert(managedGuidance.includes("snflow-implement"), "managed guidance routes implementation to project agent");
  assert(managedGuidance.includes("snflow-check"), "managed guidance routes review to project agent");
  assert(managedGuidance.includes("agentContract: { version: 1 }"), "managed guidance requires generic execution projections");
  assert(managedGuidance.includes("acceptanceRole: read-only"), "managed check agent declares its read-only acceptance role");
  assert(managedGuidance.includes("completionGuard: false"), "managed check agent disables the implementation completion guard");
  assert(managedGuidance.includes("Default to ordinary direct development"), "managed guidance defaults to direct work");
  assert(managedGuidance.includes("explicitly asks to use SnFlow"), "managed skill requires explicit opt-in");
  assert(managedGuidance.includes("Warnings and informational findings must still produce `pass`"), "managed check agent keeps advisory findings non-blocking");
  assert(!managedGuidance.includes("Real dev work: create"), "managed guidance removes automatic task creation");
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
