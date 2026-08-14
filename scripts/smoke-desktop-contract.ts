/**
 * Smoke checks for desktop pet UI/read/notification contracts (U7).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-contract.ts
 *
 * Pure domain + static source contracts — does not launch Electron.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  assertRendererViewSafe,
  buildActivityView,
  compareActivityRows,
  findActivityById,
  flattenActivities,
  listUnreadTransitionIds,
  markActivityRead,
  markAllTerminalRead,
  projectActivityRow,
  sortProjectGroups,
} from "../desktop/main/activity-store";
import { applyLaunchAtLogin, readLaunchAtLogin } from "../desktop/main/autostart";
import {
  createInitialConnectionState,
  DESKTOP_START_COMMAND,
  reduceConnectionState,
} from "../desktop/main/connection-state";
import {
  openValidatedDeepLink,
  rejectArbitraryRendererUrl,
} from "../desktop/main/deep-link-opener";
import {
  isRendererIpcChannel,
  PET_IPC_CHANNELS,
  PET_RENDERER_ALLOWED_CHANNELS,
} from "../desktop/main/ipc-contract";
import {
  isSquirrelLifecycleEvent,
  shouldAutoStartDesktopMain,
} from "../desktop/main/main";
import {
  DesktopNotificationController,
  notificationBodyFor,
  selectNotifications,
} from "../desktop/main/notification-controller";
import {
  loadDesktopSettingsFile,
  saveDesktopSettingsFile,
  settingsFilePath,
  type SettingsFs,
} from "../desktop/main/settings-persistence";
import {
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
  parseDesktopSettingsJson,
  updateDesktopSettings,
} from "../desktop/main/settings-store";
import {
  assertQuitLabelSafe,
  buildTrayMenuModel,
  buildTrayTooltip,
  trayItemToAction,
} from "../desktop/main/tray-controller";
import {
  applyWindowManagerState,
  clampWindowBounds,
  createInitialWindowManagerState,
  handleDisableClickThrough,
  defaultPetWindowPosition,
  handleMoveBy,
  handlePetWindowCloseRequest,
  handleRestoreDefaultPosition,
  handleSetClickThrough,
  handleSetPetScale,
  handleShowPet,
  handleToggleTray,
  petStackScreenRect,
  petWindowWebPreferences,
  pickTrayLayoutAnchor,
  recoverWindowToNearestWorkArea,
  resolvePetLayoutSpec,
  resolvePetWindowReveal,
  sendPetWindowChannel,
  unionWorkAreas,
  PET_LAYOUT,
  PET_WINDOW_DEFAULTS,
  type PetWindowHandle,
} from "../desktop/main/window-manager";
import {
  acceptStaticPetPreview,
  isSafePetAssetPath,
  validatePackagedPetAssets,
  validatePetManifestDocument,
} from "../desktop/renderer/pet-assets";
import {
  connectionBannerText,
  countActivitiesByFilter,
  createInitialPetBubbleState,
  createInitialPetCelebrateState,
  filterProjectGroups,
  formatActivityProgress,
  formatElapsed,
  getBuiltinPetManifest,
  moveActivitySelection,
  nextActDelayMs,
  nextBlinkDelayMs,
  petSourceLabel,
  petTerminalOutcome,
  reducePetBubbleState,
  resolveActivityElapsedMs,
  resolveActivitySelection,
  resolveBuiltinPetManifest,
  resolvePetFrame,
  resolvePetTransitionAction,
  shouldCelebrateCompletion,
  shouldRunIdleLife,
} from "../desktop/renderer/pet-state";
import { DESKTOP_PACKAGE_CONTRACT } from "../forge.config";
import { buildAgentDeepLink } from "../lib/desktop-deep-link";
import {
  buildAgentActivityId,
  buildAgentTaskKey,
  buildAgentTransitionId,
  buildTaskObserverSnapshot,
  projectActivity,
} from "../lib/task-observer-projection";
import type {
  TaskObserverActivityInput,
  TaskObserverTransitionInput,
} from "../lib/task-observer-types";

function activityInput(input: {
  sessionId: string;
  projectKey: string;
  projectName: string;
  title: string;
  executionState: TaskObserverActivityInput["executionState"];
  outcome?: TaskObserverActivityInput["outcome"];
  attention?: TaskObserverActivityInput["attention"];
  promptEpoch?: number;
  stateVersion?: number;
  updatedAt?: string;
  children?: TaskObserverActivityInput["children"];
}): TaskObserverActivityInput {
  const instanceId = "inst-u7";
  const promptEpoch = input.promptEpoch ?? 1;
  const stateVersion = input.stateVersion ?? 1;
  return {
    taskKey: buildAgentTaskKey(input.sessionId),
    activityId: buildAgentActivityId(instanceId, input.sessionId, promptEpoch),
    source: "agent",
    projectKey: input.projectKey,
    projectName: input.projectName,
    title: input.title,
    executionState: input.executionState,
    outcome: input.outcome ?? null,
    attention: input.attention ?? "none",
    progress: { kind: "indeterminate" },
    deepLink: buildAgentDeepLink(input.sessionId),
    lastTransitionId: buildAgentTransitionId(instanceId, input.sessionId, promptEpoch, stateVersion),
    stateVersion,
    updatedAt: input.updatedAt ?? "2026-08-12T12:00:00.000Z",
    startedAt: "2026-08-12T11:00:00.000Z",
    children: input.children,
  };
}

function collectDesktopSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function workAreaPreview(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: 1920, height: 1080 };
}

type RecordedPetCall =
  | "show"
  | "showInactive"
  | "hide"
  | "focus"
  | "destroy"
  | `send:${string}`;

function isRevealCall(call: RecordedPetCall): call is "show" | "showInactive" | "hide" | "focus" {
  return call === "show" || call === "showInactive" || call === "hide" || call === "focus";
}

function createRecordingPetWindow(input?: {
  visible?: boolean;
  destroyed?: boolean;
}): { handle: PetWindowHandle; calls: RecordedPetCall[] } {
  const calls: RecordedPetCall[] = [];
  let visible = input?.visible === true;
  let destroyed = input?.destroyed === true;
  const handle: PetWindowHandle = {
    show() {
      calls.push("show");
      visible = true;
    },
    showInactive() {
      calls.push("showInactive");
      visible = true;
    },
    hide() {
      calls.push("hide");
      visible = false;
    },
    close() {
      visible = false;
    },
    destroy() {
      calls.push("destroy");
      destroyed = true;
      visible = false;
    },
    isDestroyed() {
      return destroyed;
    },
    isVisible() {
      return !destroyed && visible;
    },
    focus() {
      calls.push("focus");
    },
    setAlwaysOnTop() {
      return;
    },
    setIgnoreMouseEvents() {
      return;
    },
    getBounds() {
      return { x: 40, y: 40, width: 140, height: 160 };
    },
    setBounds() {
      return;
    },
    send(channel) {
      if (destroyed) return;
      calls.push(`send:${channel}`);
    },
    onClose() {
      return;
    },
    onMoved() {
      return;
    },
    onBlur() {
      return;
    },
    onFocus() {
      return;
    },
  };
  return { handle, calls };
}

function assertNoServiceControl(source: string, file: string): void {
  assert.equal(
    /from\s+["']child_process["']|require\(\s*["']child_process["']\s*\)/.test(source),
    false,
    `${file} must not import child_process`,
  );
  assert.equal(/\b(?:spawn|fork|execFile)\s*\(/.test(source), false, `${file} must not spawn/execFile`);
  assert.equal(/\bprocess\.kill\b/.test(source), false, `${file} must not process.kill`);
  assert.equal(/\bservicePid\b\s*[:=]/.test(source), false, `${file} must not track servicePid`);
}

async function main() {
  console.log("smoke-desktop-contract: start");

  // --- Multi-project priority + grouping ---
  const activities = [
    activityInput({
      sessionId: "s-run",
      projectKey: "proj-b",
      projectName: "Beta",
      title: "Running agent",
      executionState: "running",
      updatedAt: "2026-08-12T12:01:00.000Z",
      children: [
        {
          childId: "child-safe-1",
          title: "Review tests",
          executionState: "running",
          outcome: null,
          attention: "none",
          phase: "review",
          updatedAt: "2026-08-12T12:00:30.000Z",
        },
      ],
    }),
    activityInput({
      sessionId: "s-ready",
      projectKey: "proj-a",
      projectName: "Alpha",
      title: "Ready agent",
      executionState: "settled",
      outcome: "succeeded",
      promptEpoch: 2,
      stateVersion: 3,
      updatedAt: "2026-08-12T12:02:00.000Z",
    }),
    activityInput({
      sessionId: "s-need",
      projectKey: "proj-c",
      projectName: "Gamma",
      title: "Needs input agent",
      executionState: "running",
      attention: "needs_input",
      promptEpoch: 3,
      stateVersion: 2,
      updatedAt: "2026-08-12T12:03:00.000Z",
    }),
    activityInput({
      sessionId: "s-block",
      projectKey: "proj-a",
      projectName: "Alpha",
      title: "Blocked agent",
      executionState: "settled",
      outcome: "failed",
      promptEpoch: 4,
      stateVersion: 2,
      updatedAt: "2026-08-12T12:04:00.000Z",
    }),
  ];

  const snapshot = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 1,
    activities,
    recentTransitions: activities.map((item, index) => {
      const projected = projectActivity(item);
      const presentation =
        item.attention === "needs_input"
          ? "needs_input"
          : item.outcome === "failed"
            ? "blocked"
            : item.outcome === "succeeded"
              ? "ready"
              : "running";
      const transition: TaskObserverTransitionInput = {
        transitionId: projected.lastTransitionId,
        taskKey: projected.taskKey,
        activityId: projected.activityId,
        source: projected.source,
        projectKey: projected.projectKey,
        presentation: presentation as TaskObserverTransitionInput["presentation"],
        executionState: projected.executionState,
        outcome: projected.outcome,
        attention: projected.attention,
        at: item.updatedAt ?? "2026-08-12T12:00:00.000Z",
      };
      void index;
      return transition;
    }),
  });

  let settings = createDefaultDesktopSettings();
  let connection = createInitialConnectionState({ port: 62666, now: 1 });
  connection = reduceConnectionState(
    connection,
    { type: "connected", instanceId: "inst-u7", resetBaseline: true },
    2,
  );

  let view = buildActivityView({
    snapshot,
    connection,
    settings,
    now: Date.parse("2026-08-12T12:05:00.000Z"),
  });

  assert.equal(view.presentation, "needs_input");
  assert.equal(view.projects.length, 3);
  // Highest priority project first (Gamma needs input)
  assert.equal(view.projects[0].projectKey, "proj-c");
  assert.equal(view.projects[0].activities[0].presentation, "needs_input");
  // Alpha has blocked before ready
  const alpha = view.projects.find((p) => p.projectKey === "proj-a");
  assert.ok(alpha);
  assert.equal(alpha!.activities[0].presentation, "blocked");
  assert.equal(alpha!.activities[1].presentation, "ready");

  const sortedRows = flattenActivities(view.projects).slice().sort(compareActivityRows);
  assert.equal(sortedRows[0].presentation, "needs_input");
  assert.equal(sortedRows[1].presentation, "blocked");
  assert.equal(sortedRows[2].presentation, "ready");
  assert.equal(sortedRows[3].presentation, "running");

  assertRendererViewSafe(view);
  assert.deepEqual(sortedRows.find((row) => row.activityId.includes("s-run"))?.children, [
    {
      childId: "child-safe-1",
      title: "Review tests",
      executionState: "running",
      outcome: null,
      attention: "none",
      phase: "review",
      updatedAt: "2026-08-12T12:00:30.000Z",
    },
  ]);

  // --- Renderer-local filters + safe selection reset ---
  assert.deepEqual(countActivitiesByFilter(view.projects), {
    all: 4,
    attention: 2,
    running: 2,
    completed: 2,
  });
  assert.deepEqual(
    flattenActivities(filterProjectGroups(view.projects, "attention")).map(
      (row) => row.presentation,
    ),
    ["needs_input", "blocked"],
  );
  assert.deepEqual(
    flattenActivities(filterProjectGroups(view.projects, "running")).map(
      (row) => row.activityId,
    ),
    [sortedRows[0].activityId, sortedRows[3].activityId],
  );
  assert.deepEqual(
    flattenActivities(filterProjectGroups(view.projects, "completed")).map(
      (row) => row.presentation,
    ),
    ["blocked", "ready"],
  );
  const runningIds = flattenActivities(filterProjectGroups(view.projects, "running")).map(
    (row) => row.activityId,
  );
  assert.equal(resolveActivitySelection(runningIds, sortedRows[2].activityId), runningIds[0]);
  assert.equal(resolveActivitySelection([], runningIds[0]), null);
  assert.equal(resolveActivitySelection(runningIds, runningIds[1]), runningIds[1]);

  // --- Mark-read changes local priority only ---
  const needs = findActivityById(view.projects, sortedRows[0].activityId);
  assert.ok(needs);
  // Mark blocked + ready read; needs_input remains highest
  const blocked = sortedRows.find((r) => r.presentation === "blocked")!;
  const ready = sortedRows.find((r) => r.presentation === "ready")!;
  settings = markActivityRead(settings, blocked);
  settings = markActivityRead(settings, ready);
  view = buildActivityView({ snapshot, connection, settings, now: Date.parse("2026-08-12T12:05:00.000Z") });
  assert.equal(view.presentation, "needs_input");
  const readyAfter = flattenActivities(view.projects).find((r) => r.activityId === ready.activityId)!;
  assert.equal(readyAfter.unread, false);
  assert.equal(readyAfter.presentation, "idle");
  assert.ok(
    flattenActivities(filterProjectGroups(view.projects, "completed")).some(
      (row) => row.activityId === ready.activityId,
    ),
    "read terminal activities must remain discoverable in the completed filter",
  );
  assert.deepEqual(
    flattenActivities(filterProjectGroups(view.projects, "attention")).map(
      (row) => row.presentation,
    ),
    ["needs_input"],
  );

  settings = markAllTerminalRead(settings, view);
  view = buildActivityView({ snapshot, connection, settings, now: Date.parse("2026-08-12T12:05:00.000Z") });
  // needs_input still unread after mark-all terminal
  const needAfter = flattenActivities(view.projects).find((r) => r.presentation === "needs_input");
  assert.ok(needAfter);

  // --- Transition/revision-driven pet bubble lifecycle ---
  let bubble = createInitialPetBubbleState();
  const runningSignal = {
    presentation: "running" as const,
    transitionId: "bubble-running-1",
    revision: 10,
    instanceId: "inst-u7",
    unread: false,
    reset: false,
  };
  bubble = reducePetBubbleState(bubble, { type: "snapshot", signal: runningSignal, now: 100 });
  assert.equal(bubble.visible, true);
  assert.equal(bubble.mode, "transient");
  const runningExpiresAt = bubble.expiresAt;
  assert.ok(runningExpiresAt != null && runningExpiresAt > 100);
  bubble = reducePetBubbleState(bubble, { type: "tick", now: runningExpiresAt! });
  assert.equal(bubble.visible, false);
  // Same transition replay and elapsed-only revision change must not re-trigger.
  bubble = reducePetBubbleState(bubble, {
    type: "snapshot",
    signal: { ...runningSignal, revision: 11 },
    now: runningExpiresAt! + 1,
  });
  assert.equal(bubble.visible, false);

  bubble = reducePetBubbleState(bubble, {
    type: "snapshot",
    signal: {
      ...runningSignal,
      presentation: "retrying",
      transitionId: "bubble-retrying-1",
      revision: 12,
    },
    now: 5000,
  });
  assert.equal(bubble.visible, true);
  assert.equal(bubble.mode, "transient");

  const needsSignal = {
    ...runningSignal,
    presentation: "needs_input" as const,
    transitionId: "bubble-needs-1",
    revision: 13,
    unread: true,
  };
  bubble = reducePetBubbleState(bubble, { type: "snapshot", signal: needsSignal, now: 6000 });
  assert.equal(bubble.visible, true);
  assert.equal(bubble.mode, "persistent");
  bubble = reducePetBubbleState(bubble, { type: "tick", now: 999999 });
  assert.equal(bubble.visible, true);
  bubble = reducePetBubbleState(bubble, {
    type: "viewed",
    transitionId: needsSignal.transitionId,
  });
  assert.equal(bubble.visible, false);
  bubble = reducePetBubbleState(bubble, { type: "snapshot", signal: needsSignal, now: 1000000 });
  assert.equal(bubble.visible, false, "viewed attention replay stays dismissed");

  const readySignal = {
    ...runningSignal,
    presentation: "ready" as const,
    transitionId: "bubble-ready-1",
    revision: 14,
    unread: true,
  };
  bubble = reducePetBubbleState(bubble, { type: "snapshot", signal: readySignal, now: 1000001 });
  assert.equal(bubble.visible, true);
  assert.equal(bubble.mode, "persistent");
  bubble = reducePetBubbleState(bubble, {
    type: "snapshot",
    signal: { ...readySignal, unread: false },
    now: 1000002,
  });
  assert.equal(bubble.visible, false, "ready bubble clears after local read");

  bubble = reducePetBubbleState(bubble, {
    type: "snapshot",
    signal: {
      ...runningSignal,
      transitionId: "bubble-reset-running",
      revision: 15,
      reset: true,
    },
    now: 1000003,
  });
  assert.equal(bubble.visible, false, "reset baseline does not replay running bubble");
  bubble = reducePetBubbleState(bubble, {
    type: "snapshot",
    signal: {
      ...runningSignal,
      presentation: "idle",
      transitionId: null,
      revision: 16,
    },
    now: 1000004,
  });
  assert.equal(bubble.visible, false);

  // --- Completion celebration dedup + coalescing (transitionId-based, pure) ---
  const readyCelebrateSignal = {
    presentation: "ready" as const,
    transitionId: "celebrate-ready-1",
    reducedMotion: false,
    reset: false,
  };
  let celebrate = createInitialPetCelebrateState();
  const firstCelebrate = shouldCelebrateCompletion(celebrate, readyCelebrateSignal, 1000);
  assert.equal(firstCelebrate.celebrate, true);
  celebrate = firstCelebrate.state;
  assert.equal(celebrate.lastTransitionId, "celebrate-ready-1");
  assert.equal(celebrate.lastCelebratedAt, 1000);
  // Same transition replay (SSE redelivery) must not re-fire.
  assert.equal(
    shouldCelebrateCompletion(celebrate, readyCelebrateSignal, 1100).celebrate,
    false,
  );
  // Reset/baseline must not replay historical celebration.
  assert.equal(
    shouldCelebrateCompletion(
      createInitialPetCelebrateState(),
      { ...readyCelebrateSignal, transitionId: "celebrate-ready-2", reset: true },
      2000,
    ).celebrate,
    false,
  );
  // Reduced motion never celebrates.
  assert.equal(
    shouldCelebrateCompletion(
      createInitialPetCelebrateState(),
      { ...readyCelebrateSignal, transitionId: "celebrate-ready-3", reducedMotion: true },
      2000,
    ).celebrate,
    false,
  );
  // Non-ready and missing transition id never celebrate.
  assert.equal(
    shouldCelebrateCompletion(
      createInitialPetCelebrateState(),
      {
        presentation: "running",
        transitionId: "celebrate-running-1",
        reducedMotion: false,
        reset: false,
      },
      2000,
    ).celebrate,
    false,
  );
  assert.equal(
    shouldCelebrateCompletion(
      createInitialPetCelebrateState(),
      {
        presentation: "ready",
        transitionId: null,
        reducedMotion: false,
        reset: false,
      },
      2000,
    ).celebrate,
    false,
  );
  // A completion inside the coalesce window is absorbed into the active burst.
  const coalesced = shouldCelebrateCompletion(
    celebrate,
    { ...readyCelebrateSignal, transitionId: "celebrate-ready-2" },
    2000,
  );
  assert.equal(coalesced.celebrate, false);
  celebrate = coalesced.state;
  assert.equal(celebrate.lastTransitionId, "celebrate-ready-2");
  assert.equal(celebrate.lastCelebratedAt, 1000);
  // After the window, a fresh completion celebrates again.
  const fresh = shouldCelebrateCompletion(
    celebrate,
    { ...readyCelebrateSignal, transitionId: "celebrate-ready-3" },
    3000,
  );
  assert.equal(fresh.celebrate, true);
  celebrate = fresh.state;
  assert.equal(celebrate.lastCelebratedAt, 3000);

  // --- One-shot semantic transition actions (pure) ---
  assert.equal(resolvePetTransitionAction("ready", "idle", false), "ready-to-idle-sink");
  assert.equal(resolvePetTransitionAction("retrying", "running", false), "retrying-to-running-go");
  assert.equal(resolvePetTransitionAction("ready", "idle", true), null);
  assert.equal(resolvePetTransitionAction(null, "idle", false), null);
  assert.equal(resolvePetTransitionAction("running", "idle", false), null);
  assert.equal(resolvePetTransitionAction("idle", "idle", false), null);

  // --- Idle-life scheduling policy (pure) ---
  assert.equal(
    shouldRunIdleLife({ animated: true, idle: true, hidden: false, reducedMotion: false, pressed: false, dragging: false }),
    true,
  );
  assert.equal(
    shouldRunIdleLife({ animated: true, idle: true, hidden: true, reducedMotion: false, pressed: false, dragging: false }),
    false,
  );
  assert.equal(
    shouldRunIdleLife({ animated: true, idle: true, hidden: false, reducedMotion: true, pressed: false, dragging: false }),
    false,
  );
  assert.equal(
    shouldRunIdleLife({ animated: true, idle: false, hidden: false, reducedMotion: false, pressed: false, dragging: false }),
    false,
  );
  assert.equal(
    shouldRunIdleLife({ animated: true, idle: true, hidden: false, reducedMotion: false, pressed: true, dragging: false }),
    false,
  );
  assert.equal(
    shouldRunIdleLife({ animated: false, idle: true, hidden: false, reducedMotion: false, pressed: false, dragging: false }),
    false,
  );
  assert.equal(nextBlinkDelayMs(() => 0), 2600);
  assert.equal(nextActDelayMs(() => 0), 6500);
  assert.equal(nextBlinkDelayMs(() => 1), 7200);
  assert.equal(nextActDelayMs(() => 1), 14000);

  // --- Terminal outcome label stays visible after read (decoupled from presentation) ---
  assert.deepEqual(petTerminalOutcome("succeeded"), { label: "已完成", glyph: "✓" });
  assert.deepEqual(petTerminalOutcome("failed"), { label: "失败", glyph: "!" });
  assert.deepEqual(petTerminalOutcome("cancelled"), { label: "已取消", glyph: "×" });
  assert.deepEqual(petTerminalOutcome("interrupted"), { label: "已中断", glyph: "!" });
  assert.deepEqual(petTerminalOutcome("ambiguous"), { label: "失败", glyph: "!" });
  assert.equal(petTerminalOutcome(null), null);

  // --- Notifications: baseline none; later once; replay none ---
  const baseSettings = createDefaultDesktopSettings();
  const baseline = selectNotifications({
    settings: baseSettings,
    snapshot,
    resetBaseline: true,
    appInBackground: true,
  });
  assert.equal(baseline.toNotify.length, 0);
  assert.ok(baseline.notifiedTransitionIds.length >= 1);

  let notifSettings = updateDesktopSettings(baseSettings, {
    notifiedTransitionIds: baseline.notifiedTransitionIds,
  });

  // Fresh transition after baseline
  const newTransitionId = buildAgentTransitionId("inst-u7", "s-new", 9, 1);
  const newActivity = activityInput({
    sessionId: "s-new",
    projectKey: "proj-a",
    projectName: "Alpha",
    title: "New ready",
    executionState: "settled",
    outcome: "succeeded",
    promptEpoch: 9,
    stateVersion: 1,
  });
  const snap2 = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 2,
    activities: [...activities, newActivity],
    recentTransitions: [
      {
        transitionId: newTransitionId,
        taskKey: buildAgentTaskKey("s-new"),
        activityId: buildAgentActivityId("inst-u7", "s-new", 9),
        source: "agent",
        projectKey: "proj-a",
        presentation: "ready",
        executionState: "settled",
        outcome: "succeeded",
        attention: "none",
        at: "2026-08-12T12:10:00.000Z",
      },
    ],
  });

  const first = selectNotifications({
    settings: notifSettings,
    snapshot: snap2,
    resetBaseline: false,
    appInBackground: true,
  });
  assert.equal(first.toNotify.length, 1);
  assert.equal(first.toNotify[0].transitionId, newTransitionId);
  assert.equal(first.toNotify[0].presentation, "ready");
  assert.equal(first.toNotify[0].body, "任务已完成");
  assert.equal(notificationBodyFor("needs_input"), "任务需要输入");
  assert.equal(notificationBodyFor("blocked"), "任务受阻");
  notifSettings = updateDesktopSettings(notifSettings, {
    notifiedTransitionIds: first.notifiedTransitionIds,
  });

  const replay = selectNotifications({
    settings: notifSettings,
    snapshot: snap2,
    resetBaseline: false,
    appInBackground: true,
  });
  assert.equal(replay.toNotify.length, 0);

  // completion never
  const neverSettings = updateDesktopSettings(createDefaultDesktopSettings(), {
    notification: { completion: "never", needsInput: true, blocked: true },
    notifiedTransitionIds: [],
  });
  const neverResult = selectNotifications({
    settings: neverSettings,
    snapshot: snap2,
    resetBaseline: false,
    appInBackground: true,
    transitions: snap2.recentTransitions,
  });
  assert.equal(
    neverResult.toNotify.filter((n) => n.presentation === "ready").length,
    0,
  );

  // background-only suppresses when app focused
  const bgSettings = updateDesktopSettings(createDefaultDesktopSettings(), {
    notification: { completion: "background-only", needsInput: true, blocked: true },
    notifiedTransitionIds: [],
  });
  const focused = selectNotifications({
    settings: bgSettings,
    snapshot: snap2,
    resetBaseline: false,
    appInBackground: false,
    transitions: snap2.recentTransitions,
  });
  assert.equal(focused.toNotify.filter((n) => n.presentation === "ready").length, 0);

  const controller = new DesktopNotificationController({
    isSupported: () => true,
    show: () => {
      throw new Error("should not show on baseline");
    },
  });
  const emittedBaseline = controller.handleSnapshot({
    settings: createDefaultDesktopSettings(),
    snapshot,
    resetBaseline: true,
  });
  assert.equal(emittedBaseline.emitted.length, 0);

  // --- Default position is bottom-right of work area (not 0,0) ---
  const pos = defaultPetWindowPosition({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.ok(pos.x > 1000);
  assert.ok(pos.y > 500);
  // Collapsed window must fit chrome + avatar (not the old 128² clip box).
  assert.ok(PET_WINDOW_DEFAULTS.petOnlyWidth >= 140);
  assert.ok(PET_WINDOW_DEFAULTS.petOnlyHeight >= 160);

  // --- Close-to-tray + click-through recovery ---
  let win = createInitialWindowManagerState({
    clickThrough: true,
    trayOpen: false,
    defaultPosition: pos,
  });
  assert.equal(win.bounds?.x, pos.x);
  assert.equal(win.bounds?.y, pos.y);
  assert.equal(win.bounds?.width, PET_WINDOW_DEFAULTS.petOnlyWidth);
  assert.equal(win.bounds?.height, PET_WINDOW_DEFAULTS.petOnlyHeight);
  win = handlePetWindowCloseRequest(win);
  assert.equal(win.visible, false);
  win = handleShowPet(win);
  assert.equal(win.visible, true);
  assert.equal(win.clickThrough, false);
  win = handleSetClickThrough(win, true);
  win = handleDisableClickThrough(win);
  assert.equal(win.clickThrough, false);
  assert.equal(win.visible, true);

  // Hidden layout changes must not resurrect a tray-hidden pet.
  const hiddenLayout = handleToggleTray(
    handlePetWindowCloseRequest(createInitialWindowManagerState({ trayOpen: false })),
    workAreaPreview(),
  );
  assert.equal(hiddenLayout.visible, false);
  assert.equal(hiddenLayout.trayExpanded, true);

  // --- Window reveal intents: passive vs user activation ---
  assert.equal(
    resolvePetWindowReveal({ visible: false, reason: "passive-snapshot" }),
    "keep",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: false, reason: "passive-connection" }),
    "keep",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: false, reason: "passive-notification" }),
    "keep",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: true, reason: "passive-snapshot" }),
    "keep",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: true, reason: "startup" }),
    "show-inactive",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: true, reason: "user-show" }),
    "activate",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: false, reason: "user-show" }),
    "activate",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: false, reason: "second-instance" }),
    "activate",
  );
  assert.equal(
    resolvePetWindowReveal({ visible: true, reason: "user-disable-click-through" }),
    "activate",
  );

  const hiddenState = handlePetWindowCloseRequest(
    createInitialWindowManagerState({ clickThrough: true, trayOpen: false }),
  );
  assert.equal(hiddenState.visible, false);

  {
    const rec = createRecordingPetWindow();
    applyWindowManagerState(rec.handle, hiddenState, {
      reveal: resolvePetWindowReveal({ visible: hiddenState.visible, reason: "passive-snapshot" }),
    });
    assert.deepEqual(rec.calls.filter(isRevealCall), ["hide"]);
    rec.handle.send("pet:state-changed", { presentation: "ready" });
    assert.ok(rec.calls.includes("send:pet:state-changed"));
    assert.equal(rec.calls.includes("show"), false);
    assert.equal(rec.calls.includes("showInactive"), false);
    assert.equal(rec.calls.includes("focus"), false);
  }

  {
    const rec = createRecordingPetWindow();
    applyWindowManagerState(rec.handle, hiddenState, {
      reveal: resolvePetWindowReveal({ visible: hiddenState.visible, reason: "passive-connection" }),
    });
    rec.handle.send("pet:state-changed", { connectionStatus: "connected" });
    assert.equal(rec.calls.includes("show"), false);
    assert.equal(rec.calls.includes("focus"), false);
    assert.equal(rec.handle.isVisible(), false);
  }

  {
    const rec = createRecordingPetWindow({ visible: true });
    applyWindowManagerState(rec.handle, { ...hiddenState, visible: true }, {
      reveal: resolvePetWindowReveal({ visible: true, reason: "startup" }),
    });
    assert.deepEqual(rec.calls.filter(isRevealCall), ["showInactive"]);
    assert.equal(rec.calls.includes("focus"), false);
  }

  {
    const rec = createRecordingPetWindow({ visible: true });
    applyWindowManagerState(rec.handle, { ...hiddenState, visible: true }, {
      reveal: resolvePetWindowReveal({ visible: true, reason: "passive-snapshot" }),
    });
    rec.handle.send("pet:state-changed", { presentation: "running" });
    assert.equal(rec.calls.includes("show"), false);
    assert.equal(rec.calls.includes("showInactive"), false);
    assert.equal(rec.calls.includes("focus"), false);
    assert.ok(rec.calls.includes("send:pet:state-changed"));
  }

  {
    const rec = createRecordingPetWindow();
    const shown = handleShowPet(hiddenState);
    applyWindowManagerState(rec.handle, shown, {
      reveal: resolvePetWindowReveal({ visible: shown.visible, reason: "user-show" }),
    });
    assert.equal(shown.visible, true);
    assert.equal(shown.clickThrough, false);
    assert.ok(rec.calls.includes("show"));
    assert.ok(rec.calls.includes("focus"));
    assert.equal(rec.calls.includes("showInactive"), false);
  }

  {
    const rec = createRecordingPetWindow({ destroyed: true });
    assert.equal(
      sendPetWindowChannel(rec.handle, "pet:state-changed", { presentation: "ready" }),
      false,
    );
    assert.doesNotThrow(() => {
      applyWindowManagerState(rec.handle, { ...hiddenState, visible: true }, { reveal: "activate" });
    });
    assert.deepEqual(rec.calls.filter(isRevealCall), []);
  }

  {
    const rec = createRecordingPetWindow();
    rec.handle.destroy();
    assert.equal(sendPetWindowChannel(rec.handle, "pet:state-changed", { ok: true }), false);
    assert.doesNotThrow(() => rec.handle.send("pet:state-changed", { ok: true }));
  }

  // Pet icon stays fixed on screen; tray grows outward (prefer down/right).
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const centerPos = { x: 800, y: 300 };
  win = {
    ...win,
    trayExpanded: false,
    trayAnchor: "top-left",
    bounds: {
      x: centerPos.x,
      y: centerPos.y,
      width: PET_WINDOW_DEFAULTS.petOnlyWidth,
      height: PET_WINDOW_DEFAULTS.petOnlyHeight,
    },
  };
  const centerStack = petStackScreenRect(win.bounds!, "top-left");
  win = handleToggleTray(win, workArea);
  assert.equal(win.trayExpanded, true);
  assert.equal(win.trayAnchor, "top-left");
  assert.equal(win.bounds?.width, PET_WINDOW_DEFAULTS.trayWidth);
  assert.equal(win.bounds?.height, PET_WINDOW_DEFAULTS.trayHeight);
  assert.deepEqual(petStackScreenRect(win.bounds!, win.trayAnchor), centerStack);

  // Collapse keeps the same pet-stack screen position.
  win = handleToggleTray(win, workArea);
  assert.equal(win.trayExpanded, false);
  assert.equal(win.bounds?.width, PET_WINDOW_DEFAULTS.petOnlyWidth);
  assert.equal(win.bounds?.height, PET_WINDOW_DEFAULTS.petOnlyHeight);
  assert.deepEqual(petStackScreenRect(win.bounds!, "top-left"), centerStack);

  // Bottom-right docked pet expands UP+LEFT so the icon does not jump to the card corner.
  const corner = defaultPetWindowPosition(workArea);
  win = {
    ...win,
    trayExpanded: false,
    trayAnchor: "top-left",
    bounds: {
      x: corner.x,
      y: corner.y,
      width: PET_WINDOW_DEFAULTS.petOnlyWidth,
      height: PET_WINDOW_DEFAULTS.petOnlyHeight,
    },
  };
  const cornerStack = petStackScreenRect(win.bounds!, "top-left");
  assert.equal(
    pickTrayLayoutAnchor(
      cornerStack,
      { width: PET_WINDOW_DEFAULTS.trayWidth, height: PET_WINDOW_DEFAULTS.trayHeight },
      workArea,
    ),
    "bottom-right",
  );
  win = handleToggleTray(win, workArea);
  assert.equal(win.trayExpanded, true);
  assert.equal(win.trayAnchor, "bottom-right");
  assert.ok(win.bounds!.x + win.bounds!.width <= workArea.x + workArea.width);
  assert.ok(win.bounds!.y + win.bounds!.height <= workArea.y + workArea.height);
  assert.deepEqual(petStackScreenRect(win.bounds!, win.trayAnchor), cornerStack);
  win = handleToggleTray(win, workArea);
  assert.equal(win.trayExpanded, false);
  assert.deepEqual(petStackScreenRect(win.bounds!, "top-left"), cornerStack);
  assert.ok(PET_LAYOUT.stackHeight === 136);

  // Custom body drag delta + soft edge clamp.
  const moved = handleMoveBy(win, { dx: 12, dy: -8 }, workArea);
  assert.equal(moved.bounds?.x, win.bounds!.x + 12);
  assert.equal(moved.bounds?.y, win.bounds!.y - 8);
  const mixedDisplayAreas = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 },
  ];
  assert.deepEqual(unionWorkAreas(mixedDisplayAreas), {
    x: 0,
    y: 0,
    width: 4480,
    height: 1440,
  });
  const boundaryState = {
    ...win,
    bounds: { x: 1780, y: 300, width: 140, height: 160 },
  };
  const crossedDisplay = handleMoveBy(boundaryState, { dx: 200, dy: 0 }, mixedDisplayAreas);
  assert.equal(crossedDisplay.bounds?.x, 1980);
  assert.ok(crossedDisplay.bounds!.x >= mixedDisplayAreas[1]!.x);
  const clamped = clampWindowBounds(
    { x: 5000, y: -200, width: 140, height: 160 },
    workArea,
  );
  assert.equal(clamped.x, 1920 - 140);
  assert.equal(clamped.y, 0);

  // Re-expand for remaining assertions that expect tray open is optional.
  win = handleToggleTray(win, workArea);
  assert.equal(win.trayExpanded, true);

  const prefs = petWindowWebPreferences("/tmp/preload.js");
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);

  // --- Service-not-running copy cannot execute ---
  let offline = createInitialConnectionState({ now: 10 });
  offline = reduceConnectionState(offline, { type: "connection_refused" }, 11);
  const offlineView = buildActivityView({
    snapshot: null,
    connection: offline,
    settings: createDefaultDesktopSettings(),
  });
  assert.equal(offlineView.presentation, "service_not_running");
  assert.equal(offlineView.petScale, "medium");
  assert.equal(offlineView.canCopyStartCommand, true);
  assert.equal(offlineView.startCommand, DESKTOP_START_COMMAND);
  const banner = connectionBannerText({
    connectionStatus: offlineView.connectionStatus,
    canCopyStartCommand: true,
    startCommand: offlineView.startCommand,
  });
  assert.ok(banner && banner.includes("蜗牛派服务未启动"));
  assert.ok(banner && banner.includes(DESKTOP_START_COMMAND));
  assert.ok(
    connectionBannerText({
      connectionStatus: "incompatible",
      canCopyStartCommand: false,
      startCommand: DESKTOP_START_COMMAND,
      reasonCode: "auth_required",
    })?.includes("桌宠设置"),
  );

  // --- Deep link gate ---
  const opened: string[] = [];
  const okOpen = openValidatedDeepLink({
    origin: "http://127.0.0.1:62666",
    relativeHref: "/?session=abc",
    openExternal: (url) => {
      opened.push(url);
    },
  });
  assert.equal(okOpen.ok, true);
  assert.deepEqual(opened, ["http://127.0.0.1:62666/?session=abc"]);

  const evil = openValidatedDeepLink({
    origin: "http://127.0.0.1:62666",
    relativeHref: "https://evil.example/phish",
    openExternal: () => {
      throw new Error("should not open");
    },
  });
  assert.equal(evil.ok, false);

  const rejected = rejectArbitraryRendererUrl("https://evil.example");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "absolute_url_rejected");

  const remoteOrigin = openValidatedDeepLink({
    origin: "https://example.com",
    relativeHref: "/?session=abc",
    openExternal: () => undefined,
  });
  assert.equal(remoteOrigin.ok, false);

  // --- Tray menu recovery contract ---
  const trayModel = buildTrayMenuModel({
    presentation: "service_not_running",
    connectionStatus: "service-not-running",
    clickThrough: true,
    activeCount: 0,
    attentionCount: 0,
    canCopyStartCommand: true,
    startCommand: DESKTOP_START_COMMAND,
  });
  const labels = trayModel.map((i) => i.label).join(" | ");
  assert.ok(labels.includes("显示桌宠"));
  assert.ok(labels.includes("取消鼠标穿透"));
  assert.ok(labels.includes("重试连接"));
  assert.ok(labels.includes("打开 WebUI"));
  assert.ok(labels.includes("退出桌宠"));
  assert.ok(labels.includes(DESKTOP_START_COMMAND));
  const quit = trayModel.find((i) => i.id === "quit");
  assert.ok(quit);
  assertQuitLabelSafe(quit!.label);
  assert.equal(trayItemToAction("quit"), "quit");
  assert.ok(buildTrayTooltip({ presentation: "running", activeCount: 2, attentionCount: 1 }).includes("运行中"));

  // --- Preview isolation + builtin pet manifest v2 ---
  const previewSrc = readFileSync(
    path.join(process.cwd(), "scripts", "preview-desktop-pet-states.mjs"),
    "utf8",
  );
  assert.ok(previewSrc.includes("desktop/.preview"));
  assert.equal(/\bgetToken\s*\(|PI_CODING_AGENT_DIR/.test(previewSrc), false);
  assert.equal(/fetch\s*\(|EventSource|127\.0\.0\.1:\d+\/api/.test(previewSrc), false);
  assert.ok(existsSync(path.join(process.cwd(), "docs", "operations", "desktop-pet-visual-review.md")));

  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "preview-desktop-pet-states.mjs")], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  const previewOut = path.join(process.cwd(), "desktop", ".preview");
  const previewIndex = readFileSync(path.join(previewOut, "index.html"), "utf8");
  const previewFrame = readFileSync(path.join(previewOut, "frame.html"), "utf8");
  assert.ok(previewIndex.includes("frame-src 'self'"));
  assert.ok(previewFrame.includes("frame-ancestors 'self'"));
  assert.equal(previewFrame.includes("window.parent"), false);
  assert.ok(previewFrame.includes('<script src="./fixtures.js"></script>'));
  assert.ok(previewFrame.includes('<script src="./preview-frame-bootstrap.js"></script>'));
  const previewBootstrap = readFileSync(
    path.join(previewOut, "preview-frame-bootstrap.js"),
    "utf8",
  );
  assert.ok(previewBootstrap.includes("__SNAIL_PET_PREVIEW_FIXTURES__"));
  assert.ok(previewBootstrap.includes("__SNAIL_PET_PREVIEW__"));
  assert.equal(previewBootstrap.includes("window.parent"), false);

  const previewPreloadSrc = readFileSync(
    path.join(process.cwd(), "desktop", "preload", "pet-preload.ts"),
    "utf8",
  );
  assert.ok(previewPreloadSrc.includes("setReducedMotion"));
  assert.equal(/__SNAIL_PET_PREVIEW__|preview-desktop-pet/.test(previewPreloadSrc), false);
  assert.equal(isRendererIpcChannel("pet:preview"), false);
  assert.equal(PET_RENDERER_ALLOWED_CHANNELS.includes("pet:preview"), false);

  const defaultManifest = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "desktop", "assets", "pets", "snail-default", "manifest.json"),
      "utf8",
    ),
  );
  const accepted = validatePetManifestDocument(defaultManifest);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.manifest.version, 2);
    assert.equal(accepted.manifest.renderMode, "css");
    assert.equal(accepted.manifest.sheet, undefined);
  }
  assert.equal(validatePetManifestDocument({ ...defaultManifest, version: 1 }).ok, false);
  const statesWithoutIdle = { ...defaultManifest.states };
  delete statesWithoutIdle.idle;
  assert.equal(
    validatePetManifestDocument({ ...defaultManifest, states: statesWithoutIdle }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...defaultManifest,
      states: { ...defaultManifest.states, flying: defaultManifest.states.idle },
    }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...defaultManifest,
      renderMode: "spritesheet",
      sheet: { src: "../secret.png", frameWidth: 32, frameHeight: 32, columns: 2, rows: 2 },
    }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...defaultManifest,
      renderMode: "spritesheet",
      sheet: { src: "http://example.com/sheet.png", frameWidth: 32, frameHeight: 32, columns: 2, rows: 2 },
    }).ok,
    false,
  );
  const spriteStates = Object.fromEntries(
    Object.entries(
      defaultManifest.states as Record<string, Record<string, unknown>>,
    ).map(([state, frame], index) => [
      state,
      {
        ...frame,
        firstFrame: index * 2,
        frameCount: 2,
        durationMs: 240,
        staticFrameIndex: 0,
      },
    ]),
  );
  const validSpriteManifest = {
    ...defaultManifest,
    renderMode: "spritesheet",
    states: spriteStates,
    sheet: { src: "snail.png", frameWidth: 32, frameHeight: 32, columns: 4, rows: 4 },
  };
  assert.equal(validatePetManifestDocument(validSpriteManifest).ok, true);
  assert.equal(
    validatePetManifestDocument({
      ...validSpriteManifest,
      states: {
        ...spriteStates,
        idle: { ...spriteStates.idle, frameCount: 17 },
      },
    }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...validSpriteManifest,
      states: {
        ...spriteStates,
        idle: { ...spriteStates.idle, frameCount: undefined },
      },
    }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...validSpriteManifest,
      states: {
        ...spriteStates,
        idle: { ...spriteStates.idle, firstFrame: 15, frameCount: 2 },
      },
    }).ok,
    false,
  );
  assert.equal(
    validatePetManifestDocument({
      ...defaultManifest,
      command: "calc.exe",
    }).ok,
    false,
  );
  assert.equal(isSafePetAssetPath("../x.png"), false);
  assert.equal(isSafePetAssetPath("file://x.png"), false);
  assert.equal(isSafePetAssetPath(`${"a".repeat(81)}.png`), false);
  assert.equal(resolveBuiltinPetManifest("missing", { id: "evil" }).id, "snail-default");
  assert.equal(
    resolveBuiltinPetManifest("snail-classic", {
      ...defaultManifest,
      id: "snail-classic",
      name: "Broken",
      version: 9,
    }).renderMode,
    "css",
  );
  validatePackagedPetAssets(path.join(process.cwd(), "desktop", "assets", "pets"), {
    readFile: (filePath) => readFileSync(filePath, "utf8"),
    exists: existsSync,
    size: (filePath) => statSync(filePath).size,
    join: path.join,
  });
  const packagedFiles = new Map<string, string>([
    ["/pets/snail-default/manifest.json", JSON.stringify(validSpriteManifest)],
    ["/pets/snail-default/snail.png", "sprite"],
    [
      "/pets/snail-classic/manifest.json",
      JSON.stringify({ ...defaultManifest, id: "snail-classic", name: "Classic Snail" }),
    ],
  ]);
  const packagedIo = {
    readFile: (filePath: string) => packagedFiles.get(filePath) ?? "",
    exists: (filePath: string) => packagedFiles.has(filePath),
    size: (filePath: string) => packagedFiles.get(filePath)?.length ?? 0,
    join: path.posix.join,
  };
  assert.deepEqual(validatePackagedPetAssets("/pets", packagedIo), [
    { id: "snail-default", renderMode: "spritesheet" },
    { id: "snail-classic", renderMode: "css" },
  ]);
  packagedFiles.delete("/pets/snail-default/snail.png");
  assert.throws(
    () => validatePackagedPetAssets("/pets", packagedIo),
    /missing pet sheet/,
  );
  packagedFiles.set("/pets/snail-default/snail.png", "sprite");
  assert.throws(
    () =>
      validatePackagedPetAssets("/pets", {
        ...packagedIo,
        size: (filePath: string) =>
          filePath.endsWith("snail.png") ? 256 * 1024 + 1 : packagedIo.size(filePath),
      }),
    /pet sheet size/,
  );
  assert.equal(
    acceptStaticPetPreview({
      presentation: "idle",
      projects: [],
      token: "leak",
    }),
    null,
  );
  assert.ok(
    acceptStaticPetPreview({
      presentation: "idle",
      projects: [],
      origin: "http://127.0.0.1:62666",
    }),
  );

  // --- Reduced motion + builtin pets ---
  const manifest = getBuiltinPetManifest("snail-default");
  const animated = resolvePetFrame(manifest, "running", false);
  assert.equal(animated.animated, true);
  const staticFrame = resolvePetFrame(manifest, "running", true);
  assert.equal(staticFrame.animated, false);
  assert.equal(staticFrame.frame, "running-static");
  assert.equal(resolvePetFrame(manifest, "idle", false).animated, true);
  assert.equal(resolvePetFrame(manifest, "idle", true).animated, false);
  assert.ok(staticFrame.label);
  assert.ok(staticFrame.glyph);
  assert.equal(getBuiltinPetManifest("missing").id, "snail-default");
  assert.equal(formatElapsed(65000), "1m 5s");
  assert.equal(
    resolveActivityElapsedMs(
      { startedAt: "2026-08-13T00:00:00.000Z", elapsedMs: 1000 },
      Date.parse("2026-08-13T00:01:05.000Z"),
    ),
    65000,
  );
  assert.equal(
    resolveActivityElapsedMs(
      {
        startedAt: "2026-08-13T00:00:00.000Z",
        endedAt: "2026-08-13T00:00:30.000Z",
        elapsedMs: 1000,
      },
      Date.parse("2026-08-13T00:01:05.000Z"),
    ),
    30000,
  );
  assert.equal(petSourceLabel("quick_command"), "快捷命令");
  assert.equal(formatActivityProgress({ kind: "ratio", current: 3, total: 4 }), "3/4 · 75%");
  assert.equal(
    formatActivityProgress({ kind: "counters", currentToolName: "bash", toolCount: 2 }, 1),
    "bash · 2 工具 · 1 Subagent",
  );
  assert.equal(formatActivityProgress({ kind: "indeterminate" }), null);
  assert.equal(moveActivitySelection(["a", "b", "c"], "a", "next"), "b");
  assert.equal(moveActivitySelection(["a", "b", "c"], "a", "prev"), "c");

  // --- Settings migration + layout geometry ---
  const migrated = parseDesktopSettingsJson(
    JSON.stringify({
      version: 1,
      port: 62666,
      selectedPetId: "snail-classic",
      alwaysOnTop: true,
      windowPosition: { x: 120, y: 80 },
    }),
  );
  assert.equal(migrated.petScale, "medium");
  assert.equal(migrated.selectedPetId, "snail-classic");
  assert.deepEqual(migrated.windowPosition, { x: 120, y: 80 });
  assert.equal(normalizeDesktopSettings({ petScale: "huge" }).petScale, "medium");
  assert.equal(normalizeDesktopSettings({ petScale: 0.85 }).petScale, "small");
  assert.equal(normalizeDesktopSettings({ petScale: 1.2 }).petScale, "large");
  assert.equal(normalizeDesktopSettings({ windowPosition: { x: Number.NaN, y: 10 } }).windowPosition, null);
  assert.equal(
    normalizeDesktopSettings({ windowPosition: { x: "12", y: 8 } }).windowPosition,
    null,
  );

  const mediumSpec = resolvePetLayoutSpec("medium");
  const smallSpec = resolvePetLayoutSpec("small");
  const largeSpec = resolvePetLayoutSpec("large");
  assert.equal(mediumSpec.collapsedWidth, PET_WINDOW_DEFAULTS.petOnlyWidth);
  assert.equal(mediumSpec.collapsedHeight, PET_WINDOW_DEFAULTS.petOnlyHeight);
  assert.equal(mediumSpec.trayWidth, PET_WINDOW_DEFAULTS.trayWidth);
  assert.equal(mediumSpec.stackHeight, PET_LAYOUT.stackHeight);
  assert.ok(smallSpec.collapsedWidth < mediumSpec.collapsedWidth);
  assert.ok(largeSpec.collapsedWidth > mediumSpec.collapsedWidth);
  assert.ok(smallSpec.collapsedWidth >= smallSpec.rootPad * 2 + smallSpec.stackWidth);
  assert.ok(smallSpec.collapsedHeight >= smallSpec.rootPad * 2 + smallSpec.stackHeight);
  assert.ok(largeSpec.collapsedWidth >= largeSpec.rootPad * 2 + largeSpec.stackWidth);
  assert.ok(largeSpec.collapsedHeight >= largeSpec.rootPad * 2 + largeSpec.stackHeight);
  assert.equal(smallSpec.clickTargetWidth, smallSpec.surfaceSize);
  assert.equal(largeSpec.clickTargetWidth, largeSpec.surfaceSize);
  assert.equal(
    updateDesktopSettings(
      updateDesktopSettings(createDefaultDesktopSettings(), { petScale: "large" }),
      { alwaysOnTop: false },
    ).petScale,
    "large",
  );

  const scaleWorkArea = { x: 0, y: 0, width: 1920, height: 1080 };
  let scaled = createInitialWindowManagerState({
    position: { x: 800, y: 300 },
    petScale: "medium",
    trayOpen: false,
  });
  const mediumStack = petStackScreenRect(scaled.bounds!, "top-left", mediumSpec);
  scaled = handleSetPetScale(scaled, "large", scaleWorkArea);
  assert.equal(scaled.petScale, "large");
  assert.equal(scaled.bounds?.width, largeSpec.collapsedWidth);
  assert.equal(scaled.bounds?.height, largeSpec.collapsedHeight);
  assert.deepEqual(petStackScreenRect(scaled.bounds!, "top-left", largeSpec), {
    ...mediumStack,
    width: largeSpec.stackWidth,
    height: largeSpec.stackHeight,
  });
  const largeStack = petStackScreenRect(scaled.bounds!, "top-left", largeSpec);
  scaled = handleToggleTray(scaled, scaleWorkArea);
  assert.equal(scaled.bounds?.width, largeSpec.trayWidth);
  assert.equal(scaled.bounds?.height, largeSpec.trayHeight);
  assert.deepEqual(petStackScreenRect(scaled.bounds!, scaled.trayAnchor, largeSpec), largeStack);

  const recovered = recoverWindowToNearestWorkArea(
    createInitialWindowManagerState({
      position: { x: 4000, y: 200 },
      petScale: "small",
      trayOpen: false,
    }),
    [scaleWorkArea],
  );
  assert.ok((recovered.bounds?.x ?? 0) + (recovered.bounds?.width ?? 0) <= scaleWorkArea.width);
  assert.equal(recovered.bounds?.width, smallSpec.collapsedWidth);
  const restored = handleRestoreDefaultPosition(
    createInitialWindowManagerState({
      position: { x: 12, y: 12 },
      petScale: "large",
      trayOpen: true,
    }),
    scaleWorkArea,
  );
  assert.equal(restored.trayExpanded, false);
  assert.deepEqual(restored.bounds, {
    ...defaultPetWindowPosition(scaleWorkArea, "large"),
    width: largeSpec.collapsedWidth,
    height: largeSpec.collapsedHeight,
  });
  const restoredDefaults = handleRestoreDefaultPosition(
    handleSetPetScale(restored, "medium", scaleWorkArea),
    scaleWorkArea,
  );
  assert.equal(restoredDefaults.petScale, "medium");
  assert.deepEqual(restoredDefaults.bounds, {
    ...defaultPetWindowPosition(scaleWorkArea, "medium"),
    width: mediumSpec.collapsedWidth,
    height: mediumSpec.collapsedHeight,
  });

  // --- Settings persistence without tokens ---
  const memory = new Map<string, string>();
  const fsMock: SettingsFs = {
    readFile: (p) => {
      const v = memory.get(p);
      if (v == null) throw new Error("missing");
      return v;
    },
    writeFile: (p, data) => {
      memory.set(p, data);
    },
    mkdirp: () => undefined,
    exists: (p) => memory.has(p),
  };
  const userData = "/tmp/snail-pet-user";
  saveDesktopSettingsFile(userData, createDefaultDesktopSettings({ port: 62667 }), fsMock);
  const loaded = loadDesktopSettingsFile(userData, fsMock);
  assert.equal(loaded.port, 62667);
  assert.equal(settingsFilePath(userData).endsWith("desktop-pet-settings.json"), true);
  assert.equal(JSON.stringify(loaded).includes("token"), false);

  // --- Autostart host only toggles login item ---
  let openAtLogin = false;
  const loginHost = {
    getLoginItemSettings: () => ({ openAtLogin }),
    setLoginItemSettings: (s: { openAtLogin: boolean }) => {
      openAtLogin = s.openAtLogin;
    },
  };
  assert.equal(readLaunchAtLogin(loginHost), false);
  assert.equal(applyLaunchAtLogin(loginHost, true), true);
  assert.equal(openAtLogin, true);

  // --- IPC allowlist ---
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.getState), true);
  assert.equal(isRendererIpcChannel("pet:eval"), false);
  assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.copyStartCommand));
  assert.ok(!PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.stateChanged));

  // --- Preload surface must not expose token helpers ---
  const preloadSrc = readFileSync(
    path.join(process.cwd(), "desktop", "preload", "pet-preload.ts"),
    "utf8",
  );
  assert.equal(/getToken|observerToken|process\.pid/.test(preloadSrc), false);
  assert.ok(preloadSrc.includes("contextBridge.exposeInMainWorld"));
  assert.ok(preloadSrc.includes("snailPet"));

  // --- Static desktop tree: no service control ---
  const desktopRoot = path.join(process.cwd(), "desktop");
  for (const file of collectDesktopSources(desktopRoot)) {
    const rel = path.relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");
    assertNoServiceControl(source, rel);
  }

  // Packaged Electron is the application entry even when argv[1] is absent.
  assert.equal(
    shouldAutoStartDesktopMain({ isElectron: true, disableAutoMain: false }),
    true,
  );
  assert.equal(
    shouldAutoStartDesktopMain({ isElectron: false, disableAutoMain: false }),
    false,
  );
  assert.equal(
    shouldAutoStartDesktopMain({ isElectron: true, disableAutoMain: true }),
    false,
  );
  for (const event of [
    "--squirrel-install",
    "--squirrel-updated",
    "--squirrel-uninstall",
    "--squirrel-obsolete",
  ]) {
    assert.equal(isSquirrelLifecycleEvent(["snail-pi-pet.exe", event]), true);
  }
  assert.equal(
    isSquirrelLifecycleEvent(["snail-pi-pet.exe", "--squirrel-firstrun"]),
    false,
  );

  // main.ts must not warn about interrupting tasks on quit
  const mainSrc = readFileSync(path.join(process.cwd(), "desktop", "main", "main.ts"), "utf8");
  assert.equal(/会中断任务|interrupt tasks|stop the service/.test(mainSrc), false);
  assert.ok(mainSrc.includes("No task-interruption warning") || mainSrc.includes("cannot stop"));
  assert.ok(mainSrc.includes("dragWorkAreas.length > 0 ? dragWorkAreas : resolveWorkArea()"));

  // copyStartCommand must not execute
  assert.ok(mainSrc.includes("Copy only"));
  assert.equal(/\bexec\(|\bspawn\(|shell\.openPath\(\s*["']spi/.test(mainSrc), false);

  // Passive snapshot/reconnect/notification paths must not activate the pet window.
  assert.ok(mainSrc.includes("showInactive"));
  assert.ok(mainSrc.includes("show: false"));
  assert.ok(mainSrc.includes("sendPetWindowChannel"));
  assert.ok(mainSrc.includes("passive-connection"));
  assert.ok(mainSrc.includes('"user-show"'));
  assert.ok(mainSrc.includes('"second-instance"'));
  assert.ok(mainSrc.includes("user-disable-click-through"));
  assert.equal(/petWindow\?\.focus\(/.test(mainSrc), false);
  assert.ok(mainSrc.includes("Never show/focus a hidden pet"));
  assert.ok(mainSrc.includes("display-added"));
  assert.ok(mainSrc.includes("display-removed"));
  assert.ok(mainSrc.includes("display-metrics-changed"));
  assert.ok(mainSrc.includes("recoverWindowToNearestWorkArea"));
  assert.ok(mainSrc.includes("handleRestoreDefaultPosition"));
  assert.match(
    mainSrc,
    /restoreDefaultPosition[\s\S]{0,420}handleSetPetScale\(windowState, "medium"/,
  );
  const notifyClick = mainSrc.match(/n\.on\(\s*["']click["'][\s\S]{0,180}/);
  assert.ok(notifyClick);
  assert.ok(notifyClick![0].includes("openActivityDeepLink"));
  assert.equal(/handleShowPet|focus\(/.test(notifyClick![0]), false);

  // Package contract
  assert.equal(DESKTOP_PACKAGE_CONTRACT.petOnly, true);
  assert.equal(DESKTOP_PACKAGE_CONTRACT.separateFromNpmSpi, true);
  assert.ok(DESKTOP_PACKAGE_CONTRACT.forbiddenBundlePaths.includes(".next"));
  assert.ok(DESKTOP_PACKAGE_CONTRACT.forbiddenBundlePaths.includes("bin/pi-web.js"));

  // Required asset manifests exist
  for (const petId of ["snail-default", "snail-classic"]) {
    const manifestPath = path.join(
      process.cwd(),
      "desktop",
      "assets",
      "pets",
      petId,
      "manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string; states: Record<string, unknown> };
    assert.equal(manifest.id, petId);
    for (const state of [
      "idle",
      "running",
      "retrying",
      "needs_input",
      "ready",
      "blocked",
      "disconnected",
      "service_not_running",
    ]) {
      assert.ok(manifest.states[state], `${petId} missing state ${state}`);
    }
  }

  // Renderer HTML CSP + no inline node + drag/close affordances
  const html = readFileSync(path.join(process.cwd(), "desktop", "renderer", "index.html"), "utf8");
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));
  assert.equal(html.includes("nodeIntegration"), false);
  // Pet body owns click-vs-drag; no separate drag strip markup.
  assert.equal(html.includes("pet-drag-bar"), false);
  assert.ok(html.includes('id="btn-hide"'));
  assert.ok(html.includes("隐藏到托盘"));
  assert.ok(html.includes('id="pet-caption"'));
  assert.ok(html.includes('id="settings-panel"'));
  assert.ok(html.includes('id="auth-panel"'));
  assert.ok(
    html.indexOf('id="settings-panel"') < html.indexOf('id="auth-panel"'),
    "access key controls must live inside desktop pet settings",
  );
  assert.ok(html.includes('data-pet-id="snail-classic"'));
  assert.ok(html.includes('data-pet-scale="large"'));
  assert.ok(html.includes("恢复默认位置与尺寸"));
  assert.ok(html.includes("收起活动列表"));
  assert.ok(html.includes('id="activity-filters"'));
  for (const filter of ["all", "attention", "running", "completed"]) {
    assert.ok(html.includes(`data-activity-filter="${filter}"`));
  }

  const css = readFileSync(path.join(process.cwd(), "desktop", "renderer", "pet.css"), "utf8");
  assert.ok(css.includes("-webkit-app-region: drag"));
  assert.ok(css.includes("-webkit-app-region: no-drag"));
  // Author display rules must not resurrect [hidden] surfaces (collapsed tray bleed).
  assert.ok(css.includes(".activity-tray[hidden]"));
  assert.ok(css.includes(".pet-badge[hidden]"));
  assert.ok(css.includes("display: none !important"));
  assert.ok(css.includes('data-tray-anchor="bottom-right"'));
  assert.ok(css.includes("column-reverse"));
  assert.ok(css.includes('.pet-root[data-pet="snail-classic"]'));
  assert.ok(css.includes('data-pet-scale="large"'));
  assert.ok(css.includes("--pet-scale"));
  assert.ok(css.includes("background: transparent"));
  assert.ok(css.includes("prefers-reduced-motion: reduce"));
  assert.ok(css.includes(".activity-filter"));
  // Pet life + tray polish markers (idle acts, press duck, eye follow, confetti, pop).
  for (const marker of [
    "idle-act-look",
    "idle-act-sleepy",
    "idle-act-stretch",
    "is-pressed",
    "--eye-shift-x",
    "confetti-fly",
    "tray-pop",
    "empty-pet",
  ]) {
    assert.ok(css.includes(marker), `pet.css missing ${marker}`);
  }
  // Running loop redesign: no whole-body scoot/shell rotation; staggered focus parts + drop pop.
  assert.equal(css.includes("pet-scoot"), false);
  assert.equal(css.includes("shell-focus"), false);
  for (const marker of [
    "running-focus",
    "running-head-probe",
    "running-tail-stretch",
    "running-shell-gloss",
    "pop-out",
    "transition-ready-sink",
    "transition-retry-go",
  ]) {
    assert.ok(css.includes(marker), `pet.css missing ${marker}`);
  }
  const rendererSource = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-app.tsx"),
    "utf8",
  );
  assert.ok(rendererSource.includes("scheduleIdleActs"));
  assert.ok(rendererSource.includes("launchConfetti"));
  assert.ok(rendererSource.includes("dataset.presentation"));
  // P1: quick jump + keyboard path, drag pop-out, celebration dedup, timer cleanup, outcome label.
  assert.ok(rendererSource.includes("canJumpToPrimary"));
  assert.ok(rendererSource.includes("activatePet"));
  assert.ok(rendererSource.includes('event.key !== "Enter"'));
  assert.ok(rendererSource.includes('classList.add("pop-out")'));
  assert.ok(rendererSource.includes("shouldCelebrateCompletion"));
  assert.ok(rendererSource.includes("petDropPopTimer"));
  assert.ok(rendererSource.includes("clearTimeout(petDropPopTimer)"));
  assert.ok(rendererSource.includes("dataset.outcome"));
  // P2: transition actions, blink/act scheduling, hidden-window pause.
  assert.ok(rendererSource.includes("resolvePetTransitionAction"));
  assert.ok(rendererSource.includes("startTransition"));
  assert.ok(rendererSource.includes("clearTransition"));
  assert.ok(rendererSource.includes("blinkEnabled"));
  assert.ok(rendererSource.includes("actEnabled"));
  assert.ok(rendererSource.includes("actActive"));
  assert.ok(rendererSource.includes("onVisibilityChange"));
  assert.ok(rendererSource.includes('addEventListener("visibilitychange"'));
  assert.ok(rendererSource.includes('removeEventListener("visibilitychange"'));
  assert.ok(rendererSource.includes("nextBlinkDelayMs"));
  assert.ok(rendererSource.includes("nextActDelayMs"));
  assert.ok(css.includes(".row-child-meta"));
  assert.ok(css.includes(".row-actions"));
  assert.ok(html.includes("pet-stack"));
  assert.ok(html.includes("data-tray-anchor"));

  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.hideToTray), true);
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.moveBy), true);
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.restoreDefaultPosition), true);
  assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.restoreDefaultPosition));

  const preloadBridge = readFileSync(
    path.join(process.cwd(), "desktop", "preload", "pet-preload.ts"),
    "utf8",
  );
  assert.ok(preloadBridge.includes("moveBy"));
  assert.ok(preloadBridge.includes("restoreDefaultPosition"));

  const petAppSource = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-app.tsx"),
    "utf8",
  );
  assert.ok(petAppSource.includes("打开任务"));
  assert.ok(petAppSource.includes("标记已读"));
  assert.ok(petAppSource.includes("Subagent 安全摘要"));
  assert.ok(petAppSource.includes("syncElapsedTimer"));
  assert.ok(petAppSource.includes("current?.trayOpen === true"));
  assert.ok(petAppSource.includes("!settingsOpen"));
  assert.ok(petAppSource.includes("setInterval(refreshElapsedLabels, 1000)"));
  assert.ok(petAppSource.includes("clearElapsedTimer"));
  const markReadHandler = petAppSource.match(
    /readButton\.addEventListener\("click",[\s\S]{0,160}?\n\s*}\);/,
  );
  assert.ok(markReadHandler);
  assert.ok(markReadHandler![0].includes("markRead"));
  assert.equal(markReadHandler![0].includes("openActivity"), false);
  const openHandler = petAppSource.match(
    /openButton\.addEventListener\("click",[\s\S]{0,220}?\n\s*}\);/,
  );
  assert.ok(openHandler);
  assert.ok(openHandler![0].includes("openActivity"));
  assert.ok(openHandler![0].includes("selectActivity"));

  const openActivityHandler = mainSrc.match(
    /ipcMain\.handle\(PET_IPC_CHANNELS\.openActivity,[\s\S]{0,520}?\n\s*}\);/,
  );
  assert.ok(openActivityHandler);
  assert.ok(openActivityHandler![0].includes("markActivityRead"));
  assert.ok(openActivityHandler![0].includes("openActivityDeepLink"));

  const petAppJs = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-app.js"),
    "utf8",
  );
  assert.ok(petAppJs.includes("DRAG_THRESHOLD_PX"));
  assert.ok(petAppJs.includes("moveBy"));
  assert.ok(petAppJs.includes("is-collapsed"));
  assert.ok(petAppJs.includes("formatActivityProgress"));
  assert.ok(petAppJs.includes("selectedPetId"));
  assert.ok(petAppJs.includes("petScale"));
  assert.ok(petAppJs.includes("restoreDefaultPosition"));
  assert.ok(petAppJs.includes("settingsOpen"));
  assert.ok(petAppJs.includes("filterProjectGroups"));
  assert.ok(petAppJs.includes("resolveActivitySelection"));
  assert.ok(petAppJs.includes("row-child-toggle"));
  assert.ok(petAppJs.includes("markRead"));

  // Collapsed avatar labels stay short Chinese strings (fit 112px surface).
  assert.equal(resolvePetFrame(getBuiltinPetManifest("snail-default"), "idle", false).label, "空闲");
  assert.equal(
    resolvePetFrame(getBuiltinPetManifest("snail-default"), "service_not_running", false).label,
    "未启动",
  );

  // Unread helper
  const unreadIds = listUnreadTransitionIds(
    buildActivityView({
      snapshot,
      connection,
      settings: createDefaultDesktopSettings(),
      now: Date.now(),
    }),
  );
  assert.ok(unreadIds.length >= 2);

  // projectActivityRow sanity
  const row = projectActivityRow(projectActivity(activities[0]), { acknowledgedTransitionIds: [] }, Date.now());
  assert.equal(row.source, "agent");
  assert.ok(row.deepLink.startsWith("/"));

  // sortProjectGroups stable
  const groups = sortProjectGroups(view.projects);
  assert.equal(groups.length, view.projects.length);

  console.log("smoke-desktop-contract: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
