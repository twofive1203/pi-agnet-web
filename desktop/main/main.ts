/**
 * Electron main entry for the Snail Pi desktop pet (U7).
 *
 * Attach-only observer: never spawns/stops/signals the Snail Pi service.
 * Tokens stay in main memory; renderer receives sanitized activity views only.
 *
 * Runtime requires Electron (packaged via Electron Forge in U8). Pure domain
 * modules remain importable without Electron for smokes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  assertRendererViewSafe,
  buildActivityView,
  findActivityById,
  markActivityRead,
  markAllTerminalRead,
  type DesktopActivityView,
} from "./activity-store";
import {
  clearDesktopAccessKey,
  createMemoryAccessKeyCodec,
  createSafeStorageAccessKeyCodec,
  loadDesktopAccessKey,
  normalizeAccessKeyInput,
  saveDesktopAccessKey,
  type AccessKeyCodec,
  type AccessKeyFs,
} from "./access-key-store";
import { applyLaunchAtLogin } from "./autostart";
import type { DesktopConnectionState } from "./connection-state";
import { openValidatedDeepLink, rejectArbitraryRendererUrl } from "./deep-link-opener";
import { PET_IPC_CHANNELS, type PetPrefsPatch } from "./ipc-contract";
import { DesktopNotificationController } from "./notification-controller";
import { DesktopObserverClient } from "./observer-client";
import {
  loadDesktopSettingsFile,
  saveDesktopSettingsFile,
  type SettingsFs,
} from "./settings-persistence";
import {
  updateDesktopSettings,
  type DesktopPetSettings,
} from "./settings-store";
import {
  assertQuitLabelSafe,
  buildTrayMenuModel,
  buildTrayTooltip,
  trayItemToAction,
  type TrayMenuItem,
} from "./tray-controller";
import {
  applyWindowManagerState,
  createInitialWindowManagerState,
  defaultPetWindowPosition,
  handleBoundsChanged,
  handleDisableClickThrough,
  handleMoveBy,
  handlePetWindowCloseRequest,
  handleRestoreDefaultPosition,
  handleSetAlwaysOnTop,
  handleSetClickThrough,
  handleSetPetScale,
  handleShowPet,
  handleToggleTray,
  petWindowWebPreferences,
  recoverWindowToNearestWorkArea,
  resolvePetWindowReveal,
  sendPetWindowChannel,
  PET_WINDOW_DEFAULTS,
  type PetWindowHandle,
  type PetWindowRevealReason,
  type WindowManagerState,
  type WorkAreaRect,
} from "./window-manager";

type ElectronApp = typeof import("electron").app;
type ElectronBrowserWindow = typeof import("electron").BrowserWindow;
type ElectronIpcMain = typeof import("electron").ipcMain;
type ElectronShell = typeof import("electron").shell;
type ElectronClipboard = typeof import("electron").clipboard;
type ElectronTray = typeof import("electron").Tray;
type ElectronMenu = typeof import("electron").Menu;
type ElectronNotification = typeof import("electron").Notification;
type ElectronNativeImage = typeof import("electron").nativeImage;
type ElectronScreen = typeof import("electron").screen;

export type DesktopMainDeps = {
  app: ElectronApp;
  BrowserWindow: ElectronBrowserWindow;
  ipcMain: ElectronIpcMain;
  shell: ElectronShell;
  clipboard: ElectronClipboard;
  Tray: ElectronTray;
  Menu: ElectronMenu;
  Notification: ElectronNotification;
  nativeImage: ElectronNativeImage;
  screen?: ElectronScreen;
  userDataDir?: string;
  assetRoot?: string;
  settingsFs?: SettingsFs;
  accessKeyFs?: AccessKeyFs;
  accessKeyCodec?: AccessKeyCodec;
  /** Optional Electron safeStorage; used when accessKeyCodec is omitted. */
  safeStorage?: {
    isEncryptionAvailable: () => boolean;
    encryptString: (plain: string) => Buffer;
    decryptString: (blob: Buffer) => string;
  };
  createObserverClient?: (options: ConstructorParameters<typeof DesktopObserverClient>[0]) => DesktopObserverClient;
};

