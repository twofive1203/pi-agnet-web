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
  isDndSuppressiblePresentation,
  shouldSuppressProactiveByDnd,
} from "../desktop/main/dnd-policy";
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
  PET_MAIN_PUSH_CHANNELS,
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
  DesktopSoundCueController,
  selectSoundCues,
  soundCueForPresentation,
  SOUND_COOLDOWN_MS,
} from "../desktop/main/sound-policy";
import { isSoundCueKind, SOUND_CUE_KINDS } from "../desktop/main/sound-cue";
import {
  loadDesktopSettingsFile,
  saveDesktopSettingsFile,
  settingsFilePath,
  type SettingsFs,
} from "../desktop/main/settings-persistence";
import {
  assertDesktopSettingsSafe,
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
  parseDesktopSettingsJson,
  serializeDesktopSettings,
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
  isCustomPetId,
  isSafeCustomPetSheetDataUrl,
  isSafePetAssetPath,
  decodeBase64PetBytes,
  validateCustomPetAsset,
  validatePackagedPetAssets,
  validatePetManifestDocument,
  validateRendererCatalogEntry,
  validateRendererPetAsset,
} from "../desktop/renderer/pet-assets";
import {
  validateCodexPetDocument,
  isCodexAtlasSize,
  CODEX_PET_V1_HEIGHT,
  CODEX_PET_V1_WIDTH,
  CODEX_PET_V2_HEIGHT,
  CODEX_PET_V2_WIDTH,
} from "../desktop/renderer/codex-pet-assets";
import {
  buildPetKey,
  DEFAULT_PET_KEY,
  parsePetKey,
  petCssToken,
  resolvePetKey,
} from "../desktop/renderer/pet-key";
import {
  assertNoLookRows,
  canApplyWaveOverlay,
  clipTotalDurationMs,
  lookCellIndex,
  profileFromCodexMetadata,
  profileFromSnailManifest,
  quantizeCodexLookDirection,
  resolveActivePetClip,
  resolveCodexDragClip,
  SNAIL_STATE_TO_CODEX_CLIP,
} from "../desktop/renderer/pet-runtime-profile";
import {
  connectionBannerText,
  countActivitiesByFilter,
  createInitialIdleSleepState,
  createInitialPetBubbleState,
  createInitialPetCelebrateState,
  createInitialPetClickSequenceState,
  createInitialRunningCueState,
  filterProjectGroups,
  formatActiveModel,
  formatActivityProgress,
  formatElapsed,
  formatSessionResources,
  getBuiltinPetManifest,
  moveActivitySelection,
  nextActDelayMs,
  nextBlinkDelayMs,
  nextIdleSleepBoundaryMs,
  petSourceLabel,
  petTerminalOutcome,
  reduceIdleSleepState,
  reducePetBubbleState,
  reducePetClickSequence,
  reduceRunningCueState,
  resolveActivityElapsedMs,
  resolveActivitySelection,
  resolveBuiltinPetManifest,
  resolveCustomPetManifest,
  resolveIdleSleepStage,
  resolvePetFrame,
  resolvePetBodyClick,
  resolvePetReaction,
  resolvePrimaryContextMeter,
  resolvePetTransitionAction,
  resolveRunningCue,
  resolveRunningCueVisual,
  runningCueNextUpdateAt,
  selectPrimaryActivity,
  canPlayPetInteract,
  shouldAllowPetReaction,
  shouldCelebrateCompletion,
  shouldRunIdleLife,
  shouldRunProgressiveSleep,
  PET_DOUBLE_CLICK_INTERVAL_MS,
  PET_FLAIL_ANIMATION_MS,
  PET_IDLE_POINTER_WAKE_THROTTLE_MS,
  PET_POKE_ANIMATION_MS,
  PET_QUAD_CLICK_WINDOW_MS,
  PET_SLEEPING_AFTER_MS,
  PET_SLEEPY_AFTER_MS,
  RUNNING_CUE_DEBOUNCE_MS,
  RUNNING_CUE_MIN_DWELL_MS,
} from "../desktop/renderer/pet-state";
import {
  animationName,
  buildSpriteSheetStyleText,
  buildSpriteSheetStyleTextFromProfile,
  clipAnimationName,
  isUniformClip,
  positionCss,
  resolveClipSheetStyle,
  resolveSpriteSheetStyle,
  resolveSpriteStylesheetSource,
  spriteCellPosition,
  spriteSheetBackgroundSize,
} from "../desktop/renderer/pet-sheet";
import {
  PetSoundPlayer,
  SOUND_CUE_PATTERNS,
  SOUND_MASTER_GAIN,
  SOUND_MAX_CUE_MS,
  type PetAudioContextLike,
} from "../desktop/renderer/pet-sound";
import { DESKTOP_PACKAGE_CONTRACT } from "../forge.config";
import {
  CUSTOM_PET_MAX_COUNT,
  resolveCustomPetsRoot,
  sameRealPath,
  scanCustomPets,
  type CustomPetsIo,
} from "../desktop/main/custom-pets";
import {
  readCatalogPetAsset,
  resolveCodexPetsRoot,
  scanPetCatalog,
  toRendererCatalogPayload,
  type PetCatalogIo,
} from "../desktop/main/pet-catalog";
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
  phase?: string;
  progress?: TaskObserverActivityInput["progress"];
  activeModel?: TaskObserverActivityInput["activeModel"];
  sessionResources?: TaskObserverActivityInput["sessionResources"];
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
    phase: input.phase,
    progress: input.progress ?? { kind: "indeterminate" },
    activeModel: input.activeModel,
    sessionResources: input.sessionResources,
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

