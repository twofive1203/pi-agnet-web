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
import { resolvePetLayoutSpec } from "../main/window-manager";
import type { SnailPetBridge } from "../preload/pet-preload";
import { acceptStaticPetPreview } from "./pet-assets";
import {
  connectionBannerText,
  countActivitiesByFilter,
  createInitialPetBubbleState,
  createInitialPetCelebrateState,
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
  petSourceLabel,
  petStateGlyph,
  petStateLabel,
  petTerminalOutcome,
  reducePetBubbleState,
  reduceRunningCueState,
  resolveActivityElapsedMs,
  resolveActivitySelection,
  resolvePetFrame,
  resolvePetTransitionAction,
  resolvePrimaryContextMeter,
  resolveRunningCue,
  resolveRunningCueVisual,
  runningCueNextUpdateAt,
  selectPrimaryActivity,
  shouldCelebrateCompletion,
  shouldRunIdleLife,
  type DesktopActivityFilter,
  type PetBubbleSignal,
  type PetManifest,
  type PetTransitionAction,
  type PetVisualState,
} from "./pet-state";
import { buildSpriteSheetStyleText, resolveSpriteSheetStyle } from "./pet-sheet";
import { PET_SHEET_DATA_URLS } from "./pet-sheet-assets";

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
  const btnHide = root.getElementById("btn-hide");
  const btnHideTray = root.getElementById("btn-hide-tray");
  const btnSettings = root.getElementById("btn-settings");
  const settingsPanel = root.getElementById("settings-panel");
  const petPicker = root.getElementById("pet-picker");
  const petScalePicker = root.getElementById("pet-scale-picker");
  const btnRestorePosition = root.getElementById("btn-restore-position");
  const prefAlwaysOnTop = root.getElementById("pref-always-on-top") as HTMLInputElement | null;
  const prefClickThrough = root.getElementById("pref-click-through") as HTMLInputElement | null;
  const prefLaunchAtLogin = root.getElementById("pref-launch-at-login") as HTMLInputElement | null;
  const prefCompletion = root.getElementById("pref-completion") as HTMLSelectElement | null;
  const prefNeedsInput = root.getElementById("pref-needs-input") as HTMLInputElement | null;
  const prefBlocked = root.getElementById("pref-blocked") as HTMLInputElement | null;
  const prefShowContextMeter = root.getElementById("pref-show-context-meter") as HTMLInputElement | null;
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
  let trayMoreOpen = false;
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
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let runningCueTimer: ReturnType<typeof setTimeout> | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Spritesheet pets inject one per-pet <style> and verify the inlined bitmap
  // decodes; a load/decode failure falls back to the CSS snail.
  const spriteStyleSheets = new Map<string, HTMLStyleElement>();
  const spriteVerified = new Set<string>();
  const spriteFailed = new Set<string>();

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

  function dismissActivityBubble(activity: DesktopActivityRow | null): void {
    if (!activity) return;
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
    // blink/idle-act timers have nothing to drive.
    if (avatar?.classList.contains("pet-sprite")) return false;
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
    if (documentHidden) {
      if (idleBlinkTimer) {
        clearTimeout(idleBlinkTimer);
        idleBlinkTimer = null;
      }
      clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
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

  function ensureSpriteStylesheet(manifest: PetManifest): void {
    if (spriteStyleSheets.has(manifest.id)) return;
    const text = buildSpriteSheetStyleText(manifest, PET_SHEET_DATA_URLS[manifest.id] ?? null);
    if (!text) return;
    const style = root.createElement("style");
    style.setAttribute("data-pet-sprite", manifest.id);
    style.textContent = text;
    root.head?.appendChild(style);
    spriteStyleSheets.set(manifest.id, style);
  }

  // Inlined data URLs cannot fail to fetch, but a corrupt bitmap still can; a
  // decode rejection marks the pet failed so the renderer re-renders as CSS.
  function verifySpriteImage(petId: string, url: string): void {
    if (spriteVerified.has(petId) || spriteFailed.has(petId)) return;
    const img = root.createElement("img");
    img.addEventListener("error", () => {
      spriteFailed.add(petId);
      if (current) update(current);
    });
    img.addEventListener("load", () => {
      if (typeof img.decode !== "function") {
        spriteVerified.add(petId);
        return;
      }
      void img.decode().then(
        () => spriteVerified.add(petId),
        () => {
          spriteFailed.add(petId);
          if (current) update(current);
        },
      );
    });
    img.src = url;
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
    runningCueState = reduceRunningCueState(
      runningCueState,
      { presentation: state, cue: resolveRunningCue(primary) },
      updateNow,
    );
    scheduleRunningCueUpdate(updateNow);
    const runningCue = runningCueState.active ? runningCueState.cue : "generic";
    const cueVisual = resolveRunningCueVisual(runningCue);
    const manifest = getBuiltinPetManifest(view.selectedPetId);
    const motionReduced = view.reducedMotion || reducedMotion;
    const frame = resolvePetFrame(manifest, state, motionReduced);
    const displayGlyph = state === "running" ? cueVisual.glyph : frame.glyph || petStateGlyph(state);
    const displayLabel = state === "running" ? cueVisual.label : frame.label || petStateLabel(state);
    const spriteImageUrl = PET_SHEET_DATA_URLS[manifest.id] ?? null;
    const spriteStyle = resolveSpriteSheetStyle(manifest, state, spriteImageUrl);
    const spriteActive = spriteStyle != null && !spriteFailed.has(manifest.id);
    if (spriteActive && spriteImageUrl) {
      ensureSpriteStylesheet(manifest);
      verifySpriteImage(manifest.id, spriteImageUrl);
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
      const spriteClass = spriteActive ? ` pet-sprite pet-sprite-${manifest.id}` : "";
      petAvatar.className = `pet-avatar${spriteClass} frame-${frame.frame}${frame.animated ? " is-animated" : ""}${transitionClass ? ` ${transitionClass}` : ""}`;
      petAvatar.setAttribute("data-state", state);
      if (state === "running") {
        petAvatar.setAttribute("data-running-cue", runningCue);
      } else {
        petAvatar.removeAttribute("data-running-cue");
      }
      // Re-arm idle life only when the visual frame actually changes, so frequent
      // view updates never starve the blink/act timers.
      const lifeKey = `${frame.frame}:${frame.animated ? "1" : "0"}`;
      if (lifeKey !== idleLifeKey) {
        idleLifeKey = lifeKey;
        scheduleIdleBlink(petAvatar);
        scheduleIdleActs(petAvatar);
      }
    }
    if (petRoot) petRoot.setAttribute("data-pet", manifest.id);
    if (petGlyph) petGlyph.textContent = displayGlyph;
    if (petLabel) petLabel.textContent = displayLabel;

    const activityDrivesState = primary?.presentation === state;
    const signal: PetBubbleSignal = {
      presentation: state,
      transitionId: activityDrivesState ? primary.lastTransitionId : null,
      revision: view.revision,
      instanceId: view.instanceId,
      unread: activityDrivesState ? primary.unread : false,
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
    if (petCaption) {
      petCaption.hidden = !bubbleState.visible;
      petCaption.dataset.bubbleMode = bubbleState.mode ?? "hidden";
    }
    if (petCaptionState) petCaptionState.textContent = displayLabel;
    if (petCaptionTitle) {
      petCaptionTitle.textContent = primary?.title ?? connectionBannerText({
        connectionStatus: view.connectionStatus,
        canCopyStartCommand: view.canCopyStartCommand,
        startCommand: view.startCommand,
        reasonCode: view.connectionReasonCode,
      }) ?? "";
    }
    scheduleBubbleExpiry(bubbleNow);

    if (petBadge) {
      const count = view.attentionCount + (view.aggregate?.ready ?? 0);
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
    if (!view.trayOpen) {
      settingsOpen = false;
      setTrayMoreOpen(false);
    }
    if (settingsPanel) settingsPanel.hidden = !settingsOpen;
    if (activityFilters) activityFilters.hidden = settingsOpen;
    if (projectList) projectList.hidden = settingsOpen;
    if (btnSettings) {
      btnSettings.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
    }
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
      petRoot.style.setProperty("--pet-scale", String(spec.factor));
      petRoot.style.setProperty("--pet-root-pad", `${spec.rootPad}px`);
      petRoot.style.setProperty("--pet-stack-gap", `${Math.max(1, spec.stackHeight - spec.chromeHeight - spec.surfaceSize)}px`);
      petRoot.style.setProperty("--pet-stack-width", `${spec.stackWidth}px`);
      petRoot.style.setProperty("--pet-chrome-height", `${spec.chromeHeight}px`);
      petRoot.style.setProperty("--pet-surface-size", `${spec.surfaceSize}px`);
    }
    if (petButton) {
      petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
      const attentionJump = canJumpToPrimary(view);
      petButton.setAttribute(
        "aria-label",
        view.trayOpen
          ? "桌宠，点击收起活动列表，拖动可移动"
          : attentionJump
            ? "桌宠，点击直达待处理任务，拖动可移动"
            : "桌宠，点击展开活动列表，拖动可移动",
      );
    }

    if (trayCounts) {
      const active = view.activeCount;
      const attention = view.attentionCount;
      trayCounts.textContent = `活动 ${active} · 关注 ${attention}`;
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
    petPicker?.querySelectorAll<HTMLElement>("[data-pet-id]").forEach((option) => {
      const selected = option.dataset.petId === view.selectedPetId;
      option.setAttribute("aria-checked", selected ? "true" : "false");
    });
    petScalePicker?.querySelectorAll<HTMLElement>("[data-pet-scale]").forEach((option) => {
      const selected = option.dataset.petScale === view.petScale;
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
        // A miniature resting snail keeps the empty panel on-brand. It reuses the
        // pet anatomy classes so palette variants (classic shell) apply for free.
        const emptyPet = root.createElement("div");
        emptyPet.className = "empty-pet";
        emptyPet.setAttribute("aria-hidden", "true");
        const emptyAvatar = root.createElement("span");
        emptyAvatar.className = "pet-avatar frame-idle is-animated empty-pet-avatar";
        emptyAvatar.innerHTML =
          '<span class="pet-shadow"></span><span class="pet-tail"></span><span class="pet-body"></span>' +
          '<span class="pet-head"><span class="pet-antenna pet-antenna-left"></span>' +
          '<span class="pet-antenna pet-antenna-right"></span><span class="pet-eye pet-eye-left"></span>' +
          '<span class="pet-eye pet-eye-right"></span><span class="pet-mouth"></span></span>' +
          '<span class="pet-shell"><span class="pet-shell-spiral"></span></span>';
        emptyPet.appendChild(emptyAvatar);
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
        empty.append(emptyPet, emptyTitle, emptyHint);
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

  // Hover play: pupils track the cursor and the head tilts toward it. Both use
  // the independent `translate`/`rotate` CSS properties so they never fight the
  // keyframe animations driven through `transform`.
  const resetEyeFollow = () => {
    if (!(petAvatar instanceof HTMLElement)) return;
    petAvatar.style.removeProperty("--eye-shift-x");
    petAvatar.style.removeProperty("--eye-shift-y");
    petAvatar.style.removeProperty("--head-tilt");
  };

  const applyEyeFollow = (event: PointerEvent) => {
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

  const endPetPointer = (target: HTMLElement, pointerId: number, playDrop = true) => {
    if (petPointerId !== pointerId) return;
    try {
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // ignore release errors when the element is gone
    }
    target.classList.remove("is-dragging");
    petAvatar?.classList.remove("is-pressed", "is-dragging");
    const wasDragging = petDragging;
    petPointerId = null;
    petDragging = false;
    if (!wasDragging) {
      activatePet();
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
    petPointerId = event.pointerId;
    petDragOriginX = event.screenX;
    petDragOriginY = event.screenY;
    petLastScreenX = event.screenX;
    petLastScreenY = event.screenY;
    petDragging = false;
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
      petButton.classList.add("is-dragging");
      petAvatar?.classList.remove("is-pressed");
      petAvatar?.classList.add("is-dragging");
    }
    if (!petDragging) return;
    const dx = event.screenX - petLastScreenX;
    const dy = event.screenY - petLastScreenY;
    petLastScreenX = event.screenX;
    petLastScreenY = event.screenY;
    if (dx !== 0 || dy !== 0) {
      bridge?.moveBy(dx, dy);
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
      petDragging = true;
      endPetPointer(petButton, event.pointerId, false);
    }
  });

  petButton?.addEventListener("pointerleave", () => {
    if (petPointerId === null) resetEyeFollow();
  });

  // Keyboard activation mirrors the contextual pointer action (Enter/Space).
  // The click handler below still swallows the browser-synthesized click.
  petButton?.addEventListener("keydown", (event) => {
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

  const onRootClick = () => {
    if (trayMoreOpen) setTrayMoreOpen(false);
  };
  root.addEventListener("click", onRootClick);

  btnMarkAll?.addEventListener("click", () => {
    setTrayMoreOpen(false);
    const primary = current ? selectPrimaryActivity(current.projects) : null;
    if (primary?.presentation === "ready" || primary?.presentation === "blocked") {
      dismissActivityBubble(primary);
    }
    bridge?.markAllRead();
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

  btnHideTray?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    bridge?.toggleTray();
  });

  btnSettings?.addEventListener("click", () => {
    setTrayMoreOpen(false);
    settingsOpen = !settingsOpen;
    if (current) update(current);
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
      ? event.target.closest<HTMLElement>("[data-pet-id]")
      : null;
    const selectedPetId = target?.dataset.petId;
    if (!selectedPetId) return;
    bridge?.setPrefs({ selectedPetId });
  });

  petScalePicker?.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-pet-scale]")
      : null;
    const petScale = target?.dataset.petScale;
    if (petScale !== "small" && petScale !== "medium" && petScale !== "large") return;
    bridge?.setPrefs({ petScale });
  });

  btnRestorePosition?.addEventListener("click", () => {
    bridge?.restoreDefaultPosition();
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && trayMoreOpen) {
      setTrayMoreOpen(false);
      btnTrayMore?.focus();
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
      if (selectedVisibleActivityId && expandedActivityIds.has(selectedVisibleActivityId)) {
        expandedActivityIds.delete(selectedVisibleActivityId);
        update(current);
        focusActivityRow(selectedVisibleActivityId);
      } else if (settingsOpen) {
        settingsOpen = false;
        update(current);
      } else if (current.trayOpen) {
        bridge?.toggleTray();
      }
    }
  };
  root.addEventListener("keydown", onKeyDown);

  let unsubscribe: (() => void) | undefined;
  if (bridge) {
    unsubscribe = bridge.onStateChanged((view) => {
      update(view as DesktopActivityView);
    });
    void bridge.getState().then((view) => {
      if (view) update(view as DesktopActivityView);
    });
  }

  return {
    update,
    destroy: () => {
      clearBubbleTimer();
      clearElapsedTimer();
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
      clearIdleAct(petAvatar instanceof HTMLElement ? petAvatar : null);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("click", onRootClick);
      for (const style of spriteStyleSheets.values()) style.remove();
      spriteStyleSheets.clear();
      unsubscribe?.();
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
