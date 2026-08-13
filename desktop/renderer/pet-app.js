"use strict";
(() => {
  // lib/task-observer-types.ts
  var TASK_OBSERVER_BUDGETS = {
    maxProjects: 50,
    maxActivities: 200,
    maxRecentTransitions: 20,
    maxChildrenPerActivity: 8,
    maxEncodedBytes: 256 * 1024,
    maxTitleChars: 120,
    maxProjectNameChars: 80,
    maxProjectKeyChars: 128,
    maxPhaseChars: 64,
    maxReasonCodeChars: 64,
    maxDeepLinkChars: 256,
    maxToolNameChars: 64,
    maxDiagnostics: 20,
    maxDiagnosticCodeChars: 64,
    maxDiagnosticMessageChars: 160,
    /** Desktop-local acknowledged/notified transition LRU capacity (presentation only). */
    maxLocalAckTransitions: 500
  };

  // desktop/renderer/pet-state.ts
  var DEFAULT_FRAMES = {
    service_not_running: {
      frame: "service-not-running",
      staticFrame: "service-not-running",
      // Short zh labels fit the collapsed avatar without clipping.
      label: "\u672A\u542F\u52A8",
      glyph: "\u23FB"
    },
    disconnected: {
      frame: "disconnected",
      staticFrame: "disconnected",
      label: "\u672A\u8FDE\u63A5",
      glyph: "\u26A0"
    },
    needs_input: {
      frame: "needs-input",
      staticFrame: "needs-input",
      label: "\u5F85\u8F93\u5165",
      glyph: "?"
    },
    blocked: {
      frame: "blocked",
      staticFrame: "blocked",
      label: "\u53D7\u963B",
      glyph: "!"
    },
    ready: {
      frame: "ready",
      staticFrame: "ready",
      label: "\u5DF2\u5B8C\u6210",
      glyph: "\u2713"
    },
    retrying: {
      frame: "retrying",
      staticFrame: "retrying-static",
      label: "\u91CD\u8BD5\u4E2D",
      glyph: "\u21BB"
    },
    running: {
      frame: "running",
      staticFrame: "running-static",
      label: "\u8FD0\u884C\u4E2D",
      glyph: "\u203A"
    },
    idle: {
      frame: "idle",
      staticFrame: "idle",
      label: "\u7A7A\u95F2",
      glyph: "\xB7"
    }
  };
  function buildDefaultPetManifest(id, name, version = 1) {
    return {
      id,
      name,
      version,
      states: { ...DEFAULT_FRAMES }
    };
  }
  var BUILTIN_PET_MANIFESTS = [
    buildDefaultPetManifest("snail-default", "Snail"),
    buildDefaultPetManifest("snail-classic", "Classic Snail")
  ];
  function getBuiltinPetManifest(petId) {
    return BUILTIN_PET_MANIFESTS.find((pet) => pet.id === petId) ?? BUILTIN_PET_MANIFESTS[0];
  }
  function resolvePetFrame(manifest, state, reducedMotion) {
    const entry = manifest.states[state] ?? DEFAULT_FRAMES[state] ?? DEFAULT_FRAMES.idle;
    const frame = reducedMotion ? entry.staticFrame : entry.frame;
    const animated = !reducedMotion && state !== "service_not_running" && state !== "disconnected";
    return {
      frame,
      label: entry.label,
      glyph: entry.glyph,
      animated
    };
  }
  function petStateLabel(state) {
    return DEFAULT_FRAMES[state]?.label ?? state;
  }
  function petStateGlyph(state) {
    return DEFAULT_FRAMES[state]?.glyph ?? "\xB7";
  }
  var SOURCE_LABELS = {
    agent: "Agent",
    snflow: "SnFlow",
    automation: "\u81EA\u52A8\u5316",
    quick_command: "\u5FEB\u6377\u547D\u4EE4"
  };
  function petSourceLabel(source) {
    return SOURCE_LABELS[source] ?? source;
  }
  function formatActivityProgress(progress, childCount = 0) {
    if (progress.kind === "ratio") {
      const current = Math.max(0, Math.floor(progress.current));
      const total = Math.max(0, Math.floor(progress.total));
      if (total <= 0) return null;
      const boundedCurrent = Math.min(current, total);
      return `${boundedCurrent}/${total} \xB7 ${Math.round(boundedCurrent / total * 100)}%`;
    }
    if (progress.kind === "counters") {
      const parts = [];
      if (progress.currentToolName) parts.push(progress.currentToolName);
      if (typeof progress.turnCount === "number") parts.push(`${progress.turnCount} \u56DE\u5408`);
      if (typeof progress.toolCount === "number") parts.push(`${progress.toolCount} \u5DE5\u5177`);
      const active = progress.activeSubagents ?? 0;
      const completed = progress.completedSubagents ?? 0;
      const subagents = Math.max(childCount, active + completed);
      if (subagents > 0) parts.push(`${subagents} Subagent`);
      return parts.length > 0 ? parts.join(" \xB7 ") : null;
    }
    return childCount > 0 ? `${childCount} Subagent` : null;
  }
  function formatElapsed(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "\u2014";
    const totalSec = Math.floor(ms / 1e3);
    if (totalSec < 60) return `${totalSec}s`;
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return `${min}m ${sec}s`;
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return `${hr}h ${remMin}m`;
  }
  function moveActivitySelection(activityIds, currentId, direction) {
    if (activityIds.length === 0) return null;
    if (currentId == null) {
      return direction === "next" ? activityIds[0] : activityIds[activityIds.length - 1];
    }
    const index = activityIds.indexOf(currentId);
    if (index === -1) {
      return direction === "next" ? activityIds[0] : activityIds[activityIds.length - 1];
    }
    if (direction === "next") {
      return activityIds[(index + 1) % activityIds.length];
    }
    return activityIds[(index - 1 + activityIds.length) % activityIds.length];
  }
  function connectionBannerText(input) {
    if (input.connectionStatus === "service-not-running") {
      return `\u8717\u725B\u6D3E\u670D\u52A1\u672A\u542F\u52A8 \u2014 \u590D\u5236 \`${input.startCommand}\` \u540E\u5728\u7EC8\u7AEF\u542F\u52A8\uFF0C\u7136\u540E\u91CD\u8BD5`;
    }
    if (input.connectionStatus === "incompatible") {
      if (input.reasonCode === "auth_required") {
        return "\u670D\u52A1\u5DF2\u5F00\u542F\u8BBF\u95EE\u5BC6\u94A5 \u2014 \u8BF7\u5728\u4E0B\u65B9\u7C98\u8D34\u5BC6\u94A5\u540E\u8FDE\u63A5";
      }
      if (input.reasonCode === "auth_invalid") {
        return "\u8BBF\u95EE\u5BC6\u94A5\u65E0\u6548 \u2014 \u8BF7\u91CD\u65B0\u7C98\u8D34\u6B63\u786E\u7684\u5BC6\u94A5";
      }
      return `\u4E0D\u517C\u5BB9\u7684\u670D\u52A1${input.reasonCode ? ` (${input.reasonCode})` : ""} \u2014 \u8BF7\u68C0\u67E5\u7AEF\u53E3\u540E\u91CD\u8BD5`;
    }
    if (input.connectionStatus === "reconnecting" || input.connectionStatus === "probing") {
      return input.connectionStatus === "probing" ? "\u6B63\u5728\u8FDE\u63A5\u672C\u5730\u670D\u52A1\u2026" : "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE\u2026";
    }
    return null;
  }

  // desktop/renderer/pet-app.tsx
  function isPetVisualState(value) {
    return value === "service_not_running" || value === "disconnected" || value === "needs_input" || value === "blocked" || value === "ready" || value === "retrying" || value === "running" || value === "idle";
  }
  function renderPetApp(root = document) {
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
    const accessKeyInput = root.getElementById("access-key-input");
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
    const prefAlwaysOnTop = root.getElementById("pref-always-on-top");
    const prefClickThrough = root.getElementById("pref-click-through");
    const prefLaunchAtLogin = root.getElementById("pref-launch-at-login");
    const prefCompletion = root.getElementById("pref-completion");
    const prefNeedsInput = root.getElementById("pref-needs-input");
    const prefBlocked = root.getElementById("pref-blocked");
    const staleFlag = root.getElementById("stale-flag");
    const hideToTray = () => {
      bridge?.hideToTray();
    };
    const DRAG_THRESHOLD_PX = 5;
    let current = null;
    let settingsOpen = false;
    let reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    function activityIds(view) {
      const ids = [];
      for (const project of view.projects) {
        for (const activity of project.activities) ids.push(activity.activityId);
      }
      return ids;
    }
    function update(view) {
      current = view;
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
      const primaryActivity = view.projects[0]?.activities[0] ?? null;
      const showCaption = primaryActivity != null || state !== "idle";
      if (petCaption) petCaption.hidden = !showCaption;
      if (petCaptionState) petCaptionState.textContent = frame.label || petStateLabel(state);
      if (petCaptionTitle) {
        petCaptionTitle.textContent = primaryActivity?.title ?? connectionBannerText({
          connectionStatus: view.connectionStatus,
          canCopyStartCommand: view.canCopyStartCommand,
          startCommand: view.startCommand,
          reasonCode: view.connectionReasonCode
        }) ?? "";
      }
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
      if (projectList) projectList.hidden = settingsOpen;
      if (btnSettings) {
        btnSettings.setAttribute("aria-expanded", settingsOpen ? "true" : "false");
      }
      if (petRoot) {
        petRoot.classList.toggle("is-collapsed", !view.trayOpen);
        petRoot.classList.toggle("is-expanded", view.trayOpen);
        const anchor = view.trayAnchor === "top-right" || view.trayAnchor === "bottom-left" || view.trayAnchor === "bottom-right" ? view.trayAnchor : "top-left";
        petRoot.setAttribute("data-tray-anchor", view.trayOpen ? anchor : "top-left");
      }
      if (petButton) {
        petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
        petButton.setAttribute(
          "aria-label",
          view.trayOpen ? "\u684C\u5BA0\uFF0C\u70B9\u51FB\u6536\u8D77\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8" : "\u684C\u5BA0\uFF0C\u70B9\u51FB\u5C55\u5F00\u6D3B\u52A8\u5217\u8868\uFF0C\u62D6\u52A8\u53EF\u79FB\u52A8"
        );
      }
      if (trayCounts) {
        const active = view.activeCount;
        const attention = view.attentionCount;
        trayCounts.textContent = `\u6D3B\u52A8 ${active} \xB7 \u5173\u6CE8 ${attention}`;
      }
      const bannerText = connectionBannerText({
        connectionStatus: view.connectionStatus,
        canCopyStartCommand: view.canCopyStartCommand,
        startCommand: view.startCommand,
        reasonCode: view.connectionReasonCode
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
      petPicker?.querySelectorAll("[data-pet-id]").forEach((option) => {
        const selected = option.dataset.petId === view.selectedPetId;
        option.setAttribute("aria-checked", selected ? "true" : "false");
      });
      if (projectList) {
        projectList.replaceChildren();
        if (view.projects.length === 0) {
          const empty = root.createElement("div");
          empty.className = "empty-tray";
          empty.textContent = view.connectionStatus === "connected" ? "\u5F53\u524D\u6CA1\u6709\u53EF\u89C2\u5BDF\u7684\u6D3B\u52A8" : "\u8FDE\u63A5\u672C\u5730\u8717\u725B\u6D3E\u670D\u52A1\u540E\u5373\u53EF\u89C2\u5BDF\u4EFB\u52A1";
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
    function renderRow(activity, selectedId) {
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
      meta.textContent = [petStateLabel(activity.presentation), activity.phase].filter(Boolean).join(" \xB7 ");
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
      if (activity.children.length > 0) {
        const children = document.createElement("span");
        children.className = "row-children";
        for (const child of activity.children.slice(0, 3)) {
          const chip = document.createElement("span");
          chip.className = "row-child";
          chip.textContent = `${child.executionState === "settled" ? "\u2713" : "\u21B3"} ${child.title}`;
          children.appendChild(chip);
        }
        main.appendChild(children);
      }
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
    let petPointerId = null;
    let petDragOriginX = 0;
    let petDragOriginY = 0;
    let petLastScreenX = 0;
    let petLastScreenY = 0;
    let petDragging = false;
    const endPetPointer = (target, pointerId) => {
      if (petPointerId !== pointerId) return;
      try {
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
      }
      target.classList.remove("is-dragging");
      const wasDragging = petDragging;
      petPointerId = null;
      petDragging = false;
      if (!wasDragging) {
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
      }
    });
    petButton?.addEventListener("pointermove", (event) => {
      if (!(petButton instanceof HTMLElement)) return;
      if (petPointerId !== event.pointerId) return;
      const totalDx = event.screenX - petDragOriginX;
      const totalDy = event.screenY - petDragOriginY;
      if (!petDragging && (Math.abs(totalDx) >= DRAG_THRESHOLD_PX || Math.abs(totalDy) >= DRAG_THRESHOLD_PX)) {
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
      if (petPointerId === event.pointerId) {
        petDragging = true;
        endPetPointer(petButton, event.pointerId);
      }
    });
    petButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
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
      bridge?.toggleTray();
    });
    btnSettings?.addEventListener("click", () => {
      settingsOpen = !settingsOpen;
      if (current) update(current);
    });
    petPicker?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-pet-id]") : null;
      const selectedPetId = target?.dataset.petId;
      if (!selectedPetId) return;
      bridge?.setPrefs({ selectedPetId });
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
    const onKeyDown = (event) => {
      if (!current?.trayOpen) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const ids = activityIds(current);
        const next = moveActivitySelection(
          ids,
          current.selectedActivityId,
          event.key === "ArrowDown" ? "next" : "prev"
        );
        if (next) bridge?.selectActivity(next);
      }
      if (event.key === "Enter" && current.selectedActivityId) {
        event.preventDefault();
        void bridge?.openActivity(current.selectedActivityId);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (settingsOpen) {
          settingsOpen = false;
          update(current);
        } else if (current.trayOpen) {
          bridge?.toggleTray();
        }
      }
    };
    root.addEventListener("keydown", onKeyDown);
    let unsubscribe;
    if (bridge) {
      unsubscribe = bridge.onStateChanged((view) => {
        update(view);
      });
      void bridge.getState().then((view) => {
        if (view) update(view);
      });
    }
    return {
      update,
      destroy: () => {
        root.removeEventListener("keydown", onKeyDown);
        unsubscribe?.();
      }
    };
  }
  function boot() {
    if (typeof document === "undefined") return;
    if (!document.getElementById("root")) return;
    renderPetApp(document);
  }
  boot();
})();
