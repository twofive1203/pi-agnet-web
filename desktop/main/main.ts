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
  handlePetWindowCloseRequest,
  handleSetAlwaysOnTop,
  handleSetClickThrough,
  handleShowPet,
  handleToggleTray,
  petWindowWebPreferences,
  PET_WINDOW_DEFAULTS,
  type PetWindowHandle,
  type WindowManagerState,
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
  let stale = false;
  let reducedMotion = false;
  let selectedActivityId: string | null = null;
  const defaultPosition = (() => {
    try {
      const screenApi = deps.screen;
      if (!screenApi) return { x: 80, y: 80 };
      return defaultPetWindowPosition(screenApi.getPrimaryDisplay().workArea);
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

  let windowState = createInitialWindowManagerState({
    position: savedPosition,
    defaultPosition,
    alwaysOnTop: settings.alwaysOnTop,
    clickThrough: settings.clickThrough,
    trayOpen: settings.activityTrayOpen,
  });

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
    });
    assertRendererViewSafe(view);
    return view;
  };

  const pushState = () => {
    const view = buildView();
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.send(PET_IPC_CHANNELS.stateChanged, view);
    }
    refreshTray(view);
  };

  const onConnectionState = (state: DesktopConnectionState) => {
    if (state.status !== "connected") {
      stale = snapshot != null;
    }
    // Surface the access-key form when server auth blocks attach.
    if (
      state.reasonCode === "auth_required" ||
      state.reasonCode === "auth_invalid"
    ) {
      if (!windowState.trayExpanded) {
        applyWindowState(handleToggleTray(windowState));
        return;
      }
    }
    pushState();
  };

  const onSnapshot = (json: string, meta: { reset: boolean; instanceId: string | null }) => {
    const next = parseSnapshotJson(json);
    if (!next) return;
    snapshot = next;
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

  function applyWindowState(next: WindowManagerState): void {
    windowState = next;
    if (petWindow && !petWindow.isDestroyed()) {
      applyWindowManagerState(petWindow, windowState);
    }
    const pos = windowState.bounds
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : settings.windowPosition;
    settings = updateDesktopSettings(settings, {
      activityTrayOpen: windowState.trayExpanded,
      clickThrough: windowState.clickThrough,
      alwaysOnTop: windowState.alwaysOnTop,
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
        applyWindowState(handleShowPet(windowState));
        petWindow?.focus();
        break;
      case "disable-click-through":
        applyWindowState(handleDisableClickThrough(windowState));
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
      show: true,
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

    applyWindowManagerState(handle, windowState);
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
      applyWindowState(handleShowPet(windowState));
      petWindow?.focus();
    });
    return t;
  }

  function registerIpc(): void {
    ipcMain.handle(PET_IPC_CHANNELS.getState, () => buildView());

    ipcMain.on(PET_IPC_CHANNELS.toggleTray, () => {
      applyWindowState(handleToggleTray(windowState));
    });

    ipcMain.on(PET_IPC_CHANNELS.hideToTray, () => {
      applyWindowState(handlePetWindowCloseRequest(windowState));
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
      settings = updateDesktopSettings(settings, {
        selectedPetId: p.selectedPetId,
        alwaysOnTop: p.alwaysOnTop,
        clickThrough: p.clickThrough,
        launchAtLogin: p.launchAtLogin,
        activityTrayOpen: p.activityTrayOpen,
        notification: p.notification,
        port: p.port,
      });
      if (typeof p.launchAtLogin === "boolean") {
        applyLaunchAtLogin(app, p.launchAtLogin);
      }
      if (typeof p.alwaysOnTop === "boolean" || typeof p.clickThrough === "boolean") {
        applyWindowState(
          handleSetClickThrough(
            handleSetAlwaysOnTop(windowState, settings.alwaysOnTop),
            settings.clickThrough,
          ),
        );
      }
      if (typeof p.port === "number" && p.port !== client.getState().port) {
        client.quit();
        // Recreate client on port change would need full restart; retry with new settings port.
        // For v1, persist and ask user to restart pet — still call retry on same client after update.
      }
      persistSettings();
      pushState();
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
    applyWindowState(handleShowPet(windowState));
    petWindow?.focus();
  });

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

function shouldAutoStartMain(): boolean {
  if (typeof process === "undefined") return false;
  if (!(process.versions as { electron?: string } | undefined)?.electron) return false;
  if (process.env.SNAIL_PET_DISABLE_AUTOMAIN === "1") return false;
  if (process.env.SNAIL_PET_MAIN === "1") return true;
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
  return /\/main(\.(js|cjs|mjs|ts))?$/i.test(entry) || entry.includes("/main.");
}

if (shouldAutoStartMain()) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
