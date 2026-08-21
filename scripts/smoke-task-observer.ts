/**
 * Smoke checks for desktop pet task-observer domain contract (U1).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-task-observer.ts
 */
import assert from "node:assert/strict";

import {
  TASK_OBSERVER_BUDGETS,
  TASK_OBSERVER_FORBIDDEN_FIELDS,
  TASK_OBSERVER_GENERIC_TITLES,
  TASK_OBSERVER_PROTOCOL_VERSION,
  type TaskObserverActivityInput,
  type TaskObserverChildSummaryInput,
  type TaskObserverTransitionInput,
} from "../lib/task-observer-types";
import {
  acknowledgeTransition,
  acknowledgeTransitions,
  applyStaleConnectionOverlay,
  assertNoForbiddenFields,
  assertPublicActivityShape,
  buildAgentActivityId,
  buildAgentTaskKey,
  buildAgentTransitionId,
  buildAutomationTaskKey,
  buildAutomationTransitionId,
  buildQuickCommandTaskKey,
  buildQuickCommandTransitionId,
  buildRunActivityId,
  buildSnflowTaskKey,
  buildSnflowTransitionId,
  buildTaskObserverSnapshot,
  createEmptyLocalAckState,
  deriveActivityPresentation,
  deriveDesktopPresentation,
  isTransitionAcknowledged,
  normalizeProgress,
  parseAndAssertPublicSnapshot,
  projectActivity,
  resolveSafeTitle,
  serializeTaskObserverSnapshot,
  snapshotContentFingerprint,
  snapshotsShareContentRevision,
} from "../lib/task-observer-projection";

function agentActivity(input: {
  sessionId: string;
  instanceId?: string;
  promptEpoch: number;
  stateVersion: number;
  projectKey?: string;
  projectName?: string;
  title?: string | null;
  executionState: TaskObserverActivityInput["executionState"];
  outcome?: TaskObserverActivityInput["outcome"];
  attention?: TaskObserverActivityInput["attention"];
  phase?: string;
  reasonCode?: string;
  progress?: TaskObserverActivityInput["progress"];
  activeModel?: TaskObserverActivityInput["activeModel"];
  sessionResources?: TaskObserverActivityInput["sessionResources"];
  children?: TaskObserverChildSummaryInput[];
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
}): TaskObserverActivityInput {
  const instanceId = input.instanceId ?? "inst-1";
  const sessionId = input.sessionId;
  const taskKey = buildAgentTaskKey(sessionId);
  const activityId = buildAgentActivityId(instanceId, sessionId, input.promptEpoch);
  const lastTransitionId = buildAgentTransitionId(
    instanceId,
    sessionId,
    input.promptEpoch,
    input.stateVersion,
  );
  return {
    taskKey,
    activityId,
    source: "agent",
    projectKey: input.projectKey ?? "proj-a",
    projectName: input.projectName ?? "Project A",
    title: input.title,
    executionState: input.executionState,
    outcome: input.outcome ?? null,
    attention: input.attention ?? "none",
    phase: input.phase,
    reasonCode: input.reasonCode,
    progress: input.progress,
    activeModel: input.activeModel,
    sessionResources: input.sessionResources,
    children: input.children,
    deepLink: `/?session=${encodeURIComponent(sessionId)}`,
    lastTransitionId,
    stateVersion: input.stateVersion,
    startedAt: input.startedAt ?? "2026-08-12T10:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-12T10:05:00.000Z",
    endedAt: input.endedAt,
  };
}