const nodeSettingsFs: SettingsFs = {
  readFile: (p, enc) => fs.readFileSync(p, enc),
  writeFile: (p, data, enc) => fs.writeFileSync(p, data, enc),
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
  exists: (p) => fs.existsSync(p),
};

function parseSnapshotJson(json: string): import("../../lib/task-observer-types").TaskObserverSnapshot | null {
  try {
    const parsed = JSON.parse(json) as import("../../lib/task-observer-types").TaskObserverSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.instanceId !== "string") return null;
    if (!Array.isArray(parsed.projects)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Boot the pet main process. Injectable Electron deps enable static wiring tests.
 */
export async function startDesktopPetMain(deps: DesktopMainDeps): Promise<{
  quit: () => void;
  getView: () => DesktopActivityView;
  getSettings: () => DesktopPetSettings;
}> {
  const {
    app,
    BrowserWindow,
    ipcMain,
    shell,
    clipboard,
    Tray,
    Menu,
    Notification,
    nativeImage,
  } = deps;

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return {
      quit: () => undefined,
      getView: () => {
        throw new Error("second instance");
      },
      getSettings: () => {
        throw new Error("second instance");
      },
    };
  }

  try {
    app.setAppUserModelId("com.twofive.snail-pi-pet");
  } catch {
    // non-Windows / older electron
  }

  await app.whenReady();

  const userDataDir = deps.userDataDir ?? app.getPath("userData");
  const settingsFs = deps.settingsFs ?? nodeSettingsFs;
  const accessKeyFs: AccessKeyFs = deps.accessKeyFs ?? {
    readFile: (p, enc) => fs.readFileSync(p, enc),
    writeFile: (p, data, enc) => fs.writeFileSync(p, data, enc),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    exists: (p) => fs.existsSync(p),
    unlink: (p) => fs.unlinkSync(p),
  };
  const accessKeyCodec =
    deps.accessKeyCodec ??
    (deps.safeStorage
      ? createSafeStorageAccessKeyCodec(deps.safeStorage)
      : createMemoryAccessKeyCodec());
  let settings = loadDesktopSettingsFile(userDataDir, settingsFs);
  let accessKey = loadDesktopAccessKey(userDataDir, accessKeyFs, accessKeyCodec);

  applyLaunchAtLogin(app, settings.launchAtLogin);

  let snapshot: import("../../lib/task-observer-types").TaskObserverSnapshot | null = null;
  let snapshotReset = false;
  let stale = false;
  let reducedMotion = false;
  let selectedActivityId: string | null = null;
  const collectWorkAreas = (): WorkAreaRect[] => {
    try {
      const screenApi = deps.screen;
      if (!screenApi) return [];
      return screenApi.getAllDisplays().map((display) => display.workArea);
    } catch {
      return [];
    }
  };

  const defaultPosition = (() => {
    try {
      const screenApi = deps.screen;
      if (!screenApi) return { x: 80, y: 80 };
      return defaultPetWindowPosition(
        screenApi.getPrimaryDisplay().workArea,
        settings.petScale,
      );
    } catch {
      return { x: 80, y: 80 };
    }
  })();

  // Treat missing/origin corner (0,0) as unset so first-run is not stuck top-left.
  const savedPosition =
    settings.windowPosition &&
    !(settings.windowPosition.x === 0 && settings.windowPosition.y === 0)
      ? settings.windowPosition
      : null;

  let windowState = recoverWindowToNearestWorkArea(
    createInitialWindowManagerState({
      position: savedPosition,
      defaultPosition,
      alwaysOnTop: settings.alwaysOnTop,
      clickThrough: settings.clickThrough,
      trayOpen: settings.activityTrayOpen,
      petScale: settings.petScale,
    }),
    collectWorkAreas(),
  );

  const notifications = new DesktopNotificationController();
  notifications.setHost({
    isSupported: () => {
      try {
        return Notification.isSupported();
      } catch {
        return false;
      }
    },
    show: (candidate) => {
      const n = new Notification({
        title: candidate.title,
        body: `${candidate.projectName} · ${candidate.body}`,
      });
      n.on("click", () => {
        openActivityDeepLink(candidate.deepLink);
      });
      n.show();
    },
  });

  const persistSettings = () => {
    try {
      saveDesktopSettingsFile(userDataDir, settings, settingsFs);
    } catch {
      // ignore disk errors; in-memory state remains authoritative for the session
    }
  };

  if (windowState.bounds) {
    const recoveredPosition = { x: windowState.bounds.x, y: windowState.bounds.y };
    const needsPersist =
      settings.petScale !== windowState.petScale ||
      !savedPosition ||
      savedPosition.x !== recoveredPosition.x ||
      savedPosition.y !== recoveredPosition.y;
    if (needsPersist) {
      settings = updateDesktopSettings(settings, {
        windowPosition: recoveredPosition,
        petScale: windowState.petScale,
      });
      persistSettings();
    }
  }

  let clientRef: DesktopObserverClient | null = null;
  let petWindow: PetWindowHandle | null = null;
  let tray: InstanceType<ElectronTray> | null = null;

  const buildView = (): DesktopActivityView => {
    const connection = clientRef?.getState() ?? ({
      status: "probing" as const,
      origin: `http://127.0.0.1:${settings.port}`,
      port: settings.port,
      startCommand: "spi --no-open",
      instanceId: null,
      reasonCode: null,
      detail: null,
      attempt: 0,
      resetNotificationBaseline: true,
      updatedAt: Date.now(),
    } satisfies DesktopConnectionState);
    const view = buildActivityView({
      snapshot,
      connection,
      settings,
      reducedMotion,
      selectedActivityId,
      stale,
      hasAccessKey: Boolean(accessKey),
      trayAnchor: windowState.trayExpanded ? windowState.trayAnchor : "top-left",
      reset: snapshotReset,
    });
    assertRendererViewSafe(view);
    return view;
  };

  const pushState = () => {
    const view = buildView();
    sendPetWindowChannel(petWindow, PET_IPC_CHANNELS.stateChanged, view);
    refreshTray(view);
  };

  const onConnectionState = (state: DesktopConnectionState) => {
    if (state.status !== "connected") {
      stale = snapshot != null;
    }
    // Expand an already-visible tray so the access-key form is reachable.
    // Never show/focus a hidden pet from reconnect or auth diagnostics.
    if (
      state.reasonCode === "auth_required" ||
      state.reasonCode === "auth_invalid"
    ) {
      if (windowState.visible && !windowState.trayExpanded) {
        applyWindowState(
          handleToggleTray(windowState, resolveWorkArea()),
          "passive-connection",
        );
        return;
      }
    }
    pushState();
  };

  const onSnapshot = (json: string, meta: { reset: boolean; instanceId: string | null }) => {
    const next = parseSnapshotJson(json);
    if (!next) return;
    snapshot = next;
    snapshotReset = meta.reset || next.reset === true;
    stale = false;
    const result = notifications.handleSnapshot({
      settings,
      snapshot,
      resetBaseline: meta.reset,
    });
    if (result.settings !== settings) {
      settings = result.settings;
      persistSettings();
    }
    pushState();
    snapshotReset = false;
  };

  const client =
    deps.createObserverClient?.({
      port: settings.port,
      accessKey,
      onStateChange: onConnectionState,
      onSnapshot,
    }) ??
    new DesktopObserverClient({
      port: settings.port,
      accessKey,
      onStateChange: onConnectionState,
      onSnapshot,
    });
  clientRef = client;

  function openActivityDeepLink(relativeHref: string): boolean {
    const result = openValidatedDeepLink({
      origin: client.getOrigin(),
      relativeHref,
      openExternal: (url) => {
        void shell.openExternal(url);
      },
    });
    return result.ok;
  }

  function openDefaultWebUi(): void {
    void shell.openExternal(client.getOrigin() + "/");
  }

  function copyStartCommand(): boolean {
    try {
      clipboard.writeText(client.getState().startCommand);
      return true;
    } catch {
      return false;
    }
  }

  function resolveWorkArea(bounds?: { x: number; y: number } | null): WorkAreaRect | null {
    try {
      const screenApi = deps.screen;
      if (!screenApi) return null;
      const point = bounds ?? windowState.bounds ?? { x: 0, y: 0 };
      return screenApi.getDisplayNearestPoint({ x: point.x, y: point.y }).workArea;
    } catch {
      return null;
    }
  }

  function applyWindowState(
    next: WindowManagerState,
    reason: PetWindowRevealReason = "passive-snapshot",
  ): void {
    windowState = next;
    if (petWindow && !petWindow.isDestroyed()) {
      applyWindowManagerState(petWindow, windowState, {
        reveal: resolvePetWindowReveal({ visible: windowState.visible, reason }),
      });
    }
    const pos = windowState.bounds
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : settings.windowPosition;
    settings = updateDesktopSettings(settings, {
      activityTrayOpen: windowState.trayExpanded,
      clickThrough: windowState.clickThrough,
      alwaysOnTop: windowState.alwaysOnTop,
      petScale: windowState.petScale,
      windowPosition: pos,
    });
    persistSettings();
    pushState();
  }

  function refreshTray(view: DesktopActivityView): void {
    if (!tray) return;
    tray.setToolTip(
      buildTrayTooltip({
        presentation: view.presentation,
        activeCount: view.activeCount,
        attentionCount: view.attentionCount,
      }),
    );
    const model = buildTrayMenuModel({
      presentation: view.presentation,
      connectionStatus: view.connectionStatus,
      clickThrough: windowState.clickThrough,
      dndEnabled: view.dndEnabled,
      activeCount: view.activeCount,
      attentionCount: view.attentionCount,
      canCopyStartCommand: view.canCopyStartCommand,
      startCommand: view.startCommand,
    });
    for (const item of model) {
      if (item.id === "quit") assertQuitLabelSafe(item.label);
    }
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplateFromModel(model)));
  }

  function menuTemplateFromModel(model: TrayMenuItem[]) {
    return model.map((item) => {
      if (item.type === "separator") return { type: "separator" as const };
      const action = trayItemToAction(item.id);
      return {
        label: item.label,
        enabled: item.enabled,
        checked: item.checked,
        click: action
          ? () => {
              handleTrayAction(action);
            }
          : undefined,
      };
    });
  }

  function handleTrayAction(action: ReturnType<typeof trayItemToAction>): void {
    if (!action) return;
    switch (action) {
      case "show-pet":
        applyWindowState(handleShowPet(windowState), "user-show");
        break;
      case "disable-click-through":
        applyWindowState(handleDisableClickThrough(windowState), "user-disable-click-through");
        break;
      case "toggle-dnd":
        // Local quiet mode only: observation, tray unread and server tasks stay
        // untouched. pushState also closes active suppressible bubbles in the
        // renderer immediately.
        settings = updateDesktopSettings(settings, {
          dndEnabled: !settings.dndEnabled,
        });
        persistSettings();
        pushState();
        break;
      case "retry":
        client.retry();
        break;
      case "open-webui":
        openDefaultWebUi();
        break;
      case "copy-start-command":
        copyStartCommand();
        break;
      case "quit":
        // No task-interruption warning — quitting the pet leaves spi/tasks untouched.
        shutdown();
        break;
      default:
        break;
    }
  }

  function createPetWindow(): PetWindowHandle {
    const preloadPath = path.join(assetPath(deps, "preload"), "pet-preload.js");
    const indexHtmlPath = path.join(assetPath(deps, "renderer"), "index.html");
    const bounds = windowState.bounds ?? {
      x: 40,
      y: 40,
      width: PET_WINDOW_DEFAULTS.petOnlyWidth,
      height: PET_WINDOW_DEFAULTS.petOnlyHeight,
    };

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      closable: true,
      skipTaskbar: true,
      alwaysOnTop: windowState.alwaysOnTop,
      hasShadow: false,
      fullscreenable: false,
      backgroundColor: "#00000000",
      webPreferences: petWindowWebPreferences(preloadPath),
    });

    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => {
      callback(false);
    });
    win.webContents.on("will-navigate", (event: unknown) => {
      const e = event as { preventDefault(): void };
      e.preventDefault();
    });

    void win.loadFile(indexHtmlPath);

    const handle: PetWindowHandle = {
      show: () => win.show(),
      showInactive: () => win.showInactive(),
      hide: () => win.hide(),
      close: () => win.close(),
      destroy: () => {
        if (!win.isDestroyed()) win.destroy();
      },
      isDestroyed: () => win.isDestroyed(),
      isVisible: () => win.isVisible(),
      focus: () => win.focus(),
      setAlwaysOnTop: (flag) => win.setAlwaysOnTop(flag),
      setIgnoreMouseEvents: (ignore, options) => win.setIgnoreMouseEvents(ignore, options),
      getBounds: () => win.getBounds(),
      setBounds: (next) => win.setBounds(next),
      send: (channel, payload) => {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
      },
      onClose: (handler) => {
        win.on("close", (event: unknown) => {
          handler(event as { preventDefault(): void });
        });
      },
      onMoved: (handler) => {
        const emit = () => handler(win.getBounds());
        win.on("moved", emit);
        win.on("resized", emit);
      },
      onBlur: (handler) => {
        win.on("blur", handler);
      },
      onFocus: (handler) => {
        win.on("focus", handler);
      },
    };

    handle.onClose((event) => {
      event.preventDefault();
      applyWindowState(handlePetWindowCloseRequest(windowState));
    });
    handle.onMoved((nextBounds) => {
      applyWindowState(handleBoundsChanged(windowState, nextBounds));
    });
    handle.onBlur(() => {
      notifications.setAppInBackground(true);
    });
    handle.onFocus(() => {
      notifications.setAppInBackground(false);
    });

    applyWindowManagerState(handle, windowState, {
      reveal: resolvePetWindowReveal({ visible: windowState.visible, reason: "startup" }),
    });
    return handle;
  }

  function createTrayIcon(): InstanceType<ElectronTray> {
    const iconPath = path.join(assetPath(deps, "assets"), "tray", "tray-icon.png");
    let image = nativeImage.createEmpty();
    try {
      if (fs.existsSync(iconPath)) {
        image = nativeImage.createFromPath(iconPath);
      }
    } catch {
      image = nativeImage.createEmpty();
    }
    if (image.isEmpty()) {
      // 1x1 PNG fallback so Tray construction does not throw on missing art.
      image = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      );
    }
    const t = new Tray(image);
    t.on("click", () => {
      applyWindowState(handleShowPet(windowState), "user-show");
    });
    return t;
  }

  function registerIpc(): void {
    ipcMain.handle(PET_IPC_CHANNELS.getState, () => buildView());

    ipcMain.on(PET_IPC_CHANNELS.toggleTray, () => {
      applyWindowState(handleToggleTray(windowState, resolveWorkArea()));
    });

    ipcMain.on(PET_IPC_CHANNELS.hideToTray, () => {
      applyWindowState(handlePetWindowCloseRequest(windowState));
    });

    ipcMain.on(PET_IPC_CHANNELS.moveBy, (_event, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const raw = payload as { dx?: unknown; dy?: unknown };
      const dx = typeof raw.dx === "number" && Number.isFinite(raw.dx) ? raw.dx : 0;
      const dy = typeof raw.dy === "number" && Number.isFinite(raw.dy) ? raw.dy : 0;
      if (dx === 0 && dy === 0) return;
      // Cap a single IPC tick so a buggy renderer cannot teleport the window.
      const capped = {
        dx: Math.max(-240, Math.min(240, dx)),
        dy: Math.max(-240, Math.min(240, dy)),
      };
      // Drag path: move only — skip pushState (view unchanged) to keep pointer smooth.
      const dragWorkAreas = collectWorkAreas();
      const next = handleMoveBy(
        windowState,
        capped,
        dragWorkAreas.length > 0 ? dragWorkAreas : resolveWorkArea(),
      );
      if (next === windowState) return;
      windowState = next;
      if (petWindow && !petWindow.isDestroyed() && windowState.bounds) {
        petWindow.setBounds(windowState.bounds);
      }
      const pos = windowState.bounds
        ? { x: windowState.bounds.x, y: windowState.bounds.y }
        : settings.windowPosition;
      settings = updateDesktopSettings(settings, { windowPosition: pos });
      // Persist on native moved/resized; here only update in-memory. Flush via onMoved.
    });

    ipcMain.on(PET_IPC_CHANNELS.selectActivity, (_event, activityId: unknown) => {
      if (typeof activityId !== "string") return;
      selectedActivityId = activityId;
      pushState();
    });

    ipcMain.on(PET_IPC_CHANNELS.markRead, (_event, activityId: unknown) => {
      if (typeof activityId !== "string") return;
      const view = buildView();
      const row = findActivityById(view.projects, activityId);
      if (!row) return;
      settings = markActivityRead(settings, row);
      persistSettings();
      pushState();
    });

    ipcMain.on(PET_IPC_CHANNELS.markAllRead, () => {
      const view = buildView();
      settings = markAllTerminalRead(settings, view);
      persistSettings();
      pushState();
    });

    ipcMain.handle(PET_IPC_CHANNELS.openActivity, (_event, activityId: unknown) => {
      if (typeof activityId !== "string") return { ok: false, reason: "bad_id" };
      const view = buildView();
      const row = findActivityById(view.projects, activityId);
      if (!row) return { ok: false, reason: "missing" };
      settings = markActivityRead(settings, row);
      persistSettings();
      const ok = openActivityDeepLink(row.deepLink);
      pushState();
      return { ok };
    });

    ipcMain.handle(PET_IPC_CHANNELS.openExternalUrl, (_event, url: unknown) => {
      if (typeof url !== "string") return { ok: false, reason: "bad_url" };
      // Absolute / arbitrary URLs from renderer are always rejected (AE6).
      const rejected = rejectArbitraryRendererUrl(url);
      if (rejected.reason === "absolute_url_rejected" || url.includes("://")) {
        return rejected;
      }
      return openValidatedDeepLink({
        origin: client.getOrigin(),
        relativeHref: url,
        openExternal: (href) => {
          void shell.openExternal(href);
        },
      });
    });

    ipcMain.on(PET_IPC_CHANNELS.retry, () => {
      client.retry();
    });

    ipcMain.handle(PET_IPC_CHANNELS.copyStartCommand, () => {
      // Copy only — never execute (R16).
      return { ok: copyStartCommand(), command: client.getState().startCommand };
    });

    ipcMain.on(PET_IPC_CHANNELS.setPrefs, (_event, patch: unknown) => {
      if (!patch || typeof patch !== "object") return;
      const p = patch as PetPrefsPatch;
      const previousScale = settings.petScale;
      settings = updateDesktopSettings(settings, {
        selectedPetId: p.selectedPetId,
        petScale: p.petScale,
        alwaysOnTop: p.alwaysOnTop,
        clickThrough: p.clickThrough,
        launchAtLogin: p.launchAtLogin,
        activityTrayOpen: p.activityTrayOpen,
        showContextMeter: p.showContextMeter,
        dndEnabled: p.dndEnabled,
        notification: p.notification,
        port: p.port,
      });
      if (typeof p.launchAtLogin === "boolean") {
        applyLaunchAtLogin(app, p.launchAtLogin);
      }
      let nextWindow = windowState;
      let windowTouched = false;
      if (typeof p.alwaysOnTop === "boolean" || typeof p.clickThrough === "boolean") {
        nextWindow = handleSetClickThrough(
          handleSetAlwaysOnTop(nextWindow, settings.alwaysOnTop),
          settings.clickThrough,
        );
        windowTouched = true;
      }
      if (settings.petScale !== previousScale || typeof p.petScale === "string") {
        nextWindow = handleSetPetScale(nextWindow, settings.petScale, resolveWorkArea());
        windowTouched = true;
      }
      if (typeof p.port === "number" && p.port !== client.getState().port) {
        client.quit();
        // Recreate client on port change would need full restart; retry with new settings port.
        // For v1, persist and ask user to restart pet — still call retry on same client after update.
      }
      if (windowTouched) {
        applyWindowState(nextWindow);
        return;
      }
      persistSettings();
      pushState();
    });

    ipcMain.on(PET_IPC_CHANNELS.restoreDefaultPosition, () => {
      const workArea =
        resolveWorkArea() ??
        collectWorkAreas()[0] ?? {
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
        };
      const defaultScaleState = handleSetPetScale(windowState, "medium", workArea);
      applyWindowState(
        handleRestoreDefaultPosition(defaultScaleState, workArea),
        "user-show",
      );
    });

    ipcMain.on(PET_IPC_CHANNELS.setReducedMotion, (_event, value: unknown) => {
      reducedMotion = value === true;
      pushState();
    });

    ipcMain.handle(PET_IPC_CHANNELS.setAccessKey, (_event, value: unknown) => {
      const next = normalizeAccessKeyInput(value);
      if (!next) {
        return { ok: false, reason: "invalid_key" };
      }
      accessKey = next;
      client.setAccessKey(next);
      const saved = saveDesktopAccessKey(userDataDir, next, accessKeyFs, accessKeyCodec);
      client.retry();
      pushState();
      return { ok: true, persisted: saved.persisted };
    });

    ipcMain.handle(PET_IPC_CHANNELS.clearAccessKey, () => {
      accessKey = null;
      client.setAccessKey(null);
      clearDesktopAccessKey(userDataDir, accessKeyFs);
      client.retry();
      pushState();
      return { ok: true };
    });
  }

  let stopped = false;
  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    client.quit();
    try {
      tray?.destroy();
    } catch {
      // ignore
    }
    tray = null;
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.destroy();
    }
    petWindow = null;
    app.quit();
  }

  app.on("second-instance", () => {
    applyWindowState(handleShowPet(windowState), "second-instance");
  });

  function recoverToVisibleDisplays(): void {
    const recovered = recoverWindowToNearestWorkArea(windowState, collectWorkAreas());
    if (recovered === windowState) return;
    applyWindowState(recovered);
  }

  try {
    const screenApi = deps.screen;
    screenApi?.on("display-added", recoverToVisibleDisplays);
    screenApi?.on("display-removed", recoverToVisibleDisplays);
    screenApi?.on("display-metrics-changed", recoverToVisibleDisplays);
  } catch {
    // older / test hosts may omit display events
  }

  registerIpc();
  petWindow = createPetWindow();
  tray = createTrayIcon();
  pushState();
  client.start();

  app.on("before-quit", () => {
    client.quit();
  });

  return {
    quit: shutdown,
    getView: () => buildView(),
    getSettings: () => settings,
  };
}

