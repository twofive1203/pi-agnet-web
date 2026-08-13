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
  filterProjectGroups,
  formatActivityProgress,
  formatElapsed,
  getBuiltinPetManifest,
  moveActivitySelection,
  petSourceLabel,
  petStateGlyph,
  petStateLabel,
  reducePetBubbleState,
  resolveActivitySelection,
  resolvePetFrame,
  type DesktopActivityFilter,
  type PetBubbleSignal,
  type PetVisualState,
} from "./pet-state";

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
  const staleFlag = root.getElementById("stale-flag");

  const hideToTray = () => {
    bridge?.hideToTray();
  };

  /** Pixel threshold before a pointer gesture becomes a window drag. */
  const DRAG_THRESHOLD_PX = 5;

  let current: DesktopActivityView | null = null;
  let settingsOpen = false;
  let activityFilter: DesktopActivityFilter = "all";
  let selectedVisibleActivityId: string | null = null;
  const expandedActivityIds = new Set<string>();
  let bubbleState = createInitialPetBubbleState();
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  function activityIds(projects: readonly DesktopProjectGroup[]): string[] {
    const ids: string[] = [];
    for (const project of projects) {
      for (const activity of project.activities) ids.push(activity.activityId);
    }
    return ids;
  }

  function primaryActivity(view: DesktopActivityView): DesktopActivityRow | null {
    return view.projects[0]?.activities[0] ?? null;
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

  function update(view: DesktopActivityView): void {
    const previousView = current;
    current = view;
    const previewSettingsOpen = (view as unknown as { settingsOpen?: unknown }).settingsOpen;
    if (!bridge && typeof previewSettingsOpen === "boolean") {
      settingsOpen = previewSettingsOpen;
    }
    const state = isPetVisualState(view.presentation) ? view.presentation : "idle";
    const manifest = getBuiltinPetManifest(view.selectedPetId);
    const frame = resolvePetFrame(manifest, state, view.reducedMotion || reducedMotion);

    if (petAvatar) {
      petAvatar.className = `pet-avatar frame-${frame.frame}${frame.animated ? " is-animated" : ""}`;
      petAvatar.setAttribute("data-state", state);
    }
    if (petRoot) petRoot.setAttribute("data-pet", manifest.id);
    if (petGlyph) petGlyph.textContent = frame.glyph || petStateGlyph(state);
    if (petLabel) petLabel.textContent = frame.label || petStateLabel(state);

    const primary = primaryActivity(view);
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
    const bubbleNow = Date.now();
    bubbleState = reducePetBubbleState(bubbleState, {
      type: "snapshot",
      signal,
      now: bubbleNow,
    });
    if (petCaption) {
      petCaption.hidden = !bubbleState.visible;
      petCaption.dataset.bubbleMode = bubbleState.mode ?? "hidden";
    }
    if (petCaptionState) petCaptionState.textContent = frame.label || petStateLabel(state);
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

    if (tray) tray.hidden = !view.trayOpen;
    if (!view.trayOpen) settingsOpen = false;
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
      petButton.setAttribute(
        "aria-label",
        view.trayOpen ? "桌宠，点击收起活动列表，拖动可移动" : "桌宠，点击展开活动列表，拖动可移动",
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
        empty.textContent =
          view.projects.length > 0
            ? "此筛选下暂无活动"
            : view.connectionStatus === "connected"
              ? "当前没有可观察的活动"
              : "连接本地蜗牛派服务后即可观察任务";
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
    row.className = `activity-row${activity.unread ? " is-unread" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");
    row.setAttribute("aria-label", `${activity.title}，${petStateLabel(activity.presentation)}`);
    row.tabIndex = activity.activityId === selectedId ? 0 : -1;
    row.dataset.activityId = activity.activityId;

    const summary = document.createElement("div");
    summary.className = "activity-row-summary";

    const glyph = document.createElement("span");
    glyph.className = "row-glyph";
    glyph.textContent = petStateGlyph(activity.presentation);
    glyph.title = petStateLabel(activity.presentation);

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
    meta.textContent = [petStateLabel(activity.presentation), activity.phase]
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
    elapsed.textContent = formatElapsed(activity.elapsedMs);
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

  const endPetPointer = (target: HTMLElement, pointerId: number) => {
    if (petPointerId !== pointerId) return;
    try {
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // ignore release errors when the element is gone
    }
    target.classList.remove("is-dragging");
    const wasDragging = petDragging;
    petPointerId = null;
    petDragging = false;
    if (!wasDragging) {
      const primary = current ? primaryActivity(current) : null;
      if (
        current &&
        !current.trayOpen &&
        (primary?.presentation === "needs_input" || primary?.presentation === "blocked")
      ) {
        dismissActivityBubble(primary);
      }
      bridge?.toggleTray();
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
    try {
      petButton.setPointerCapture(event.pointerId);
    } catch {
      // older hosts may lack capture; move/up still work while over the button
    }
  });

  petButton?.addEventListener("pointermove", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    if (petPointerId !== event.pointerId) return;
    const totalDx = event.screenX - petDragOriginX;
    const totalDy = event.screenY - petDragOriginY;
    if (
      !petDragging &&
      (Math.abs(totalDx) >= DRAG_THRESHOLD_PX || Math.abs(totalDy) >= DRAG_THRESHOLD_PX)
    ) {
      petDragging = true;
      petButton.classList.add("is-dragging");
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
    endPetPointer(petButton, event.pointerId);
  });

  petButton?.addEventListener("pointercancel", (event) => {
    if (!(petButton instanceof HTMLElement)) return;
    // Cancelled gestures should not toggle the tray.
    if (petPointerId === event.pointerId) {
      petDragging = true;
      endPetPointer(petButton, event.pointerId);
    }
  });

  // Suppress the synthetic click after pointerup so we do not double-toggle.
  petButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  btnMarkAll?.addEventListener("click", () => {
    const primary = current ? primaryActivity(current) : null;
    if (primary?.presentation === "ready" || primary?.presentation === "blocked") {
      dismissActivityBubble(primary);
    }
    bridge?.markAllRead();
  });

  btnRetry?.addEventListener("click", () => {
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

  const onKeyDown = (event: KeyboardEvent) => {
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
      root.removeEventListener("keydown", onKeyDown);
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
