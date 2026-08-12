/**
 * Plain runtime companion for index.html when TS is not bundled yet.
 * Keep behavior aligned with pet-app.tsx (U7).
 */
(function () {
  "use strict";

  const bridge = window.snailPet;
  const petButton = document.getElementById("pet-button");
  const petAvatar = document.getElementById("pet-avatar");
  const petGlyph = document.getElementById("pet-glyph");
  const petLabel = document.getElementById("pet-label");
  const petBadge = document.getElementById("pet-badge");
  const tray = document.getElementById("activity-tray");
  const projectList = document.getElementById("project-list");
  const trayCounts = document.getElementById("tray-counts");
  const banner = document.getElementById("connection-banner");
  const btnMarkAll = document.getElementById("btn-mark-all");
  const btnRetry = document.getElementById("btn-retry");
  const btnCopy = document.getElementById("btn-copy-cmd");
  const staleFlag = document.getElementById("stale-flag");

  const LABELS = {
    service_not_running: "Service not running",
    disconnected: "Disconnected",
    needs_input: "Needs input",
    blocked: "Blocked",
    ready: "Ready",
    retrying: "Retrying",
    running: "Running",
    idle: "Idle",
  };
  const GLYPHS = {
    service_not_running: "⏻",
    disconnected: "⚠",
    needs_input: "?",
    blocked: "!",
    ready: "✓",
    retrying: "↻",
    running: "›",
    idle: "·",
  };
  const FRAMES = {
    service_not_running: "service-not-running",
    disconnected: "disconnected",
    needs_input: "needs-input",
    blocked: "blocked",
    ready: "ready",
    retrying: "retrying",
    running: "running",
    idle: "idle",
  };
  const STATIC_FRAMES = {
    ...FRAMES,
    retrying: "retrying-static",
    running: "running-static",
  };

  let current = null;
  let reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function formatElapsed(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return totalSec + "s";
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min < 60) return min + "m " + sec + "s";
    const hr = Math.floor(min / 60);
    return hr + "h " + (min % 60) + "m";
  }

  function bannerText(view) {
    if (view.connectionStatus === "service-not-running") {
      return "蜗牛派服务未启动 — 复制 `" + view.startCommand + "` 后在终端启动，然后重试";
    }
    if (view.connectionStatus === "incompatible") {
      return (
        "不兼容的服务" +
        (view.connectionReasonCode ? " (" + view.connectionReasonCode + ")" : "") +
        " — 请检查端口后重试"
      );
    }
    if (view.connectionStatus === "probing") return "正在连接本地服务…";
    if (view.connectionStatus === "reconnecting") return "连接中断，正在重连…";
    return null;
  }

  function update(view) {
    current = view;
    const state = LABELS[view.presentation] ? view.presentation : "idle";
    const motion = view.reducedMotion || reducedMotion;
    const frame = motion ? STATIC_FRAMES[state] || FRAMES[state] : FRAMES[state];
    const animated = !motion && (state === "running" || state === "retrying");

    if (petAvatar) {
      petAvatar.className =
        "pet-avatar frame-" + frame + (animated ? " is-animated" : "");
      petAvatar.setAttribute("data-state", state);
    }
    if (petGlyph) petGlyph.textContent = GLYPHS[state] || "·";
    if (petLabel) petLabel.textContent = LABELS[state] || state;

    if (petBadge) {
      const count = (view.attentionCount || 0) + ((view.aggregate && view.aggregate.ready) || 0);
      if (count > 0) {
        petBadge.hidden = false;
        petBadge.textContent = count > 99 ? "99+" : String(count);
      } else {
        petBadge.hidden = true;
      }
    }

    if (tray) tray.hidden = !view.trayOpen;
    if (petButton) petButton.setAttribute("aria-expanded", view.trayOpen ? "true" : "false");
    if (trayCounts) {
      trayCounts.textContent =
        "活动 " + (view.activeCount || 0) + " · 关注 " + (view.attentionCount || 0);
    }

    const text = bannerText(view);
    if (banner) {
      if (text) {
        banner.hidden = false;
        banner.textContent = text;
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }
    if (btnCopy) btnCopy.hidden = !view.canCopyStartCommand;
    if (staleFlag) staleFlag.hidden = !view.stale;

    if (!projectList) return;
    projectList.replaceChildren();
    const projects = view.projects || [];
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-tray";
      empty.textContent =
        view.connectionStatus === "connected"
          ? "当前没有可观察的活动"
          : "连接本地蜗牛派服务后即可观察任务";
      projectList.appendChild(empty);
      return;
    }

    for (const project of projects) {
      const group = document.createElement("div");
      group.className = "project-group";
      const name = document.createElement("div");
      name.className = "project-name";
      name.textContent = project.displayName;
      group.appendChild(name);
      for (const activity of project.activities || []) {
        group.appendChild(renderRow(activity, view.selectedActivityId));
      }
      projectList.appendChild(group);
    }
  }

  function renderRow(activity, selectedId) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "activity-row" + (activity.unread ? " is-unread" : "");
    btn.setAttribute("aria-selected", activity.activityId === selectedId ? "true" : "false");

    const glyph = document.createElement("span");
    glyph.className = "row-glyph";
    glyph.textContent = GLYPHS[activity.presentation] || "·";

    const main = document.createElement("span");
    main.className = "row-main";
    const title = document.createElement("div");
    title.className = "row-title";
    title.textContent = activity.title;
    const meta = document.createElement("div");
    meta.className = "row-meta";
    meta.textContent =
      (LABELS[activity.presentation] || activity.presentation) + " · " + activity.source;
    main.append(title, meta);

    const elapsed = document.createElement("span");
    elapsed.className = "row-elapsed";
    elapsed.textContent = formatElapsed(activity.elapsedMs);

    btn.append(glyph, main, elapsed);
    btn.addEventListener("click", function () {
      if (!bridge) return;
      bridge.selectActivity(activity.activityId);
      bridge.openActivity(activity.activityId);
    });
    return btn;
  }

  if (petButton) {
    petButton.addEventListener("click", function () {
      if (bridge) bridge.toggleTray();
    });
  }
  if (btnMarkAll) {
    btnMarkAll.addEventListener("click", function () {
      if (bridge) bridge.markAllRead();
    });
  }
  if (btnRetry) {
    btnRetry.addEventListener("click", function () {
      if (bridge) bridge.retry();
    });
  }
  if (btnCopy) {
    btnCopy.addEventListener("click", function () {
      if (bridge) bridge.copyStartCommand();
    });
  }

  document.addEventListener("keydown", function (event) {
    if (!current || !current.trayOpen || !bridge) return;
    if (event.key === "Escape") {
      event.preventDefault();
      bridge.toggleTray();
    }
  });

  if (bridge) {
    bridge.setReducedMotion(reducedMotion);
    bridge.onStateChanged(function (view) {
      update(view);
    });
    bridge.getState().then(function (view) {
      if (view) update(view);
    });
  }
})();
