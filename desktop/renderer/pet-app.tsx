/**
 * Desktop pet renderer app (U7).
 *
 * Presentation-only. Talks to main through window.snailPet preload bridge.
 * No Node, no token, no arbitrary navigation.
 *
 * Bundlers (Electron Forge / U8) should compile this file. A plain ES build
 * target can also emit pet-app.js next to index.html.
 */

import type {
  DesktopActivityRow,
  DesktopActivityView,
  DesktopProjectGroup,
} from "../main/activity-store";
import { isDesktopPetBubbleTheme } from "../main/settings-store";
import { resolvePetLayoutSpec } from "../main/window-manager";
import type { SnailPetBridge } from "../preload/pet-preload";
import {
  acceptStaticPetPreview,
  validateRendererCatalogEntry,
  validateRendererPetAsset,
} from "./pet-assets";
import {
  connectionBannerText,
  countActivitiesByFilter,
  countUnreadActivities,
  createInitialIdleSleepState,
  createInitialPetBubbleState,
  createInitialPetCelebrateState,
  createInitialPetClickSequenceState,
  createInitialRunningCueState,
  filterProjectGroups,
  formatActiveModel,
  formatActivityProgress,
  formatElapsed,
  formatPetActivityDetail,
  formatSessionResources,
  getPetManifest,
  getPetRuntimeProfile,
  registerCatalogPet,
  clearCatalogPets,
  clearCustomPetManifests,
  listCatalogPets,
  resolvePetKey,
  moveActivitySelection,
  nextActDelayMs,
  nextBlinkDelayMs,
  petSourceLabel,
  petStateGlyph,
  petStateLabel,
  petTerminalOutcome,
  reduceIdleSleepState,
  reducePetBubbleState,
  reducePetClickSequence,
  reduceRunningCueState,
  resolveActivityElapsedMs,
  resolveActivitySelection,
  resolvePetFrame,
  resolvePetBodyClick,
  resolvePetIntentMenuPresentation,
  resolvePetTransitionAction,
  resolvePrimaryContextMeter,
  resolveRunningCue,
  resolveRunningCueVisual,
  runningCueNextUpdateAt,
  selectPrimaryActivity,
  shouldAllowPetReaction,
  shouldCelebrateCompletion,
  shouldRunIdleLife,
  PET_FLAIL_ANIMATION_MS,
  PET_IDLE_POINTER_WAKE_THROTTLE_MS,
  PET_POKE_ANIMATION_MS,
  type DesktopActivityFilter,
  type IdleSleepStage,
  type PetBubbleSignal,
  type PetClickSequenceState,
  type PetManifest,
  type PetReaction,
  type PetTransitionAction,
  type PetVisualState,
} from "./pet-state";
import {
  buildSpriteSheetStyleText,
  buildSpriteSheetStyleTextFromProfile,
  expectedSheetPixelSize,
  resolveClipSheetStyle,
  resolveSpriteSheetStyle,
  resolveSpriteStylesheetSource,
} from "./pet-sheet";
import {
  clearCustomPetSheetDataUrls,
  clearCustomPetSheetUrls,
  petSheetDataUrl,
  petSheetUrl,
  rememberOwnedBlobUrl,
  revokeOwnedSheetUrl,
  setCustomPetSheetUrl,
} from "./pet-sheet-assets";
import {
  canApplyDragOverlay,
  canApplyJumpOverlay,
  canApplyLookOverlay,
  clipTotalDurationMs,
  CODEX_LOOK_RELEASE_MS,
  isCodexLookPointerInBounds,
  quantizeCodexLookDirection,
  resolveActivePetClip,
  resolveCodexDragClip,
  type PetDragClipName,
} from "./pet-runtime-profile";
import { PetSoundPlayer } from "./pet-sound";
import {
  canSubmitQuickSession,
  countQuickSessionChars,
  createInitialQuickSessionState,
  filterQuickSessionModels,
  filterQuickSessionProjects,
  formatQuickSessionModelLabel,
  formatQuickSessionProjectLabel,
  QUICK_SESSION_MAX_MESSAGE_CHARS,
  quickSessionErrorText,
  reduceQuickSessionState,
  selectedQuickSessionModel,
  selectedQuickSessionProject,
  type QuickSessionCatalog,
  type QuickSessionErrorCode,
  type QuickSessionModelCatalog,
  type QuickSessionState,
} from "./quick-session-state";

declare global {
  interface Window {
    snailPet?: SnailPetBridge;
    /** Dev-only static fixture. Production preload never sets this. */
    __SNAIL_PET_PREVIEW__?: unknown;
    matchMedia: (query: string) => MediaQueryList;
  }
}

function isPetVisualState(value: string): value is PetVisualState {
  return (
    value === "service_not_running" ||
    value === "disconnected" ||
    value === "needs_input" ||
    value === "blocked" ||
    value === "ready" ||
    value === "retrying" ||
    value === "running" ||
    value === "idle"
  );
}

