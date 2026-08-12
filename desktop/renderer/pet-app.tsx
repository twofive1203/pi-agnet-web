/**
 * Desktop pet renderer app (U7).
 *
 * Presentation-only. Talks to main through window.snailPet preload bridge.
 * No Node, no token, no arbitrary navigation.
 *
 * Bundlers (Electron Forge / U8) should compile this file. A plain ES build
 * target can also emit pet-app.js next to index.html.
 */

import type { DesktopActivityRow, DesktopActivityView } from "../main/activity-store";
import type { SnailPetBridge } from "../preload/pet-preload";
import {
  connectionBannerText,
  formatElapsed,
  getBuiltinPetManifest,
  moveActivitySelection,
  petStateGlyph,
  petStateLabel,
  resolvePetFrame,
  type PetVisualState,
} from "./pet-state";

declare global {
  interface Window {
    snailPet?: SnailPetBridge;
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
  const petButton = root.getElementById("pet-button");
  const petAvatar = root.getElementById("pet-avatar");
  const petGlyph = root.getElementById("pet-glyph");
  const petLabel = root.getElementById("pet-label");
  const petBadge = root.getElementById("pet-badge");
  const tray = root.getElementById("activity-tray");
  const projectList = root.getElementById("project-list");
  const trayCounts = root.getElementById("tray-counts");
  const banner = root.getElementById("connection-banner");
  const authPanel = root.getElementById("auth-panel");
  const accessKeyInput = root.getElementById("access-key-input") as HTMLInputElement | null;
  const btnSaveKey = root.getElementById("btn-save-key");
  const btnClearKey = root.getElementById("btn-clear-key");
  const btnMarkAll = root.getElementById("btn-mark-all");
  const btnRetry = root.getElementById("btn-retry");
  const btnCopy = root.getElementById("btn-copy-cmd");
  const btnHide = root.getElementById("btn-hide");
  const btnHideTray = root.getElementById("btn-hide-tray");
  const staleFlag = root.getElementById("stale-flag");

  const hideToTray = () => {
    bridge?.hideToTray();
  };

  let current: DesktopActivityView | null = null;
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

  function activityIds(view: DesktopActivityView): string[] {
    const ids: string[] = [];
    for (const project of view.projects) {
      for (const activity of project.activities) ids.push(activity.activityId);
    }
    return ids;
  }

  function update(view: DesktopActivityView): void {
    current = view;
    const state = isPetVisualState(view.presentation) ? view.presentation : "idle";
    const manifest = getBuiltinPetManifest(view.selectedPetId);
    const frame = resolvePetFrame(manifest, state, view.reducedMotion || reducedMotion);

    if (petAvatar) {
      petAvatar.className = `pet-avatar frame-${frame.frame}${frame.animated ? " is-animated" : ""}`;
      petAvatar.setAttribute("data-state", state);
    }
    if (petGlyph) petGlyph.textContent = frame.glyph || petStateGlyph(state);
    if (petLabel) petLabel.textContent = frame.label || petStateLabel(state);

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
    if (petButton) {
      petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
    }

    if (trayCounts) {
      const active = view.activeCount;
      const attention = view.attentionCount;
      trayCounts.textContent = `活动 ${active} · 关注 ${attention}`;
    }

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

    if (projectList) {
      projectList.replaceChildren();
      if (view.projects.length === 0) {
        const empty = root.createElement("div");
        empty.className = "empty-tray";
        empty.textContent =
          view.connectionStatus === "connected"
            ? "当前没有可观察的活动"
            : "连接本地蜗牛派服务后即可观察任务";
        projectList.appendChild(empty);
      } else {
        for (const project of view.projects) {
          const group = root.createElement("div");
          group.className = "project-group";
          group.setAttribute("role", "group");
          const name = root.createElement("div");
          name.className = "project-name";
          name.textContent = project.displayName;
          group.appendChild(name);
          for (const activity of project.activities) {
            group.appendChild(renderRow(activity, view.selectedActivityId));
          }
          projectList.appendChild(group);
        }
      }
    }
  }

  function renderRow(activity: DesktopActivityRow, selectedId: string | null): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `activity-row${activity.unread ? " is-unread" : ""}`;
    btn.setAttribute("role", "listitem");
    btn.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");
    btn.dataset.activityId = activity.activityId;

    const glyph = document.createElement("span");
    glyph.className = "row-glyph";
    glyph.textContent = petStateGlyph(activity.presentation);
    glyph.title = petStateLabel(activity.presentation);

    const main = document.createElement("span");
    main.className = "row-main";
    const title = document.createElement("div");
    title.className = "row-title";
    title.textContent = activity.title;
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent = `${petStateLabel(activity.presentation)} · ${activity.source}`;
    main.append(title, meta);

    const elapsed = document.createElement("span");
    elapsed.className = "row-elapsed";
    elapsed.textContent = formatElapsed(activity.elapsedMs);

    btn.append(glyph, main, elapsed);
    btn.addEventListener("click", () => {
      bridge?.selectActivity(activity.activityId);
      void bridge?.openActivity(activity.activityId);
    });
    btn.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        bridge?.selectActivity(activity.activityId);
        void bridge?.openActivity(activity.activityId);
      }
      if ((event.key === "m" || event.key === "M") && activity.unread) {
        event.preventDefault();
        bridge?.markRead(activity.activityId);
      }
    });
    return btn;
  }

  petButton?.addEventListener("click", () => {
    bridge?.toggleTray();
  });

  btnMarkAll?.addEventListener("click", () => {
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
    hideToTray();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (!current?.trayOpen) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const ids = activityIds(current);
      const next = moveActivitySelection(
        ids,
        current.selectedActivityId,
        event.key === "ArrowDown" ? "next" : "prev",
      );
      if (next) bridge?.selectActivity(next);
    }
    if (event.key === "Enter" && current.selectedActivityId) {
      event.preventDefault();
      void bridge?.openActivity(current.selectedActivityId);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (current.trayOpen) bridge?.toggleTray();
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
      root.removeEventListener("keydown", onKeyDown);
      unsubscribe?.();
    },
  };
}

function boot(): void {
  if (typeof document === "undefined") return;
  if (!document.getElementById("root")) return;
  renderPetApp(document);
}

boot();