async function main() {
  console.log("smoke-task-observer: start");

  // --- Identities: two prompts → one taskKey, distinct activityIds ---
  const sessionId = "sess-aaa";
  const taskKey = buildAgentTaskKey(sessionId);
  const activity1 = buildAgentActivityId("inst-1", sessionId, 1);
  const activity2 = buildAgentActivityId("inst-1", sessionId, 2);
  assert.equal(taskKey, "agent:sess-aaa");
  assert.equal(activity1, "inst-1:sess-aaa:1");
  assert.equal(activity2, "inst-1:sess-aaa:2");
  assert.notEqual(activity1, activity2);

  const transitionV1 = buildAgentTransitionId("inst-1", sessionId, 1, 1);
  const transitionV1Again = buildAgentTransitionId("inst-1", sessionId, 1, 1);
  const transitionV2 = buildAgentTransitionId("inst-1", sessionId, 1, 2);
  assert.equal(transitionV1, transitionV1Again, "rebuilt terminal transition must be stable");
  assert.notEqual(transitionV1, transitionV2);

  assert.equal(buildSnflowTaskKey("p1", "t1"), "snflow:p1:t1");
  assert.equal(buildAutomationTaskKey("auto-1"), "automation:auto-1");
  assert.equal(buildQuickCommandTaskKey("p1", "cmd-1"), "quick:p1:cmd-1");
  assert.equal(buildRunActivityId("run-9"), "run-9");
  assert.equal(
    buildSnflowTransitionId("run-9", "running", "2026-08-12T10:00:00.000Z"),
    "snflow:run-9:running:2026-08-12T10:00:00.000Z",
  );
  assert.equal(
    buildAutomationTransitionId("run-9", "blocked", "2026-08-12T10:00:00.000Z"),
    "automation:run-9:blocked:2026-08-12T10:00:00.000Z",
  );
  assert.equal(
    buildQuickCommandTransitionId("run-9", "succeeded", "2026-08-12T10:00:00.000Z"),
    "quick:run-9:succeeded:2026-08-12T10:00:00.000Z",
  );

  // --- Safe title: explicit name wins; never require firstMessage ---
  assert.equal(resolveSafeTitle("agent", "My named session"), "My named session");
  assert.equal(resolveSafeTitle("agent", null), TASK_OBSERVER_GENERIC_TITLES.agent);
  assert.equal(resolveSafeTitle("agent", "   "), TASK_OBSERVER_GENERIC_TITLES.agent);
  assert.equal(resolveSafeTitle("snflow", undefined), TASK_OBSERVER_GENERIC_TITLES.snflow);
  assert.equal(resolveSafeTitle("automation", ""), TASK_OBSERVER_GENERIC_TITLES.automation);
  assert.equal(resolveSafeTitle("quick_command", null), TASK_OBSERVER_GENERIC_TITLES.quick_command);

  // --- Progress: indeterminate or real counters only ---
  assert.deepEqual(normalizeProgress(null), { kind: "indeterminate" });
  assert.deepEqual(normalizeProgress({ kind: "ratio", current: 2, total: 5 }), {
    kind: "ratio",
    current: 2,
    total: 5,
  });
  assert.deepEqual(
    normalizeProgress({ kind: "ratio", current: 6, total: 5 }),
    { kind: "indeterminate" },
    "invalid ratio falls back to indeterminate",
  );
  assert.deepEqual(normalizeProgress({ kind: "counters", toolCount: 3, currentToolName: "bash" }), {
    kind: "counters",
    toolCount: 3,
    currentToolName: "bash",
  });

  // --- Agent session resources are numeric-only, bounded, and source-scoped ---
  const resourceActivity = projectActivity(agentActivity({
    sessionId: "sess-resources",
    promptEpoch: 1,
    stateVersion: 1,
    executionState: "running",
    activeModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
    sessionResources: {
      context: { percent: 142, usedTokens: 8400, contextWindow: 20000 },
      billing: { totalTokens: 12000, costUsd: 0.0842 },
      performance: { avgTps: 31.8, sampleCount: 6 },
    },
  }));
  assert.deepEqual(resourceActivity.activeModel, {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
  });
  assert.deepEqual(resourceActivity.sessionResources, {
    context: { percent: 100, usedTokens: 8400, contextWindow: 20000 },
    billing: { totalTokens: 12000, costUsd: 0.0842 },
    performance: { avgTps: 31.8, sampleCount: 6 },
  });
  const resourceJson = JSON.stringify(resourceActivity.sessionResources);
  assert.equal(resourceJson.includes("prompt"), false);
  assert.equal(resourceJson.includes("cwd"), false);
  const nonAgentWithResources = projectActivity({
    ...agentActivity({
      sessionId: "not-an-agent-resource",
      promptEpoch: 1,
      stateVersion: 1,
      executionState: "running",
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
      sessionResources: { billing: { totalTokens: 12000, costUsd: 0.0842 } },
    }),
    source: "automation",
  });
  assert.equal(nonAgentWithResources.activeModel, undefined);
  assert.equal(nonAgentWithResources.sessionResources, undefined);

  // --- Needs input can clear and resume running ---
  let ack = createEmptyLocalAckState();
  const needsInput = projectActivity(
    agentActivity({
      sessionId: "sess-ni",
      promptEpoch: 1,
      stateVersion: 2,
      executionState: "running",
      attention: "needs_input",
      phase: "extension_ui",
    }),
  );
  assert.equal(deriveActivityPresentation(needsInput, ack), "needs_input");

  const resumed = projectActivity(
    agentActivity({
      sessionId: "sess-ni",
      promptEpoch: 1,
      stateVersion: 3,
      executionState: "running",
      attention: "none",
      phase: "tool",
      progress: { kind: "counters", currentToolName: "bash", toolCount: 1 },
    }),
  );
  assert.equal(deriveActivityPresentation(resumed, ack), "running");
  assert.equal(resumed.progress.kind, "counters");

  // --- Presentation priority + local acknowledgement ---
  const readyAct = projectActivity(
    agentActivity({
      sessionId: "sess-ready",
      promptEpoch: 1,
      stateVersion: 4,
      executionState: "settled",
      outcome: "succeeded",
      endedAt: "2026-08-12T10:10:00.000Z",
    }),
  );
  const blockedAct = projectActivity(
    agentActivity({
      sessionId: "sess-blocked",
      promptEpoch: 1,
      stateVersion: 2,
      executionState: "settled",
      outcome: "failed",
      reasonCode: "provider_error",
      endedAt: "2026-08-12T10:11:00.000Z",
    }),
  );
  const runningAct = projectActivity(
    agentActivity({
      sessionId: "sess-run",
      promptEpoch: 1,
      stateVersion: 1,
      executionState: "running",
    }),
  );
  const retryingAct = projectActivity(
    agentActivity({
      sessionId: "sess-retry",
      promptEpoch: 1,
      stateVersion: 2,
      executionState: "retrying",
    }),
  );

  assert.equal(deriveActivityPresentation(readyAct, ack), "ready");
  assert.equal(deriveActivityPresentation(blockedAct, ack), "blocked");
  assert.equal(deriveActivityPresentation(runningAct, ack), "running");
  assert.equal(deriveActivityPresentation(retryingAct, ack), "retrying");

  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: [readyAct, blockedAct, runningAct, needsInput],
      ack,
    }),
    "needs_input",
    "Needs input outranks Blocked/Ready/Running",
  );
  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: [readyAct, blockedAct, runningAct],
      ack,
    }),
    "blocked",
  );
  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: [readyAct, runningAct, retryingAct],
      ack,
    }),
    "ready",
  );
  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: [runningAct, retryingAct],
      ack,
    }),
    "retrying",
  );
  assert.equal(
    deriveDesktopPresentation({
      connection: "service_not_running",
      activities: [needsInput, blockedAct],
      ack,
    }),
    "service_not_running",
    "Service not running covers task priority",
  );
  assert.equal(
    deriveDesktopPresentation({
      connection: "reconnecting",
      activities: [needsInput],
      ack,
    }),
    "disconnected",
  );

  // Local ack clears Ready without mutating activity record
  assert.equal(isTransitionAcknowledged(ack, readyAct.lastTransitionId), false);
  ack = acknowledgeTransition(ack, readyAct.lastTransitionId);
  assert.equal(isTransitionAcknowledged(ack, readyAct.lastTransitionId), true);
  assert.equal(deriveActivityPresentation(readyAct, ack), "idle");
  assert.equal(readyAct.outcome, "succeeded", "server outcome unchanged by local ack");
  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: [readyAct, runningAct],
      ack,
    }),
    "running",
  );

  // Ack all terminal failures → idle
  ack = acknowledgeTransitions(ack, [blockedAct.lastTransitionId]);
  assert.equal(deriveActivityPresentation(blockedAct, ack), "idle");

  // --- Two prompt cycles as independent activities in one snapshot ---
  const prompt1Input = agentActivity({
    sessionId,
    promptEpoch: 1,
    stateVersion: 3,
    title: "Named chat",
    executionState: "settled",
    outcome: "succeeded",
    endedAt: "2026-08-12T10:01:00.000Z",
  });
  const prompt2Input = agentActivity({
    sessionId,
    promptEpoch: 2,
    stateVersion: 1,
    title: "Named chat",
    executionState: "running",
    phase: "assistant",
  });
  assert.equal(prompt1Input.taskKey, prompt2Input.taskKey);
  assert.notEqual(prompt1Input.activityId, prompt2Input.activityId);

  const snapshot = buildTaskObserverSnapshot({
    instanceId: "inst-1",
    revision: 7,
    generatedAt: "2026-08-12T10:20:00.000Z",
    reset: false,
    activities: [prompt1Input, prompt2Input],
    recentTransitions: [
      {
        transitionId: prompt1Input.lastTransitionId,
        taskKey: prompt1Input.taskKey,
        activityId: prompt1Input.activityId,
        source: "agent",
        projectKey: prompt1Input.projectKey,
        presentation: "ready",
        executionState: "settled",
        outcome: "succeeded",
        attention: "none",
        at: "2026-08-12T10:01:00.000Z",
      } satisfies TaskObserverTransitionInput,
    ],
  });

  assert.equal(snapshot.protocolVersion, TASK_OBSERVER_PROTOCOL_VERSION);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].activities.length, 2);
  assert.equal(snapshot.projects[0].activities[0].activityId, prompt1Input.activityId);
  assert.equal(snapshot.projects[0].activities[1].activityId, prompt2Input.activityId);
  assert.equal(snapshot.projects[0].activities[0].title, "Named chat");
  assert.equal(snapshot.aggregate.running, 1);
  assert.equal(snapshot.aggregate.ready, 1);

  // Rebuilt terminal snapshot keeps the same transition id (no duplicate identity)
  const rebuilt = buildTaskObserverSnapshot({
    instanceId: "inst-1",
    revision: 7,
    generatedAt: "2026-08-12T10:25:00.000Z",
    activities: [prompt1Input, prompt2Input],
    recentTransitions: [
      {
        transitionId: buildAgentTransitionId("inst-1", sessionId, 1, 3),
        taskKey: prompt1Input.taskKey,
        activityId: prompt1Input.activityId,
        source: "agent",
        projectKey: prompt1Input.projectKey,
        presentation: "ready",
        executionState: "settled",
        outcome: "succeeded",
        attention: "none",
        at: "2026-08-12T10:01:00.000Z",
      },
    ],
  });
  assert.equal(
    rebuilt.recentTransitions[0]?.transitionId,
    snapshot.recentTransitions[0]?.transitionId,
  );

  // --- Time-only / generatedAt change must not alter content fingerprint ---
  const laterClock = {
    ...snapshot,
    generatedAt: "2026-08-12T11:00:00.000Z",
  };
  assert.equal(snapshotsShareContentRevision(snapshot, laterClock), true);
  assert.equal(
    snapshotContentFingerprint(snapshot),
    snapshotContentFingerprint(laterClock),
  );
  const contentChanged = {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      activities: project.activities.map((activity, index) =>
        index === 1
          ? { ...activity, executionState: "settled" as const, outcome: "succeeded" as const }
          : activity,
      ),
    })),
  };
  assert.equal(snapshotsShareContentRevision(snapshot, contentChanged), false);

  // --- Forbidden fields cannot serialize ---
  for (const activity of snapshot.projects[0].activities) {
    assertPublicActivityShape(activity);
  }
  const { json, bytes } = serializeTaskObserverSnapshot(snapshot);
  assert.ok(bytes > 0);
  assert.ok(bytes <= TASK_OBSERVER_BUDGETS.maxEncodedBytes);
  const publicSnap = parseAndAssertPublicSnapshot(json);
  assert.equal(publicSnap.instanceId, "inst-1");

  // Injecting forbidden keys into a raw object is detected
  for (const field of ["cwd", "firstMessage", "prompt", "command", "output", "rawError"]) {
    assert.throws(
      () => assertNoForbiddenFields({ [field]: "secret-value" }, "$"),
      new RegExp(field, "i"),
    );
  }
  assert.ok(TASK_OBSERVER_FORBIDDEN_FIELDS.includes("cwd"));

  // projectActivity drops unknown / sensitive input by construction (only public keys)
  const sneaky = projectActivity(
    agentActivity({
      sessionId: "sess-safe",
      promptEpoch: 1,
      stateVersion: 1,
      title: null,
      executionState: "running",
      // adapters might try to pass junk via progress tool name only — title stays generic
    }),
  );
  assert.equal(sneaky.title, TASK_OBSERVER_GENERIC_TITLES.agent);
  assertPublicActivityShape(sneaky);
  assert.equal(Object.prototype.hasOwnProperty.call(sneaky, "cwd"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sneaky, "firstMessage"), false);

  // --- Oversized fixtures truncate deterministically ---
  const manyActivities: TaskObserverActivityInput[] = [];
  for (let i = 0; i < TASK_OBSERVER_BUDGETS.maxActivities + 25; i += 1) {
    manyActivities.push(
      agentActivity({
        sessionId: `sess-bulk-${i}`,
        promptEpoch: 1,
        stateVersion: 1,
        projectKey: `proj-${i % 3}`,
        projectName: `Project ${i % 3}`,
        title: `Activity ${i}`,
        executionState: "running",
        // oversized children list
        children: Array.from({ length: TASK_OBSERVER_BUDGETS.maxChildrenPerActivity + 5 }, (_, childIdx) => ({
          childId: `child-${i}-${childIdx}`,
          title: `Child ${childIdx}`,
          executionState: "running" as const,
        })),
      }),
    );
  }
  const manyTransitions: TaskObserverTransitionInput[] = Array.from(
    { length: TASK_OBSERVER_BUDGETS.maxRecentTransitions + 10 },
    (_, i) => ({
      transitionId: `agent:inst-1:sess-bulk-${i}:1:1`,
      taskKey: `agent:sess-bulk-${i}`,
      activityId: `inst-1:sess-bulk-${i}:1`,
      source: "agent" as const,
      projectKey: `proj-${i % 3}`,
      presentation: "running" as const,
      executionState: "running" as const,
      outcome: null,
      attention: "none" as const,
      at: "2026-08-12T10:00:00.000Z",
    }),
  );

  const oversized = buildTaskObserverSnapshot({
    instanceId: "inst-bulk",
    revision: 1,
    generatedAt: "2026-08-12T12:00:00.000Z",
    activities: manyActivities,
    recentTransitions: manyTransitions,
  });
  const totalActivities = oversized.projects.reduce((sum, project) => sum + project.activities.length, 0);
  assert.equal(totalActivities, TASK_OBSERVER_BUDGETS.maxActivities);
  assert.ok(oversized.truncation.activitiesOmitted >= 25);
  assert.equal(oversized.recentTransitions.length, TASK_OBSERVER_BUDGETS.maxRecentTransitions);
  assert.equal(oversized.truncation.transitionsOmitted, 10);
  assert.ok(oversized.truncation.childrenOmitted > 0);
  for (const project of oversized.projects) {
    for (const activity of project.activities) {
      assert.ok(activity.children.length <= TASK_OBSERVER_BUDGETS.maxChildrenPerActivity);
    }
  }

  // Byte budget: craft large titles until encoded limit triggers deterministic drop
  const heavyActivities: TaskObserverActivityInput[] = [];
  const heavyTitle = "T".repeat(TASK_OBSERVER_BUDGETS.maxTitleChars);
  for (let i = 0; i < 180; i += 1) {
    heavyActivities.push(
      agentActivity({
        sessionId: `heavy-${i}-${"x".repeat(40)}`,
        promptEpoch: 1,
        stateVersion: 1,
        projectKey: `heavy-proj-${i}`,
        projectName: `Heavy ${i} ${"N".repeat(40)}`,
        title: heavyTitle,
        executionState: "running",
        phase: "p".repeat(TASK_OBSERVER_BUDGETS.maxPhaseChars),
        children: Array.from({ length: TASK_OBSERVER_BUDGETS.maxChildrenPerActivity }, (_, childIdx) => ({
          childId: `hchild-${i}-${childIdx}`,
          title: heavyTitle,
          executionState: "running" as const,
          phase: "phase-heavy",
        })),
      }),
    );
  }
  const heavySnap = buildTaskObserverSnapshot({
    instanceId: "inst-heavy",
    revision: 2,
    generatedAt: "2026-08-12T13:00:00.000Z",
    activities: heavyActivities,
  });
  const serializedHeavy = serializeTaskObserverSnapshot(heavySnap);
  assert.ok(
    serializedHeavy.bytes <= TASK_OBSERVER_BUDGETS.maxEncodedBytes,
    `encoded bytes ${serializedHeavy.bytes} exceed budget`,
  );
  parseAndAssertPublicSnapshot(serializedHeavy.json);
  if (Buffer.byteLength(JSON.stringify(heavySnap), "utf8") > TASK_OBSERVER_BUDGETS.maxEncodedBytes) {
    assert.equal(serializedHeavy.snapshot.truncation.encodedBytesLimited, true);
    assert.ok(
      serializedHeavy.snapshot.truncation.activitiesOmitted > 0 ||
        serializedHeavy.snapshot.truncation.projectsOmitted > 0,
    );
  }

  // --- Stale overlay does not mutate task state ---
  const liveSnap = buildTaskObserverSnapshot({
    instanceId: "inst-1",
    revision: 3,
    generatedAt: "2026-08-12T14:00:00.000Z",
    activities: [
      agentActivity({
        sessionId: "sess-stale",
        promptEpoch: 1,
        stateVersion: 1,
        executionState: "running",
      }),
    ],
  });
  const beforeJson = JSON.stringify(liveSnap.projects);
  const stale = applyStaleConnectionOverlay({
    snapshot: liveSnap,
    connection: "reconnecting",
    ack: createEmptyLocalAckState(),
  });
  assert.equal(stale.presentation, "disconnected");
  assert.equal(JSON.stringify(stale.snapshot.projects), beforeJson);
  assert.equal(stale.snapshot.projects[0].activities[0].executionState, "running");
  assert.equal(
    deriveDesktopPresentation({
      connection: "connected",
      activities: stale.snapshot.projects[0].activities,
      ack: createEmptyLocalAckState(),
    }),
    "running",
    "clearing overlay restores task-derived presentation without snapshot mutation",
  );

  // Cancelled unread → Ready; acknowledged → idle
  const cancelled = projectActivity(
    agentActivity({
      sessionId: "sess-cancel",
      promptEpoch: 1,
      stateVersion: 2,
      executionState: "settled",
      outcome: "cancelled",
    }),
  );
  assert.equal(deriveActivityPresentation(cancelled, createEmptyLocalAckState()), "ready");

  // =========================================================================
  // U2 — ordinary Agent prompt observation + idle eligibility
  // =========================================================================
  const {
    AgentTaskObserver,
    buildAgentFallbackTitle,
    buildProjectDisplayNameFromCwd,
    buildProjectKeyFromCwd,
    canScheduleAgentIdleTeardown,
    classifyObserverReasonCode,
    inferAgentTitleFromEntries,
    inferAgentTitleFromUserMessage,
    isBlockingExtensionUiMethod,
  } = await import("../lib/task-observer-agent");

  assert.equal(isBlockingExtensionUiMethod("select"), true);
  assert.equal(isBlockingExtensionUiMethod("notify"), false);
  assert.equal(classifyObserverReasonCode("401 unauthorized api key"), "provider_auth");
  assert.equal(classifyObserverReasonCode("rate limit 429"), "provider_quota");
  assert.equal(classifyObserverReasonCode("ECONNREFUSED"), "provider_network");
  assert.equal(classifyObserverReasonCode("model not found xyz"), "model_not_found");
  assert.equal(classifyObserverReasonCode("aborted by user"), "aborted");

  const projectKey = buildProjectKeyFromCwd("D:\\work\\demo-app");
  assert.match(projectKey, /^p_[a-f0-9]{16}$/);
  assert.equal(buildProjectDisplayNameFromCwd("D:\\work\\demo-app"), "demo-app");
  assert.match(buildAgentFallbackTitle("sess-u2"), /^Agent #[A-F0-9]{6}$/);
  assert.equal(buildAgentFallbackTitle("sess-u2"), buildAgentFallbackTitle("sess-u2"));
  assert.equal(
    inferAgentTitleFromUserMessage("  优化桌宠\n会话标题  "),
    "优化桌宠 会话标题",
  );
  assert.equal(inferAgentTitleFromUserMessage("   "), null);
  assert.equal(
    inferAgentTitleFromEntries([
      { type: "message", message: { role: "assistant", content: "not the title" } },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "First user title" }] },
      },
      { type: "message", message: { role: "user", content: "Later title" } },
    ]),
    "First user title",
  );
  assert.notEqual(projectKey, "D:\\work\\demo-app");
  assert.equal(
    buildProjectKeyFromCwd("D:\\work\\demo-app"),
    buildProjectKeyFromCwd("D:\\work\\demo-app"),
    "projectKey must be stable",
  );

  let clock = 1_000_000;
  const observer = new AgentTaskObserver(
    {
      instanceId: "inst-u2",
      sessionId: "sess-u2",
      cwd: "D:\\work\\demo-app",
      explicitTitle: null,
    },
    { clock: () => clock },
  );

  // --- Two prompt cycles produce independent activities ---
  observer.beginUserPrompt();
  observer.observeEvent({ type: "agent_start" });
  observer.observeEvent({ type: "agent_end" });
  observer.observeEvent({ type: "agent_settled" });
  const first = observer.toActivityInput();
  assert.ok(first);
  assert.equal(first.taskKey, "agent:sess-u2");
  assert.equal(first.activityId, "inst-u2:sess-u2:1");
  assert.equal(first.executionState, "settled");
  assert.equal(first.outcome, "succeeded");
  assert.equal(first.title, buildAgentFallbackTitle("sess-u2"));
  assert.notEqual(first.title, TASK_OBSERVER_GENERIC_TITLES.agent);
  assert.equal(first.projectKey, projectKey);
  assert.equal(first.projectName, "demo-app");
  assert.equal(first.deepLink, "/?session=sess-u2");
  assertPublicActivityShape(projectActivity(first));

  clock += 1000;
  observer.beginUserPrompt();
  observer.observeEvent({ type: "agent_start" });
  const secondRunning = observer.toActivityInput();
  assert.ok(secondRunning);
  assert.equal(secondRunning.taskKey, first.taskKey);
  assert.equal(secondRunning.activityId, "inst-u2:sess-u2:2");
  assert.notEqual(secondRunning.activityId, first.activityId);
  assert.equal(secondRunning.executionState, "running");
  assert.equal(observer.getPromptEpoch(), 2);

  // --- Unnamed sessions use the first user message and keep it across turns ---
  const inferredObserver = new AgentTaskObserver({
    instanceId: "inst-inferred",
    sessionId: "sess-inferred",
    cwd: "D:\\work\\demo-app",
    explicitTitle: null,
  });
  inferredObserver.beginUserPrompt("Implement the desktop pet title");
  assert.equal(inferredObserver.toActivityInput()?.title, "Implement the desktop pet title");
  inferredObserver.observeEvent({ type: "agent_settled" });
  inferredObserver.beginUserPrompt("This later prompt must not replace the title");
  assert.equal(inferredObserver.toActivityInput()?.title, "Implement the desktop pet title");

  const restoredObserver = new AgentTaskObserver({
    instanceId: "inst-restored",
    sessionId: "sess-restored",
    cwd: "D:\\work\\demo-app",
    inferredTitle: "Historical first user message",
  });
  restoredObserver.beginUserPrompt("Current follow-up");
  assert.equal(restoredObserver.toActivityInput()?.title, "Historical first user message");

  // --- Retry remains active across agent_end ---
  observer.observeEvent({ type: "agent_end", willRetry: true });
  assert.equal(observer.toActivityInput()?.executionState, "retrying");
  observer.observeEvent({ type: "auto_retry_start", attempt: 1 });
  assert.equal(observer.toActivityInput()?.executionState, "retrying");
  observer.observeEvent({ type: "agent_start" });
  assert.equal(observer.getPromptEpoch(), 2, "retry agent_start must not open a new epoch");
  assert.equal(observer.toActivityInput()?.activityId, "inst-u2:sess-u2:2");
  observer.observeEvent({ type: "auto_retry_end", success: true, attempt: 1 });
  observer.observeEvent({ type: "agent_end" });
  assert.equal(observer.toActivityInput()?.executionState, "running");
  observer.observeEvent({ type: "agent_settled" });
  assert.equal(observer.toActivityInput()?.executionState, "settled");
  assert.equal(observer.toActivityInput()?.outcome, "succeeded");

  // --- Silent tool: not idle-eligible even with zero browser listeners ---
  observer.beginUserPrompt();
  observer.observeEvent({ type: "agent_start" });
  observer.observeEvent({
    type: "tool_execution_start",
    toolCallId: "call-bash-1",
    toolName: "bash",
  });
  const silent = observer.toActivityInput();
  assert.ok(silent);
  assert.equal(silent.executionState, "running");
  const silentProgress = silent.progress;
  assert.ok(silentProgress);
  assert.equal(silentProgress.kind, "counters");
  if (silentProgress.kind === "counters") {
    assert.equal(silentProgress.currentToolName, "bash");
    assert.equal(silentProgress.toolCount, 1);
  }
  const silentIdle = observer.getIdleEligibility(0);
  assert.equal(silentIdle.canSchedule, false, "active silent tool must block idle teardown");
  assert.equal(silentIdle.activeToolCount, 1);
  assert.equal(
    canScheduleAgentIdleTeardown({
      settledForIdle: false,
      activeToolCount: 1,
      activeSubagentCount: 0,
      blockingUiCount: 0,
    }),
    false,
  );

  // agent_end without tool_end still not idle (tool active)
  observer.observeEvent({ type: "agent_end" });
  assert.equal(observer.getIdleEligibility(0).canSchedule, false);

  // Settle while tool still tracked — forceSettle clears tools; idle becomes eligible
  // (real runtime should tool_end first; defensive settle still must not leak busy flags)
  observer.observeEvent({
    type: "tool_execution_end",
    toolCallId: "call-bash-1",
    toolName: "bash",
  });
  observer.observeEvent({ type: "agent_settled" });
  assert.equal(observer.toActivityInput()?.executionState, "settled");
  assert.equal(
    observer.getIdleEligibility(0).canSchedule,
    true,
    "settled wrapper with zero tools may start idle teardown",
  );
  assert.equal(
    canScheduleAgentIdleTeardown({
      settledForIdle: true,
      activeToolCount: 0,
      activeSubagentCount: 0,
      blockingUiCount: 0,
    }),
    true,
  );

  // Zero SSE listeners never appears in eligibility inputs — observer path is independent.
  assert.equal(observer.getDebugSnapshot().settledForIdle, true);

  // --- Blocking extension UI → Needs input, then clear ---
  observer.beginUserPrompt();
  observer.observeEvent({ type: "agent_start" });
  observer.observeEvent({
    type: "extension_ui_request",
    id: "ui-1",
    method: "select",
    title: "Pick one",
    options: ["a", "b"],
  });
  const needs = observer.toActivityInput();
  assert.ok(needs);
  assert.equal(needs.attention, "needs_input");
  assert.equal(needs.phase, "needs_input");
  assert.equal(deriveActivityPresentation(projectActivity(needs), createEmptyLocalAckState()), "needs_input");
  // Privacy: request title/options must not be copied onto the activity
  const needsJson = JSON.stringify(needs);
  assert.equal(needsJson.includes("Pick one"), false);
  assert.equal(needsJson.includes("\"a\""), false);
  assert.equal(observer.getIdleEligibility(0).canSchedule, false);

  observer.noteExtensionUiResolved("ui-1");
  const cleared = observer.toActivityInput();
  assert.ok(cleared);
  assert.equal(cleared.attention, "none");
  assert.equal(cleared.executionState, "running");
  assert.equal(deriveActivityPresentation(projectActivity(cleared), createEmptyLocalAckState()), "running");

  // Non-blocking notify must not enter needs_input
  observer.observeEvent({
    type: "extension_ui_request",
    id: "ui-notify",
    method: "notify",
    message: "hello",
  });
  assert.equal(observer.toActivityInput()?.attention, "none");

  // --- prompt_error classifies without leaking raw text ---
  observer.observeEvent({
    type: "prompt_error",
    error: "Invalid API key for provider sk-secret-12345",
  });
  const failed = observer.toActivityInput();
  assert.ok(failed);
  assert.equal(failed.executionState, "settled");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.reasonCode, "provider_auth");
  const failedJson = JSON.stringify(failed);
  assert.equal(failedJson.includes("sk-secret"), false);
  assert.equal(failedJson.includes("Invalid API key"), false);
  assertPublicActivityShape(projectActivity(failed));
  assert.equal(observer.getIdleEligibility(0).canSchedule, true);

  // --- Explicit session title overrides the inferred first-user title ---
  observer.setExplicitTitle("My feature work");
  observer.beginUserPrompt();
  observer.observeEvent({ type: "agent_start" });
  assert.equal(observer.toActivityInput()?.title, "My feature work");
  observer.observeEvent({ type: "session_info_changed", name: "Renamed live session" });
  assert.equal(observer.toActivityInput()?.title, "Renamed live session");

  // Resource updates do not change transition identity.
  const transitionBeforeResources = observer.toActivityInput()?.lastTransitionId;
  observer.setActiveModel({ provider: "anthropic", modelId: "claude-sonnet-4" });
  observer.setSessionResources({
    context: { percent: 42.3, usedTokens: 8460, contextWindow: 20000 },
    billing: { totalTokens: 12840, costUsd: 0.0842 },
    performance: { avgTps: 31.8, sampleCount: 6 },
  });
  const withResources = observer.toActivityInput();
  assert.deepEqual(withResources?.activeModel, {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
  });
  assert.deepEqual(withResources?.sessionResources?.performance, { avgTps: 31.8, sampleCount: 6 });
  assert.equal(withResources?.lastTransitionId, transitionBeforeResources);

  // --- Steer stays in current activity ---
  const epochBeforeSteer = observer.getPromptEpoch();
  observer.noteInActivityControl("steer");
  assert.equal(observer.getPromptEpoch(), epochBeforeSteer);
  assert.equal(observer.toActivityInput()?.executionState, "running");

  // --- Subagent nested under parent, counters only ---
  observer.observeEvent({
    type: "tool_execution_start",
    toolCallId: "call-sub-1",
    toolName: "subagent",
  });
  const withChild = observer.toActivityInput();
  assert.ok(withChild);
  const children = withChild.children ?? [];
  assert.ok(children.length >= 1);
  assert.equal(children[0]?.executionState, "running");
  const childProgress = withChild.progress;
  assert.ok(childProgress);
  if (childProgress.kind === "counters") {
    assert.equal(childProgress.activeSubagents, 1);
  }
  assert.equal(observer.getIdleEligibility(0).activeSubagentCount, 1);
  assert.equal(observer.getIdleEligibility(0).canSchedule, false);

  // =========================================================================
  // U3 — SnFlow / Automation / Quick Command adapters + host dedupe
  // =========================================================================
  const {
    collectSnflowSuppressedHostSessionIds,
    filterAgentActivitiesForSnflowDedupe,
    projectSnflowRun,
  } = await import("../lib/task-observer-snflow");
  const { projectAutomationRun } = await import("../lib/task-observer-automation");
  const { projectQuickCommandSource } = await import("../lib/task-observer-quick-command");
  const {
    notifyTaskObserverSourceChange,
    resetTaskObserverInvalidateForTests,
    subscribeTaskObserverInvalidate,
  } = await import("../lib/task-observer-invalidate");
  const {
    listQuickCommandObserverSources,
    resetQuickCommandRunnerForTests,
    subscribeQuickCommandObserver,
  } = await import("../lib/quick-command-runner");

  // --- SnFlow host dedupe yields one top-level activity ---
  const snflowRun = {
    schemaVersion: 1 as const,
    id: "impl-run-1",
    taskId: "fix-auth",
    phase: "implement" as const,
    agentName: "implementer",
    state: "running" as const,
    requestedCwd: "D:\\work\\demo-app",
    effectiveCwd: "D:\\work\\demo-app",
    hostSessionId: "host-native-sess",
    taskRevision: "rev1",
    parentSessionId: "chat-parent-sess",
    parentToolCallId: "tool-call-9",
    nativeRunId: null,
    asyncDir: null,
    sessionFile: null,
    outputFile: null,
    model: null,
    thinking: null,
    summary: null,
    createdAt: "2026-08-12T15:00:00.000Z",
    startedAt: "2026-08-12T15:00:01.000Z",
    endedAt: null,
    lastReconciledAt: null,
    error: null,
    implementResult: null,
    checkResult: null,
    toolCount: 2,
    turnCount: 4,
  };
  const snflowProj = projectSnflowRun({
    run: snflowRun,
    cwd: "D:\\work\\demo-app",
    taskTitle: "Fix auth",
  });
  assert.ok(snflowProj);
  assert.equal(snflowProj.activity.source, "snflow");
  assert.equal(snflowProj.activity.executionState, "running");
  assert.equal(snflowProj.parentSessionId, "chat-parent-sess");
  assert.ok((snflowProj.activity.title ?? "").includes("Fix auth"));
  assert.equal(snflowProj.activity.deepLink.includes("inspector=snflow"), true);
  assert.equal(snflowProj.activity.deepLink.includes("firstMessage"), false);
  const snflowJson = JSON.stringify(snflowProj.activity);
  assert.equal(snflowJson.includes("D:\\work\\demo-app"), false, "cwd must not appear in activity");
  assert.equal(snflowJson.includes("tool-call-9"), false, "parentToolCallId must not appear on wire");

  const hostAgent = projectActivity(
    agentActivity({
      sessionId: "chat-parent-sess",
      promptEpoch: 1,
      stateVersion: 1,
      executionState: "running",
      title: "Host chat",
    }),
  );
  const otherAgent = projectActivity(
    agentActivity({
      sessionId: "other-sess",
      promptEpoch: 1,
      stateVersion: 1,
      executionState: "running",
    }),
  );
  const deduped = filterAgentActivitiesForSnflowDedupe(
    [hostAgent, otherAgent],
    [snflowProj],
  );
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.taskKey, "agent:other-sess");
  assert.ok(collectSnflowSuppressedHostSessionIds([snflowProj]).has("chat-parent-sess"));

  // Terminal rebuild keeps stable transition id
  const snflowDone = projectSnflowRun({
    run: {
      ...snflowRun,
      state: "completed",
      endedAt: "2026-08-12T15:10:00.000Z",
    },
    cwd: "D:\\work\\demo-app",
    taskTitle: "Fix auth",
  });
  assert.ok(snflowDone);
  const snflowDoneAgain = projectSnflowRun({
    run: {
      ...snflowRun,
      state: "completed",
      endedAt: "2026-08-12T15:10:00.000Z",
    },
    cwd: "D:\\work\\demo-app",
    taskTitle: "Fix auth",
  });
  assert.equal(snflowDone.activity.lastTransitionId, snflowDoneAgain?.activity.lastTransitionId);
  // Completed SnFlow no longer suppresses host
  assert.equal(collectSnflowSuppressedHostSessionIds([snflowDone]).size, 0);

  // Malformed SnFlow isolated
  assert.equal(
    projectSnflowRun({ run: { id: "" } as never, cwd: "D:\\work\\demo-app" }),
    null,
  );

  // --- Automation states map correctly ---
  const autoBase = {
    schemaVersion: 1 as const,
    id: "auto-run-1",
    taskId: "task-nightly",
    taskRevision: "r1",
    trigger: "scheduled" as const,
    blockedReason: null as null,
    occurrence: {
      occurrenceKey: "occ-1",
      scheduledForUtc: "2026-08-12T02:00:00.000Z",
      localWallTime: "",
      localOffsetMinutes: 0,
      timezone: "UTC",
      schedulePolicyVersion: 1 as const,
      cron: "0 2 * * *",
    },
    lease: null,
    promptHash: "ph",
    requestedModel: { provider: "openai", modelId: "gpt" },
    actualModel: null,
    effectiveTools: [],
    effectiveExtensions: [],
    session: {
      sessionId: null,
      sessionFile: null,
      availability: "pending" as const,
      unavailableReason: null,
      sealed: false,
      seal: null,
    },
    summary: null,
    usage: null,
    errorCategory: null as string | null,
    errorMessage: null as string | null,
    sideEffectsStarted: false,
    cancelRequestedAt: null,
    createdAt: "2026-08-12T02:00:00.000Z",
    claimedAt: null,
    startedAt: "2026-08-12T02:00:01.000Z",
    completedAt: null as string | null,
    cwd: "D:\\work\\demo-app",
    terminal: false,
  };

  const autoRunning = projectAutomationRun({
    run: { ...autoBase, status: "running" },
    taskName: "Nightly check",
  });
  assert.ok(autoRunning);
  assert.equal(autoRunning.activity.executionState, "running");
  assert.equal(autoRunning.activity.title, "Nightly check");
  assert.equal(autoRunning.activity.deepLink.includes("panel=automation"), true);

  const autoBlocked = projectAutomationRun({
    run: {
      ...autoBase,
      id: "auto-blocked",
      status: "blocked",
      blockedReason: "reauthorization_required",
      terminal: true,
      completedAt: "2026-08-12T02:05:00.000Z",
    },
    taskName: "Nightly check",
  });
  assert.ok(autoBlocked);
  assert.equal(autoBlocked.activity.executionState, "settled");
  assert.equal(autoBlocked.activity.attention, "blocked");
  assert.equal(autoBlocked.activity.outcome, "failed");
  assert.ok(autoBlocked.activity.reasonCode?.startsWith("blocked_"));

  const autoAmbiguous = projectAutomationRun({
    run: {
      ...autoBase,
      id: "auto-amb",
      status: "ambiguous",
      terminal: true,
      completedAt: "2026-08-12T02:06:00.000Z",
    },
  });
  assert.ok(autoAmbiguous);
  assert.equal(autoAmbiguous.activity.outcome, "ambiguous");
  assert.equal(autoAmbiguous.activity.attention, "blocked");

  const autoTimeout = projectAutomationRun({
    run: {
      ...autoBase,
      id: "auto-to",
      status: "timed_out",
      terminal: true,
      completedAt: "2026-08-12T02:07:00.000Z",
    },
  });
  assert.ok(autoTimeout);
  assert.equal(autoTimeout.activity.outcome, "failed");
  assert.equal(autoTimeout.activity.reasonCode, "timed_out");

  const autoWire = JSON.stringify(autoBlocked.activity);
  assert.equal(autoWire.includes("errorMessage"), false);
  assert.equal(autoWire.includes("D:\\work\\demo-app"), false);
  assert.equal(
    projectAutomationRun({ run: { id: "x" } as never }),
    null,
    "malformed automation isolated",
  );

  // Stable transition on re-project
  const autoBlockedAgain = projectAutomationRun({
    run: {
      ...autoBase,
      id: "auto-blocked",
      status: "blocked",
      blockedReason: "reauthorization_required",
      terminal: true,
      completedAt: "2026-08-12T02:05:00.000Z",
    },
    taskName: "Nightly check",
  });
  assert.equal(autoBlocked.activity.lastTransitionId, autoBlockedAgain?.activity.lastTransitionId);

  // --- Quick Command maps without sensitive execution data ---
  const qcSource = {
    runId: "qc-run-1",
    commandId: "lint",
    name: "Lint",
    status: "running" as const,
    startedAt: "2026-08-12T16:00:00.000Z",
    endedAt: null,
    projectCwd: "D:\\work\\demo-app",
  };
  const qc = projectQuickCommandSource(qcSource);
  assert.ok(qc);
  assert.equal(qc.activity.source, "quick_command");
  assert.equal(qc.activity.executionState, "running");
  assert.equal(qc.activity.title, "Lint");
  const qcJson = JSON.stringify(qc.activity);
  assert.equal(qcJson.includes("npm run"), false);
  assert.equal(qcJson.includes("projectCwd"), false);
  assert.equal(qcJson.includes("D:\\work\\demo-app"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(qc.activity, "command"), false);
  assert.equal(qc.activity.deepLink, "/?panel=quick-commands&run=qc-run-1");

  const qcFailed = projectQuickCommandSource({
    ...qcSource,
    runId: "qc-fail",
    status: "timed_out",
    endedAt: "2026-08-12T16:05:00.000Z",
  });
  assert.ok(qcFailed);
  assert.equal(qcFailed.activity.outcome, "failed");
  assert.equal(qcFailed.activity.reasonCode, "timed_out");
  assert.equal(
    projectQuickCommandSource({ runId: "", commandId: "x", name: "n", status: "running", startedAt: "", endedAt: null, projectCwd: "p" }),
    null,
  );

  // Multi-source snapshot grouping stays privacy-safe
  const multi = buildTaskObserverSnapshot({
    instanceId: "inst-u3",
    revision: 1,
    generatedAt: "2026-08-12T17:00:00.000Z",
    activities: [
      snflowProj.activity,
      autoRunning.activity,
      qc.activity,
      ...filterAgentActivitiesForSnflowDedupe([hostAgent, otherAgent], [snflowProj]),
    ],
  });
  assert.equal(multi.aggregate.running >= 3, true);
  const multiSer = serializeTaskObserverSnapshot(multi);
  parseAndAssertPublicSnapshot(multiSer.json);
  assert.equal(multiSer.json.includes("D:\\work\\demo-app"), false);
  assert.equal(multiSer.json.includes("npm "), false);

  // --- Observer invalidate never fails source-side notify ---
  resetTaskObserverInvalidateForTests();
  let hits = 0;
  const unsub = subscribeTaskObserverInvalidate(() => {
    hits += 1;
    throw new Error("listener boom");
  });
  assert.doesNotThrow(() => notifyTaskObserverSourceChange());
  assert.equal(hits, 1);
  unsub();
  resetTaskObserverInvalidateForTests();

  // QC observer channel exposes only safe fields
  resetQuickCommandRunnerForTests();
  assert.deepEqual(listQuickCommandObserverSources(), []);
  let observedSafe = 0;
  const unsubQc = subscribeQuickCommandObserver((source) => {
    observedSafe += 1;
    assert.equal("command" in source, false);
    assert.equal("resolvedCwd" in source, false);
    assert.equal("outputText" in source, false);
    assert.ok(source.runId);
  });
  unsubQc();
  resetQuickCommandRunnerForTests();
  assert.equal(observedSafe, 0);

  console.log("smoke-task-observer: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