function assetPath(deps: DesktopMainDeps, kind: "preload" | "renderer" | "assets"): string {
  if (deps.assetRoot) {
    if (kind === "assets") return path.join(deps.assetRoot, "assets");
    return path.join(deps.assetRoot, kind);
  }
  // In packaged app, resources live next to main bundle.
  return path.join(__dirname, "..", kind === "assets" ? "assets" : kind);
}

/** CLI entry when launched under Electron. */
export async function main(): Promise<void> {
  // Dynamic import keeps pure smokes from loading electron at import time.
  const electron = await import("electron");
  if (isSquirrelLifecycleEvent(process.argv)) {
    if (process.argv.includes("--squirrel-uninstall")) {
      try {
        electron.app.setLoginItemSettings({ openAtLogin: false });
      } catch {
        // Best effort: uninstall must still exit promptly.
      }
    }
    electron.app.quit();
    return;
  }
  await startDesktopPetMain({
    app: electron.app,
    BrowserWindow: electron.BrowserWindow,
    ipcMain: electron.ipcMain,
    shell: electron.shell,
    clipboard: electron.clipboard,
    Tray: electron.Tray,
    Menu: electron.Menu,
    Notification: electron.Notification,
    nativeImage: electron.nativeImage,
    screen: electron.screen,
    safeStorage: electron.safeStorage,
  });
}

export function shouldAutoStartDesktopMain(input: {
  isElectron: boolean;
  disableAutoMain: boolean;
}): boolean {
  return input.isElectron && !input.disableAutoMain;
}

const SQUIRREL_LIFECYCLE_EVENTS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

export function isSquirrelLifecycleEvent(argv: readonly string[]): boolean {
  return argv.some((arg) => SQUIRREL_LIFECYCLE_EVENTS.has(arg));
}

function shouldAutoStartMain(): boolean {
  if (typeof process === "undefined") return false;
  return shouldAutoStartDesktopMain({
    isElectron: Boolean((process.versions as { electron?: string } | undefined)?.electron),
    disableAutoMain: process.env.SNAIL_PET_DISABLE_AUTOMAIN === "1",
  });
}

if (shouldAutoStartMain()) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