function extractCssKeyframes(css: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`@keyframes\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("{") && line.includes("%"));
}

function keyframeBlockHasOverlappingPercents(lines: string[]): boolean {
  const percents: string[] = [];
  for (const line of lines) {
    const labels = line.match(/-?\d+(?:\.\d+)?%/g) ?? [];
    for (const label of labels) {
      if (percents.includes(label)) return true;
      percents.push(label);
    }
  }
  return false;
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
      activeModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
      sessionResources: {
        context: { percent: 42.3, usedTokens: 84600, contextWindow: 200000 },
        billing: { totalTokens: 128400, costUsd: 0.0842 },
        performance: { avgTps: 31.8, sampleCount: 6 },
      },
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

  // --- Primary activity selection must not inherit project-name ordering ---
  const primaryBase = sortedRows[3];
  const primaryGroups = [
    {
      projectKey: "alpha",
      displayName: "Alpha",
      counts: { active: 1, needsInput: 0, blocked: 0, ready: 0, unread: 0 },
      activities: [
        {
          ...primaryBase,
          activityId: "alpha-older",
          projectKey: "alpha",
          projectName: "Alpha",
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
    },
    {
      projectKey: "zulu",
      displayName: "Zulu",
      counts: { active: 1, needsInput: 0, blocked: 0, ready: 0, unread: 0 },
      activities: [
        {
          ...primaryBase,
          activityId: "zulu-newer",
          projectKey: "zulu",
          projectName: "Zulu",
          updatedAt: "2026-08-12T12:10:00.000Z",
        },
      ],
    },
  ];
  assert.equal(selectPrimaryActivity(primaryGroups)?.activityId, "zulu-newer");
  assert.equal(
    selectPrimaryActivity([
      {
        ...primaryGroups[0],
        activities: [
          {
            ...primaryGroups[0].activities[0],
            activityId: "active-older",
            executionState: "running",
          },
          {
            ...primaryGroups[0].activities[0],
            activityId: "settled-newer",
            executionState: "settled",
            updatedAt: "2026-08-12T12:20:00.000Z",
          },
        ],
      },
    ])?.activityId,
    "active-older",
  );
  assert.equal(selectPrimaryActivity([]), null);

  // --- Compact context meter uses the same primary, never another Agent ---
  const meterPrimary = {
    ...primaryBase,
    source: "agent" as const,
    sessionResources: {
      context: { percent: 72.4, usedTokens: 144800, contextWindow: 200000 },
      billing: { totalTokens: 128400, costUsd: 0.08 },
      performance: { avgTps: 31.8, sampleCount: 6 },
    },
  };
  const meterVisible = (percent: number) =>
    resolvePrimaryContextMeter({
      activity: {
        ...meterPrimary,
        sessionResources: {
          context: { percent, usedTokens: 1, contextWindow: 200000 },
        },
      },
      stale: false,
      enabled: true,
    });
  assert.deepEqual(meterVisible(0), {
    percent: 0,
    displayPercent: 0,
    label: "上下文 0%",
    title: "当前主任务上下文已使用 0%",
    ariaLabel: "当前主任务上下文已使用 0%",
    level: "ok",
  });
  assert.equal(meterVisible(72.4)?.displayPercent, 72);
  assert.equal(meterVisible(72.4)?.label, "上下文 72%");
  assert.equal(meterVisible(89.4)?.level, "warn");
  assert.equal(meterVisible(99.6)?.displayPercent, 100);
  assert.equal(meterVisible(100)?.percent, 100);
  assert.equal(meterVisible(100)?.level, "high");
  assert.equal(
    resolvePrimaryContextMeter({
      activity: {
        ...meterPrimary,
        sessionResources: { context: { percent: null, usedTokens: 1, contextWindow: 200000 } },
      },
      stale: false,
      enabled: true,
    }),
    null,
  );
  assert.equal(
    resolvePrimaryContextMeter({
      activity: { ...meterPrimary, sessionResources: undefined },
      stale: false,
      enabled: true,
    }),
    null,
  );
  assert.equal(
    resolvePrimaryContextMeter({
      activity: {
        ...meterPrimary,
        sessionResources: {
          context: {
            percent: Number.NaN,
            usedTokens: 1,
            contextWindow: 200000,
          },
        },
      },
      stale: false,
      enabled: true,
    }),
    null,
  );
  assert.equal(
    resolvePrimaryContextMeter({
      activity: { ...meterPrimary, source: "snflow" },
      stale: false,
      enabled: true,
    }),
    null,
  );
  assert.equal(
    resolvePrimaryContextMeter({ activity: meterPrimary, stale: true, enabled: true }),
    null,
  );
  assert.equal(
    resolvePrimaryContextMeter({ activity: meterPrimary, stale: false, enabled: false }),
    null,
  );
  const settledPrimary = {
    ...meterPrimary,
    presentation: "ready" as const,
    executionState: "settled" as const,
    sessionResources: {
      context: { percent: 41, usedTokens: 82000, contextWindow: 200000 },
    },
  };
  assert.equal(
    resolvePrimaryContextMeter({
      activity: settledPrimary,
      stale: false,
      enabled: true,
    })?.displayPercent,
    41,
  );
  const olderAgent = {
    ...meterPrimary,
    activityId: "older-agent",
    updatedAt: "2026-08-12T12:00:00.000Z",
    sessionResources: {
      context: { percent: 11, usedTokens: 1, contextWindow: 200000 },
    },
  };
  const newerAgent = {
    ...meterPrimary,
    activityId: "newer-agent",
    updatedAt: "2026-08-12T12:20:00.000Z",
    sessionResources: {
      context: { percent: 88, usedTokens: 1, contextWindow: 200000 },
    },
  };
  const mixedPrimary = selectPrimaryActivity([
    {
      projectKey: "alpha",
      displayName: "Alpha",
      counts: { active: 1, needsInput: 0, blocked: 0, ready: 0, unread: 0 },
      activities: [olderAgent],
    },
    {
      projectKey: "zulu",
      displayName: "Zulu",
      counts: { active: 1, needsInput: 0, blocked: 0, ready: 0, unread: 0 },
      activities: [newerAgent],
    },
  ]);
  assert.equal(mixedPrimary?.activityId, newerAgent.activityId);
  assert.equal(
    resolvePrimaryContextMeter({
      activity: mixedPrimary,
      stale: false,
      enabled: true,
    })?.displayPercent,
    88,
  );
  const nonAgentPrimary = selectPrimaryActivity([
    {
      projectKey: "flow",
      displayName: "Flow",
      counts: { active: 0, needsInput: 1, blocked: 0, ready: 0, unread: 1 },
      activities: [
        {
          ...meterPrimary,
          activityId: "snflow-needs-input",
          source: "snflow",
          presentation: "needs_input",
          executionState: "running",
          sessionResources: undefined,
        },
      ],
    },
    {
      projectKey: "agent-b",
      displayName: "Agent B",
      counts: { active: 1, needsInput: 0, blocked: 0, ready: 0, unread: 0 },
      activities: [newerAgent],
    },
  ]);
  assert.equal(nonAgentPrimary?.activityId, "snflow-needs-input");
  assert.equal(
    resolvePrimaryContextMeter({
      activity: nonAgentPrimary,
      stale: false,
      enabled: true,
    }),
    null,
  );

  // --- Running cue classification uses finite local allowlists only ---
  const runningCueRow = {
    ...primaryBase,
    source: "agent" as const,
    presentation: "running" as const,
    executionState: "running" as const,
    attention: "none" as const,
    phase: "tool",
  };
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", currentToolName: "edit" } }),
    "editing",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", currentToolName: "write" } }),
    "editing",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", currentToolName: "bash" } }),
    "command",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", currentToolName: "read" } }),
    "thinking",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, phase: "running", progress: { kind: "indeterminate" } }),
    "thinking",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", activeSubagents: 1 } }),
    "subagent_one",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", activeSubagents: 2 } }),
    "subagent_many",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters", currentToolName: "extension_tool" } }),
    "generic",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, progress: { kind: "counters" } }),
    "generic",
  );
  assert.equal(
    resolveRunningCue({
      ...runningCueRow,
      progress: { kind: "counters", currentToolName: "bash", activeSubagents: 1 },
    }),
    "generic",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, source: "snflow" }),
    "generic",
  );
  assert.equal(
    resolveRunningCue({ ...runningCueRow, presentation: "retrying" }),
    "generic",
  );
  assert.deepEqual(resolveRunningCueVisual("editing"), { glyph: "✎", label: "编辑中" });
  assert.deepEqual(resolveRunningCueVisual("subagent_many"), { glyph: "2+", label: "协作中" });

  // --- Running cue dwell/debounce; aggregate states preempt immediately ---
  let cueState = createInitialRunningCueState();
  cueState = reduceRunningCueState(
    cueState,
    { presentation: "running", cue: "editing" },
    0,
  );
  assert.equal(cueState.cue, "editing");
  cueState = reduceRunningCueState(
    cueState,
    { presentation: "running", cue: "command" },
    100,
  );
  assert.equal(cueState.cue, "editing");
  assert.equal(cueState.candidateCue, "command");
  assert.equal(
    runningCueNextUpdateAt(cueState),
    Math.max(RUNNING_CUE_MIN_DWELL_MS, 100 + RUNNING_CUE_DEBOUNCE_MS),
  );
  cueState = reduceRunningCueState(
    cueState,
    { presentation: "running", cue: "command" },
    RUNNING_CUE_MIN_DWELL_MS,
  );
  assert.equal(cueState.cue, "command");
  for (const presentation of ["needs_input", "blocked", "ready", "retrying", "idle"] as const) {
    const preempted = reduceRunningCueState(
      cueState,
      { presentation, cue: "subagent_many" },
      RUNNING_CUE_MIN_DWELL_MS + 1,
    );
    assert.equal(preempted.active, false, `${presentation} must preempt the running cue`);
    assert.equal(preempted.cue, "generic");
    assert.equal(runningCueNextUpdateAt(preempted), null);
  }
  cueState = reduceRunningCueState(
    reduceRunningCueState(
      cueState,
      { presentation: "needs_input", cue: "generic" },
      RUNNING_CUE_MIN_DWELL_MS + 1,
    ),
    { presentation: "running", cue: "subagent_one" },
    RUNNING_CUE_MIN_DWELL_MS + 2,
  );
  assert.equal(cueState.cue, "subagent_one", "re-entering Running shows the current cue immediately");

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
    dndEnabled: false,
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

  // --- Progressive idle sleep stages (U3, pure) ---
  assert.equal(PET_SLEEPY_AFTER_MS, 45_000);
  assert.equal(PET_SLEEPING_AFTER_MS, 120_000);
  assert.ok(PET_IDLE_POINTER_WAKE_THROTTLE_MS > 0);
  assert.equal(resolveIdleSleepStage(0), "awake");
  assert.equal(resolveIdleSleepStage(PET_SLEEPY_AFTER_MS - 1), "awake");
  assert.equal(resolveIdleSleepStage(PET_SLEEPY_AFTER_MS), "sleepy");
  assert.equal(resolveIdleSleepStage(PET_SLEEPING_AFTER_MS - 1), "sleepy");
  assert.equal(resolveIdleSleepStage(PET_SLEEPING_AFTER_MS), "sleeping");
  assert.equal(resolveIdleSleepStage(Number.NaN), "awake");
  assert.equal(resolveIdleSleepStage(Number.POSITIVE_INFINITY), "awake");
  assert.equal(resolveIdleSleepStage(-1), "awake");

  assert.equal(nextIdleSleepBoundaryMs("awake", 0), PET_SLEEPY_AFTER_MS);
  assert.equal(nextIdleSleepBoundaryMs("awake", 10_000), PET_SLEEPY_AFTER_MS - 10_000);
  assert.equal(nextIdleSleepBoundaryMs("awake", Number.NaN), PET_SLEEPY_AFTER_MS);
  assert.equal(
    nextIdleSleepBoundaryMs("sleepy", PET_SLEEPY_AFTER_MS),
    PET_SLEEPING_AFTER_MS - PET_SLEEPY_AFTER_MS,
  );
  assert.equal(nextIdleSleepBoundaryMs("sleepy", PET_SLEEPING_AFTER_MS - 1), 1);
  assert.equal(nextIdleSleepBoundaryMs("sleeping", PET_SLEEPING_AFTER_MS), null);

  const sleepOn = {
    idle: true,
    hidden: false,
    reducedMotion: false,
    pressed: false,
    dragging: false,
  };
  assert.equal(shouldRunProgressiveSleep(sleepOn), true);
  assert.equal(shouldRunProgressiveSleep({ ...sleepOn, idle: false }), false);
  assert.equal(shouldRunProgressiveSleep({ ...sleepOn, hidden: true }), false);
  assert.equal(shouldRunProgressiveSleep({ ...sleepOn, reducedMotion: true }), false);
  assert.equal(shouldRunProgressiveSleep({ ...sleepOn, pressed: true }), false);
  assert.equal(shouldRunProgressiveSleep({ ...sleepOn, dragging: true }), false);

  // Reducer: idle origin is captured once and never advanced by same-state snapshots.
  const idleSignal = {
    presentation: "idle" as const,
    hidden: false,
    reducedMotion: false,
    pressed: false,
    dragging: false,
  };
  let sleepState = createInitialIdleSleepState();
  sleepState = reduceIdleSleepState(sleepState, idleSignal, 1_000);
  assert.equal(sleepState.stage, "awake");
  assert.equal(sleepState.idleSince, 1_000);
  assert.equal(sleepState.nextBoundaryAt, 1_000 + PET_SLEEPY_AFTER_MS);
  const sameStateLater = reduceIdleSleepState(sleepState, idleSignal, 2_000);
  assert.equal(sameStateLater.idleSince, 1_000, "same-state snapshot must not reset the idle origin");
  assert.equal(
    sameStateLater.nextBoundaryAt,
    1_000 + PET_SLEEPY_AFTER_MS,
    "same-state snapshot must not move the boundary",
  );
  sleepState = reduceIdleSleepState(sleepState, idleSignal, 1_000 + PET_SLEEPY_AFTER_MS);
  assert.equal(sleepState.stage, "sleepy");
  assert.equal(sleepState.nextBoundaryAt, 1_000 + PET_SLEEPING_AFTER_MS);
  sleepState = reduceIdleSleepState(sleepState, idleSignal, 1_000 + PET_SLEEPING_AFTER_MS);
  assert.equal(sleepState.stage, "sleeping");
  assert.equal(sleepState.nextBoundaryAt, null, "sleeping is terminal");

  // Attention/terminal/connection states preempt immediately.
  for (const presentation of [
    "needs_input",
    "blocked",
    "ready",
    "retrying",
    "running",
    "disconnected",
    "service_not_running",
  ] as const) {
    const preempted = reduceIdleSleepState(
      sleepState,
      { ...idleSignal, presentation },
      50_000,
    );
    assert.equal(preempted.stage, "awake", `${presentation} must preempt sleep`);
    assert.equal(preempted.idleSince, null);
    assert.equal(preempted.nextBoundaryAt, null);
  }

  // Hidden / reduced-motion / pressed / dragging reset with no pending timer.
  for (const override of [
    { hidden: true },
    { reducedMotion: true },
    { pressed: true },
    { dragging: true },
  ] as const) {
    const reset = reduceIdleSleepState(sleepState, { ...idleSignal, ...override }, 50_000);
    assert.equal(reset.stage, "awake");
    assert.equal(reset.idleSince, null);
    assert.equal(reset.nextBoundaryAt, null);
  }

  // --- U4b fun reactions: click-sequence reducer + reaction gate (pure) ---
  // Concentrated timing constants stay inside the recommended ranges.
  assert.ok(PET_DOUBLE_CLICK_INTERVAL_MS >= 300 && PET_DOUBLE_CLICK_INTERVAL_MS <= 350);
  assert.ok(PET_QUAD_CLICK_WINDOW_MS >= 800 && PET_QUAD_CLICK_WINDOW_MS <= 1000);
  assert.ok(PET_POKE_ANIMATION_MS >= 300 && PET_POKE_ANIMATION_MS <= 500);
  assert.ok(PET_FLAIL_ANIMATION_MS >= 600 && PET_FLAIL_ANIMATION_MS <= 900);

  assert.equal(resolvePetReaction(2, PET_DOUBLE_CLICK_INTERVAL_MS), "flail");
  assert.equal(resolvePetReaction(2, PET_QUAD_CLICK_WINDOW_MS), "flail");
  assert.equal(resolvePetReaction(2, PET_QUAD_CLICK_WINDOW_MS + 1), null);
  assert.equal(resolvePetReaction(4, PET_QUAD_CLICK_WINDOW_MS), "flail");
  assert.equal(resolvePetReaction(1, 0), null);

  assert.equal(canPlayPetInteract("idle", false), true);
  assert.equal(canPlayPetInteract("running", false), true);
  assert.equal(canPlayPetInteract("retrying", false), true);
  assert.equal(shouldAllowPetReaction("idle", false), true);
  for (const presentation of [
    "needs_input",
    "blocked",
    "ready",
    "disconnected",
    "service_not_running",
  ] as const) {
    assert.equal(
      shouldAllowPetReaction(presentation, false),
      false,
      `${presentation} must not spend the body click on a greeting`,
    );
  }
  assert.equal(shouldAllowPetReaction("idle", true), false, "reduced motion disables reactions");

  assert.equal(
    resolvePetBodyClick({
      trayOpen: true,
      presentation: "idle",
      reducedMotion: false,
      canJumpPrimary: false,
    }),
    "close-tray",
  );
  assert.equal(
    resolvePetBodyClick({
      trayOpen: false,
      presentation: "needs_input",
      reducedMotion: false,
      canJumpPrimary: true,
    }),
    "jump-primary",
  );
  assert.equal(
    resolvePetBodyClick({
      trayOpen: false,
      presentation: "idle",
      reducedMotion: false,
      canJumpPrimary: false,
    }),
    "interact",
  );
  assert.equal(
    resolvePetBodyClick({
      trayOpen: false,
      presentation: "running",
      reducedMotion: false,
      canJumpPrimary: false,
    }),
    "interact",
  );
  assert.equal(
    resolvePetBodyClick({
      trayOpen: false,
      presentation: "ready",
      reducedMotion: false,
      canJumpPrimary: false,
    }),
    "open-tray",
  );
  assert.equal(
    resolvePetBodyClick({
      trayOpen: false,
      presentation: "idle",
      reducedMotion: true,
      canJumpPrimary: false,
    }),
    "open-tray",
  );

  // First click is the greeting; the caller maps singleClick to interact.
  let clickSeq = createInitialPetClickSequenceState();
  let clickOut = reducePetClickSequence(clickSeq, { type: "click", now: 1000 });
  assert.equal(clickOut.singleClick, true);
  assert.equal(clickOut.startReaction, null);
  assert.equal(clickOut.cancelReaction, null);
  clickSeq = clickOut.state;

  // Second click upgrades to flail and must not re-toggle the tray.
  clickOut = reducePetClickSequence(clickSeq, { type: "click", now: 1200 });
  assert.equal(clickOut.singleClick, false, "second click must not re-toggle");
  assert.equal(clickOut.startReaction, "flail");
  clickSeq = clickOut.state;
  assert.equal(clickSeq.committedReaction, "flail");

  // A late click (past the double interval) starts a fresh single-click sequence.
  clickOut = reducePetClickSequence(clickSeq, { type: "click", now: 5000 });
  assert.equal(clickOut.singleClick, true, "timeout restarts the sequence");
  clickSeq = clickOut.state;

  // A rapid follow-up after flail is inert: no re-toggle, no re-fire.
  clickSeq = createInitialPetClickSequenceState();
  clickSeq = reducePetClickSequence(clickSeq, { type: "click", now: 100 }).state;
  clickOut = reducePetClickSequence(clickSeq, { type: "click", now: 300 });
  assert.equal(clickOut.startReaction, "flail");
  clickSeq = clickOut.state;
  clickOut = reducePetClickSequence(clickSeq, { type: "click", now: 500 });
  assert.equal(clickOut.singleClick, false, "post-flail rapid click must not re-toggle the tray");
  assert.equal(clickOut.startReaction, null);
  clickSeq = clickOut.state;

  // Drag / pointercancel / lost capture / hidden / preempt / destroy all cancel.
  const cancelled = reducePetClickSequence(clickSeq, { type: "cancel" });
  assert.deepEqual(cancelled.state, createInitialPetClickSequenceState());
  assert.equal(cancelled.singleClick, false);
  assert.equal(cancelled.startReaction, null);
  assert.equal(cancelled.cancelReaction, null);

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

  // --- DND (U7a): manual local quiet mode ---
  // Fresh install default + legacy migration keep DND off.
  assert.equal(createDefaultDesktopSettings().dndEnabled, false);
  assert.equal(
    parseDesktopSettingsJson(
      JSON.stringify({ version: 1, port: 62666, selectedPetId: "snail-default" }),
    ).dndEnabled,
    false,
  );
  assert.equal(normalizeDesktopSettings({ dndEnabled: "on" }).dndEnabled, false);
  assert.equal(normalizeDesktopSettings({ dndEnabled: true }).dndEnabled, true);
  assert.equal(
    updateDesktopSettings(createDefaultDesktopSettings(), { dndEnabled: true }).dndEnabled,
    true,
  );
  const dndRoundTrip = parseDesktopSettingsJson(
    serializeDesktopSettings(updateDesktopSettings(createDefaultDesktopSettings(), { dndEnabled: true })),
  );
  assert.equal(dndRoundTrip.dndEnabled, true);
  assert.equal(dndRoundTrip.version, 1, "schema version must stay at 1");

  // Unified policy: task/attention states suppressed; connection diagnostics never.
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: false, presentation: "needs_input", surface: "system-notification" }),
    false,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "needs_input", surface: "system-notification" }),
    true,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "blocked", surface: "system-notification" }),
    true,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "ready", surface: "system-notification" }),
    true,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "running", surface: "state-bubble" }),
    true,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "retrying", surface: "state-bubble" }),
    true,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "service_not_running", surface: "state-bubble" }),
    false,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "disconnected", surface: "state-bubble" }),
    false,
  );
  assert.equal(
    shouldSuppressProactiveByDnd({ dndEnabled: true, presentation: "idle", surface: "state-bubble" }),
    false,
  );
  assert.equal(isDndSuppressiblePresentation("needs_input"), true);
  assert.equal(isDndSuppressiblePresentation("service_not_running"), false);

  // DND suppresses notifications and consumes the transition silently:
  // disabling DND must not replay missed notifications.
  const dndTransitionId = buildAgentTransitionId("inst-u7", "s-need", 3, 9);
  const dndSnapshot = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 3,
    activities,
    recentTransitions: [
      {
        transitionId: dndTransitionId,
        taskKey: buildAgentTaskKey("s-need"),
        activityId: buildAgentActivityId("inst-u7", "s-need", 3),
        source: "agent",
        projectKey: "proj-c",
        presentation: "needs_input",
        executionState: "running",
        outcome: null,
        attention: "needs_input",
        at: "2026-08-12T12:20:00.000Z",
      },
    ],
  });
  const dndOnSettings = updateDesktopSettings(createDefaultDesktopSettings(), {
    dndEnabled: true,
    notifiedTransitionIds: [],
  });
  const dndSuppressed = selectNotifications({
    settings: dndOnSettings,
    snapshot: dndSnapshot,
    resetBaseline: false,
    appInBackground: true,
  });
  assert.equal(dndSuppressed.toNotify.length, 0);
  assert.ok(
    dndSuppressed.notifiedTransitionIds.includes(dndTransitionId),
    "DND transitions are silently consumed",
  );
  const dndOffSettings = updateDesktopSettings(dndOnSettings, {
    dndEnabled: false,
    notifiedTransitionIds: dndSuppressed.notifiedTransitionIds,
  });
  const dndReplay = selectNotifications({
    settings: dndOffSettings,
    snapshot: dndSnapshot,
    resetBaseline: false,
    appInBackground: true,
  });
  assert.equal(dndReplay.toNotify.length, 0, "disabling DND must not replay missed notifications");
  assert.equal(
    dndOffSettings.acknowledgedTransitionIds.length,
    0,
    "DND must never write acknowledgedTransitionIds (no mark-read)",
  );

  // A throwing notification host must not affect DND handling or observation.
  const dndController = new DesktopNotificationController({
    isSupported: () => true,
    show: () => {
      throw new Error("broken notification host");
    },
  });
  const dndControllerResult = dndController.handleSnapshot({
    settings: dndOnSettings,
    snapshot: dndSnapshot,
    resetBaseline: false,
  });
  assert.equal(dndControllerResult.emitted.length, 0);
  assert.ok(dndControllerResult.settings.notifiedTransitionIds.includes(dndTransitionId));

  // DND passes through the sanitized view without changing task presentation.
  const dndView = buildActivityView({
    snapshot,
    connection,
    settings: dndOnSettings,
    now: Date.parse("2026-08-12T12:05:00.000Z"),
  });
  assert.equal(dndView.dndEnabled, true);
  assert.equal(dndView.presentation, "needs_input", "DND never rewrites the pet state");
  assert.ok(dndView.attentionCount >= 1, "Activity tray attention stays observable");
  assert.ok(
    flattenActivities(dndView.projects).some((row) => row.presentation === "needs_input" && row.unread),
    "DND keeps tray unread state untouched",
  );
  assert.equal(
    buildActivityView({
      snapshot,
      connection,
      settings: createDefaultDesktopSettings(),
      now: Date.parse("2026-08-12T12:05:00.000Z"),
    }).dndEnabled,
    false,
  );

  // Bubbles: silenced during DND, no replay after disable, diagnostics visible.
  let dndBubble = createInitialPetBubbleState();
  const dndNeedsSignal = {
    presentation: "needs_input" as const,
    transitionId: "dnd-need-1",
    revision: 30,
    instanceId: "inst-u7",
    unread: true,
    dndEnabled: true,
    reset: false,
  };
  dndBubble = reducePetBubbleState(dndBubble, {
    type: "snapshot",
    signal: dndNeedsSignal,
    now: 1000,
  });
  assert.equal(dndBubble.visible, false, "needs_input bubble suppressed under DND");
  assert.equal(
    dndBubble.dismissedSignalKey,
    "needs_input:transition:dnd-need-1",
    "suppressed transition is silently handled",
  );
  dndBubble = reducePetBubbleState(dndBubble, {
    type: "snapshot",
    signal: { ...dndNeedsSignal, dndEnabled: false },
    now: 2000,
  });
  assert.equal(dndBubble.visible, false, "no bubble replay after DND off");
  // A genuinely new transition after DND off alerts again.
  const dndFreshSignal = { ...dndNeedsSignal, transitionId: "dnd-need-2", dndEnabled: false };
  dndBubble = reducePetBubbleState(dndBubble, {
    type: "snapshot",
    signal: dndFreshSignal,
    now: 3000,
  });
  assert.equal(dndBubble.visible, true);
  // Enabling DND closes the active bubble immediately and keeps it closed.
  dndBubble = reducePetBubbleState(dndBubble, {
    type: "snapshot",
    signal: { ...dndFreshSignal, dndEnabled: true },
    now: 4000,
  });
  assert.equal(dndBubble.visible, false, "enabling DND closes the active bubble");
  dndBubble = reducePetBubbleState(dndBubble, {
    type: "snapshot",
    signal: { ...dndFreshSignal, dndEnabled: false },
    now: 5000,
  });
  assert.equal(dndBubble.visible, false, "closed bubble stays closed after DND off");

  // Connection diagnostics must stay visible under DND.
  let dndDiagBubble = createInitialPetBubbleState();
  dndDiagBubble = reducePetBubbleState(dndDiagBubble, {
    type: "snapshot",
    signal: {
      presentation: "service_not_running",
      transitionId: null,
      revision: null,
      instanceId: "inst-u7",
      unread: false,
      dndEnabled: true,
      reset: false,
    },
    now: 1000,
  });
  assert.equal(dndDiagBubble.visible, true, "service_not_running stays visible under DND");
  assert.equal(dndDiagBubble.mode, "persistent");
  dndDiagBubble = reducePetBubbleState(dndDiagBubble, {
    type: "snapshot",
    signal: {
      presentation: "disconnected",
      transitionId: null,
      revision: null,
      instanceId: "inst-u7",
      unread: false,
      dndEnabled: true,
      reset: false,
    },
    now: 2000,
  });
  assert.equal(dndDiagBubble.visible, true, "disconnected stays visible under DND");
  assert.equal(dndDiagBubble.mode, "persistent");

  // Transient running bubbles are proactive and suppressed under DND.
  let dndRunBubble = createInitialPetBubbleState();
  dndRunBubble = reducePetBubbleState(dndRunBubble, {
    type: "snapshot",
    signal: {
      presentation: "running",
      transitionId: null,
      revision: 31,
      instanceId: "inst-u7",
      unread: false,
      dndEnabled: true,
      reset: false,
    },
    now: 1000,
  });
  assert.equal(dndRunBubble.visible, false, "running bubble suppressed under DND");
  dndRunBubble = reducePetBubbleState(dndRunBubble, {
    type: "snapshot",
    signal: {
      presentation: "running",
      transitionId: null,
      revision: 31,
      instanceId: "inst-u7",
      unread: false,
      dndEnabled: false,
      reset: false,
    },
    now: 2000,
  });
  assert.equal(dndRunBubble.visible, false, "suppressed running bubble never replays");

  // --- Sound cues (U4a): defaults, migration, gating, DND, cooldown, dedupe ---
  // Fresh install never beeps; per-event switches default on (preserved when master off).
  assert.deepEqual(createDefaultDesktopSettings().sound, {
    masterEnabled: false,
    needsInput: true,
    completion: true,
  });
  const legacySound = parseDesktopSettingsJson(
    JSON.stringify({ version: 1, port: 62666, selectedPetId: "snail-default" }),
  );
  assert.equal(legacySound.sound.masterEnabled, false, "legacy v1 files migrate sound off");
  assert.equal(legacySound.sound.needsInput, true);
  assert.equal(legacySound.sound.completion, true);
  assert.equal(legacySound.version, 1, "sound settings must not bump the schema version");
  assert.equal(normalizeDesktopSettings({ sound: { masterEnabled: "on" } }).sound.masterEnabled, false);
  assert.equal(
    normalizeDesktopSettings({ sound: { masterEnabled: true, needsInput: false, completion: false } })
      .sound.needsInput,
    false,
  );
  const soundRoundTrip = parseDesktopSettingsJson(
    serializeDesktopSettings(
      updateDesktopSettings(createDefaultDesktopSettings(), {
        sound: { masterEnabled: true, needsInput: false },
        soundedTransitionIds: ["snd-a", "snd-b"],
      }),
    ),
  );
  assert.equal(soundRoundTrip.sound.masterEnabled, true);
  assert.equal(soundRoundTrip.sound.needsInput, false);
  assert.equal(soundRoundTrip.sound.completion, true, "untouched event switch keeps its default");
  assert.deepEqual(soundRoundTrip.soundedTransitionIds, ["snd-a", "snd-b"]);
  assert.equal(soundRoundTrip.version, 1);

  // Classification: only needs_input / ready map; everything else silent.
  assert.equal(soundCueForPresentation("needs_input"), "attention");
  assert.equal(soundCueForPresentation("ready"), "completion");
  assert.equal(soundCueForPresentation("blocked"), null);
  assert.equal(soundCueForPresentation("running"), null);
  assert.equal(soundCueForPresentation("retrying"), null);
  assert.equal(soundCueForPresentation("idle"), null);
  assert.deepEqual(SOUND_CUE_KINDS, ["attention", "completion"]);
  assert.equal(isSoundCueKind("attention"), true);
  assert.equal(isSoundCueKind("completion"), true);
  assert.equal(isSoundCueKind("file://x"), false);
  assert.equal(isSoundCueKind(42), false);
  assert.ok(SOUND_COOLDOWN_MS >= 10_000);

  // Baseline seeds the sounded LRU and emits nothing.
  const soundBaseSettings = createDefaultDesktopSettings();
  const soundBaseline = selectSoundCues({
    settings: soundBaseSettings,
    snapshot,
    resetBaseline: true,
  });
  assert.deepEqual(soundBaseline.cues, []);
  assert.ok(soundBaseline.soundedTransitionIds.length >= 1);
  assert.ok(soundBaseline.changed);
  // Independent sounded LRU: sound processing never touches the notified LRU.
  assert.deepEqual(soundBaseSettings.notifiedTransitionIds, []);

  const soundSettings = updateDesktopSettings(soundBaseSettings, {
    sound: { masterEnabled: true, needsInput: true, completion: true },
    soundedTransitionIds: soundBaseline.soundedTransitionIds,
  });

  const sndTransition = (id: string, presentation: string): TaskObserverTransitionInput => ({
    transitionId: id,
    taskKey: buildAgentTaskKey("s-snd"),
    activityId: buildAgentActivityId("inst-u7", "s-snd", 1),
    source: "agent",
    projectKey: "proj-a",
    presentation: presentation as TaskObserverTransitionInput["presentation"],
    executionState: "settled",
    outcome: "succeeded",
    attention: "none",
    at: "2026-08-12T12:20:00.000Z",
  });

  const needId = buildAgentTransitionId("inst-u7", "s-need", 7, 3);
  const needSnap = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 10,
    activities,
    recentTransitions: [sndTransition(needId, "needs_input")],
  });
  const needSound = selectSoundCues({
    settings: soundSettings,
    snapshot: needSnap,
    resetBaseline: false,
    now: 10_000,
  });
  assert.deepEqual(needSound.cues, ["attention"], "needs_input maps to the attention cue");
  assert.ok(needSound.soundedTransitionIds.includes(needId));

  const needSettings = updateDesktopSettings(soundSettings, {
    soundedTransitionIds: needSound.soundedTransitionIds,
  });
  // SSE replay / same snapshot never repeats.
  const needReplay = selectSoundCues({
    settings: needSettings,
    snapshot: needSnap,
    resetBaseline: false,
    now: 11_000,
  });
  assert.deepEqual(needReplay.cues, []);
  assert.equal(needReplay.changed, false);

  // ready maps to completion.
  const readyId = buildAgentTransitionId("inst-u7", "s-ready", 7, 4);
  const readySnap = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 11,
    activities,
    recentTransitions: [sndTransition(readyId, "ready")],
  });
  const readySound = selectSoundCues({
    settings: soundSettings,
    snapshot: readySnap,
    resetBaseline: false,
    now: 20_000,
  });
  assert.deepEqual(readySound.cues, ["completion"], "ready maps to the completion cue");

  // blocked/running/retrying transitions never sound.
  const blockedId = buildAgentTransitionId("inst-u7", "s-block", 7, 5);
  const blockedSnap = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 12,
    activities,
    recentTransitions: [sndTransition(blockedId, "blocked")],
  });
  const blockedSound = selectSoundCues({
    settings: soundSettings,
    snapshot: blockedSnap,
    resetBaseline: false,
    now: 30_000,
  });
  assert.deepEqual(blockedSound.cues, []);
  assert.equal(blockedSound.changed, false);

  // Master off consumes transitions silently; enabling later never replays.
  const masterOffSettings = updateDesktopSettings(soundSettings, {
    sound: { masterEnabled: false },
  });
  const masterOff = selectSoundCues({
    settings: masterOffSettings,
    snapshot: readySnap,
    resetBaseline: false,
    now: 40_000,
  });
  assert.deepEqual(masterOff.cues, []);
  assert.ok(masterOff.soundedTransitionIds.includes(readyId), "settings-off transitions are consumed");
  const masterOnLater = updateDesktopSettings(masterOffSettings, {
    sound: { masterEnabled: true },
    soundedTransitionIds: masterOff.soundedTransitionIds,
  });
  const noReplayAfterToggle = selectSoundCues({
    settings: masterOnLater,
    snapshot: readySnap,
    resetBaseline: false,
    now: 41_000,
  });
  assert.deepEqual(noReplayAfterToggle.cues, [], "enabling master must not replay history");

  // Per-event switch off consumes that kind silently.
  const needsInputOffSettings = updateDesktopSettings(soundSettings, {
    sound: { needsInput: false },
  });
  const needsOff = selectSoundCues({
    settings: needsInputOffSettings,
    snapshot: needSnap,
    resetBaseline: false,
    now: 50_000,
  });
  assert.deepEqual(needsOff.cues, []);
  assert.ok(needsOff.soundedTransitionIds.includes(needId));

  // DND silences sounds and consumes the transition; disabling DND never replays.
  const dndSoundSettings = updateDesktopSettings(soundSettings, { dndEnabled: true });
  const dndSound = selectSoundCues({
    settings: dndSoundSettings,
    snapshot: needSnap,
    resetBaseline: false,
    now: 60_000,
  });
  assert.deepEqual(dndSound.cues, []);
  assert.ok(dndSound.soundedTransitionIds.includes(needId), "DND consumes sound transitions");
  const dndOffSoundSettings = updateDesktopSettings(dndSoundSettings, {
    dndEnabled: false,
    soundedTransitionIds: dndSound.soundedTransitionIds,
  });
  const dndOffSound = selectSoundCues({
    settings: dndOffSoundSettings,
    snapshot: needSnap,
    resetBaseline: false,
    now: 61_000,
  });
  assert.deepEqual(dndOffSound.cues, [], "disabling DND never replays sounds");
  assert.equal(dndOffSoundSettings.acknowledgedTransitionIds.length, 0, "DND never writes acknowledged ids");
  assert.equal(dndOffSoundSettings.sound.masterEnabled, true, "DND never mutates sound preferences");

  // Per-kind cooldown merges bursts; suppressed transitions are consumed.
  const coolReadyA = buildAgentTransitionId("inst-u7", "s-cool-a", 7, 6);
  const coolReadyB = buildAgentTransitionId("inst-u7", "s-cool-b", 7, 7);
  const coolSnapA = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 13,
    activities,
    recentTransitions: [sndTransition(coolReadyA, "ready")],
  });
  const coolFirst = selectSoundCues({
    settings: soundSettings,
    snapshot: coolSnapA,
    resetBaseline: false,
    now: 100_000,
  });
  assert.deepEqual(coolFirst.cues, ["completion"]);
  const coolSettings = updateDesktopSettings(soundSettings, {
    soundedTransitionIds: coolFirst.soundedTransitionIds,
  });
  const coolSnapB = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 14,
    activities,
    recentTransitions: [sndTransition(coolReadyB, "ready")],
  });
  const coolSecond = selectSoundCues({
    settings: coolSettings,
    snapshot: coolSnapB,
    resetBaseline: false,
    now: 103_000,
    lastPlayedAt: coolFirst.lastPlayedAt,
  });
  assert.deepEqual(coolSecond.cues, [], "cooldown merges same-kind bursts");
  assert.ok(coolSecond.soundedTransitionIds.includes(coolReadyB), "cooldown-suppressed transitions are consumed");
  const coolSettings2 = updateDesktopSettings(coolSettings, {
    soundedTransitionIds: coolSecond.soundedTransitionIds,
  });
  // After cooldown, the same id stays deduped; a genuinely new one plays.
  const coolAfter = selectSoundCues({
    settings: coolSettings2,
    snapshot: coolSnapB,
    resetBaseline: false,
    now: 111_000,
    lastPlayedAt: coolFirst.lastPlayedAt,
  });
  assert.deepEqual(coolAfter.cues, [], "same id stays deduped after cooldown");
  const coolSnapC = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 15,
    activities,
    recentTransitions: [sndTransition(buildAgentTransitionId("inst-u7", "s-cool-c", 7, 8), "ready")],
  });
  const coolAfterNew = selectSoundCues({
    settings: coolSettings2,
    snapshot: coolSnapC,
    resetBaseline: false,
    now: 111_000,
    lastPlayedAt: coolFirst.lastPlayedAt,
  });
  assert.deepEqual(coolAfterNew.cues, ["completion"], "fresh transition after cooldown plays");

  // Multiple completions in one snapshot play exactly once.
  const multiA = buildAgentTransitionId("inst-u7", "s-multi-a", 7, 9);
  const multiB = buildAgentTransitionId("inst-u7", "s-multi-b", 7, 10);
  const multiSnap = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 16,
    activities,
    recentTransitions: [sndTransition(multiA, "ready"), sndTransition(multiB, "ready")],
  });
  const multi = selectSoundCues({
    settings: soundSettings,
    snapshot: multiSnap,
    resetBaseline: false,
    now: 200_000,
  });
  assert.deepEqual(multi.cues, ["completion"], "same-kind cluster plays exactly once");
  assert.ok(multi.soundedTransitionIds.includes(multiA));
  assert.ok(multi.soundedTransitionIds.includes(multiB));

  // Different kinds in one snapshot each emit once.
  const bothSnap = buildTaskObserverSnapshot({
    instanceId: "inst-u7",
    revision: 17,
    activities,
    recentTransitions: [
      sndTransition(buildAgentTransitionId("inst-u7", "s-both-a", 7, 11), "needs_input"),
      sndTransition(buildAgentTransitionId("inst-u7", "s-both-b", 7, 12), "ready"),
    ],
  });
  const both = selectSoundCues({
    settings: soundSettings,
    snapshot: bothSnap,
    resetBaseline: false,
    now: 300_000,
  });
  assert.deepEqual([...both.cues].sort(), ["attention", "completion"]);

  // Sounded LRU is bounded and independent of the notified LRU.
  const boundedIds = Array.from({ length: 600 }, (_item, index) => `snd-${index}`);
  const bounded = selectSoundCues({
    settings: updateDesktopSettings(soundSettings, { soundedTransitionIds: boundedIds }),
    snapshot: multiSnap,
    resetBaseline: false,
    now: 400_000,
  });
  assert.ok(bounded.soundedTransitionIds.length <= 500, "sounded LRU stays bounded");
  assert.ok(bounded.soundedTransitionIds.includes(multiB));
  assert.equal(bounded.soundedTransitionIds.includes("snd-0"), false, "oldest ids evicted");

  // Controller forwards cues, seeds baseline silently, and survives throwing emitters.
  const emittedCues: string[] = [];
  const soundController = new DesktopSoundCueController({ emit: (cue) => emittedCues.push(cue) });
  const controllerBaseline = soundController.handleSnapshot({
    settings: soundSettings,
    snapshot,
    resetBaseline: true,
  });
  assert.equal(controllerBaseline.emitted.length, 0);
  assert.ok(controllerBaseline.settings.soundedTransitionIds.length >= 1);
  const controllerResult = soundController.handleSnapshot({
    settings: soundSettings,
    snapshot: readySnap,
    resetBaseline: false,
  });
  assert.ok(emittedCues.includes("completion"));
  assert.ok(controllerResult.settings.soundedTransitionIds.includes(readyId));

  let throwingCount = 0;
  const throwingController = new DesktopSoundCueController({
    emit: () => {
      throwingCount += 1;
      throw new Error("no audio sink");
    },
  });
  const throwingResult = throwingController.handleSnapshot({
    settings: soundSettings,
    snapshot: needSnap,
    resetBaseline: false,
  });
  assert.equal(throwingCount, 1);
  assert.equal(throwingResult.emitted.length, 1);
  assert.ok(throwingResult.settings.soundedTransitionIds.includes(needId), "emitter failure never loses consumption");

  // --- Renderer player: bounded synthesis, silent failure, teardown (U4a) ---
  for (const tones of Object.values(SOUND_CUE_PATTERNS)) {
    for (const tone of tones) {
      assert.ok(tone.startMs + tone.durationMs <= SOUND_MAX_CUE_MS, "cue stays within duration cap");
      assert.ok(tone.freq >= 100 && tone.freq <= 4000, "fixed bounded frequency range");
    }
  }
  assert.ok(SOUND_MASTER_GAIN <= 0.1, "volume cap stays low");

  class FakeParam {
    values: number[] = [];
    setValueAtTime(value: number): void {
      this.values.push(value);
    }
    linearRampToValueAtTime(value: number): void {
      this.values.push(value);
    }
  }
  class FakeOsc {
    type = "";
    frequency = new FakeParam();
    gain: FakeGain | null = null;
    started = 0;
    stopped = 0;
    connect(node: unknown): void {
      this.gain = node as FakeGain;
    }
    start(when = 0): void {
      this.started = when;
    }
    stop(when = 0): void {
      this.stopped = when;
    }
  }
  class FakeGain {
    gain = new FakeParam();
    destination: unknown = null;
    connect(node: unknown): void {
      this.destination = node;
    }
  }
  class FakeContext {
    currentTime = 1.5;
    state = "running";
    destination = {};
    resumeCalls = 0;
    closeCalls = 0;
    oscillators: FakeOsc[] = [];
    resume(): Promise<unknown> {
      this.resumeCalls += 1;
      return Promise.resolve();
    }
    close(): Promise<unknown> {
      this.closeCalls += 1;
      return Promise.resolve();
    }
    createOscillator(): FakeOsc {
      const osc = new FakeOsc();
      this.oscillators.push(osc);
      return osc;
    }
    createGain(): FakeGain {
      return new FakeGain();
    }
  }

  const fakeCtx = new FakeContext();
  const player = new PetSoundPlayer(() => fakeCtx as unknown as PetAudioContextLike);
  assert.equal(player.play("attention"), true);
  assert.equal(fakeCtx.oscillators.length, 2);
  assert.equal(fakeCtx.oscillators[0].type, "sine");
  const allGainValues = fakeCtx.oscillators.flatMap((osc) => osc.gain?.gain.values ?? []);
  assert.ok(allGainValues.length > 0);
  assert.ok(allGainValues.every((value) => value <= SOUND_MASTER_GAIN + 0.001), "gain never exceeds the cap");
  assert.deepEqual(
    fakeCtx.oscillators.map((osc) => osc.frequency.values[0]),
    SOUND_CUE_PATTERNS.attention.map((tone) => tone.freq),
  );
  const firstSpan = fakeCtx.oscillators.reduce((max, osc) => Math.max(max, osc.stopped - osc.started), 0);
  assert.ok(firstSpan <= SOUND_MAX_CUE_MS / 1000 + 0.01);
  // Per-kind defensive gap drops duplicate replays; other kinds still play.
  assert.equal(player.play("attention"), false);
  assert.equal(player.play("completion"), true);
  assert.equal(fakeCtx.oscillators.length, 4);
  player.destroy();
  assert.equal(fakeCtx.closeCalls, 1, "destroy closes the AudioContext");
  assert.equal(player.play("attention"), false, "destroyed player never plays");

  // Missing / throwing context factories and suspended contexts stay silent/no-throw.
  const nullPlayer = new PetSoundPlayer(() => null);
  assert.equal(nullPlayer.play("attention"), false);
  assert.equal(nullPlayer.play("completion"), false);
  const throwingPlayer = new PetSoundPlayer(() => {
    throw new Error("no audio device");
  });
  assert.equal(throwingPlayer.play("attention"), false);
  const suspendedCtx = new FakeContext();
  suspendedCtx.state = "suspended";
  const suspendedPlayer = new PetSoundPlayer(() => suspendedCtx as unknown as PetAudioContextLike);
  assert.equal(suspendedPlayer.play("completion"), true);
  assert.equal(suspendedCtx.resumeCalls, 1, "suspended context resumes best-effort");

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
  assert.equal(offlineView.showContextMeter, true);
  assert.equal(
    buildActivityView({
      snapshot: null,
      connection: offline,
      settings: updateDesktopSettings(createDefaultDesktopSettings(), { showContextMeter: false }),
    }).showContextMeter,
    false,
  );
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
    dndEnabled: false,
    soundMasterEnabled: false,
    activeCount: 0,
    attentionCount: 0,
    canCopyStartCommand: true,
    startCommand: DESKTOP_START_COMMAND,
  });
  const labels = trayModel.map((i) => i.label).join(" | ");
  assert.ok(labels.includes("显示桌宠"));
  assert.ok(labels.includes("取消鼠标穿透"));
  assert.ok(labels.includes("勿扰模式"));
  assert.ok(labels.includes("重试连接"));
  assert.ok(labels.includes("打开 WebUI"));
  assert.ok(labels.includes("退出桌宠"));
  assert.ok(labels.includes(DESKTOP_START_COMMAND));
  const quit = trayModel.find((i) => i.id === "quit");
  assert.ok(quit);
  assertQuitLabelSafe(quit!.label);
  assert.equal(trayItemToAction("quit"), "quit");
  assert.equal(trayItemToAction("toggle-dnd"), "toggle-dnd");
  const trayDndOff = trayModel.find((i) => i.id === "toggle-dnd");
  assert.ok(trayDndOff);
  assert.equal(trayDndOff!.checked, false);
  const trayDndOn = buildTrayMenuModel({
    presentation: "running",
    connectionStatus: "connected",
    clickThrough: false,
    dndEnabled: true,
    soundMasterEnabled: true,
    activeCount: 1,
    attentionCount: 0,
    canCopyStartCommand: false,
    startCommand: DESKTOP_START_COMMAND,
  }).find((i) => i.id === "toggle-dnd");
  assert.ok(trayDndOn);
  assert.equal(trayDndOn!.checked, true);
  assert.ok(labels.includes("声音提示"));
  assert.equal(trayItemToAction("toggle-sound"), "toggle-sound");
  const traySoundOff = trayModel.find((i) => i.id === "toggle-sound");
  assert.ok(traySoundOff);
  assert.equal(traySoundOff!.checked, false);
  const traySoundOn = buildTrayMenuModel({
    presentation: "running",
    connectionStatus: "connected",
    clickThrough: false,
    dndEnabled: false,
    soundMasterEnabled: true,
    activeCount: 1,
    attentionCount: 0,
    canCopyStartCommand: false,
    startCommand: DESKTOP_START_COMMAND,
  }).find((i) => i.id === "toggle-sound");
  assert.ok(traySoundOn);
  assert.equal(traySoundOn!.checked, true, "tray mirrors the sound master switch");
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
  // A frame run that wraps onto a second sheet row cannot be animated with a
  // single two-keyframe `steps()` animation, so the validator rejects it.
  assert.equal(
    validatePetManifestDocument({
      ...validSpriteManifest,
      states: {
        ...spriteStates,
        idle: { ...spriteStates.idle, firstFrame: 3, frameCount: 2 },
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
    [
      "/pets/snail-sprite/manifest.json",
      JSON.stringify({ ...validSpriteManifest, id: "snail-sprite", name: "Pixel Snail" }),
    ],
    ["/pets/snail-sprite/snail.png", "sprite"],
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
    { id: "snail-sprite", renderMode: "spritesheet" },
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
  assert.deepEqual(resolveRunningCueVisual("command"), { glyph: "›_", label: "命令中" });
  assert.equal(resolvePetFrame(manifest, "idle", false).animated, true);
  assert.equal(resolvePetFrame(manifest, "idle", true).animated, false);
  assert.ok(staticFrame.label);
  assert.ok(staticFrame.glyph);
  assert.equal(getBuiltinPetManifest("missing").id, "snail-default");

  // --- Spritesheet runtime style + fallback (P3) ---
  const spriteManifest = getBuiltinPetManifest("snail-sprite");
  assert.equal(spriteManifest.renderMode, "spritesheet");
  assert.ok(spriteManifest.sheet);
  const sheet = spriteManifest.sheet!;
  assert.equal(sheet.frameWidth, 108);
  assert.equal(sheet.frameHeight, 92);
  assert.equal(sheet.columns, 4);
  assert.equal(sheet.rows, 8);
  assert.equal(spriteSheetBackgroundSize(sheet), "432px 736px");
  assert.equal(positionCss(spriteCellPosition(sheet, 0)), "0px 0px");
  assert.equal(positionCss(spriteCellPosition(sheet, 1)), "-108px 0px");
  assert.equal(positionCss(spriteCellPosition(sheet, 4)), "0px -92px");
  assert.equal(positionCss(spriteCellPosition(sheet, 24)), "0px -552px");

  const spriteUrl = "data:image/png;base64,AA==";
  const idleStyle = resolveSpriteSheetStyle(spriteManifest, "idle", spriteUrl);
  assert.ok(idleStyle);
  assert.equal(idleStyle!.animatedPosition, "0px 0px");
  assert.ok(idleStyle!.animation?.includes("steps(3, end)"));
  assert.ok(idleStyle!.animation?.includes("1080ms"));
  const disconnectedStyle = resolveSpriteSheetStyle(spriteManifest, "disconnected", spriteUrl);
  assert.ok(disconnectedStyle);
  assert.equal(disconnectedStyle!.animation, null);
  assert.equal(disconnectedStyle!.staticPosition, "0px -552px");
  assert.equal(resolveSpriteSheetStyle(spriteManifest, "idle", null), null);
  assert.equal(resolveSpriteSheetStyle(manifest, "idle", spriteUrl), null);
  assert.equal(animationName("snail-sprite", "idle"), "pet-sprite-snail-sprite-idle");

  const spriteCss = buildSpriteSheetStyleText(spriteManifest, spriteUrl);
  assert.ok(spriteCss.includes('.pet-sprite-snail-sprite[data-state="idle"].is-animated'));
  assert.ok(spriteCss.includes("@keyframes pet-sprite-snail-sprite-idle"));
  assert.ok(spriteCss.includes("steps(3, end)"));
  assert.equal(buildSpriteSheetStyleText(spriteManifest, null), "");
  assert.equal(buildSpriteSheetStyleText(manifest, spriteUrl), "");

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
  assert.equal(migrated.showContextMeter, true);
  assert.equal(migrated.dndEnabled, false);
  assert.equal(migrated.selectedPetId, "snail-classic");
  assert.equal(migrated.selectedPetKey, "snail:snail-classic");
  assert.deepEqual(migrated.windowPosition, { x: 120, y: 80 });
  assert.equal(
    updateDesktopSettings(createDefaultDesktopSettings(), { showContextMeter: false }).showContextMeter,
    false,
  );
  assert.equal(normalizeDesktopSettings({ showContextMeter: "nope" }).showContextMeter, true);
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
  assert.ok(preloadSrc.includes("listQuickSessionProjects"));
  assert.ok(preloadSrc.includes("listQuickSessionModels"));
  assert.ok(preloadSrc.includes("createQuickSession"));
  assert.equal(preloadSrc.includes("ipcRenderer.invoke(channel"), true);
  assert.equal(/exposeInMainWorld\([\s\S]*ipcRenderer/.test(preloadSrc), false);
  assert.equal(preloadSrc.includes("getAccessKey"), false);

  // DND travels the narrow existing bridge: panel checkbox -> setPrefs patch ->
  // main persist + tray rebuild. No new IPC channels.
  const ipcSrc = readFileSync(
    path.join(process.cwd(), "desktop", "main", "ipc-contract.ts"),
    "utf8",
  );
  assert.ok(ipcSrc.includes("dndEnabled"));
  const petAppSrc = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-app.tsx"),
    "utf8",
  );
  assert.ok(petAppSrc.includes("pref-dnd"));
  assert.ok(petAppSrc.includes("setPrefs({ dndEnabled: prefDnd.checked })"));
  assert.ok(petAppSrc.includes("dndEnabled: view.dndEnabled === true"));
  const indexHtmlSrc = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "index.html"),
    "utf8",
  );
  assert.ok(indexHtmlSrc.includes('id="pref-dnd"'));
  assert.ok(indexHtmlSrc.includes('id="quick-session-panel"'));
  assert.ok(indexHtmlSrc.includes('id="btn-quick-session"'));
  assert.ok(indexHtmlSrc.includes("connect-src 'none'"));
  assert.equal(/nodeIntegration|child_process/.test(indexHtmlSrc), false);
  assert.ok(petAppSrc.includes("listQuickSessionProjects"));
  assert.ok(petAppSrc.includes("listQuickSessionModels"));
  assert.ok(petAppSrc.includes("createQuickSession"));
  assert.ok(indexHtmlSrc.includes('id="qs-project-trigger"'));
  assert.ok(indexHtmlSrc.includes('id="qs-model-trigger"'));
  assert.ok(petAppSrc.includes("isComposing"));

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
  // U4a: main owns the sound policy and pushes only the finite cue vocabulary.
  assert.ok(mainSrc.includes("DesktopSoundCueController"));
  assert.ok(mainSrc.includes("PET_IPC_CHANNELS.soundCue"));
  assert.ok(mainSrc.includes('sound: { masterEnabled: !settings.sound.masterEnabled }'));

  // Tray DND toggle persists settings and pushes state without any process control.
  assert.ok(mainSrc.includes('"toggle-dnd"'));
  assert.ok(mainSrc.includes("dndEnabled: p.dndEnabled"));
  assert.ok(mainSrc.includes("dndEnabled: !settings.dndEnabled"));

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
    for (const cue of ["thinking", "editing", "command", "subagent_one", "subagent_many"]) {
      assert.equal(manifest.states[cue], undefined, `${petId} must not add cue sub-states`);
    }
  }

  // Renderer HTML CSP + no inline node + drag/close affordances
  const html = readFileSync(path.join(process.cwd(), "desktop", "renderer", "index.html"), "utf8");
  assert.ok(html.includes("Content-Security-Policy"));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes("img-src 'self' data: blob:"));
  assert.ok(html.includes("connect-src 'none'"));
  assert.equal(html.includes("nodeIntegration"), false);
  // Pet body owns click-vs-drag; no separate drag strip markup.
  assert.equal(html.includes("pet-drag-bar"), false);
  assert.ok(html.includes('id="btn-hide"'));
  assert.ok(html.includes("隐藏到托盘"));
  assert.ok(html.includes('id="pet-intent-menu"'));
  assert.ok(html.includes('id="btn-pet-activity"'));
  assert.ok(html.includes('id="btn-pet-mark-all"'));
  assert.ok(html.includes('id="btn-pet-quick-session"'));
  assert.ok(html.includes('id="btn-pet-settings"'));
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
  assert.ok(html.includes("显示上下文占比"));
  assert.ok(html.includes('id="pet-context-meter"'));
  assert.ok(html.includes('id="pref-show-context-meter"'));
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
  assert.ok(css.includes(".pet-context-meter[hidden]"));
  assert.ok(css.includes("display: none !important"));
  assert.ok(css.includes(".pet-context-ring"));
  assert.ok(css.includes("conic-gradient"));
  assert.ok(css.includes("--context-percent"));
  assert.ok(css.includes('data-tray-anchor="bottom-right"'));
  assert.ok(css.includes("column-reverse"));
  assert.ok(css.includes('.pet-root[data-pet="snail-classic"]'));
  assert.ok(css.includes('data-pet-scale="large"'));
  assert.ok(css.includes("--pet-scale"));
  assert.ok(css.includes("background: transparent"));
  assert.ok(css.includes("prefers-reduced-motion: reduce"));
  assert.ok(css.includes(".activity-filter"));
  assert.ok(css.includes("align-self: stretch"));
  assert.ok(css.includes(".tray-counts[hidden]"));
  assert.ok(css.includes(".pet-intent-menu"));
  assert.ok(css.includes(".pet-stack:focus-within .pet-intent-menu"));
  // Comic-bubble chrome: cream paper + ink outline, not a dark admin overlay.
  assert.ok(css.includes("--bubble-paper"));
  assert.ok(css.includes(".settings-card"));
  assert.ok(html.includes("settings-card"));
  for (const cue of [
    "thinking",
    "editing",
    "command",
    "subagent_one",
    "subagent_many",
  ]) {
    assert.ok(css.includes(`data-running-cue="${cue}"`), `pet.css missing ${cue} cue modifier`);
  }
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
    "pet-sleepy",
    "pet-sleeping",
    "idle-sleepy-z",
    "idle-sleep-z",
    "idle-sleep-breathe",
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
  assert.ok(rendererSource.includes("selectPrimaryActivity"));
  assert.ok(rendererSource.includes("resolvePrimaryContextMeter"));
  assert.ok(rendererSource.includes("showContextMeter"));
  assert.ok(rendererSource.includes("resolveRunningCue"));
  assert.ok(rendererSource.includes('setAttribute("data-running-cue", runningCue)'));
  assert.ok(rendererSource.includes("scheduleRunningCueUpdate"));
  assert.ok(rendererSource.includes("clearTimeout(runningCueTimer)"));
  assert.equal(rendererSource.includes("view.projects[0]?.activities[0]"), false);
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
  // U3: progressive idle sleep is renderer-local and leaves observer state untouched.
  assert.ok(rendererSource.includes("syncIdleSleep"));
  assert.ok(rendererSource.includes("wakeIdleSleep"));
  assert.ok(rendererSource.includes("maybeWakeOnHover"));
  assert.ok(rendererSource.includes("reduceIdleSleepState"));
  assert.ok(rendererSource.includes("clearIdleSleepTimer"));
  assert.ok(rendererSource.includes('data-idle-sleep'));
  assert.ok(rendererSource.includes("PET_IDLE_POINTER_WAKE_THROTTLE_MS"));
  assert.equal(rendererSource.includes("powerMonitor"), false, "U3 must not use powerMonitor");
  // U4b/U4c: greetings stay renderer-local and never enter the observer/8-state contract.
  assert.ok(rendererSource.includes("reducePetClickSequence"));
  assert.ok(rendererSource.includes("shouldAllowPetReaction"));
  assert.ok(rendererSource.includes("resolvePetBodyClick"));
  assert.ok(rendererSource.includes("playInteract"));
  assert.ok(rendererSource.includes("toggleActivityFromMenu"));
  assert.ok(rendererSource.includes("cancelClickSequence"));
  assert.ok(rendererSource.includes("handlePetClick"));
  assert.ok(rendererSource.includes("playReaction"));
  assert.ok(rendererSource.includes('addEventListener("lostpointercapture"'));
  assert.ok(rendererSource.includes('event.key === "p"'));
  assert.ok(rendererSource.includes("markAllVisibleRead"));
  assert.ok(rendererSource.includes("PET_POKE_ANIMATION_MS"));
  assert.ok(rendererSource.includes("PET_FLAIL_ANIMATION_MS"));
  assert.ok(rendererSource.includes("reactionClass"));
  assert.ok(rendererSource.includes("shiftKey"));
  assert.ok(css.includes("reaction-poke"));
  assert.ok(css.includes("reaction-flail"));
  assert.ok(css.includes("@keyframes reaction-poke"));
  assert.ok(css.includes("@keyframes reaction-flail"));
  assert.ok(css.includes(".row-child-meta"));
  assert.ok(css.includes(".row-actions"));
  assert.ok(html.includes("pet-stack"));
  assert.ok(html.includes("data-tray-anchor"));

  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.hideToTray), true);
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.moveBy), true);
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.restoreDefaultPosition), true);
  assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.restoreDefaultPosition));

  // --- U4a sound surface: settings panel, tray, IPC, preload, renderer ---
  assert.ok(html.includes('id="pref-sound-master"'));
  assert.ok(html.includes('id="pref-sound-needs-input"'));
  assert.ok(html.includes('id="pref-sound-completion"'));
  assert.ok(html.includes('id="sound-dnd-note"'));
  assert.ok(html.includes("声音已被勿扰模式静音"));
  // Synthesized audio adds no remote content: CSP stays without media-src.
  assert.equal(html.includes("media-src"), false);
  assert.ok(PET_MAIN_PUSH_CHANNELS.includes(PET_IPC_CHANNELS.soundCue));
  assert.equal(
    PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.soundCue),
    false,
    "renderer can never send sound cues",
  );
  assert.equal(isRendererIpcChannel(PET_IPC_CHANNELS.soundCue), false);
  assert.ok(css.includes("sound-dnd-note"));

  const preloadBridge = readFileSync(
    path.join(process.cwd(), "desktop", "preload", "pet-preload.ts"),
    "utf8",
  );
  assert.ok(preloadBridge.includes("moveBy"));
  assert.ok(preloadBridge.includes("restoreDefaultPosition"));
  assert.ok(preloadBridge.includes("onSoundCue"));
  assert.ok(preloadBridge.includes("isSoundCueKind"));

  const petAppSource = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-app.tsx"),
    "utf8",
  );
  assert.ok(petAppSource.includes("打开任务"));
  assert.ok(petAppSource.includes("标记已读"));
  assert.ok(petAppSource.includes("Subagent 安全摘要"));
  assert.ok(petAppSource.includes("row-resources"));
  assert.ok(petAppSource.includes("formatActiveModel"));
  assert.ok(petAppSource.includes("formatSessionResources"));
  assert.ok(petAppSource.includes("syncElapsedTimer"));
  assert.ok(petAppSource.includes("PetSoundPlayer"));
  assert.ok(petAppSource.includes("onSoundCue"));
  assert.ok(petAppSource.includes("prefSoundMaster"));
  assert.ok(petAppSource.includes("soundDndNote"));
  assert.ok(petAppSource.includes("soundPlayer.destroy"));
  assert.ok(petAppSource.includes("current?.trayOpen === true"));
  assert.ok(petAppSource.includes("!settingsOpen"));
  assert.ok(petAppSource.includes('trayTitle.textContent = settingsOpen ? "设置"'));
  assert.ok(petAppSource.includes("trayCounts.hidden = hideCounts"));
  assert.ok(petAppSource.includes("悬停打开活动列表"));
  assert.ok(petAppSource.includes("markAllVisibleRead"));
  assert.ok(petAppSource.includes("openSettingsPanel"));
  assert.ok(petAppSource.includes("openQuickSessionPanel"));
  assert.ok(petAppSource.includes("pendingTrayPanel"));
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
  assert.ok(petAppJs.includes("row-resources"));
  assert.ok(petAppJs.includes("formatActiveModel"));
  assert.ok(petAppJs.includes("formatSessionResources"));
  assert.ok(petAppJs.includes("markRead"));
  assert.ok(petAppJs.includes("selectPrimaryActivity"));
  assert.ok(petAppJs.includes("resolvePrimaryContextMeter"));
  assert.ok(petAppJs.includes("showContextMeter"));
  assert.ok(petAppJs.includes("data-running-cue"));
  assert.ok(petAppJs.includes("scheduleRunningCueUpdate"));
  assert.ok(petAppJs.includes("PetSoundPlayer"));
  assert.ok(petAppJs.includes("onSoundCue"));
  assert.ok(petAppJs.includes("syncIdleSleep"));
  assert.ok(petAppJs.includes("data-idle-sleep"));
  assert.ok(petAppJs.includes("PET_IDLE_POINTER_WAKE_THROTTLE_MS"));

  const petSoundSrc = readFileSync(
    path.join(process.cwd(), "desktop", "renderer", "pet-sound.ts"),
    "utf8",
  );
  assert.equal(
    /fetch\s*\(|XMLHttpRequest|https?:\/\//.test(petSoundSrc),
    false,
    "sound synthesis never touches the network",
  );
  assert.ok(petSoundSrc.includes("SOUND_MASTER_GAIN"));
  assert.ok(petSoundSrc.includes("createOscillator"));
  assert.ok(petSoundSrc.includes("SOUND_MAX_CUE_MS"));

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
  assert.deepEqual(row.activeModel, { provider: "anthropic", modelId: "claude-sonnet-4" });
  assert.equal(formatActiveModel(row.activeModel), "anthropic/claude-sonnet-4");
  assert.deepEqual(row.sessionResources?.performance, { avgTps: 31.8, sampleCount: 6 });
  assert.equal(
    formatSessionResources(row.sessionResources),
    "上下文 42% · 31.8 t/s · $0.08",
  );
  assert.equal(
    formatSessionResources({ billing: { totalTokens: 128400, costUsd: 0 } }),
    "128k tokens",
  );
  assert.ok(row.deepLink.startsWith("/"));

  // sortProjectGroups stable
  const groups = sortProjectGroups(view.projects);
  assert.equal(groups.length, view.projects.length);

  // -------------------------------------------------------------------------
  // Custom pets (U6 slice 1): folder drop-in scan, gates, and IPC contract
  // -------------------------------------------------------------------------
  {
    function customSpriteManifest(id: string, name: string, src = "turtle.png") {
      const states: Record<string, unknown> = {};
      const required = [
        "idle",
        "running",
        "retrying",
        "needs_input",
        "ready",
        "blocked",
        "disconnected",
        "service_not_running",
      ];
      required.forEach((state, index) => {
        states[state] = {
          frame: "idle",
          staticFrame: "idle",
          label: "L",
          glyph: "·",
          firstFrame: index * 2,
          frameCount: 2,
          durationMs: 200,
          staticFrameIndex: 0,
        };
      });
      return {
        id,
        name,
        version: 2,
        renderMode: "spritesheet",
        states,
        sheet: { src, frameWidth: 32, frameHeight: 32, columns: 4, rows: 4 },
      };
    }

    function customCssManifest(id: string, name: string) {
      const states: Record<string, unknown> = {};
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
        states[state] = { frame: "idle", staticFrame: "idle", label: "L", glyph: "·" };
      }
      return { id, name, version: 2, renderMode: "css", states };
    }

    type FakeEntry =
      | { kind: "dir"; names: string[] }
      | { kind: "text"; text: string }
      | { kind: "bytes"; bytes: Uint8Array };

    function fakeCustomPetsIo(entries: Record<string, FakeEntry>): CustomPetsIo {
      return {
        listDirs: (root) => {
          const entry = entries[root];
          if (!entry || entry.kind !== "dir") throw new Error("unreadable root");
          return entry.names;
        },
        readText: (p) => {
          const entry = entries[p];
          if (!entry || entry.kind !== "text") throw new Error("no text");
          return entry.text;
        },
        readBinary: (p) => {
          const entry = entries[p];
          if (!entry || entry.kind !== "bytes") throw new Error("no bytes");
          return entry.bytes;
        },
        exists: (p) => p in entries,
        size: (p) => {
          const entry = entries[p];
          if (!entry) throw new Error("no entry");
          if (entry.kind === "text") return Buffer.byteLength(entry.text);
          if (entry.kind === "bytes") return entry.bytes.length;
          throw new Error("no size");
        },
        encodeBase64: (bytes) =>
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
        join: (...parts) => parts.join("/"),
      };
    }

    // Root resolution: explicit override wins, then PI_CODING_AGENT_DIR, then home.
    assert.equal(
      resolveCustomPetsRoot({ env: { SNAIL_PET_CUSTOM_PETS_DIR: "D:/pets" }, homedir: "/home/u" }),
      "D:/pets",
    );
    assert.equal(
      resolveCustomPetsRoot({ env: { PI_CODING_AGENT_DIR: "/data/agent" }, homedir: "/home/u" }),
      "/data/agent/desktop-pets",
    );
    assert.equal(
      resolveCustomPetsRoot({ env: {}, homedir: "/home/u" }),
      "/home/u/.pi/agent/desktop-pets",
    );

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    // Happy path: one valid turtle spritesheet pet, PNG sheet, base64 round-trip.
    const happyIo = fakeCustomPetsIo({
      root: { kind: "dir", names: ["turtle-sprite"] },
      "root/turtle-sprite/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("turtle-sprite", "Pixel Turtle")),
      },
      "root/turtle-sprite/turtle.png": { kind: "bytes", bytes: pngBytes },
    });
    const happy = scanCustomPets("root", happyIo);
    assert.equal(happy.errors.length, 0);
    assert.equal(happy.pets.length, 1);
    assert.equal(happy.pets[0].id, "turtle-sprite");
    assert.equal(happy.pets[0].manifest.name, "Pixel Turtle");
    assert.equal(happy.pets[0].sheetMime, "image/png");
    assert.equal(happy.pets[0].sheetSize, pngBytes.length);
    assert.equal("sheetDataUrl" in happy.pets[0], false);

    // WebP sheets carry the matching MIME.
    const webpIo = fakeCustomPetsIo({
      root: { kind: "dir", names: ["turtle-webp"] },
      "root/turtle-webp/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("turtle-webp", "Turtle", "turtle.webp")),
      },
      "root/turtle-webp/turtle.webp": { kind: "bytes", bytes: new Uint8Array([1, 2, 3]) },
    });
    const webp = scanCustomPets("root", webpIo);
    assert.equal(webp.pets.length, 1);
    assert.equal(webp.pets[0].sheetMime, "image/webp");

    // Names/labels containing absolute URLs are filtered before the renderer
    // view gate could reject the whole payload.
    const urlNameIo = fakeCustomPetsIo({
      root: { kind: "dir", names: ["url-name"] },
      "root/url-name/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("url-name", "See http://evil.example")),
      },
      "root/url-name/turtle.png": { kind: "bytes", bytes: pngBytes },
    });
    const urlName = scanCustomPets("root", urlNameIo);
    assert.equal(urlName.pets.length, 0);
    assert.equal(urlName.errors[0].reason, "unsafe_content");

    // Rejection matrix: every bad candidate lands in errors, never in pets.
    const bigSheet = new Uint8Array(257 * 1024);
    const capabilityManifest = customSpriteManifest("capability", "Cap");
    (capabilityManifest.states as Record<string, Record<string, unknown>>).idle.command = "calc.exe";
    const rejectEntries: Record<string, FakeEntry> = {
      root: { kind: "dir", names: ["Turtle!", "snail-default", "id-mismatch", "css-pet", "no-sheet", "big-sheet", "big-manifest", "bad-json", "traversal", "capability", "bad-type"] },
      "root/Turtle!/manifest.json": { kind: "text", text: "{}" },
      "root/snail-default/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("snail-default", "Nope")),
      },
      "root/snail-default/snail.png": { kind: "bytes", bytes: pngBytes },
      "root/id-mismatch/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("other-id", "Mismatch")),
      },
      "root/css-pet/manifest.json": {
        kind: "text",
        text: JSON.stringify(customCssManifest("css-pet", "Css")),
      },
      "root/no-sheet/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("no-sheet", "NoSheet")),
      },
      "root/big-sheet/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("big-sheet", "Big")),
      },
      "root/big-sheet/turtle.png": { kind: "bytes", bytes: bigSheet },
      "root/big-manifest/manifest.json": { kind: "text", text: "x".repeat(17 * 1024) },
      "root/bad-json/manifest.json": { kind: "text", text: "{nope" },
      "root/traversal/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("traversal", "Traversal", "../turtle.png")),
      },
      "root/traversal/turtle.png": { kind: "bytes", bytes: pngBytes },
      "root/capability/manifest.json": {
        kind: "text",
        text: JSON.stringify(capabilityManifest),
      },
      "root/capability/turtle.png": { kind: "bytes", bytes: pngBytes },
      "root/bad-type/manifest.json": {
        kind: "text",
        text: JSON.stringify(customSpriteManifest("bad-type", "Gif", "turtle.gif")),
      },
      "root/bad-type/turtle.gif": { kind: "bytes", bytes: pngBytes },
    };
    const rejected = scanCustomPets("root", fakeCustomPetsIo(rejectEntries));
    assert.equal(rejected.pets.length, 0);
    const reasonOf = (petId: string) =>
      rejected.errors.find((e) => e.petId === petId)?.reason;
    assert.equal(reasonOf("Turtle!"), "bad_id");
    assert.equal(reasonOf("snail-default"), "builtin_id_collision");
    assert.equal(reasonOf("id-mismatch"), "id");
    assert.equal(reasonOf("css-pet"), "custom_render_mode");
    assert.equal(reasonOf("no-sheet"), "sheet_missing");
    assert.equal(reasonOf("big-sheet"), "sheet_size");
    assert.equal(reasonOf("big-manifest"), "manifest_size");
    assert.equal(reasonOf("bad-json"), "manifest_json");
    assert.equal(reasonOf("traversal"), "sheet_src");
    assert.equal(reasonOf("capability"), "capability:command");
    // The shared manifest validator already rejects non-PNG/WebP sheet sources.
    assert.equal(reasonOf("bad-type"), "sheet_src");

    // Unreadable root is a single soft error, never a throw.
    const unreadable = scanCustomPets("missing", fakeCustomPetsIo({}));
    assert.equal(unreadable.pets.length, 0);
    assert.equal(unreadable.errors[0].reason, "root_unreadable");

    // Pet count cap: 17 valid folders → 16 accepted + one too_many_pets error.
    const manyNames = Array.from({ length: CUSTOM_PET_MAX_COUNT + 1 }, (_v, i) => `pet-${i}`);
    const manyEntries: Record<string, FakeEntry> = { root: { kind: "dir", names: manyNames } };
    for (const name of manyNames) {
      manyEntries[`root/${name}/manifest.json`] = {
        kind: "text",
        text: JSON.stringify(customSpriteManifest(name, "P")),
      };
      manyEntries[`root/${name}/turtle.png`] = { kind: "bytes", bytes: pngBytes };
    }
    const many = scanCustomPets("root", fakeCustomPetsIo(manyEntries));
    assert.equal(many.pets.length, CUSTOM_PET_MAX_COUNT);
    assert.equal(
      many.errors.find((e) => e.reason === "too_many_pets")?.petId,
      "pet-9",
    );

    // Renderer-side gates: id pattern, sheet data URLs, and the asset gate.
    assert.equal(isCustomPetId("turtle-sprite"), true);
    assert.equal(isCustomPetId("Turtle!"), false);
    assert.equal(isCustomPetId("a".repeat(65)), false);
    assert.equal(isCustomPetId("-bad"), false);
    assert.equal(isSafeCustomPetSheetDataUrl("data:image/png;base64,aGVsbG8="), true);
    assert.equal(isSafeCustomPetSheetDataUrl("data:image/webp;base64,aGVsbG8="), true);
    assert.equal(isSafeCustomPetSheetDataUrl("data:image/gif;base64,aGVsbG8="), false);
    assert.equal(isSafeCustomPetSheetDataUrl("https://evil/x.png"), false);
    assert.equal(isSafeCustomPetSheetDataUrl("data:image/png;base64,!!!"), false);
    assert.equal(isSafeCustomPetSheetDataUrl(`data:image/png;base64,${"A".repeat(400_000)}`), false);

    const gateOk = validateCustomPetAsset(
      {
        id: "turtle-sprite",
        manifest: customSpriteManifest("turtle-sprite", "Pixel Turtle"),
        sheetDataUrl: "data:image/png;base64,aGVsbG8=",
      },
      "turtle-sprite",
    );
    assert.equal(gateOk.ok, true);
    assert.equal(
      validateCustomPetAsset(
        {
          id: "x",
          manifest: customCssManifest("x", "Css"),
          sheetDataUrl: "data:image/png;base64,AA==",
        },
        "x",
      ).ok,
      false,
    );
    assert.equal(
      validateCustomPetAsset(
        {
          id: "turtle-sprite",
          manifest: customSpriteManifest("turtle-sprite", "Pixel Turtle"),
          sheetDataUrl: "https://evil/x.png",
        },
        "turtle-sprite",
      ).ok,
      false,
    );

    // pet-state runtime gate: spritesheet docs resolve; css/unknown ids do not.
    assert.equal(
      resolveCustomPetManifest(
        "turtle-sprite",
        customSpriteManifest("turtle-sprite", "Pixel Turtle"),
      )?.renderMode,
      "spritesheet",
    );
    assert.equal(
      resolveCustomPetManifest(
        "css-pet",
        customCssManifest("css-pet", "Css"),
      ),
      null,
    );
    assert.equal(resolveCustomPetManifest("other", customSpriteManifest("evil", "Evil")), null);

    // IPC contract: custom pets channels follow the renderer/push split.
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.getCustomPets));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.openCustomPetsDir));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.rescanCustomPets));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.getPetAsset));
    assert.ok(!PET_MAIN_PUSH_CHANNELS.includes(PET_IPC_CHANNELS.getPetAsset));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.listQuickSessionProjects));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.listQuickSessionModels));
    assert.ok(PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.createQuickSession));
    assert.ok(!PET_RENDERER_ALLOWED_CHANNELS.includes(PET_IPC_CHANNELS.customPetsChanged));
    assert.ok(PET_MAIN_PUSH_CHANNELS.includes(PET_IPC_CHANNELS.customPetsChanged));

    // View and custom-pet payloads stay renderer-safe (no tokens/absolute URLs).
    const viewWithRoot = buildActivityView({
      snapshot,
      connection,
      settings: createDefaultDesktopSettings(),
      now: Date.now(),
      customPetsRoot: "D:/home/.pi/agent/desktop-pets",
    });
    assert.equal(viewWithRoot.customPetsRoot, "D:/home/.pi/agent/desktop-pets");
    assert.equal(viewWithRoot.quickSessionAvailable, false);
    assertRendererViewSafe(viewWithRoot);
    const connectedQuick = reduceConnectionState(
      connection,
      { type: "connected", instanceId: "inst-u7", quickSessionAvailable: true },
      Date.now(),
    );
    const viewQuick = buildActivityView({
      snapshot,
      connection: connectedQuick,
      settings: createDefaultDesktopSettings(),
      now: Date.now(),
    });
    assert.equal(viewQuick.quickSessionAvailable, true);
    assertRendererViewSafe(viewQuick);
    assertRendererViewSafe({
      pets: [{ id: "turtle-sprite", manifest: customSpriteManifest("turtle-sprite", "Pixel Turtle"), sheetDataUrl: "data:image/png;base64,aGVsbG8=" }],
      root: "D:/home/.pi/agent/desktop-pets",
    });
  }

  // --- Codex parser + namespaced keys + runtime profile (U1) ---
  const v1Meta = validateCodexPetDocument({
    id: "blue-whale",
    displayName: "Blue",
    spritesheetPath: "spritesheet.webp",
  });
  assert.equal(v1Meta.ok, true);
  if (v1Meta.ok) {
    assert.equal(v1Meta.metadata.spriteVersionNumber, 1);
    const v1Profile = profileFromCodexMetadata(v1Meta.metadata);
    assert.equal(v1Profile.petKey, "codex:blue-whale");
    assert.equal(v1Profile.sheet?.expectedWidth, CODEX_PET_V1_WIDTH);
    assert.equal(v1Profile.sheet?.expectedHeight, CODEX_PET_V1_HEIGHT);
    assert.equal(v1Profile.capabilities.look, false);
    assert.equal(assertNoLookRows(v1Profile), true);
    assert.equal(isCodexAtlasSize(1, CODEX_PET_V1_WIDTH, CODEX_PET_V1_HEIGHT), true);
  }
  const v2Meta = validateCodexPetDocument({
    id: "blue-whale-maid",
    displayName: "蓝鲸女仆",
    description: "kind is display-only",
    spritesheetPath: "spritesheet.webp",
    spriteVersionNumber: 2,
    kind: "person",
    command: "calc.exe",
    url: "https://evil.example",
  });
  assert.equal(v2Meta.ok, true);
  if (v2Meta.ok) {
    assert.equal(v2Meta.metadata.spriteVersionNumber, 2);
    assert.equal("kind" in v2Meta.metadata, false);
    assert.equal("command" in v2Meta.metadata, false);
    assert.equal("url" in v2Meta.metadata, false);
    const v2Profile = profileFromCodexMetadata(v2Meta.metadata);
    assert.equal(v2Profile.capabilities.look, true);
    assert.equal(v2Profile.sheet?.expectedHeight, CODEX_PET_V2_HEIGHT);
    assert.equal(isCodexAtlasSize(2, CODEX_PET_V2_WIDTH, CODEX_PET_V2_HEIGHT), true);
    assert.equal(clipTotalDurationMs(v2Profile.clips.idle), 1100);
    for (const state of Object.keys(SNAIL_STATE_TO_CODEX_CLIP)) {
      const binding = SNAIL_STATE_TO_CODEX_CLIP[state as keyof typeof SNAIL_STATE_TO_CODEX_CLIP];
      assert.ok(v2Profile.clips[binding.clipName], `missing clip for ${state}`);
    }
    assert.equal(lookCellIndex(0), 72);
    assert.equal(lookCellIndex(7), 79);
    assert.equal(lookCellIndex(8), 80);
    assert.equal(lookCellIndex(15), 87);
  }
  assert.equal(validateCodexPetDocument({ id: "x", spritesheetPath: "https://evil/x.webp" }).ok, false);
  assert.equal(validateCodexPetDocument({ id: "x", spritesheetPath: "../x.webp" }).ok, false);
  assert.equal(validateCodexPetDocument({ id: "Bad Id", spritesheetPath: "spritesheet.webp" }).ok, false);
  assert.equal(
    validateCodexPetDocument({ id: "ok", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 3 }).ok,
    false,
  );
  assert.equal(validateCodexPetDocument({ id: "ok" }).ok, false);
  assert.equal(validateCodexPetDocument({ id: "folder", spritesheetPath: "spritesheet.webp" }, "other").ok, false);
  assert.equal(buildPetKey("snail", "turtle"), "snail:turtle");
  assert.equal(buildPetKey("codex", "turtle"), "codex:turtle");
  assert.notEqual(buildPetKey("snail", "turtle"), buildPetKey("codex", "turtle"));
  assert.equal(parsePetKey("codex:turtle")?.format, "codex");
  assert.equal(petCssToken("codex", "turtle"), "codex-turtle");
  assert.equal(petCssToken("snail", "snail-default"), "snail-default");
  assert.equal(resolvePetKey({ selectedPetId: "snail-classic" }), "snail:snail-classic");
  assert.equal(resolvePetKey({ selectedPetKey: "codex:minato" }), "codex:minato");
  assert.equal(resolvePetKey({ selectedPetId: "../evil" }), DEFAULT_PET_KEY);

  assert.equal(quantizeCodexLookDirection(0, -100), 0);
  assert.equal(quantizeCodexLookDirection(100, 0), 4);
  assert.equal(quantizeCodexLookDirection(0, 100), 8);
  assert.equal(quantizeCodexLookDirection(-100, 0), 12);
  assert.equal(quantizeCodexLookDirection(Math.sin((157.5 * Math.PI) / 180) * 80, -Math.cos((157.5 * Math.PI) / 180) * 80), 7);
  assert.equal(quantizeCodexLookDirection(0, 80), 8);
  assert.equal(quantizeCodexLookDirection(Math.sin((337.5 * Math.PI) / 180) * 80, -Math.cos((337.5 * Math.PI) / 180) * 80), 15);
  assert.equal(quantizeCodexLookDirection(0, -80), 0);
  assert.equal(quantizeCodexLookDirection(2, -2), null);
  assert.equal(quantizeCodexLookDirection(0, 0), null);
  assert.equal(resolveCodexDragClip(8, 1, null), "running-right");
  assert.equal(resolveCodexDragClip(-8, 1, null), "running-left");
  assert.equal(resolveCodexDragClip(1, 8, "running-right"), "running-right");
  assert.equal(resolveCodexDragClip(0, 0, null), null);

  if (v2Meta.ok) {
    const profile = profileFromCodexMetadata(v2Meta.metadata);
    const look = resolveActivePetClip({
      profile,
      state: "idle",
      reducedMotion: false,
      lookDirection: 4,
      dragClip: null,
    });
    assert.equal(look.clipName, "look-4");
    assert.equal(canApplyWaveOverlay("idle"), true);
    assert.equal(canApplyWaveOverlay("needs_input"), false);
    const wave = resolveActivePetClip({
      profile,
      state: "idle",
      reducedMotion: false,
      lookDirection: 4,
      dragClip: null,
      waveActive: true,
    });
    assert.equal(wave.clipName, "waving");
    const waveBlocked = resolveActivePetClip({
      profile,
      state: "needs_input",
      reducedMotion: false,
      lookDirection: 4,
      dragClip: null,
      waveActive: true,
    });
    assert.equal(waveBlocked.clipName, "waiting");
    const blocked = resolveActivePetClip({
      profile,
      state: "needs_input",
      reducedMotion: false,
      lookDirection: 4,
      dragClip: "running-right",
    });
    assert.equal(blocked.clipName, "waiting");
    const reduced = resolveActivePetClip({
      profile,
      state: "idle",
      reducedMotion: true,
      lookDirection: 4,
      dragClip: "running-left",
    });
    assert.equal(reduced.clipName, "idle");
    assert.equal(reduced.staticOnly, true);
    const v1 = profileFromCodexMetadata({
      id: "legacy",
      displayName: "Legacy",
      description: null,
      spritesheetPath: "spritesheet.webp",
      spriteVersionNumber: 1,
    });
    const v1Look = resolveActivePetClip({
      profile: v1,
      state: "idle",
      reducedMotion: false,
      lookDirection: 4,
      dragClip: null,
    });
    assert.equal(v1Look.clipName, "idle");
    assert.equal(v1.clips["look-0"], undefined);
  }

  const snailSprite = getBuiltinPetManifest("snail-sprite");
  const snailProfile = profileFromSnailManifest(snailSprite);
  assert.equal(snailProfile.format, "snail");
  assert.equal(snailProfile.capabilities.look, false);
  const snailCss = buildSpriteSheetStyleTextFromProfile(snailProfile, "data:image/png;base64,AA==");
  assert.ok(snailCss.includes("[data-clip=\"idle\"]"));
  const idleClip = snailProfile.clips.idle;
  const clipStyle = resolveClipSheetStyle(snailProfile.sheet!, idleClip, snailProfile.cssToken);
  assert.ok(clipStyle?.animation?.includes("steps("));
  assert.equal(clipAnimationName("codex-x", "look-4"), "pet-sprite-codex-x-look-4");

  // Codex official rows dwell on the last cell, so they are uneven. Overlapping
  // `start, end` percentages plus `linear` collapse in CSS and slide the atlas.
  if (v2Meta.ok) {
    const minato = profileFromCodexMetadata(v2Meta.metadata);
    const minatoIdle = minato.clips.idle;
    assert.equal(isUniformClip(minatoIdle), false);
    const minatoIdleStyle = resolveClipSheetStyle(minato.sheet!, minatoIdle, minato.cssToken);
    assert.ok(minatoIdleStyle?.animation);
    assert.equal(
      /\blinear\b/.test(minatoIdleStyle!.animation ?? ""),
      false,
      "Codex uneven clips must not interpolate background-position",
    );
    assert.ok(
      minatoIdleStyle!.animation?.includes("step-end") ||
        minatoIdleStyle!.animation?.includes("steps(1"),
    );
    const minatoCss = buildSpriteSheetStyleTextFromProfile(minato, "blob:minato");
    const idleKeyframes = extractCssKeyframes(
      minatoCss,
      clipAnimationName(minato.cssToken, "idle"),
    );
    assert.ok(idleKeyframes.length >= minatoIdle.frames.length);
    assert.equal(
      keyframeBlockHasOverlappingPercents(idleKeyframes),
      false,
      "overlapping keyframe percents let CSS drop the hold and slide",
    );
  }

  // Lazy custom Snail sheets are blob URLs, not builtin data URLs. Using the
  // legacy manifest stylesheet after load paints pet-sprite with no bitmap.
  assert.deepEqual(
    resolveSpriteStylesheetSource({
      format: "snail",
      spriteImageUrl: "blob:bunny-cute",
      builtinDataUrl: null,
    }),
    { kind: "profile", imageUrl: "blob:bunny-cute" },
  );
  assert.deepEqual(
    resolveSpriteStylesheetSource({
      format: "snail",
      spriteImageUrl: "data:image/png;base64,AA==",
      builtinDataUrl: "data:image/png;base64,AA==",
    }),
    { kind: "manifest", imageUrl: "data:image/png;base64,AA==" },
  );
  assert.deepEqual(
    resolveSpriteStylesheetSource({
      format: "codex",
      spriteImageUrl: "blob:minato",
      builtinDataUrl: null,
    }),
    { kind: "profile", imageUrl: "blob:minato" },
  );
  assert.deepEqual(
    resolveSpriteStylesheetSource({
      format: "snail",
      spriteImageUrl: null,
      builtinDataUrl: null,
    }),
    { kind: "none" },
  );

  // --- Dual-root catalog + lazy asset load (U2) ---
  assert.equal(
    resolveCodexPetsRoot({ env: { CODEX_HOME: "D:/codex" }, homedir: "/home/u" }),
    "D:/codex/pets",
  );
  assert.equal(
    resolveCodexPetsRoot({ env: {}, homedir: "/home/u" }),
    "/home/u/.codex/pets",
  );

  type CatalogEntry =
    | { kind: "dir"; names: string[] }
    | { kind: "text"; text: string }
    | { kind: "bytes"; bytes: Uint8Array; mtimeMs?: number };

  function fakeCatalogIo(entries: Record<string, CatalogEntry>): PetCatalogIo {
    return {
      listDirs: (root) => {
        const entry = entries[root];
        if (!entry || entry.kind !== "dir") throw new Error("unreadable root");
        return entry.names;
      },
      readText: (p) => {
        const entry = entries[p];
        if (!entry || entry.kind !== "text") throw new Error("no text");
        return entry.text;
      },
      readBinary: (p) => {
        const entry = entries[p];
        if (!entry || entry.kind !== "bytes") throw new Error("no bytes");
        return entry.bytes;
      },
      exists: (p) => p in entries,
      size: (p) => {
        const entry = entries[p];
        if (!entry) throw new Error("no entry");
        if (entry.kind === "text") return Buffer.byteLength(entry.text);
        if (entry.kind === "bytes") return entry.bytes.length;
        throw new Error("no size");
      },
      encodeBase64: (bytes) => Buffer.from(bytes).toString("base64"),
      join: (...parts) => parts.join("/"),
      realpath: (p) => p,
      statMtimeMs: (p) => {
        const entry = entries[p];
        return entry && entry.kind === "bytes" ? (entry.mtimeMs ?? 1) : 1;
      },
    };
  }

  function snailPack(id: string, name: string) {
    const states: Record<string, unknown> = {};
    for (const [index, state] of [
      "idle", "running", "retrying", "needs_input", "ready", "blocked", "disconnected", "service_not_running",
    ].entries()) {
      states[state] = {
        frame: "idle",
        staticFrame: "idle",
        label: "L",
        glyph: "·",
        firstFrame: index * 4,
        frameCount: 1,
        durationMs: 200,
        staticFrameIndex: 0,
      };
    }
    return {
      id,
      name,
      version: 2,
      renderMode: "spritesheet",
      states,
      sheet: { src: "sheet.png", frameWidth: 32, frameHeight: 32, columns: 4, rows: 8 },
    };
  }

  const snailPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const catalogIo = fakeCatalogIo({
    "/snail": { kind: "dir", names: ["turtle-sprite", "shared-id"] },
    "/snail/turtle-sprite": { kind: "dir", names: [] },
    "/snail/turtle-sprite/manifest.json": {
      kind: "text",
      text: JSON.stringify(snailPack("turtle-sprite", "Pixel Turtle")),
    },
    "/snail/turtle-sprite/sheet.png": { kind: "bytes", bytes: snailPng, mtimeMs: 10 },
    "/snail/shared-id": { kind: "dir", names: [] },
    "/snail/shared-id/pet.json": {
      kind: "text",
      text: JSON.stringify({
        id: "shared-id",
        displayName: "Shared Snail Root",
        spritesheetPath: "spritesheet.webp",
        spriteVersionNumber: 2,
      }),
    },
    "/snail/shared-id/spritesheet.webp": { kind: "bytes", bytes: new Uint8Array([1, 2, 3, 4]), mtimeMs: 11 },
    "/codex": { kind: "dir", names: ["shared-id", "minato"] },
    "/codex/shared-id": { kind: "dir", names: [] },
    "/codex/shared-id/pet.json": {
      kind: "text",
      text: JSON.stringify({
        id: "shared-id",
        displayName: "Shared Codex Home",
        spritesheetPath: "spritesheet.webp",
        spriteVersionNumber: 2,
      }),
    },
    "/codex/shared-id/spritesheet.webp": { kind: "bytes", bytes: new Uint8Array(8), mtimeMs: 12 },
    "/codex/minato": { kind: "dir", names: [] },
    "/codex/minato/pet.json": {
      kind: "text",
      text: JSON.stringify({
        id: "minato",
        displayName: "Minato",
        spritesheetPath: "spritesheet.webp",
        spriteVersionNumber: 2,
        kind: "person",
      }),
    },
    "/codex/minato/spritesheet.webp": { kind: "bytes", bytes: new Uint8Array([9, 9, 9]), mtimeMs: 13 },
  });
  const catalog = scanPetCatalog({ snailRoot: "/snail", codexRoot: "/codex", io: catalogIo });
  const catalogKeys = catalog.entries.map((entry) => entry.petKey).sort();
  assert.deepEqual(catalogKeys, ["codex:minato", "codex:shared-id", "snail:turtle-sprite"]);
  assert.equal(catalog.entries.find((entry) => entry.petKey === "codex:shared-id")?.source, "snail-custom");
  assert.ok(catalog.diagnostics.some((item) => item.reason === "duplicate_codex_id"));
  const payload = toRendererCatalogPayload(catalog);
  assert.equal(JSON.stringify(payload).includes("base64"), false);
  assert.equal(JSON.stringify(payload).includes("sheetPath"), false);
  const loadedAsset = readCatalogPetAsset(catalog, "codex:minato", catalogIo);
  assert.equal(loadedAsset.ok, true);
  if (loadedAsset.ok) {
    assert.deepEqual(loadedAsset.bytes, new Uint8Array([9, 9, 9]));
    assert.equal(loadedAsset.mime, "image/webp");
  }
  const missingRoot = scanPetCatalog({
    snailRoot: "/snail",
    codexRoot: "/missing-codex",
    io: fakeCatalogIo({
      "/snail": { kind: "dir", names: [] },
    }),
  });
  assert.equal(missingRoot.entries.length, 0);
  assert.equal(missingRoot.diagnostics.some((item) => item.source === "codex-home"), false);

  const escaped = scanPetCatalog({
    snailRoot: "/snail",
    codexRoot: "/codex",
    io: {
      ...catalogIo,
      realpath: (p) => (p.includes("minato/spritesheet") ? "/outside/secret.webp" : p),
    },
  });
  assert.equal(escaped.entries.some((entry) => entry.id === "minato"), false);
  assert.ok(escaped.diagnostics.some((item) => item.reason === "symlink_escape"));

  const changedIo = fakeCatalogIo({
    "/codex": { kind: "dir", names: ["minato"] },
    "/codex/minato": { kind: "dir", names: [] },
    "/codex/minato/pet.json": {
      kind: "text",
      text: JSON.stringify({
        id: "minato",
        displayName: "Minato",
        spritesheetPath: "spritesheet.webp",
        spriteVersionNumber: 2,
      }),
    },
    "/codex/minato/spritesheet.webp": { kind: "bytes", bytes: new Uint8Array([1]), mtimeMs: 99 },
  });
  const firstCatalog = scanPetCatalog({ snailRoot: "/empty", codexRoot: "/codex", io: {
    ...changedIo,
    exists: (p) => p === "/empty" ? false : changedIo.exists(p),
    listDirs: (root) => (root === "/empty" ? [] : changedIo.listDirs(root)),
  } });
  assert.equal(readCatalogPetAsset(firstCatalog, "codex:minato", changedIo).ok, true);
  const replacedIo = {
    ...changedIo,
    size: (p: string) => (p.endsWith("spritesheet.webp") ? 4 : changedIo.size(p)),
    readBinary: (p: string) => (p.endsWith("spritesheet.webp") ? new Uint8Array([2, 2, 2, 2]) : changedIo.readBinary(p)),
    statMtimeMs: (p: string) => (p.endsWith("spritesheet.webp") ? 1000 : changedIo.statMtimeMs(p)),
  };
  const stale = readCatalogPetAsset(firstCatalog, "codex:minato", replacedIo);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "changed");

  const gated = validateRendererCatalogEntry(payload.pets.find((pet) => pet.petKey === "codex:minato"));
  assert.equal(gated.ok, true);
  if (gated.ok) {
    assert.equal(gated.entry.capabilities.look, true);
    assert.equal(gated.entry.snailManifest, null);
  }
  assert.equal(
    validateRendererCatalogEntry({ ...payload.pets[0], petKey: "/etc/passwd" }).ok,
    false,
  );
  if (loadedAsset.ok) {
    const assetGate = validateRendererPetAsset({
      ok: true,
      petKey: loadedAsset.petKey,
      mime: loadedAsset.mime,
      bytes: loadedAsset.bytes,
      fingerprint: loadedAsset.fingerprint,
      expectedWidth: loadedAsset.expectedWidth,
      expectedHeight: loadedAsset.expectedHeight,
    });
    assert.equal(assetGate.ok, true);
    assert.equal(
      validateRendererPetAsset({
        ok: true,
        petKey: loadedAsset.petKey,
        mime: loadedAsset.mime,
        bytes: loadedAsset.bytes,
        fingerprint: loadedAsset.fingerprint,
        expectedWidth: loadedAsset.expectedWidth,
        expectedHeight: loadedAsset.expectedHeight,
        sheetPath: "/secret.webp",
      }).ok,
      false,
    );
    const b64 = Buffer.from(loadedAsset.bytes).toString("base64");
    const fromB64 = validateRendererPetAsset({
      ok: true,
      petKey: loadedAsset.petKey,
      mime: loadedAsset.mime,
      bytesBase64: b64,
      fingerprint: loadedAsset.fingerprint,
      expectedWidth: loadedAsset.expectedWidth,
      expectedHeight: loadedAsset.expectedHeight,
    });
    assert.equal(fromB64.ok, true);
    if (fromB64.ok) assert.deepEqual(fromB64.asset.bytes, loadedAsset.bytes);
    assert.deepEqual(decodeBase64PetBytes(b64), loadedAsset.bytes);
  }
  assert.equal(
    sameRealPath(
      "C:\\Users\\a\\.codex\\pets\\minato\\spritesheet.webp",
      "c:/Users/a/.codex/pets/minato/spritesheet.webp",
      { ignoreCase: true },
    ),
    true,
  );

  const sameNameSettings = normalizeDesktopSettings({
    selectedPetId: "shared-id",
  });
  assert.equal(sameNameSettings.selectedPetKey, "snail:shared-id");
  const codexSelected = updateDesktopSettings(sameNameSettings, { selectedPetKey: "codex:shared-id" });
  assert.equal(codexSelected.selectedPetKey, "codex:shared-id");
  assert.equal(codexSelected.selectedPetId, "shared-id");
  assertDesktopSettingsSafe(codexSelected);

  const viewKey = buildActivityView({
    snapshot,
    connection,
    settings: createDefaultDesktopSettings(),
    now: Date.now(),
  });
  assert.equal(viewKey.selectedPetKey, DEFAULT_PET_KEY);
  assertRendererViewSafe(viewKey);

  const mainSrcNow = readFileSync(path.join(process.cwd(), "desktop", "main", "main.ts"), "utf8");
  assert.ok(mainSrcNow.includes("getPetAsset"));
  assert.ok(mainSrcNow.includes("scanPetCatalog"));
  assert.equal(mainSrcNow.includes("sheetDataUrl"), false);
  assert.ok(petAppSource.includes("getPetAsset"));
  assert.ok(petAppSource.includes("createObjectURL"));
  assert.ok(petAppSource.includes("revokeOwnedSheetUrl"));
  assert.ok(petAppSource.includes("resolveSpriteStylesheetSource"));
  assert.equal(petAppSource.includes("profile.format === \"codex\" || needsLazySheet"), false);
  assert.ok(indexHtmlSrc.includes("data-pet-key=\"snail:snail-default\""));
  assert.ok(indexHtmlSrc.includes("pet-picker-filter"));

  console.log("smoke-desktop-contract: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