export function renderPetApp(root: Document = document): {
  update: (view: DesktopActivityView) => void;
  destroy: () => void;
} {
  const bridge = window.snailPet;
  const petRoot = root.getElementById("root");
  const petButton = root.getElementById("pet-button");
  const petAvatar = root.getElementById("pet-avatar");
  const petGlyph = root.getElementById("pet-glyph");
  const petLabel = root.getElementById("pet-label");
  const petBadge = root.getElementById("pet-badge");
  const petContextMeter = root.getElementById("pet-context-meter");
  const petContextMeterLabel = root.getElementById("pet-context-meter-label");
  const petCaption = root.getElementById("pet-caption");
  const petCaptionState = root.getElementById("pet-caption-state");
  const petCaptionTitle = root.getElementById("pet-caption-title");
  const tray = root.getElementById("activity-tray");
  const projectList = root.getElementById("project-list");
  const trayTitle = root.getElementById("tray-title");
  const trayCounts = root.getElementById("tray-counts");
  const banner = root.getElementById("connection-banner");
  const authPanel = root.getElementById("auth-panel");
  const activityFilters = root.getElementById("activity-filters");
  const accessKeyInput = root.getElementById("access-key-input") as HTMLInputElement | null;
  const btnSaveKey = root.getElementById("btn-save-key");
  const btnClearKey = root.getElementById("btn-clear-key");
  const btnMarkAll = root.getElementById("btn-mark-all");
  const btnRetry = root.getElementById("btn-retry");
  const btnTrayMore = root.getElementById("btn-tray-more");
  const trayMoreMenu = root.getElementById("tray-more-menu");
  const btnCopy = root.getElementById("btn-copy-cmd");
  const intentMenu = root.getElementById("pet-intent-menu");
  const btnHide = root.getElementById("btn-hide");
  const btnHideTray = root.getElementById("btn-hide-tray");
  const btnSettings = root.getElementById("btn-settings");
  const btnPetMarkAll = root.getElementById("btn-pet-mark-all");
  const btnPetActivity = root.getElementById("btn-pet-activity");
  const btnPetSettings = root.getElementById("btn-pet-settings");
  const btnPetHide = root.getElementById("btn-pet-hide");
  const btnPetQuickSession = root.getElementById("btn-pet-quick-session") as HTMLButtonElement | null;
  const btnQuickSession = root.getElementById("btn-quick-session") as HTMLButtonElement | null;
  const quickSessionPanel = root.getElementById("quick-session-panel");
  const qsStatus = root.getElementById("qs-status");
  const qsSelected = root.getElementById("qs-selected");
  const qsModelSelected = root.getElementById("qs-model-selected");
  const qsProjectTrigger = root.getElementById("qs-project-trigger") as HTMLButtonElement | null;
  const qsModelTrigger = root.getElementById("qs-model-trigger") as HTMLButtonElement | null;
  const qsPicker = root.getElementById("qs-picker");
  const qsPickerSearch = root.getElementById("qs-picker-search") as HTMLInputElement | null;
  const qsPickerList = root.getElementById("qs-picker-list");
  const qsPickerNote = root.getElementById("qs-picker-note");
  const qsMessage = root.getElementById("qs-message") as HTMLTextAreaElement | null;
  const qsCount = root.getElementById("qs-count");
  const qsError = root.getElementById("qs-error");
  const qsSuccess = root.getElementById("qs-success");
  const qsSuccessText = root.getElementById("qs-success-text");
  const qsEditActions = root.getElementById("qs-edit-actions");
  const btnQsCancel = root.getElementById("btn-qs-cancel");
  const btnQsSubmit = root.getElementById("btn-qs-submit") as HTMLButtonElement | null;
  const btnQsOpen = root.getElementById("btn-qs-open");
  const btnQsAnother = root.getElementById("btn-qs-another");
  const settingsPanel = root.getElementById("settings-panel");
  const petPicker = root.getElementById("pet-picker");
  const petPickerFilter = root.getElementById("pet-picker-filter") as HTMLInputElement | null;
  const customPetOptions = root.getElementById("custom-pet-options");
  const catalogDiagnostics = root.getElementById("pet-catalog-diagnostics");
  const customPetsPath = root.getElementById("custom-pets-path");
  const codexPetsPath = root.getElementById("codex-pets-path");
  const btnOpenCustomPets = root.getElementById("btn-open-custom-pets");
  const btnRescanCustomPets = root.getElementById("btn-rescan-custom-pets");
  const petScalePicker = root.getElementById("pet-scale-picker");
  const bubbleThemePicker = root.getElementById("bubble-theme-picker");
  const btnRestorePosition = root.getElementById("btn-restore-position");
  const prefAlwaysOnTop = root.getElementById("pref-always-on-top") as HTMLInputElement | null;
  const prefClickThrough = root.getElementById("pref-click-through") as HTMLInputElement | null;
  const prefLaunchAtLogin = root.getElementById("pref-launch-at-login") as HTMLInputElement | null;
  const prefCompletion = root.getElementById("pref-completion") as HTMLSelectElement | null;
  const prefNeedsInput = root.getElementById("pref-needs-input") as HTMLInputElement | null;
  const prefBlocked = root.getElementById("pref-blocked") as HTMLInputElement | null;
  const prefShowContextMeter = root.getElementById("pref-show-context-meter") as HTMLInputElement | null;
  const prefRightClickMenu = root.getElementById("pref-right-click-menu") as HTMLInputElement | null;
  const interactionHint = root.getElementById("settings-interaction-hint");
  const prefDnd = root.getElementById("pref-dnd") as HTMLInputElement | null;
  const prefSoundMaster = root.getElementById("pref-sound-master") as HTMLInputElement | null;
  const prefSoundNeedsInput = root.getElementById("pref-sound-needs-input") as HTMLInputElement | null;
  const prefSoundCompletion = root.getElementById("pref-sound-completion") as HTMLInputElement | null;
  const soundDndNote = root.getElementById("sound-dnd-note");
  const staleFlag = root.getElementById("stale-flag");

  const hideToTray = () => {
    bridge?.hideToTray();
  };

  /** Pixel threshold before a pointer gesture becomes a window drag. */
  const DRAG_THRESHOLD_PX = 5;

  /** One-shot semantic transition action classes + their removal delay. */
  const TRANSITION_CLASS: Record<PetTransitionAction, string> = {
    "ready-to-idle-sink": "transition-ready-sink",
    "retrying-to-running-go": "transition-retry-go",
  };
  const TRANSITION_ACTION_MS = 620;

  let current: DesktopActivityView | null = null;
  let settingsOpen = false;
  /** Keep settings/quick-session intent across a collapsed-to-expanded tray toggle. */
  let pendingTrayPanel: "settings" | "quick-session" | null = null;
  let quickSession: QuickSessionState = createInitialQuickSessionState();
  let qsImeComposing = false;
  let qsSubmitInFlight = false;
  let qsModelsInFlight: string | null = null;
  let trayMoreOpen = false;
  let intentMenuOpen = false;
  let idleBlinkTimer: ReturnType<typeof setTimeout> | null = null;
  let idleActTimer: ReturnType<typeof setTimeout> | null = null;
  let idleActRemoveTimer: ReturnType<typeof setTimeout> | null = null;
  let petDropPopTimer: ReturnType<typeof setTimeout> | null = null;
  let transitionClass: string | null = null;
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let actActive = false;
  let documentHidden = typeof document !== "undefined" && document.hidden === true;
  let idleLifeKey: string | null = null;
  let activityFilter: DesktopActivityFilter = "all";
  let selectedVisibleActivityId: string | null = null;
  const expandedActivityIds = new Set<string>();
  let bubbleState = createInitialPetBubbleState();
  let celebrateState = createInitialPetCelebrateState();
  let runningCueState = createInitialRunningCueState();
  let idleSleepState = createInitialIdleSleepState();
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let runningCueTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSleepTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSleepTimerTargetMs: number | null = null;
  let lastIdlePointerWakeAt = 0;
  let sleepPresentation: PetVisualState = "idle";
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  // U4b: poke/flail click-sequence state + the two short timers it needs.
  let clickSequenceState: PetClickSequenceState = createInitialPetClickSequenceState();

  let reactionClass: string | null = null;
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Spritesheet pets inject one per-pet <style> and verify the inlined bitmap
  // decodes; a load/decode failure falls back to the CSS snail.
  const spriteStyleSheets = new Map<string, HTMLStyleElement>();
  const spriteVerified = new Set<string>();
  const spriteFailed = new Set<string>();
  // U6 slice 1: custom pets registered from validated main payloads. Every
  // rescan clears prior registrations so changed art/invalidation re-renders.
  const registeredCustomPetIds = new Set<string>();
  let petPickerQuery = "";
  let lookDirection: number | null = null;
  let lookReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  let dragClip: PetDragClipName | null = null;
  let jumpActive = false;
  let jumpTimer: ReturnType<typeof setTimeout> | null = null;
  let assetLoadSeq = 0;
  let loadedAssetKey: string | null = null;
  let loadedBlobUrl: string | null = null;

  // U4a: local synthesized cues only. Playback failure is silent by design and
  // never affects the tray, bubbles or observation.
  const soundPlayer = new PetSoundPlayer();

  bridge?.setReducedMotion(reducedMotion);
  if (typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      reducedMotion = mq.matches;
      bridge?.setReducedMotion(reducedMotion);
      if (current) update(current);
    };
    mq.addEventListener?.("change", onMotion);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function activityIds(projects: readonly DesktopProjectGroup[]): string[] {
    const ids: string[] = [];
    for (const project of projects) {
      for (const activity of project.activities) ids.push(activity.activityId);
    }
    return ids;
  }

  function clearElapsedTimer(): void {
    if (elapsedTimer != null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function visibleActivities(): DesktopActivityRow[] {
    if (!current) return [];
    return filterProjectGroups(current.projects, activityFilter).flatMap(
      (project) => project.activities,
    );
  }

  function refreshElapsedLabels(now = Date.now()): void {
    if (!projectList || !current) return;
    const activities = new Map(
      visibleActivities().map((activity) => [activity.activityId, activity]),
    );
    for (const label of projectList.querySelectorAll<HTMLElement>(".row-elapsed[data-activity-id]")) {
      const activityId = label.dataset.activityId;
      const activity = activityId ? activities.get(activityId) : undefined;
      if (activity) {
        label.textContent = formatElapsed(resolveActivityElapsedMs(activity, now));
      }
    }
  }

  function syncElapsedTimer(): void {
    const shouldTick =
      current?.trayOpen === true &&
      !settingsOpen &&
      visibleActivities().some(
        (activity) => !activity.endedAt && Number.isFinite(Date.parse(activity.startedAt ?? "")),
      );
    if (!shouldTick) {
      clearElapsedTimer();
      return;
    }
    refreshElapsedLabels();
    if (elapsedTimer == null) {
      elapsedTimer = setInterval(refreshElapsedLabels, 1000);
    }
  }

  function clearBubbleTimer(): void {
    if (bubbleTimer != null) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
  }

  function scheduleBubbleExpiry(now: number): void {
    clearBubbleTimer();
    if (
      !bubbleState.visible ||
      bubbleState.mode !== "transient" ||
      bubbleState.expiresAt == null
    ) {
      return;
    }
    bubbleTimer = setTimeout(() => {
      bubbleState = reducePetBubbleState(bubbleState, { type: "tick", now: Date.now() });
      if (!bubbleState.visible && petCaption) petCaption.hidden = true;
      bubbleTimer = null;
    }, Math.max(0, bubbleState.expiresAt - now));
  }

  function scheduleRunningCueUpdate(now: number): void {
    if (runningCueTimer != null) {
      clearTimeout(runningCueTimer);
      runningCueTimer = null;
    }
    const updateAt = runningCueNextUpdateAt(runningCueState);
    if (updateAt == null) return;
    runningCueTimer = setTimeout(() => {
      runningCueTimer = null;
      if (current) update(current);
    }, Math.max(0, updateAt - now));
  }

  // --- Progressive idle sleep (U3): renderer-local decorative stage ---
  // One local timer advances awake → sleepy → sleeping while the observer stays
  // idle. Same-state snapshots never reset the origin; any real state, hiding,
  // reduced-motion or a press/drag gesture resets to awake immediately.

  function clearIdleSleepTimer(): void {
    if (idleSleepTimer != null) {
      clearTimeout(idleSleepTimer);
      idleSleepTimer = null;
    }
    idleSleepTimerTargetMs = null;
  }

  function applySleepClassToAvatar(stage: IdleSleepStage, stageChanged: boolean): void {
    const avatar = petAvatar instanceof HTMLElement ? petAvatar : null;
    if (avatar) {
      avatar.classList.remove("pet-sleepy", "pet-sleeping");
      if (stage === "sleepy") avatar.classList.add("pet-sleepy");
      else if (stage === "sleeping") avatar.classList.add("pet-sleeping");
      if (stage === "awake") avatar.removeAttribute("data-idle-sleep");
      else avatar.setAttribute("data-idle-sleep", stage);
    }
    if (!stageChanged) return;
    // Pause decorative blink/random acts while drowsy or asleep so their keyframe
    // restarts never fight the sleep posture; re-arm them on wake.
    if (stage === "awake") {
      scheduleIdleBlink(avatar);
      scheduleIdleActs(avatar);
    } else {
      if (idleBlinkTimer) {
        clearTimeout(idleBlinkTimer);
        idleBlinkTimer = null;
      }
      clearIdleAct(avatar);
    }
  }

  function syncIdleSleep(now: number): void {
    const avatar = petAvatar instanceof HTMLElement ? petAvatar : null;
    const prevStage = idleSleepState.stage;
    const next = reduceIdleSleepState(
      idleSleepState,
      {
        presentation: sleepPresentation,
        hidden: documentHidden,
        reducedMotion,
        pressed: avatar?.classList.contains("is-pressed") ?? false,
        dragging: avatar?.classList.contains("is-dragging") ?? false,
      },
      now,
    );
    idleSleepState = next;
    applySleepClassToAvatar(next.stage, next.stage !== prevStage);
    if (next.nextBoundaryAt == null) {
      clearIdleSleepTimer();
      return;
    }
    // The absolute boundary timestamp is stable across same-state snapshots, so a
    // resource refresh never rebuilds the timer.
    if (idleSleepTimer != null && idleSleepTimerTargetMs === next.nextBoundaryAt) return;
    clearIdleSleepTimer();
    idleSleepTimerTargetMs = next.nextBoundaryAt;
    idleSleepTimer = setTimeout(() => {
      idleSleepTimer = null;
      idleSleepTimerTargetMs = null;
      if (current) syncIdleSleep(Date.now());
    }, Math.max(0, next.nextBoundaryAt - now));
  }

  /** A user interaction restarts the idle origin without any business side effect. */
  function wakeIdleSleep(): void {
    // Keep the current stage so syncIdleSleep can detect the awake transition and
    // re-arm decorative blink/acts; only the idle origin is discarded.
    idleSleepState = { ...idleSleepState, idleSince: null, nextBoundaryAt: null };
    syncIdleSleep(Date.now());
  }

  /** Hover over the pet only wakes it once it is drowsy/asleep; throttled. */
  function maybeWakeOnHover(): void {
    if (idleSleepState.stage === "awake") return;
    const now = Date.now();
    if (now - lastIdlePointerWakeAt < PET_IDLE_POINTER_WAKE_THROTTLE_MS) return;
    lastIdlePointerWakeAt = now;
    wakeIdleSleep();
  }

  function dismissActivityBubble(activity: DesktopActivityRow | null): void {
    if (!activity) return;
    // Opening an active task must not dismiss the always-on activity card.
    if (activity.presentation === "running" || activity.presentation === "retrying") return;
    bubbleState = reducePetBubbleState(bubbleState, {
      type: "viewed",
      transitionId: activity.lastTransitionId,
    });
    if (!bubbleState.visible && petCaption) petCaption.hidden = true;
    clearBubbleTimer();
  }

  function findVisibleActivity(activityId: string | null): DesktopActivityRow | null {
    if (!current || !activityId) return null;
    for (const project of filterProjectGroups(current.projects, activityFilter)) {
      const activity = project.activities.find((candidate) => candidate.activityId === activityId);
      if (activity) return activity;
    }
    return null;
  }

  function focusActivityRow(activityId: string | null): void {
    if (!activityId || !projectList) return;
    for (const row of projectList.querySelectorAll<HTMLElement>("[data-activity-id]")) {
      if (row.dataset.activityId === activityId) {
        row.focus();
        return;
      }
    }
  }

  function selectVisibleActivity(activityId: string, focus: boolean): void {
    selectedVisibleActivityId = activityId;
    bridge?.selectActivity(activityId);
    if (current) update(current);
    if (focus) focusActivityRow(activityId);
  }

  // Whether the decorative idle acts may run right now (pure policy in pet-state).
  function actEnabled(avatar: HTMLElement | null): boolean {
    // Spritesheet pets are animated by CSS steps(); their anatomy is hidden so
    // blink/idle-act timers have nothing to drive. The drowsy/asleep stages also
    // pause random acts so a stretch never interrupts a sleeping pose.
    if (avatar?.classList.contains("pet-sprite")) return false;
    if (idleSleepState.stage !== "awake") return false;
    return shouldRunIdleLife({
      animated: !!avatar && avatar.classList.contains("is-animated"),
      idle: !!avatar && avatar.classList.contains("frame-idle"),
      hidden: documentHidden,
      reducedMotion,
      pressed: !!avatar && avatar.classList.contains("is-pressed"),
      dragging: !!avatar && avatar.classList.contains("is-dragging"),
    });
  }

  // Blink runs in every animated state, but pauses while an idle act owns the eyes.
  function blinkEnabled(avatar: HTMLElement | null): boolean {
    if (avatar?.classList.contains("pet-sprite")) return false;
    if (idleSleepState.stage !== "awake") return false;
    return (
      !!avatar &&
      avatar.classList.contains("is-animated") &&
      !documentHidden &&
      !reducedMotion &&
      !actActive &&
      !avatar.classList.contains("is-pressed") &&
      !avatar.classList.contains("is-dragging")
    );
  }

  // Blinks feel alive only when the cadence is irregular: restart the eye CSS
  // animation at random offsets. The blink keyframes sit on the eye spans, so the
  // restart must target them directly — resetting the avatar's own animation
  // would leave the blink cycle untouched. All blink-adjacent keyframes start
  // and end in the rest pose, so mid-cycle restarts are visually seamless.
  function scheduleIdleBlink(avatar: HTMLElement | null): void {
    if (idleBlinkTimer) {
      clearTimeout(idleBlinkTimer);
      idleBlinkTimer = null;
    }
    if (!blinkEnabled(avatar)) return;
    idleBlinkTimer = setTimeout(() => {
      idleBlinkTimer = null;
      if (!avatar?.isConnected || !blinkEnabled(avatar)) return;
      const eyes = avatar.querySelectorAll(".pet-eye");
      eyes.forEach((eye) => {
        if (eye instanceof HTMLElement) eye.style.animation = "none";
      });
      void avatar.offsetWidth;
      eyes.forEach((eye) => {
        if (eye instanceof HTMLElement) eye.style.animation = "";
      });
      scheduleIdleBlink(avatar);
    }, nextBlinkDelayMs());
  }

  // Random idle mini-acts (look around / doze off / stretch) keep the pet from
  // feeling like a static sprite. Durations match the CSS keyframes in pet.css.
  const IDLE_ACTS = [
    { className: "idle-act-look", durationMs: 2400 },
    { className: "idle-act-sleepy", durationMs: 3400 },
    { className: "idle-act-stretch", durationMs: 1800 },
  ] as const;

  function clearIdleAct(avatar: HTMLElement | null): void {
    if (idleActTimer) {
      clearTimeout(idleActTimer);
      idleActTimer = null;
    }
    if (idleActRemoveTimer) {
      clearTimeout(idleActRemoveTimer);
      idleActRemoveTimer = null;
    }
    actActive = false;
    avatar?.classList.remove("idle-act-look", "idle-act-sleepy", "idle-act-stretch");
  }

  function scheduleIdleActs(avatar: HTMLElement | null): void {
    clearIdleAct(avatar);
    if (!avatar || !actEnabled(avatar)) return;
    const queueNext = () => {
      idleActTimer = setTimeout(() => {
        idleActTimer = null;
        if (!avatar.isConnected || !actEnabled(avatar) || actActive) return;
        const act = IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)];
        actActive = true;
        // Pause blink restarts while the act owns the eyes; resume after it ends.
        if (idleBlinkTimer) {
          clearTimeout(idleBlinkTimer);
          idleBlinkTimer = null;
        }
        avatar.classList.add(act.className);
        idleActRemoveTimer = setTimeout(() => {
          idleActRemoveTimer = null;
          actActive = false;
          avatar.classList.remove(act.className);
          scheduleIdleBlink(avatar);
        }, act.durationMs + 80);
        queueNext();
      }, nextActDelayMs());
    };
    queueNext();
  }

  // Hidden windows pause decorative timers; re-arming happens on visibility.
  function onVisibilityChange(): void {
    documentHidden = document.hidden === true;
    // Hide clears the sleep timer and re-show restarts the idle origin from awake,
    // so background time never accumulates into an instant deep sleep.
    syncIdleSleep(Date.now());
    if (documentHidden) {
      if (idleBlinkTimer) {
        clearTimeout(idleBlinkTimer);
        idleBlinkTimer = null;
      }
      clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
      clearCodexLook();
      // Hiding the window also cancels any in-flight click sequence / reaction.
      cancelClickSequence();
    } else if (petAvatar instanceof HTMLElement) {
      scheduleIdleBlink(petAvatar);
      scheduleIdleActs(petAvatar);
    }
  }

  // One burst of confetti when the aggregate state reaches "ready". Particles
  // are plain spans driven by CSS custom properties; the burst self-removes.
  function launchConfetti(): void {
    const host =
      petButton instanceof HTMLElement ? petButton.querySelector(".pet-stage") : null;
    if (!(host instanceof HTMLElement)) return;
    const colors = ["#77dbc6", "#f3b95f", "#9bd875", "#8bb8ff", "#f47c83"];
    const burst = root.createElement("div");
    burst.className = "confetti-burst";
    burst.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 14; index += 1) {
      const piece = root.createElement("i");
      const angle = Math.random() * Math.PI * 2;
      const distance = 26 + Math.random() * 32;
      piece.style.setProperty("--cx", `${(Math.cos(angle) * distance).toFixed(1)}px`);
      piece.style.setProperty("--cy", `${(Math.sin(angle) * distance - 16).toFixed(1)}px`);
      piece.style.setProperty("--cr", `${Math.round(Math.random() * 260 - 130)}deg`);
      piece.style.setProperty("--cc", colors[index % colors.length]);
      piece.style.animationDelay = `${Math.round(Math.random() * 90)}ms`;
      burst.appendChild(piece);
    }
    host.appendChild(burst);
    setTimeout(() => burst.remove(), 1500);
  }

  function setTrayMoreOpen(open: boolean): void {
    trayMoreOpen = open;
    if (trayMoreMenu) trayMoreMenu.hidden = !open;
    btnTrayMore?.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function isRightClickMenu(): boolean {
    return current?.rightClickAggregatedMenu === true;
  }

  function setIntentMenuOpen(open: boolean, opts?: { focus?: boolean }): void {
    intentMenuOpen = open && isRightClickMenu();
    intentMenu?.classList.toggle("is-open", intentMenuOpen);
    petRoot?.classList.toggle("is-intent-menu-open", intentMenuOpen);
    if (isRightClickMenu()) {
      if (intentMenu) intentMenu.hidden = !intentMenuOpen;
    } else if (intentMenu) {
      intentMenu.hidden = false;
      intentMenu.classList.remove("is-open");
    }
    if (intentMenuOpen && opts?.focus) {
      intentMenu?.querySelector<HTMLButtonElement>("button:not([hidden])")?.focus();
    }
  }

  function closeIntentMenu(): void {
    if (!intentMenuOpen) return;
    setIntentMenuOpen(false);
  }

  function startTransition(className: string): void {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (transitionClass && petAvatar instanceof HTMLElement) {
      petAvatar.classList.remove(transitionClass);
    }
    transitionClass = className;
    transitionTimer = setTimeout(() => {
      transitionTimer = null;
      transitionClass = null;
      if (petAvatar instanceof HTMLElement) {
        petAvatar.classList.remove(className);
      }
    }, TRANSITION_ACTION_MS);
  }

  function clearTransition(): void {
    if (transitionTimer) {
      clearTimeout(transitionTimer);
      transitionTimer = null;
    }
    if (transitionClass && petAvatar instanceof HTMLElement) {
      petAvatar.classList.remove(transitionClass);
    }
    transitionClass = null;
  }

  // --- U4b fun reactions (poke/flail): short, interruptible class modifiers ---

  function currentPresentation(): PetVisualState {
    return current && isPetVisualState(current.presentation) ? current.presentation : "idle";
  }

  function clearReaction(): void {
    if (reactionTimer) {
      clearTimeout(reactionTimer);
      reactionTimer = null;
    }
    if (reactionClass && petAvatar instanceof HTMLElement) {
      petAvatar.classList.remove("reaction-poke", "reaction-flail");
    }
    reactionClass = null;
  }

  function playReaction(reaction: PetReaction): void {
    clearReaction();
    reactionClass = reaction === "flail" ? "reaction-flail" : "reaction-poke";
    if (petAvatar instanceof HTMLElement) {
      petAvatar.classList.add(reactionClass);
    }
    reactionTimer = setTimeout(() => {
      reactionTimer = null;
      clearReaction();
    }, reaction === "flail" ? PET_FLAIL_ANIMATION_MS : PET_POKE_ANIMATION_MS);
  }

  function clearJump(): void {
    if (jumpTimer) {
      clearTimeout(jumpTimer);
      jumpTimer = null;
    }
    jumpActive = false;
  }

  function startJump(durationMs: number): void {
    clearJump();
    const ms = Math.max(1, Math.floor(durationMs));
    jumpActive = true;
    jumpTimer = setTimeout(() => {
      jumpTimer = null;
      jumpActive = false;
      if (current) update(current);
    }, ms);
    if (current) update(current);
  }

  /** Codex one-shot hop on the inner bitmap. Outer poke/flail can play at the same time. */
  function playCodexJump(): boolean {
    const presentation = currentPresentation();
    const profile = currentPetProfile();
    if (!profile?.clips.jumping || !canApplyJumpOverlay(presentation)) return false;
    startJump(clipTotalDurationMs(profile.clips.jumping));
    return true;
  }

  function playInteract(): void {
    wakeIdleSleep();
    playCodexJump();
    playReaction("poke");
  }

  /** Drag, cancel, lost capture, hiding, preemption and teardown all reset here. */
  function cancelClickSequence(): void {
    clickSequenceState = createInitialPetClickSequenceState();
    clearReaction();
    clearJump();
  }

  /**
   * Idle/running/retrying clicks greet the pet. Attention, tray-open and
   * connection clicks keep the work path. A second click in the same burst
   * upgrades the greeting to flail without toggling the tray.
   */
  function handlePetClick(): void {
    if (intentMenuOpen) {
      closeIntentMenu();
      return;
    }
    const motionReduced = reducedMotion || current?.reducedMotion === true;
    const action = resolvePetBodyClick({
      trayOpen: current?.trayOpen === true,
      presentation: currentPresentation(),
      reducedMotion: motionReduced,
      canJumpPrimary: canJumpToPrimary(current),
    });
    if (action !== "interact") {
      cancelClickSequence();
      activatePet();
      return;
    }
    const outcome = reducePetClickSequence(clickSequenceState, {
      type: "click",
      now: Date.now(),
    });
    clickSequenceState = outcome.state;
    if (outcome.cancelReaction) {
      clearReaction();
      clearJump();
    }
    if (outcome.startReaction === "flail") {
      playCodexJump();
      playReaction("flail");
      return;
    }
    if (outcome.singleClick || outcome.startReaction === "poke") {
      playInteract();
    }
  }

  function replaceSpriteStylesheet(token: string, text: string): void {
    const existing = spriteStyleSheets.get(token);
    if (existing?.textContent === text) return;
    existing?.remove();
    if (!text) {
      spriteStyleSheets.delete(token);
      return;
    }
    const style = root.createElement("style");
    style.setAttribute("data-pet-sprite", token);
    style.textContent = text;
    root.head?.appendChild(style);
    spriteStyleSheets.set(token, style);
  }

  function ensureSpriteStylesheet(manifest: PetManifest): void {
    if (spriteStyleSheets.has(manifest.id)) return;
    const text = buildSpriteSheetStyleText(manifest, petSheetDataUrl(manifest.id));
    if (!text) return;
    replaceSpriteStylesheet(manifest.id, text);
  }

  function ensureProfileStylesheet(profileToken: string, text: string): void {
    replaceSpriteStylesheet(profileToken, text);
  }

  // Inlined data URLs cannot fail to fetch, but a corrupt bitmap still can; a
  // decode rejection marks the pet failed so the renderer re-renders as CSS.
  function verifySpriteImage(
    petId: string,
    url: string,
    expected?: { width: number; height: number },
  ): void {
    if (spriteVerified.has(petId) || spriteFailed.has(petId)) return;
    const img = root.createElement("img");
    img.addEventListener("error", () => {
      spriteFailed.add(petId);
      if (current) update(current);
    });
    img.addEventListener("load", () => {
      if (
        expected &&
        (img.naturalWidth !== expected.width || img.naturalHeight !== expected.height)
      ) {
        spriteFailed.add(petId);
        if (current) update(current);
        return;
      }
      if (typeof img.decode !== "function") {
        spriteVerified.add(petId);
        if (current) update(current);
        return;
      }
      void img.decode().then(
        () => {
          spriteVerified.add(petId);
          if (current) update(current);
        },
        () => {
          spriteFailed.add(petId);
          if (current) update(current);
        },
      );
    });
    img.src = url;
  }

  // -------------------------------------------------------------------------
  // Custom pets (U6 slice 1): folder drop-in payloads from main.
  // -------------------------------------------------------------------------

  function clearCustomPetRegistrations(): void {
    for (const petId of registeredCustomPetIds) {
      const style = spriteStyleSheets.get(petId);
      style?.remove();
      spriteStyleSheets.delete(petId);
      spriteVerified.delete(petId);
      spriteFailed.delete(petId);
    }
    for (const record of listCatalogPets()) {
      const token = record.profile.cssToken;
      const style = spriteStyleSheets.get(token);
      style?.remove();
      spriteStyleSheets.delete(token);
      spriteVerified.delete(record.entry.petKey);
      spriteFailed.delete(record.entry.petKey);
    }
    registeredCustomPetIds.clear();
    clearCatalogPets();
    clearCustomPetManifests();
    clearCustomPetSheetDataUrls();
    clearCustomPetSheetUrls();
    loadedAssetKey = null;
    loadedBlobUrl = null;
    assetLoadSeq += 1;
  }

  function registerCatalogEntry(candidate: unknown): void {
    const gate = validateRendererCatalogEntry(candidate);
    if (!gate.ok) return;
    const profile = registerCatalogPet(gate.entry);
    if (!profile) return;
    registeredCustomPetIds.add(profile.cssToken);
  }

  function renderCatalogDiagnostics(items: unknown): void {
    if (!catalogDiagnostics) return;
    catalogDiagnostics.replaceChildren();
    if (!Array.isArray(items) || items.length === 0) {
      catalogDiagnostics.hidden = true;
      return;
    }
    const list = root.createElement("ul");
    list.className = "pet-catalog-diagnostic-list";
    for (const item of items.slice(0, 8)) {
      if (!item || typeof item !== "object") continue;
      const reason = (item as { reason?: unknown }).reason;
      const petId = (item as { petId?: unknown }).petId;
      if (typeof reason !== "string") continue;
      const row = root.createElement("li");
      row.textContent = typeof petId === "string" && petId ? `${petId}: ${reason}` : reason;
      list.appendChild(row);
    }
    catalogDiagnostics.hidden = list.childElementCount === 0;
    if (list.childElementCount > 0) catalogDiagnostics.appendChild(list);
  }

  function renderCustomPetOptions(): void {
    if (!customPetOptions) return;
    customPetOptions.replaceChildren();
    const query = petPickerQuery.trim().toLowerCase();
    const groups: Array<{ source: "snail-custom" | "codex-home"; label: string }> = [
      { source: "snail-custom", label: "蜗牛派自定义" },
      { source: "codex-home", label: "Codex" },
    ];
    let rendered = 0;
    for (const group of groups) {
      const pets = listCatalogPets().filter((record) => {
        if (record.entry.source !== group.source) return false;
        if (!query) return true;
        return (
          record.entry.name.toLowerCase().includes(query) ||
          record.entry.id.toLowerCase().includes(query)
        );
      });
      if (pets.length === 0) continue;
      const heading = root.createElement("div");
      heading.className = "pet-option-group-label";
      heading.textContent = group.label;
      customPetOptions.appendChild(heading);
      for (const record of pets) {
        const btn = root.createElement("button");
        btn.type = "button";
        btn.className = "pet-option";
        btn.setAttribute("role", "radio");
        btn.dataset.petId = record.entry.id;
        btn.dataset.petKey = record.entry.petKey;
        const preview = root.createElement("span");
        preview.className = `pet-option-preview preview-custom preview-${record.entry.format}`;
        preview.setAttribute("aria-hidden", "true");
        preview.textContent = record.entry.format === "codex" ? "◈" : "◉";
        const sheetUrl = petSheetUrl(record.entry.petKey);
        if (sheetUrl && record.manifest.sheet) {
          preview.style.backgroundImage = `url("${sheetUrl}")`;
          preview.style.backgroundSize = `${record.manifest.sheet.columns * 100}% ${record.manifest.sheet.rows * 100}%`;
        }
        const label = root.createElement("span");
        label.className = "pet-option-copy";
        const name = root.createElement("span");
        name.textContent = record.entry.name;
        const badge = root.createElement("span");
        badge.className = "pet-option-badge";
        badge.textContent = record.entry.format === "codex" ? "Codex" : "Snail";
        label.append(name, badge);
        btn.append(preview, label);
        customPetOptions.appendChild(btn);
        rendered += 1;
      }
    }
    customPetOptions.hidden = rendered === 0;
  }

  function requestSelectedPetAsset(petKey: string): void {
    if (!bridge?.getPetAsset) return;
    if (loadedAssetKey === petKey && loadedBlobUrl) return;
    if (spriteFailed.has(petKey)) return;
    const seq = ++assetLoadSeq;
    void bridge.getPetAsset(petKey).then((payload) => {
      if (seq !== assetLoadSeq) return;
      const gate = validateRendererPetAsset(payload);
      if (!gate.ok) {
        spriteFailed.add(petKey);
        if (current) update(current);
        return;
      }
      if (gate.asset.petKey !== petKey) return;
      const bytes = new Uint8Array(gate.asset.bytes.byteLength);
      bytes.set(gate.asset.bytes);
      const blob = new Blob([bytes], { type: gate.asset.mime });
      const url = URL.createObjectURL(blob);
      rememberOwnedBlobUrl(url);
      if (loadedBlobUrl && loadedBlobUrl !== url) revokeOwnedSheetUrl(loadedBlobUrl);
      loadedBlobUrl = url;
      loadedAssetKey = petKey;
      setCustomPetSheetUrl(petKey, url);
      spriteFailed.delete(petKey);
      spriteVerified.delete(petKey);
      renderCustomPetOptions();
      if (current) update(current);
    }).catch(() => {
      if (seq !== assetLoadSeq) return;
      spriteFailed.add(petKey);
      if (current) update(current);
    });
  }

  /**
   * Main pushes catalog metadata on rescan; every entry is re-gated before
   * it can influence ids, class names or images. Bitmaps load separately.
   */
  function syncCustomPetsPayload(payload: unknown): void {
    clearCustomPetRegistrations();
    if (!payload || typeof payload !== "object") {
      renderCustomPetOptions();
      renderCatalogDiagnostics([]);
      return;
    }
    const pets = (payload as { pets?: unknown }).pets;
    if (Array.isArray(pets)) {
      for (const candidate of pets) registerCatalogEntry(candidate);
    }
    const snailRoot = (payload as { snailRoot?: unknown }).snailRoot ?? (payload as { root?: unknown }).root;
    if (customPetsPath && typeof snailRoot === "string" && snailRoot.length <= 512) {
      customPetsPath.textContent = snailRoot;
    }
    const codexRoot = (payload as { codexRoot?: unknown }).codexRoot;
    if (codexPetsPath && typeof codexRoot === "string" && codexRoot.length <= 512) {
      codexPetsPath.textContent = codexRoot;
      codexPetsPath.hidden = false;
    }
    renderCatalogDiagnostics((payload as { diagnostics?: unknown }).diagnostics);
    renderCustomPetOptions();
    if (current) update(current);
  }

  function update(view: DesktopActivityView): void {
    const previousView = current;
    current = view;
    const previewSettingsOpen = (view as unknown as { settingsOpen?: unknown }).settingsOpen;
    if (!bridge && typeof previewSettingsOpen === "boolean") {
      settingsOpen = previewSettingsOpen;
    }
    const state = isPetVisualState(view.presentation) ? view.presentation : "idle";
    const primary = selectPrimaryActivity(view.projects);
    const updateNow = Date.now();
    sleepPresentation = state;
    // Preempt any pending/active fun reaction the moment the pet leaves idle
    // (attention, terminal, running, connection) or motion is reduced.
    if (!shouldAllowPetReaction(state, view.reducedMotion || reducedMotion)) {
      cancelClickSequence();
    }
    syncIdleSleep(updateNow);
    runningCueState = reduceRunningCueState(
      runningCueState,
      { presentation: state, cue: resolveRunningCue(primary) },
      updateNow,
    );
    scheduleRunningCueUpdate(updateNow);
    const runningCue = runningCueState.active ? runningCueState.cue : "generic";
    const cueVisual = resolveRunningCueVisual(runningCue);
    const selectedPetKey = resolvePetKey({
      selectedPetKey: view.selectedPetKey,
      selectedPetId: view.selectedPetId,
    });
    const profile = getPetRuntimeProfile(selectedPetKey);
    const manifest = getPetManifest(selectedPetKey);
    const motionReduced = view.reducedMotion || reducedMotion;
    if (!canApplyLookOverlay(state) || motionReduced || documentHidden) {
      lookDirection = null;
    }
    if (state === "needs_input" || state === "blocked" || state === "ready" || state === "disconnected" || state === "service_not_running") {
      dragClip = null;
    }
    if (motionReduced || documentHidden || !canApplyJumpOverlay(state)) {
      if (jumpActive) clearJump();
    }
    const frame = resolvePetFrame(manifest, state, motionReduced);
    const displayGlyph = state === "running" ? cueVisual.glyph : frame.glyph || petStateGlyph(state);
    const displayLabel = state === "running" ? cueVisual.label : frame.label || petStateLabel(state);
    const activeClip = resolveActivePetClip({
      profile,
      state,
      reducedMotion: motionReduced,
      lookDirection,
      dragClip,
      jumpActive,
      runningCue,
    });
    const builtinSheetUrl = petSheetDataUrl(manifest.id);
    if (profile.renderMode === "spritesheet" && !builtinSheetUrl && !petSheetUrl(profile.petKey)) {
      requestSelectedPetAsset(profile.petKey);
    }
    const spriteImageUrl = petSheetUrl(profile.petKey) ?? builtinSheetUrl ?? petSheetDataUrl(profile.cssToken);
    const spriteFailedKey = profile.petKey;
    const profileStyle =
      profile.renderMode === "spritesheet" && profile.sheet && activeClip.clip && spriteImageUrl
        ? resolveClipSheetStyle(profile.sheet, activeClip.clip, profile.cssToken)
        : null;
    const snailStyle = resolveSpriteSheetStyle(manifest, state, spriteImageUrl);
    const spriteStyle = profile.format === "codex" ? profileStyle : snailStyle ?? profileStyle;
    const spriteActive =
      spriteStyle != null &&
      !spriteFailed.has(spriteFailedKey) &&
      !spriteFailed.has(manifest.id);
    // Verify whenever a bitmap URL exists. Do not gate verify on spriteActive —
    // custom/Codex sheets become ready only after this decode check runs.
    if (spriteImageUrl && !spriteFailed.has(spriteFailedKey) && !spriteFailed.has(manifest.id)) {
      const sheetSource = resolveSpriteStylesheetSource({
        format: profile.format,
        spriteImageUrl,
        builtinDataUrl: builtinSheetUrl,
      });
      if (sheetSource.kind === "profile") {
        ensureProfileStylesheet(
          profile.cssToken,
          buildSpriteSheetStyleTextFromProfile(profile, sheetSource.imageUrl),
        );
      } else if (sheetSource.kind === "manifest") {
        ensureSpriteStylesheet(manifest);
      }
      const expected = profile.sheet ? expectedSheetPixelSize(profile.sheet) : undefined;
      verifySpriteImage(spriteFailedKey, spriteImageUrl, expected);
    }

    if (petAvatar) {
      const transitionAction = resolvePetTransitionAction(
        previousView?.presentation ?? null,
        state,
        motionReduced,
      );
      if (transitionAction) {
        startTransition(TRANSITION_CLASS[transitionAction]);
      } else if (motionReduced) {
        clearTransition();
      }
      const spriteClass = spriteActive ? ` pet-sprite pet-sprite-${profile.cssToken}` : "";
      const sleepClass = idleSleepState.stage !== "awake" ? ` pet-${idleSleepState.stage}` : "";
      const animated =
        spriteActive ? !motionReduced && !activeClip.staticOnly : frame.animated;
      petAvatar.className = `pet-avatar${spriteClass} frame-${frame.frame}${animated ? " is-animated" : ""}${transitionClass ? ` ${transitionClass}` : ""}${sleepClass}${reactionClass ? ` ${reactionClass}` : ""}`;
      petAvatar.setAttribute("data-state", state);
      petAvatar.setAttribute("data-clip", activeClip.clipName);
      if (state === "running") {
        petAvatar.setAttribute("data-running-cue", runningCue);
      } else {
        petAvatar.removeAttribute("data-running-cue");
      }
      // Re-arm idle life only when the visual frame actually changes, so frequent
      // view updates never starve the blink/act timers.
      const lifeKey = `${frame.frame}:${animated ? "1" : "0"}:${activeClip.clipName}`;
      if (lifeKey !== idleLifeKey) {
        idleLifeKey = lifeKey;
        scheduleIdleBlink(petAvatar);
        scheduleIdleActs(petAvatar);
      }
    }
    if (petRoot) petRoot.setAttribute("data-pet", profile.cssToken);
    if (petGlyph) petGlyph.textContent = displayGlyph;
    if (petLabel) petLabel.textContent = displayLabel;

    const activityDrivesState = primary?.presentation === state;
    const signal: PetBubbleSignal = {
      presentation: state,
      transitionId: activityDrivesState ? primary.lastTransitionId : null,
      revision: view.revision,
      instanceId: view.instanceId,
      unread: activityDrivesState ? primary.unread : false,
      dndEnabled: view.dndEnabled === true,
      reset:
        view.reset ||
        (bridge != null && previousView == null) ||
        (previousView?.instanceId != null && previousView.instanceId !== view.instanceId),
    };
    const bubbleNow = updateNow;
    bubbleState = reducePetBubbleState(bubbleState, {
      type: "snapshot",
      signal,
      now: bubbleNow,
    });
    const celebrateDecision = shouldCelebrateCompletion(
      celebrateState,
      {
        presentation: state,
        transitionId: signal.transitionId,
        reducedMotion: motionReduced,
        reset: signal.reset,
      },
      bubbleNow,
    );
    celebrateState = celebrateDecision.state;
    if (celebrateDecision.celebrate) {
      launchConfetti();
    }
    const connectionDetail = connectionBannerText({
      connectionStatus: view.connectionStatus,
      canCopyStartCommand: view.canCopyStartCommand,
      startCommand: view.startCommand,
      reasonCode: view.connectionReasonCode,
    });
    const captionTitle = primary?.title ?? "蜗牛派";
    const captionDetail = primary
      ? formatPetActivityDetail(primary, state, runningCue)
      : connectionDetail ?? displayLabel;
    if (petCaption) {
      petCaption.hidden = !bubbleState.visible;
      petCaption.dataset.bubbleMode = bubbleState.mode ?? "hidden";
      petCaption.setAttribute("aria-label", `${captionTitle}，${captionDetail}`);
    }
    if (petCaptionTitle) petCaptionTitle.textContent = captionTitle;
    if (petCaptionState) petCaptionState.textContent = captionDetail;
    scheduleBubbleExpiry(bubbleNow);

    if (petBadge) {
      const count = countUnreadActivities(view.projects);
      if (count > 0) {
        petBadge.hidden = false;
        petBadge.textContent = String(count > 99 ? "99+" : count);
      } else {
        petBadge.hidden = true;
      }
    }

    const contextMeter = resolvePrimaryContextMeter({
      activity: primary,
      stale: view.stale,
      enabled: view.showContextMeter,
    });
    if (petContextMeter) {
      if (contextMeter) {
        petContextMeter.hidden = false;
        petContextMeter.dataset.level = contextMeter.level;
        petContextMeter.style.setProperty("--context-percent", String(contextMeter.percent));
        petContextMeter.title = contextMeter.title;
        petContextMeter.setAttribute("aria-label", contextMeter.ariaLabel);
        petContextMeter.setAttribute("role", "img");
      } else {
        petContextMeter.hidden = true;
        petContextMeter.removeAttribute("data-level");
        petContextMeter.style.removeProperty("--context-percent");
        petContextMeter.removeAttribute("title");
        petContextMeter.removeAttribute("aria-label");
        petContextMeter.removeAttribute("role");
      }
    }
    if (petContextMeterLabel) {
      petContextMeterLabel.textContent = contextMeter?.label ?? "";
    }

    if (tray) tray.hidden = !view.trayOpen;
    if (view.trayOpen && pendingTrayPanel === "settings") {
      settingsOpen = true;
      pendingTrayPanel = null;
    } else if (view.trayOpen && pendingTrayPanel === "quick-session") {
      pendingTrayPanel = null;
    } else if (!view.trayOpen && pendingTrayPanel == null) {
      settingsOpen = false;
      if (quickSession.phase !== "closed") {
        quickSession = reduceQuickSessionState(quickSession, { type: "close" });
      }
      setTrayMoreOpen(false);
    }
    const previewQuick = (view as unknown as { quickSessionPreview?: unknown }).quickSessionPreview;
    if (!bridge && previewQuick && typeof previewQuick === "object") {
      quickSession = {
        ...createInitialQuickSessionState(),
        ...(previewQuick as Partial<QuickSessionState>),
        phase:
          typeof (previewQuick as { phase?: unknown }).phase === "string"
            ? (previewQuick as QuickSessionState).phase
            : "editing",
      };
    }
    const composerOpen = quickSession.phase !== "closed";
    if (settingsPanel) settingsPanel.hidden = !settingsOpen;
    if (quickSessionPanel) quickSessionPanel.hidden = !composerOpen || settingsOpen;
    if (activityFilters) activityFilters.hidden = settingsOpen || composerOpen;
    if (projectList) projectList.hidden = settingsOpen || composerOpen;
    if (trayTitle) {
      trayTitle.textContent = settingsOpen ? "设置" : composerOpen ? "快速会话" : "活动";
    }
    if (btnSettings) {
      btnSettings.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
    }
    if (btnQuickSession) {
      const available = view.quickSessionAvailable === true && view.connectionStatus === "connected";
      btnQuickSession.hidden = !available && !composerOpen;
      btnQuickSession.disabled = !available && !composerOpen;
      btnQuickSession.setAttribute("aria-expanded", composerOpen ? "true" : "false");
    }
    if (btnPetQuickSession) {
      const available = view.quickSessionAvailable === true && view.connectionStatus === "connected";
      btnPetQuickSession.hidden = !available && !composerOpen;
      btnPetQuickSession.disabled = !available && !composerOpen;
      btnPetQuickSession.setAttribute("aria-expanded", composerOpen ? "true" : "false");
    }
    if (btnPetSettings) {
      btnPetSettings.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
    }
    if (btnPetActivity) {
      const activityExpanded =
        view.trayOpen && !settingsOpen && quickSession.phase === "closed";
      btnPetActivity.setAttribute("aria-expanded", activityExpanded ? "true" : "false");
    }
    renderQuickSessionPanel(view);
    if (petRoot) {
      petRoot.classList.toggle("is-collapsed", !view.trayOpen);
      petRoot.classList.toggle("is-expanded", view.trayOpen);
      const anchor =
        view.trayAnchor === "top-right" ||
        view.trayAnchor === "bottom-left" ||
        view.trayAnchor === "bottom-right"
          ? view.trayAnchor
          : "top-left";
      petRoot.setAttribute("data-tray-anchor", view.trayOpen ? anchor : "top-left");
      const scale =
        view.petScale === "small" || view.petScale === "large" ? view.petScale : "medium";
      const spec = resolvePetLayoutSpec(scale);
      petRoot.setAttribute("data-pet-scale", scale);
      const bubbleTheme = isDesktopPetBubbleTheme(view.bubbleTheme)
        ? view.bubbleTheme
        : "cream";
      petRoot.setAttribute("data-bubble-theme", bubbleTheme);
      const intentMenuPresentation = resolvePetIntentMenuPresentation(
        view.rightClickAggregatedMenu === true,
      );
      petRoot.setAttribute("data-intent-trigger", intentMenuPresentation.trigger);
      if (btnHide) btnHide.hidden = !intentMenuPresentation.showChromeClose;
      if (btnPetHide) btnPetHide.hidden = !intentMenuPresentation.showMenuHideAction;
      if (intentMenuPresentation.hoverRevealsMenu) {
        intentMenuOpen = false;
        if (intentMenu) {
          intentMenu.hidden = false;
          intentMenu.classList.remove("is-open");
        }
        petRoot.classList.remove("is-intent-menu-open");
      } else {
        setIntentMenuOpen(intentMenuOpen);
      }
      if (interactionHint) {
        interactionHint.textContent = intentMenuPresentation.trigger === "right-click"
          ? "右键角色打开快捷菜单，隐藏到托盘已放入菜单。P 互动，Shift+P 摆动。拖动可移动。"
          : "悬停角色打开快捷菜单。P 互动，Shift+P 摆动。拖动可移动。";
      }
      petRoot.style.setProperty("--pet-scale", String(spec.factor));
      petRoot.style.setProperty("--pet-root-pad", `${spec.rootPad}px`);
      petRoot.style.setProperty("--pet-stack-gap", `${Math.max(1, spec.stackHeight - spec.chromeHeight - spec.surfaceSize - spec.bubbleReserve)}px`);
      petRoot.style.setProperty("--pet-stack-width", `${spec.stackWidth}px`);
      petRoot.style.setProperty("--pet-chrome-height", `${spec.chromeHeight}px`);
      petRoot.style.setProperty("--pet-surface-size", `${spec.surfaceSize}px`);
      petRoot.style.setProperty("--pet-bubble-reserve", `${spec.bubbleReserve}px`);
      petRoot.style.setProperty("--pet-intent-gutter", `${spec.intentGutter}px`);
      petRoot.style.setProperty("--pet-status-gutter", `${spec.statusGutter}px`);
    }
    if (petButton) {
      petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
      const attentionJump = canJumpToPrimary(view);
      const bodyAction = resolvePetBodyClick({
        trayOpen: view.trayOpen,
        presentation: state,
        reducedMotion: motionReduced,
        canJumpPrimary: attentionJump,
      });
      const gestureHint =
        view.rightClickAggregatedMenu === true
          ? "右键打开快捷菜单 · P 互动 · Shift+P 摆动"
          : "悬停打开快捷菜单 · P 互动 · Shift+P 摆动";
      const bodyHint =
        bodyAction === "close-tray"
          ? "点击收起活动列表"
          : bodyAction === "jump-primary"
            ? "点击直达待处理任务"
            : bodyAction === "interact"
              ? "点击互动"
              : "点击展开活动列表";
      petButton.setAttribute(
        "aria-label",
        `桌宠，${bodyHint}，拖动可移动。${gestureHint}`,
      );
      // Native title tooltips clip over the sprite in the frameless window.
      petButton.removeAttribute("title");
    }

    if (trayCounts) {
      const hideCounts = settingsOpen || composerOpen;
      trayCounts.hidden = hideCounts;
      if (!hideCounts) {
        const active = view.activeCount;
        const attention = view.attentionCount;
        trayCounts.textContent = `活动 ${active} · 关注 ${attention}`;
      }
    }

    const filterCounts = countActivitiesByFilter(view.projects);
    activityFilters?.querySelectorAll<HTMLElement>("[data-activity-filter]").forEach((button) => {
      const filter = button.dataset.activityFilter as DesktopActivityFilter | undefined;
      if (!filter || !(filter in filterCounts)) return;
      const selected = filter === activityFilter;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      const count = button.querySelector<HTMLElement>("[data-filter-count]");
      if (count) count.textContent = String(filterCounts[filter]);
    });

    const bannerText = connectionBannerText({
      connectionStatus: view.connectionStatus,
      canCopyStartCommand: view.canCopyStartCommand,
      startCommand: view.startCommand,
      reasonCode: view.connectionReasonCode,
    });
    if (banner) {
      if (bannerText) {
        banner.hidden = false;
        banner.textContent = bannerText;
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }

    if (authPanel) {
      const showAuth = view.needsAccessKey === true || view.hasAccessKey === true;
      authPanel.hidden = !showAuth;
    }
    if (btnClearKey) {
      btnClearKey.hidden = view.hasAccessKey !== true;
    }

    if (btnCopy) {
      btnCopy.hidden = !view.canCopyStartCommand;
    }
    if (staleFlag) {
      staleFlag.hidden = !view.stale;
    }

    if (prefAlwaysOnTop) prefAlwaysOnTop.checked = view.alwaysOnTop;
    if (prefClickThrough) prefClickThrough.checked = view.clickThrough;
    if (prefLaunchAtLogin) prefLaunchAtLogin.checked = view.launchAtLogin;
    if (prefCompletion) prefCompletion.value = view.notification.completion;
    if (prefNeedsInput) prefNeedsInput.checked = view.notification.needsInput;
    if (prefBlocked) prefBlocked.checked = view.notification.blocked;
    if (prefShowContextMeter) prefShowContextMeter.checked = view.showContextMeter;
    if (prefRightClickMenu) prefRightClickMenu.checked = view.rightClickAggregatedMenu === true;
    if (prefDnd) prefDnd.checked = view.dndEnabled === true;
    if (prefSoundMaster) prefSoundMaster.checked = view.sound.masterEnabled === true;
    if (prefSoundNeedsInput) prefSoundNeedsInput.checked = view.sound.needsInput !== false;
    if (prefSoundCompletion) prefSoundCompletion.checked = view.sound.completion !== false;
    // DND never mutates sound preferences — it only silences playback, so the
    // panel keeps the toggles editable and shows why nothing beeps.
    if (soundDndNote) {
      soundDndNote.hidden = !(view.dndEnabled === true && view.sound.masterEnabled === true);
    }
    const selectedKey = resolvePetKey({
      selectedPetKey: view.selectedPetKey,
      selectedPetId: view.selectedPetId,
    });
    petPicker?.querySelectorAll<HTMLElement>("[data-pet-id], [data-pet-key]").forEach((option) => {
      const optionKey =
        option.dataset.petKey ||
        (option.dataset.petId ? resolvePetKey({ selectedPetId: option.dataset.petId }) : "");
      const selected = optionKey === selectedKey;
      option.setAttribute("aria-checked", selected ? "true" : "false");
    });
    petScalePicker?.querySelectorAll<HTMLElement>("[data-pet-scale]").forEach((option) => {
      const selected = option.dataset.petScale === view.petScale;
      option.setAttribute("aria-checked", selected ? "true" : "false");
    });
    bubbleThemePicker?.querySelectorAll<HTMLElement>("[data-bubble-theme]").forEach((option) => {
      const selected = option.dataset.bubbleTheme === (view.bubbleTheme ?? "cream");
      option.setAttribute("aria-checked", selected ? "true" : "false");
    });

    if (projectList) {
      const filteredProjects = filterProjectGroups(view.projects, activityFilter);
      const visibleIds = activityIds(filteredProjects);
      selectedVisibleActivityId = resolveActivitySelection(
        visibleIds,
        selectedVisibleActivityId ?? view.selectedActivityId,
      );
      const liveIds = new Set(activityIds(view.projects));
      for (const activityId of expandedActivityIds) {
        if (!liveIds.has(activityId)) expandedActivityIds.delete(activityId);
      }

      projectList.replaceChildren();
      if (filteredProjects.length === 0) {
        const empty = root.createElement("div");
        empty.className = "empty-tray";
        const emptyTitle = root.createElement("div");
        emptyTitle.className = "empty-tray-title";
        emptyTitle.textContent =
          view.projects.length > 0
            ? "此筛选下暂无活动"
            : view.connectionStatus === "connected"
              ? "目前没有任务活动"
              : "尚未连接";
        const emptyHint = root.createElement("div");
        emptyHint.className = "empty-tray-hint";
        emptyHint.textContent =
          view.projects.length > 0
            ? "换个筛选看看其他状态的任务"
            : view.connectionStatus === "connected"
              ? "任务开始运行后会出现在这里"
              : "连接本地蜗牛派服务后即可观察任务";
        empty.append(emptyTitle, emptyHint);
        projectList.appendChild(empty);
      } else {
        for (const project of filteredProjects) {
          const group = root.createElement("div");
          group.className = "project-group";
          group.setAttribute("role", "group");
          const name = root.createElement("div");
          name.className = "project-name";
          name.textContent = project.displayName;
          group.appendChild(name);
          for (const activity of project.activities) {
            group.appendChild(renderRow(activity, selectedVisibleActivityId));
          }
          projectList.appendChild(group);
        }
      }
    }
    syncElapsedTimer();
  }

  function childStatusText(child: DesktopActivityRow["children"][number]): string {
    if (child.attention === "needs_input") return "待输入";
    if (child.attention === "blocked") return "受阻";
    if (child.executionState === "retrying") return "重试中";
    if (child.executionState === "queued") return "排队中";
    if (child.executionState === "running") return "运行中";
    if (child.outcome === "succeeded") return "已完成";
    if (child.outcome === "cancelled") return "已取消";
    if (
      child.outcome === "failed" ||
      child.outcome === "interrupted" ||
      child.outcome === "ambiguous"
    ) {
      return "失败";
    }
    return "已结束";
  }

  function applyQuickSession(
    event: Parameters<typeof reduceQuickSessionState>[1],
    options?: { render?: boolean },
  ): void {
    const previous = quickSession;
    quickSession = reduceQuickSessionState(quickSession, event);
    if (quickSession !== previous && current && options?.render !== false) update(current);
  }

  function parseQuickSessionCatalog(payload: unknown): QuickSessionCatalog | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const source = record.catalog && typeof record.catalog === "object"
      ? record.catalog as Record<string, unknown>
      : record;
    if (!Array.isArray(source.projects)) return null;
    const projects = source.projects.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.projectRef !== "string" || typeof row.displayName !== "string") return [];
      return [{
        projectRef: row.projectRef,
        displayName: row.displayName,
        ...(typeof row.disambiguator === "string" ? { disambiguator: row.disambiguator } : {}),
        latestModified: typeof row.latestModified === "string" ? row.latestModified : "",
        archived: row.archived === true,
        worktree: row.worktree === true,
      }];
    });
    return {
      projects,
      truncated: source.truncated === true,
      omitted: typeof source.omitted === "number" ? source.omitted : 0,
    };
  }

  function parseQuickSessionModelCatalog(payload: unknown): QuickSessionModelCatalog | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    const source = record.catalog && typeof record.catalog === "object"
      ? record.catalog as Record<string, unknown>
      : record;
    if (typeof source.projectRef !== "string" || !Array.isArray(source.models)) return null;
    const models = source.models.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.provider !== "string" || typeof row.modelId !== "string" || typeof row.name !== "string") {
        return [];
      }
      return [{
        provider: row.provider,
        modelId: row.modelId,
        name: row.name,
        primaryCandidate: row.primaryCandidate === true,
      }];
    });
    const rawDefault = source.defaultModel && typeof source.defaultModel === "object"
      ? source.defaultModel as Record<string, unknown>
      : null;
    return {
      projectRef: source.projectRef,
      defaultModel:
        rawDefault
        && typeof rawDefault.provider === "string"
        && typeof rawDefault.modelId === "string"
          ? { provider: rawDefault.provider, modelId: rawDefault.modelId }
          : null,
      models,
      truncated: source.truncated === true,
    };
  }

  function shouldLoadQuickSessionModels(
    state: QuickSessionState,
    options?: { retryError?: boolean },
  ): boolean {
    return Boolean(
      state.selectedProjectRef
      && state.phase !== "closed"
      && (
        state.modelsPhase === "idle"
        || (options?.retryError === true && state.modelsPhase === "error")
        || state.modelsProjectRef !== state.selectedProjectRef
      ),
    );
  }

  async function loadQuickSessionCatalog(): Promise<void> {
    applyQuickSession({ type: "open" });
    if (!bridge?.listQuickSessionProjects) {
      applyQuickSession({ type: "catalog_failed", code: "feature_unavailable" });
      return;
    }
    try {
      const payload = await bridge.listQuickSessionProjects();
      if (payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === false) {
        const code = (payload as { code?: unknown }).code;
        applyQuickSession({
          type: "catalog_failed",
          code: typeof code === "string" ? code as QuickSessionErrorCode : "result_unknown",
        });
        return;
      }
      const catalog = parseQuickSessionCatalog(payload);
      if (!catalog) {
        applyQuickSession({ type: "catalog_failed", code: "result_unknown" });
        return;
      }
      applyQuickSession({ type: "catalog_loaded", catalog });
      qsMessage?.focus();
    } catch {
      applyQuickSession({ type: "catalog_failed", code: "result_unknown" });
    }
  }

  async function loadQuickSessionModels(options?: { retryError?: boolean }): Promise<void> {
    const projectRef = quickSession.selectedProjectRef;
    if (!projectRef || !shouldLoadQuickSessionModels(quickSession, options)) return;
    if (qsModelsInFlight === projectRef) return;
    if (!bridge?.listQuickSessionModels) {
      applyQuickSession({ type: "models_failed", projectRef, code: "feature_unavailable" });
      return;
    }
    qsModelsInFlight = projectRef;
    applyQuickSession({ type: "models_loading", projectRef });
    try {
      const payload = await bridge.listQuickSessionModels(projectRef);
      if (quickSession.selectedProjectRef !== projectRef) return;
      if (payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === false) {
        const code = (payload as { code?: unknown }).code;
        applyQuickSession({
          type: "models_failed",
          projectRef,
          code: typeof code === "string" ? code as QuickSessionErrorCode : "result_unknown",
        });
        return;
      }
      const catalog = parseQuickSessionModelCatalog(payload);
      if (!catalog) {
        applyQuickSession({ type: "models_failed", projectRef, code: "result_unknown" });
        return;
      }
      applyQuickSession({ type: "models_loaded", catalog });
    } catch {
      if (quickSession.selectedProjectRef === projectRef) {
        applyQuickSession({ type: "models_failed", projectRef, code: "result_unknown" });
      }
    } finally {
      if (qsModelsInFlight === projectRef) qsModelsInFlight = null;
    }
  }

  async function submitQuickSession(): Promise<void> {
    if (qsSubmitInFlight) return;
    if (quickSession.phase !== "submitting") {
      applyQuickSession({ type: "submit" }, { render: true });
    }
    if (quickSession.phase !== "submitting" || !quickSession.requestId || !quickSession.selectedProjectRef) {
      return;
    }
    qsSubmitInFlight = true;
    try {
      if (!bridge?.createQuickSession) {
        applyQuickSession({ type: "submit_error", code: "feature_unavailable" });
        return;
      }
      const payload = await bridge.createQuickSession({
        projectRef: quickSession.selectedProjectRef,
        message: quickSession.draft,
        requestId: quickSession.requestId,
        ...(quickSession.selectedProvider && quickSession.selectedModelId
          ? {
              provider: quickSession.selectedProvider,
              modelId: quickSession.selectedModelId,
            }
          : {}),
      });
      if (payload && typeof payload === "object" && (payload as { ok?: unknown }).ok === false) {
        const code = (payload as { code?: unknown }).code;
        applyQuickSession({
          type: "submit_error",
          code: typeof code === "string" ? code as QuickSessionErrorCode : "result_unknown",
        });
        return;
      }
      const result = payload && typeof payload === "object"
        ? ((payload as { result?: unknown }).result ?? payload) as Record<string, unknown>
        : null;
      if (!result || typeof result.sessionId !== "string" || typeof result.deepLink !== "string") {
        applyQuickSession({ type: "submit_error", code: "result_unknown" });
        return;
      }
      applyQuickSession({
        type: "submit_success",
        sessionId: result.sessionId,
        deepLink: result.deepLink,
      });
    } catch {
      applyQuickSession({ type: "submit_error", code: "result_unknown" });
    } finally {
      qsSubmitInFlight = false;
    }
  }

  function renderQuickSessionPicker(): void {
    const picker = quickSession.openPicker;
    const submitting = quickSession.phase === "submitting";
    const success = quickSession.phase === "success";
    const pickerOpen = picker !== "none" && !success;
    if (qsPicker) {
      qsPicker.hidden = !pickerOpen;
      qsPicker.dataset.align = pickerOpen ? picker : "";
    }
    if (qsProjectTrigger) {
      qsProjectTrigger.disabled = submitting || success;
      qsProjectTrigger.setAttribute("aria-expanded", picker === "project" ? "true" : "false");
    }
    if (qsModelTrigger) {
      qsModelTrigger.disabled = submitting || success || !quickSession.selectedProjectRef;
      qsModelTrigger.setAttribute("aria-expanded", picker === "model" ? "true" : "false");
    }
    if (!qsPickerList || !pickerOpen) return;

    const query = picker === "model" ? quickSession.modelQuery : quickSession.query;
    if (qsPickerSearch && qsPickerSearch.value !== query) qsPickerSearch.value = query;
    if (qsPickerSearch) {
      qsPickerSearch.disabled = submitting;
      qsPickerSearch.placeholder = picker === "model" ? "搜索模型" : "搜索项目";
    }

    const signature = picker === "model"
      ? `model:${query}:${quickSession.models.length}:${quickSession.modelsPhase}`
      : `project:${query}:${quickSession.projects.length}:${quickSession.phase}`;
    const selectedKey = picker === "model"
      ? `${quickSession.selectedProvider ?? ""}\0${quickSession.selectedModelId ?? ""}`
      : quickSession.selectedProjectRef ?? "";
    if (qsPickerList.dataset.signature === signature) {
      for (const option of qsPickerList.querySelectorAll<HTMLElement>("[role='option']")) {
        const key = picker === "model"
          ? `${option.dataset.provider ?? ""}\0${option.dataset.modelId ?? ""}`
          : option.dataset.projectRef ?? "";
        option.setAttribute("aria-selected", key === selectedKey ? "true" : "false");
      }
    } else {
      qsPickerList.replaceChildren();
      if (picker === "model") {
        const visible = filterQuickSessionModels(quickSession.models, query);
        if (quickSession.modelsPhase === "loading" || visible.length === 0) {
          const empty = document.createElement("div");
          empty.className = "qs-picker-empty";
          empty.textContent =
            quickSession.modelsPhase === "loading"
              ? "正在加载模型…"
              : quickSession.modelsPhase === "error"
                ? "模型列表加载失败"
                : quickSession.models.length === 0
                  ? "当前没有可用模型"
                  : "没有匹配的模型";
          qsPickerList.appendChild(empty);
        } else {
          for (const model of visible) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "qs-picker-option";
            option.dataset.provider = model.provider;
            option.dataset.modelId = model.modelId;
            option.setAttribute("role", "option");
            option.setAttribute(
              "aria-selected",
              model.provider === quickSession.selectedProvider && model.modelId === quickSession.selectedModelId
                ? "true"
                : "false",
            );
            option.disabled = submitting;
            const name = document.createElement("span");
            name.textContent = model.name;
            option.appendChild(name);
            const meta = document.createElement("span");
            meta.className = "qs-picker-meta";
            meta.textContent = model.primaryCandidate ? `${model.provider} · 收藏` : model.provider;
            option.appendChild(meta);
            qsPickerList.appendChild(option);
          }
        }
      } else {
        const visible = filterQuickSessionProjects(quickSession.projects, query);
        if (visible.length === 0) {
          const empty = document.createElement("div");
          empty.className = "qs-picker-empty";
          empty.textContent =
            quickSession.phase === "loading"
              ? "正在加载项目…"
              : quickSession.projects.length === 0
                ? "当前没有可启动的项目"
                : "没有匹配的项目";
          qsPickerList.appendChild(empty);
        } else {
          for (const project of visible) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "qs-picker-option";
            option.dataset.projectRef = project.projectRef;
            option.setAttribute("role", "option");
            option.setAttribute(
              "aria-selected",
              project.projectRef === quickSession.selectedProjectRef ? "true" : "false",
            );
            option.disabled = submitting;
            const name = document.createElement("span");
            name.textContent = project.displayName;
            option.appendChild(name);
            if (project.disambiguator) {
              const meta = document.createElement("span");
              meta.className = "qs-picker-meta";
              meta.textContent = project.disambiguator;
              option.appendChild(meta);
            }
            qsPickerList.appendChild(option);
          }
        }
      }
      qsPickerList.dataset.signature = signature;
    }
    if (qsPickerNote) {
      if (picker === "model") {
        qsPickerNote.hidden = !quickSession.modelsTruncated;
        qsPickerNote.textContent = "仅显示收藏/默认短名单";
      } else {
        qsPickerNote.hidden = !quickSession.truncated;
        qsPickerNote.textContent = "仅显示最近 100 个项目";
      }
    }
  }

  function renderQuickSessionPanel(view: DesktopActivityView): void {
    if (!quickSessionPanel || quickSession.phase === "closed" || settingsOpen) return;
    const submitting = quickSession.phase === "submitting";
    const success = quickSession.phase === "success";
    if (qsStatus) {
      qsStatus.hidden = quickSession.phase !== "loading" && !(quickSession.phase === "editing" && quickSession.projects.length === 0);
      qsStatus.textContent =
        quickSession.phase === "loading"
          ? "正在加载项目…"
          : view.connectionStatus !== "connected"
            ? "服务未连接"
            : "当前没有可启动的项目";
    }
    const selectedProject = selectedQuickSessionProject(quickSession);
    if (qsSelected) {
      qsSelected.textContent = formatQuickSessionProjectLabel(selectedProject);
      qsSelected.classList.toggle("is-empty", selectedProject == null);
    }
    const selectedModel = selectedQuickSessionModel(quickSession);
    if (qsModelSelected) {
      qsModelSelected.textContent =
        quickSession.modelsPhase === "loading"
          ? "加载模型…"
          : formatQuickSessionModelLabel(selectedModel);
      qsModelSelected.classList.toggle(
        "is-empty",
        selectedModel == null && quickSession.modelsPhase !== "loading",
      );
    }
    renderQuickSessionPicker();
    if (qsMessage && qsMessage.value !== quickSession.draft) qsMessage.value = quickSession.draft;
    if (qsMessage) qsMessage.disabled = submitting || success;
    const used = countQuickSessionChars(quickSession.draft);
    if (qsCount) {
      qsCount.textContent = `${used} / ${QUICK_SESSION_MAX_MESSAGE_CHARS}`;
      qsCount.classList.toggle("is-over", used > QUICK_SESSION_MAX_MESSAGE_CHARS);
    }
    if (qsError) {
      const showError = quickSession.phase === "error" && quickSession.errorCode != null;
      qsError.hidden = !showError;
      qsError.textContent = showError ? quickSessionErrorText(quickSession.errorCode) : "";
    }
    if (qsSuccess) qsSuccess.hidden = !success;
    if (qsSuccessText && success && quickSession.success) {
      const project = selectedQuickSessionProject(quickSession);
      const model = selectedQuickSessionModel(quickSession);
      const shortId = quickSession.success.sessionId.slice(0, 8);
      qsSuccessText.textContent = model
        ? `${project?.displayName ?? "项目"} · ${model.name} 已启动 · ${shortId}`
        : `${project?.displayName ?? "项目"} 已启动 · ${shortId}`;
    }
    if (qsEditActions) qsEditActions.hidden = success;
    if (btnQsSubmit) {
      btnQsSubmit.disabled = submitting || !canSubmitQuickSession({
        ...quickSession,
        phase: quickSession.phase === "error" ? "error" : "editing",
      });
      btnQsSubmit.textContent = submitting ? "启动中…" : quickSession.phase === "error" ? "重试" : "启动";
    }
    if (shouldLoadQuickSessionModels(quickSession)) {
      void loadQuickSessionModels();
    }
  }

  function childUpdatedText(updatedAt: string | undefined): string | null {
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) return null;
    return `更新 ${updatedAt.slice(0, 16).replace("T", " ")}`;
  }

  function renderRow(activity: DesktopActivityRow, selectedId: string | null): HTMLElement {
    const row = document.createElement("div");
    // Terminal outcome text stays visible even after the activity is read, so a
    // failed task never collapses into an "idle" label in the tray.
    const terminalOutcome =
      activity.executionState === "settled" ? petTerminalOutcome(activity.outcome) : null;
    const statusLabel = terminalOutcome?.label ?? petStateLabel(activity.presentation);
    const statusGlyph = terminalOutcome?.glyph ?? petStateGlyph(activity.presentation);
    row.className = `activity-row${activity.unread ? " is-unread" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");
    row.setAttribute("aria-label", `${activity.title}，${statusLabel}`);
    row.tabIndex = activity.activityId === selectedId ? 0 : -1;
    row.dataset.activityId = activity.activityId;
    row.dataset.presentation = activity.presentation;
    if (terminalOutcome) row.dataset.outcome = activity.outcome ?? "";

    const summary = document.createElement("div");
    summary.className = "activity-row-summary";

    const glyph = document.createElement("span");
    glyph.className = "row-glyph";
    glyph.textContent = statusGlyph;
    glyph.title = statusLabel;

    const main = document.createElement("span");
    main.className = "row-main";

    const heading = document.createElement("span");
    heading.className = "row-heading";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = activity.title;
    const source = document.createElement("span");
    source.className = "row-source";
    source.textContent = petSourceLabel(activity.source);
    heading.append(title, source);

    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = [statusLabel, activity.phase]
      .filter(Boolean)
      .join(" · ");
    main.append(heading, meta);

    const progressLabel = formatActivityProgress(activity.progress, activity.children.length);
    if (progressLabel) {
      const progress = document.createElement("span");
      progress.className = "row-progress";
      progress.textContent = progressLabel;
      main.appendChild(progress);
    }

    const resourceLabel = [
      formatActiveModel(activity.executionState === "settled" ? undefined : activity.activeModel),
      formatSessionResources(activity.sessionResources),
    ].filter((part): part is string => Boolean(part)).join(" · ");
    if (resourceLabel) {
      const resources = document.createElement("span");
      resources.className = "row-resources";
      resources.textContent = resourceLabel;
      resources.title = "当前模型与会话资源：上下文、会话加权平均 TPS、累计费用或 Token";
      main.appendChild(resources);
    }

    if (activity.progress.kind === "ratio" && activity.progress.total > 0) {
      const track = document.createElement("span");
      track.className = "row-progress-track";
      const bar = document.createElement("span");
      bar.className = "row-progress-bar";
      const ratio = Math.max(0, Math.min(1, activity.progress.current / activity.progress.total));
      bar.style.width = `${Math.round(ratio * 100)}%`;
      track.appendChild(bar);
      main.appendChild(track);
    }

    const elapsed = document.createElement("span");
    elapsed.className = "row-elapsed";
    elapsed.dataset.activityId = activity.activityId;
    elapsed.textContent = formatElapsed(resolveActivityElapsedMs(activity, Date.now()));
    summary.append(glyph, main, elapsed);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "row-action row-open-action";
    openButton.textContent = "打开任务";
    openButton.addEventListener("click", () => {
      dismissActivityBubble(activity);
      selectedVisibleActivityId = activity.activityId;
      bridge?.selectActivity(activity.activityId);
      void bridge?.openActivity(activity.activityId);
    });
    actions.appendChild(openButton);

    const readButton = document.createElement("button");
    readButton.type = "button";
    readButton.className = "row-action";
    readButton.textContent = activity.unread ? "标记已读" : "已读";
    readButton.disabled = !activity.unread;
    readButton.addEventListener("click", () => {
      dismissActivityBubble(activity);
      bridge?.markRead(activity.activityId);
    });
    actions.appendChild(readButton);

    if (activity.children.length > 0) {
      const expanded = expandedActivityIds.has(activity.activityId);
      const expandButton = document.createElement("button");
      expandButton.type = "button";
      expandButton.className = "row-action row-child-toggle";
      expandButton.textContent = `${expanded ? "收起" : "展开"} Subagent ${activity.children.length}`;
      expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
      expandButton.addEventListener("click", () => {
        if (expandedActivityIds.has(activity.activityId)) {
          expandedActivityIds.delete(activity.activityId);
        } else {
          expandedActivityIds.add(activity.activityId);
        }
        if (current) update(current);
        focusActivityRow(activity.activityId);
      });
      actions.appendChild(expandButton);
    }

    row.append(summary, actions);

    if (activity.children.length > 0 && expandedActivityIds.has(activity.activityId)) {
      const children = document.createElement("div");
      children.className = "row-children";
      children.setAttribute("role", "list");
      children.setAttribute("aria-label", "Subagent 安全摘要");
      for (const child of activity.children) {
        const childRow = document.createElement("div");
        childRow.className = "row-child";
        childRow.setAttribute("role", "listitem");
        const childTitle = document.createElement("span");
        childTitle.className = "row-child-title";
        childTitle.textContent = child.title;
        const childMeta = document.createElement("span");
        childMeta.className = "row-child-meta";
        childMeta.textContent = [
          childStatusText(child),
          child.phase,
          childUpdatedText(child.updatedAt),
        ].filter(Boolean).join(" · ");
        childRow.append(childTitle, childMeta);
        children.appendChild(childRow);
      }
      row.appendChild(children);
    }

    row.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return;
      selectVisibleActivity(activity.activityId, false);
    });
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        dismissActivityBubble(activity);
        void bridge?.openActivity(activity.activityId);
      }
      if ((event.key === "m" || event.key === "M") && activity.unread) {
        event.preventDefault();
        event.stopPropagation();
        dismissActivityBubble(activity);
        bridge?.markRead(activity.activityId);
      }
    });
    return row;
  }

  // Click opens/closes the tray; drag past threshold moves the frameless window.
  // CSS -webkit-app-region:drag cannot coexist with click on the same node.
  let petPointerId: number | null = null;
  let petDragOriginX = 0;
  let petDragOriginY = 0;
  let petLastScreenX = 0;
  let petLastScreenY = 0;
  let petDragging = false;
  let petNativeDragging = false;

  // Hover play: pupils track the cursor and the head tilts toward it. Both use
  // the independent `translate`/`rotate` CSS properties so they never fight the
  // keyframe animations driven through `transform`.
  const resetEyeFollow = () => {
    if (!(petAvatar instanceof HTMLElement)) return;
    petAvatar.style.removeProperty("--eye-shift-x");
    petAvatar.style.removeProperty("--eye-shift-y");
    petAvatar.style.removeProperty("--head-tilt");
  };

  const currentPetProfile = () => {
    if (!current) return null;
    return getPetRuntimeProfile(
      resolvePetKey({
        selectedPetKey: current.selectedPetKey,
        selectedPetId: current.selectedPetId,
      }),
    );
  };

  const clearLookReleaseTimer = () => {
    if (lookReleaseTimer) {
      clearTimeout(lookReleaseTimer);
      lookReleaseTimer = null;
    }
  };

  const clearCodexLook = () => {
    clearLookReleaseTimer();
    if (lookDirection == null) return;
    lookDirection = null;
    if (current) update(current);
  };

  const armLookRelease = () => {
    clearLookReleaseTimer();
    lookReleaseTimer = setTimeout(() => {
      lookReleaseTimer = null;
      clearCodexLook();
    }, CODEX_LOOK_RELEASE_MS);
  };

  const applyCodexLook = (event: PointerEvent) => {
    const profile = currentPetProfile();
    if (!profile?.capabilities.look || !current) return;
    const motionReduced = reducedMotion || current.reducedMotion === true;
    if (motionReduced || documentHidden || petDragging) {
      clearCodexLook();
      return;
    }
    if (!canApplyLookOverlay(currentPresentation())) {
      clearCodexLook();
      return;
    }
    if (!(petAvatar instanceof HTMLElement)) return;
    const rect = petAvatar.getBoundingClientRect();
    if (rect.width === 0) return;
    if (!isCodexLookPointerInBounds(event.clientX, event.clientY, rect)) {
      clearCodexLook();
      return;
    }
    const next = quantizeCodexLookDirection(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
    );
    if (next == null) {
      clearCodexLook();
      return;
    }
    armLookRelease();
    if (next === lookDirection) return;
    lookDirection = next;
    update(current);
  };

  const applyEyeFollow = (event: PointerEvent) => {
    applyCodexLook(event);
    if (!(petAvatar instanceof HTMLElement) || !(petButton instanceof HTMLElement)) return;
    if (!petAvatar.classList.contains("is-animated")) return;
    if (petAvatar.classList.contains("pet-sprite")) return;
    const stage = petButton.querySelector(".pet-stage");
    const rect = stage?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    // The head sits right-of-center inside the 112x112 stage.
    const headX = rect.left + rect.width * 0.78;
    const headY = rect.top + rect.height * 0.68;
    const dx = event.clientX - headX;
    const dy = event.clientY - headY;
    const clamp = (value: number, max: number) => Math.max(-max, Math.min(max, value));
    petAvatar.style.setProperty("--eye-shift-x", `${clamp(dx / 24, 1.7).toFixed(2)}px`);
    petAvatar.style.setProperty("--eye-shift-y", `${clamp(dy / 24, 1.3).toFixed(2)}px`);
    petAvatar.style.setProperty("--head-tilt", `${clamp(dx / 40, 4).toFixed(2)}deg`);
  };

  const onWindowPointerMove = (event: PointerEvent) => {
    if (petPointerId !== null) return;
    applyCodexLook(event);
  };
  const onWindowPointerLeave = () => {
    clearCodexLook();
  };
  const onWindowBlur = () => {
    clearCodexLook();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("pointerleave", onWindowPointerLeave);
    window.addEventListener("blur", onWindowBlur);
  }

  // Whether a single pet activation should jump straight to the top-priority
  // attention task instead of toggling the tray (P1 quick path).
  function canJumpToPrimary(view: DesktopActivityView | null): boolean {
    if (!view || view.trayOpen) return false;
    const primary = selectPrimaryActivity(view.projects);
    return (
      (view.presentation === "needs_input" || view.presentation === "blocked") &&
      (primary?.presentation === "needs_input" || primary?.presentation === "blocked")
    );
  }

  function activatePet(): void {
    // Any direct activation wakes the pet from its decorative sleep stage first;
    // this never opens a task or marks anything read on its own.
    wakeIdleSleep();
    if (!current) {
      bridge?.toggleTray();
      return;
    }
    const primary = selectPrimaryActivity(current.projects);
    if (canJumpToPrimary(current) && primary) {
      dismissActivityBubble(primary);
      selectedVisibleActivityId = primary.activityId;
      bridge?.selectActivity(primary.activityId);
      void bridge?.openActivity(primary.activityId);
      return;
    }
    bridge?.toggleTray();
  }

  /** Same bulk-ack as the tray overflow: ready/blocked only, needs_input stays. */
  function markAllVisibleRead(): void {
    const primary = current ? selectPrimaryActivity(current.projects) : null;
    if (primary?.presentation === "ready" || primary?.presentation === "blocked") {
      dismissActivityBubble(primary);
    }
    bridge?.markAllRead();
  }

  function toggleActivityFromMenu(): void {
    wakeIdleSleep();
    setTrayMoreOpen(false);
    const showingActivity =
      current?.trayOpen === true && !settingsOpen && quickSession.phase === "closed";
    if (showingActivity) {
      bridge?.toggleTray();
      return;
    }
    settingsOpen = false;
    if (quickSession.phase !== "closed") {
      applyQuickSession({ type: "close" }, { render: false });
    }
    pendingTrayPanel = null;
    if (current?.trayOpen) {
      update(current);
      return;
    }
    bridge?.toggleTray();
  }

  function openSettingsPanel(): void {
    wakeIdleSleep();
    setTrayMoreOpen(false);
    if (quickSession.phase !== "closed") {
      applyQuickSession({ type: "close" }, { render: false });
    }
    settingsOpen = true;
    if (current?.trayOpen) {
      pendingTrayPanel = null;
      update(current);
      return;
    }
    pendingTrayPanel = "settings";
    bridge?.toggleTray();
  }

  function openQuickSessionPanel(): void {
    wakeIdleSleep();
    setTrayMoreOpen(false);
    settingsOpen = false;
    if (!current?.trayOpen) pendingTrayPanel = "quick-session";
    if (quickSession.phase === "closed") {
      void loadQuickSessionCatalog();
    } else if (current) {
      update(current);
    }
    if (!current?.trayOpen) bridge?.toggleTray();
  }

  const endPetPointer = (target: HTMLElement, pointerId: number, playDrop = true) => {
    if (petPointerId !== pointerId) return;
    // Clear the pointer identity before releasing capture so the synchronous
    // (or queued) `lostpointercapture` handler below can never mistake the
    // normal pointerup path for an unexpected capture loss.
    const wasDragging = petDragging;
    petPointerId = null;
    petDragging = false;
    petNativeDragging = false;
    if (dragClip) {
      dragClip = null;
      if (current) update(current);
    }
    try {
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // ignore release errors when the element is gone
    }
    target.classList.remove("is-dragging");
    petAvatar?.classList.remove("is-pressed", "is-dragging");
    if (!wasDragging) {
      handlePetClick();
      return;
    }
    // One-shot probe-out after a completed drag (skipped on cancel/reduced motion).
    if (
      playDrop &&
      petAvatar instanceof HTMLElement &&
      !reducedMotion &&
      petAvatar.classList.contains("is-animated")
    ) {
      petAvatar.classList.add("pop-out");
      if (petDropPopTimer) clearTimeout(petDropPopTimer);
      petDropPopTimer = setTimeout(() => {
        petAvatar.classList.remove("pop-out");
        petDropPopTimer = null;
      }, 460);
    }
  };

  petButton?.addEventListener("pointerdown", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    if (event.button !== 0) return;
    wakeIdleSleep();
    petPointerId = event.pointerId;
    petDragOriginX = event.screenX;
    petDragOriginY = event.screenY;
    petLastScreenX = event.screenX;
    petLastScreenY = event.screenY;
    petDragging = false;
    petNativeDragging = false;
    resetEyeFollow();
    // Drop any running mini-act so the duck pose wins over its keyframes.
    petAvatar?.classList.remove("idle-act-look", "idle-act-sleepy", "idle-act-stretch");
    petAvatar?.classList.add("is-pressed");
    try {
      petButton.setPointerCapture(event.pointerId);
    } catch {
      // older hosts may lack capture; move/up still work while over the button
    }
  });

  petButton?.addEventListener("pointermove", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    if (petPointerId === null) {
      applyEyeFollow(event);
      maybeWakeOnHover();
      return;
    }
    if (petPointerId !== event.pointerId) return;
    const totalDx = event.screenX - petDragOriginX;
    const totalDy = event.screenY - petDragOriginY;
    if (
      !petDragging &&
      (Math.abs(totalDx) >= DRAG_THRESHOLD_PX || Math.abs(totalDy) >= DRAG_THRESHOLD_PX)
    ) {
      petDragging = true;
      // Crossing the drag threshold cancels the whole click sequence, so a drag
      // never re-toggles the tray or fires a deferred poke/flail.
      cancelClickSequence();
      closeIntentMenu();
      petButton.classList.add("is-dragging");
      petAvatar?.classList.remove("is-pressed");
      petAvatar?.classList.add("is-dragging");
      // WebView screen coordinates change logical basis while crossing mixed-DPI
      // monitors. Let the Tauri host delegate the gesture to Windows instead;
      // Electron keeps the existing renderer-delta fallback.
      petNativeDragging = typeof bridge?.startDragging === "function";
      if (petNativeDragging) bridge?.startDragging?.();
    }
    if (!petDragging) return;
    const dx = event.screenX - petLastScreenX;
    const dy = event.screenY - petLastScreenY;
    petLastScreenX = event.screenX;
    petLastScreenY = event.screenY;
    if (dx !== 0 || dy !== 0) {
      if (!petNativeDragging) bridge?.moveBy(dx, dy);
      const profile = currentPetProfile();
      if (profile?.capabilities.directionalRun && current && canApplyDragOverlay(current.presentation)) {
        const nextDrag = resolveCodexDragClip(dx, dy, dragClip);
        if (nextDrag !== dragClip) {
          dragClip = nextDrag;
          lookDirection = null;
          update(current);
        }
      }
    }
  });

  petButton?.addEventListener("pointerup", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    endPetPointer(petButton, event.pointerId, true);
  });

  petButton?.addEventListener("pointercancel", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    // Cancelled gestures should not toggle the tray or play a drop pop.
    if (petPointerId === event.pointerId) {
      cancelClickSequence();
      petDragging = true;
      endPetPointer(petButton, event.pointerId, false);
    }
  });

  // Capture can be lost without a pointerup/cancel (OS gesture, window blur,
  // overlay). Clean up the drag state and the click sequence so no dangling
  // timer or class survives.
  petButton?.addEventListener("lostpointercapture", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    if (petPointerId !== event.pointerId) return;
    petPointerId = null;
    petDragging = false;
    petNativeDragging = false;
    dragClip = null;
    petButton.classList.remove("is-dragging");
    petAvatar?.classList.remove("is-pressed", "is-dragging");
    cancelClickSequence();
    if (current) update(current);
  });

  petButton?.addEventListener("pointerleave", () => {
    if (petPointerId === null) {
      resetEyeFollow();
      clearCodexLook();
    }
  });

  // Keyboard activation: Enter/Space still opens/jumps (accessible work path).
  // P greets; Shift+P flails. The click handler swallows the synthesized click.
  petButton?.addEventListener("keydown", (event) => {
    if (
      isRightClickMenu() &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      event.stopPropagation();
      wakeIdleSleep();
      setIntentMenuOpen(true, { focus: true });
      return;
    }
    if (event.key === "p" || event.key === "P") {
      const motionReduced = reducedMotion || current?.reducedMotion === true;
      if (!shouldAllowPetReaction(currentPresentation(), motionReduced)) return;
      event.preventDefault();
      event.stopPropagation();
      cancelClickSequence();
      if (event.shiftKey) {
        playCodexJump();
        playReaction("flail");
      } else {
        playInteract();
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    activatePet();
  });

  // Suppress the synthetic click after pointerup so we do not double-toggle.
  petButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  btnTrayMore?.addEventListener("click", (event) => {
    event.stopPropagation();
    setTrayMoreOpen(!trayMoreOpen);
  });

  trayMoreMenu?.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const onRootClick = (event: Event) => {
    if (trayMoreOpen) setTrayMoreOpen(false);
    if (intentMenuOpen) {
      const intentTarget = event.target instanceof Element ? event.target : null;
      if (!intentTarget?.closest("#pet-intent-menu")) closeIntentMenu();
    }
    if (quickSession.openPicker === "none") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#qs-picker, #qs-project-trigger, #qs-model-trigger")) return;
    applyQuickSession({ type: "close_picker" });
  };
  root.addEventListener("click", onRootClick);

  btnMarkAll?.addEventListener("click", () => {
    setTrayMoreOpen(false);
    markAllVisibleRead();
  });

  btnRetry?.addEventListener("click", () => {
    setTrayMoreOpen(false);
    bridge?.retry();
  });

  const submitAccessKey = () => {
    const value = accessKeyInput?.value?.trim() ?? "";
    if (!value) return;
    void bridge?.setAccessKey(value).then(() => {
      if (accessKeyInput) accessKeyInput.value = "";
    });
  };

  btnSaveKey?.addEventListener("click", () => {
    submitAccessKey();
  });

  accessKeyInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitAccessKey();
    }
  });

  btnClearKey?.addEventListener("click", () => {
    void bridge?.clearAccessKey();
  });

  btnCopy?.addEventListener("click", () => {
    void bridge?.copyStartCommand();
  });

  btnHide?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideToTray();
  });

  btnPetHide?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeIntentMenu();
    hideToTray();
  });

  btnHideTray?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    bridge?.toggleTray();
  });

  btnSettings?.addEventListener("click", () => {
    wakeIdleSleep();
    setTrayMoreOpen(false);
    if (quickSession.phase !== "closed") {
      applyQuickSession({ type: "close" });
    }
    settingsOpen = !settingsOpen;
    if (current) update(current);
  });

  btnPetSettings?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeIntentMenu();
    if (current?.trayOpen && settingsOpen) {
      settingsOpen = false;
      update(current);
      return;
    }
    openSettingsPanel();
  });

  btnPetMarkAll?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeIntentMenu();
    wakeIdleSleep();
    markAllVisibleRead();
  });

  btnPetActivity?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeIntentMenu();
    toggleActivityFromMenu();
  });

  btnQuickSession?.addEventListener("click", () => {
    wakeIdleSleep();
    setTrayMoreOpen(false);
    settingsOpen = false;
    if (quickSession.phase === "closed") {
      void loadQuickSessionCatalog();
      return;
    }
    applyQuickSession({ type: "close" });
  });

  btnPetQuickSession?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeIntentMenu();
    if (current?.trayOpen && quickSession.phase !== "closed") {
      applyQuickSession({ type: "close" });
      return;
    }
    openQuickSessionPanel();
  });

  qsProjectTrigger?.addEventListener("click", () => {
    applyQuickSession({ type: "toggle_picker", picker: "project" });
    if (quickSession.openPicker === "project") qsPickerSearch?.focus();
  });
  qsModelTrigger?.addEventListener("click", () => {
    applyQuickSession({ type: "toggle_picker", picker: "model" });
    if (quickSession.openPicker === "model") {
      void loadQuickSessionModels({ retryError: true });
      qsPickerSearch?.focus();
    }
  });
  qsPickerSearch?.addEventListener("input", () => {
    if (quickSession.openPicker === "model") {
      applyQuickSession({ type: "set_model_query", query: qsPickerSearch.value });
      return;
    }
    applyQuickSession({ type: "set_query", query: qsPickerSearch.value });
  });
  qsPickerList?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[role='option']")
      : null;
    if (!target) return;
    if (quickSession.openPicker === "model") {
      const provider = target.dataset.provider;
      const modelId = target.dataset.modelId;
      if (!provider || !modelId) return;
      applyQuickSession({ type: "select_model", provider, modelId });
      qsMessage?.focus();
      return;
    }
    const projectRef = target.dataset.projectRef;
    if (!projectRef) return;
    applyQuickSession({ type: "select_project", projectRef });
    qsMessage?.focus();
  });
  qsMessage?.addEventListener("compositionstart", () => {
    qsImeComposing = true;
  });
  qsMessage?.addEventListener("compositionend", () => {
    qsImeComposing = false;
    applyQuickSession({ type: "set_draft", draft: qsMessage.value });
  });
  qsMessage?.addEventListener("input", () => {
    applyQuickSession({ type: "set_draft", draft: qsMessage.value });
  });
  qsMessage?.addEventListener("keydown", (event) => {
    if (qsImeComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (quickSession.phase === "error") applyQuickSession({ type: "retry" });
      void submitQuickSession();
    }
  });
  btnQsCancel?.addEventListener("click", () => {
    applyQuickSession({ type: "cancel" });
  });
  btnQsSubmit?.addEventListener("click", () => {
    if (quickSession.phase === "error") applyQuickSession({ type: "retry" });
    void submitQuickSession();
  });
  btnQsOpen?.addEventListener("click", () => {
    const href = quickSession.success?.deepLink;
    if (href) void bridge?.openExternalUrl(href);
  });
  btnQsAnother?.addEventListener("click", () => {
    applyQuickSession({ type: "start_another" });
    qsMessage?.focus();
  });

  activityFilters?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-activity-filter]")
      : null;
    const nextFilter = target?.dataset.activityFilter;
    if (
      nextFilter !== "all" &&
      nextFilter !== "attention" &&
      nextFilter !== "running" &&
      nextFilter !== "completed"
    ) {
      return;
    }
    activityFilter = nextFilter;
    if (current) {
      const visibleIds = activityIds(filterProjectGroups(current.projects, activityFilter));
      selectedVisibleActivityId = resolveActivitySelection(
        visibleIds,
        selectedVisibleActivityId ?? current.selectedActivityId,
      );
      if (selectedVisibleActivityId) bridge?.selectActivity(selectedVisibleActivityId);
      update(current);
    }
  });

  petPicker?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-pet-key], [data-pet-id]")
      : null;
    const selectedPetKey = target?.dataset.petKey;
    const selectedPetId = target?.dataset.petId;
    if (selectedPetKey) {
      bridge?.setPrefs({ selectedPetKey });
      return;
    }
    if (!selectedPetId) return;
    bridge?.setPrefs({ selectedPetId });
  });
  petPickerFilter?.addEventListener("input", () => {
    petPickerQuery = petPickerFilter.value ?? "";
    const query = petPickerQuery.trim().toLowerCase();
    petPicker?.querySelectorAll<HTMLElement>(":scope > .pet-option").forEach((option) => {
      const label = option.textContent?.toLowerCase() ?? "";
      option.hidden = Boolean(query) && !label.includes(query);
    });
    renderCustomPetOptions();
    if (current) {
      const selectedKey = resolvePetKey({
        selectedPetKey: current.selectedPetKey,
        selectedPetId: current.selectedPetId,
      });
      petPicker?.querySelectorAll<HTMLElement>("[data-pet-id], [data-pet-key]").forEach((option) => {
        const optionKey =
          option.dataset.petKey ||
          (option.dataset.petId ? resolvePetKey({ selectedPetId: option.dataset.petId }) : "");
        option.setAttribute("aria-checked", optionKey === selectedKey ? "true" : "false");
      });
    }
  });

  petScalePicker?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-pet-scale]")
      : null;
    const petScale = target?.dataset.petScale;
    if (petScale !== "small" && petScale !== "medium" && petScale !== "large") return;
    bridge?.setPrefs({ petScale });
  });

  bubbleThemePicker?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-bubble-theme]")
      : null;
    const bubbleTheme = target?.dataset.bubbleTheme;
    if (!isDesktopPetBubbleTheme(bubbleTheme)) return;
    bridge?.setPrefs({ bubbleTheme });
  });

  btnRestorePosition?.addEventListener("click", () => {
    bridge?.restoreDefaultPosition();
  });

  btnOpenCustomPets?.addEventListener("click", () => {
    void bridge?.openCustomPetsDir();
  });
  btnRescanCustomPets?.addEventListener("click", () => {
    bridge?.rescanCustomPets();
  });

  prefAlwaysOnTop?.addEventListener("change", () => {
    bridge?.setPrefs({ alwaysOnTop: prefAlwaysOnTop.checked });
  });
  prefClickThrough?.addEventListener("change", () => {
    bridge?.setPrefs({ clickThrough: prefClickThrough.checked });
  });
  prefLaunchAtLogin?.addEventListener("change", () => {
    bridge?.setPrefs({ launchAtLogin: prefLaunchAtLogin.checked });
  });
  prefCompletion?.addEventListener("change", () => {
    const completion = prefCompletion.value;
    if (completion === "never" || completion === "background-only" || completion === "always") {
      bridge?.setPrefs({ notification: { completion } });
    }
  });
  prefNeedsInput?.addEventListener("change", () => {
    bridge?.setPrefs({ notification: { needsInput: prefNeedsInput.checked } });
  });
  prefBlocked?.addEventListener("change", () => {
    bridge?.setPrefs({ notification: { blocked: prefBlocked.checked } });
  });
  prefShowContextMeter?.addEventListener("change", () => {
    bridge?.setPrefs({ showContextMeter: prefShowContextMeter.checked });
  });
  prefRightClickMenu?.addEventListener("change", () => {
    bridge?.setPrefs({ rightClickAggregatedMenu: prefRightClickMenu.checked });
  });
  prefDnd?.addEventListener("change", () => {
    bridge?.setPrefs({ dndEnabled: prefDnd.checked });
  });
  prefSoundMaster?.addEventListener("change", () => {
    // Master off keeps the per-event toggles untouched in settings.
    bridge?.setPrefs({ sound: { masterEnabled: prefSoundMaster.checked } });
  });
  prefSoundNeedsInput?.addEventListener("change", () => {
    bridge?.setPrefs({ sound: { needsInput: prefSoundNeedsInput.checked } });
  });
  prefSoundCompletion?.addEventListener("change", () => {
    bridge?.setPrefs({ sound: { completion: prefSoundCompletion.checked } });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && trayMoreOpen) {
      setTrayMoreOpen(false);
      btnTrayMore?.focus();
      return;
    }
    if (event.key === "Escape" && intentMenuOpen) {
      event.preventDefault();
      closeIntentMenu();
      return;
    }
    if (!current?.trayOpen) return;
    const target = event.target instanceof Element ? event.target : null;
    const inFormControl = target?.matches("input, select, option") === true;
    const inFilterBar = target?.closest("#activity-filters") != null;

    if (
      !inFormControl &&
      !inFilterBar &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      const ids = activityIds(filterProjectGroups(current.projects, activityFilter));
      const next = moveActivitySelection(
        ids,
        selectedVisibleActivityId,
        event.key === "ArrowDown" ? "next" : "prev",
      );
      if (next) selectVisibleActivity(next, true);
      return;
    }

    if (
      !inFormControl &&
      target?.closest("button") == null &&
      event.key === "Enter" &&
      selectedVisibleActivityId
    ) {
      event.preventDefault();
      dismissActivityBubble(findVisibleActivity(selectedVisibleActivityId));
      void bridge?.openActivity(selectedVisibleActivityId);
      return;
    }

    if (
      !inFormControl &&
      target?.closest("button") == null &&
      (event.key === "m" || event.key === "M")
    ) {
      const selected = findVisibleActivity(selectedVisibleActivityId);
      if (selected?.unread) {
        event.preventDefault();
        dismissActivityBubble(selected);
        bridge?.markRead(selected.activityId);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (quickSession.openPicker !== "none") {
        applyQuickSession({ type: "close_picker" });
      } else if (selectedVisibleActivityId && expandedActivityIds.has(selectedVisibleActivityId)) {
        expandedActivityIds.delete(selectedVisibleActivityId);
        update(current);
        focusActivityRow(selectedVisibleActivityId);
      } else if (quickSession.phase !== "closed") {
        applyQuickSession({ type: "close" });
      } else if (settingsOpen) {
        settingsOpen = false;
        update(current);
      } else if (current.trayOpen) {
        bridge?.toggleTray();
      }
    }
  };
  root.addEventListener("keydown", onKeyDown);

  const onRootContextMenu = (event: Event) => {
    if (!isRightClickMenu()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#pet-stack")) {
      event.preventDefault();
      wakeIdleSleep();
      setIntentMenuOpen(true);
      return;
    }
    closeIntentMenu();
  };
  root.addEventListener("contextmenu", onRootContextMenu);

  let unsubscribe: (() => void) | undefined;
  let unsubscribeSoundCue: (() => void) | undefined;
  let unsubscribeCustomPets: (() => void) | undefined;
  if (bridge) {
    unsubscribe = bridge.onStateChanged((view) => {
      update(view as DesktopActivityView);
    });
    // Cues arrive pre-gated from main; the player itself stays failure-silent.
    unsubscribeSoundCue = bridge.onSoundCue((cue) => {
      soundPlayer.play(cue);
    });
    // U6 slice 1: custom pets arrive as validated payloads (initial + rescan).
    unsubscribeCustomPets = bridge.onCustomPetsChanged((payload) => {
      syncCustomPetsPayload(payload);
    });
    void bridge.getState().then((view) => {
      if (view) update(view as DesktopActivityView);
    });
    void bridge.getCustomPets().then((payload) => {
      syncCustomPetsPayload(payload);
    });
  }

  return {
    update,
    destroy: () => {
      clearBubbleTimer();
      clearElapsedTimer();
      clearIdleSleepTimer();
      if (runningCueTimer != null) {
        clearTimeout(runningCueTimer);
        runningCueTimer = null;
      }
      if (idleBlinkTimer) {
        clearTimeout(idleBlinkTimer);
        idleBlinkTimer = null;
      }
      if (petDropPopTimer) {
        clearTimeout(petDropPopTimer);
        petDropPopTimer = null;
      }
      clearTransition();
      cancelClickSequence();
      clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pointermove", onWindowPointerMove);
        window.removeEventListener("pointerleave", onWindowPointerLeave);
        window.removeEventListener("blur", onWindowBlur);
      }
      clearLookReleaseTimer();
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("click", onRootClick);
      root.removeEventListener("contextmenu", onRootContextMenu);
      for (const style of spriteStyleSheets.values()) style.remove();
      spriteStyleSheets.clear();
      clearCustomPetRegistrations();
      unsubscribe?.();
      unsubscribeSoundCue?.();
      unsubscribeCustomPets?.();
      soundPlayer.destroy();
    },
  };
}

function readPreviewFixture(): DesktopActivityView | null {
  if (typeof window === "undefined") return null;
  const accepted = acceptStaticPetPreview(window.__SNAIL_PET_PREVIEW__);
  return accepted ? (accepted as DesktopActivityView) : null;
}

function boot(): void {
  if (typeof document === "undefined") return;
  if (!document.getElementById("root")) return;
  const app = renderPetApp(document);
  const preview = readPreviewFixture();
  if (preview) app.update(preview);
}

boot();
