/**
 * Minimal ambient Electron typings for the desktop pet package (U7).
 * Avoids requiring the electron npm package for `tsc --noEmit` / pure smokes.
 * Real Electron is provided at runtime by Electron Forge packaging (U8).
 */

declare module "electron" {
  export interface Size {
    width: number;
    height: number;
  }

  export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface WebPreferences {
    preload?: string;
    nodeIntegration?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
    webSecurity?: boolean;
    spellcheck?: boolean;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    show?: boolean;
    frame?: boolean;
    transparent?: boolean;
    resizable?: boolean;
    skipTaskbar?: boolean;
    alwaysOnTop?: boolean;
    hasShadow?: boolean;
    fullscreenable?: boolean;
    maximizable?: boolean;
    minimizable?: boolean;
    closable?: boolean;
    focusable?: boolean;
    thickFrame?: boolean;
    backgroundColor?: string;
    title?: string;
    icon?: string;
    webPreferences?: WebPreferences;
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    static getAllWindows(): BrowserWindow[];
    readonly webContents: WebContents;
    loadFile(filePath: string, options?: { query?: Record<string, string> }): Promise<void>;
    loadURL(url: string): Promise<void>;
    show(): void;
    hide(): void;
    close(): void;
    destroy(): void;
    isDestroyed(): boolean;
    isVisible(): boolean;
    isFocused(): boolean;
    focus(): void;
    blur(): void;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
    setAlwaysOnTop(flag: boolean, level?: string): void;
    getBounds(): Rectangle;
    setBounds(bounds: Partial<Rectangle>, animate?: boolean): void;
    setSize(width: number, height: number): void;
    setPosition(x: number, y: number): void;
    getPosition(): number[];
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebContents {
    send(channel: string, ...args: unknown[]): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" | "allow" }): void;
    session: {
      setPermissionRequestHandler(
        handler: (
          webContents: WebContents,
          permission: string,
          callback: (approval: boolean) => void,
        ) => void,
      ): void;
    };
  }

  export class Tray {
    constructor(image: NativeImage | string);
    setToolTip(tooltip: string): void;
    setContextMenu(menu: Menu | null): void;
    setImage(image: NativeImage | string): void;
    destroy(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class Menu {
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  }

  export interface MenuItemConstructorOptions {
    label?: string;
    type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
    checked?: boolean;
    enabled?: boolean;
    click?: () => void;
    role?: string;
    submenu?: MenuItemConstructorOptions[];
    accelerator?: string;
  }

  export class NativeImage {
    isEmpty(): boolean;
  }

  export class Notification {
    static isSupported(): boolean;
    constructor(options: {
      title: string;
      body: string;
      silent?: boolean;
      urgency?: string;
      toastXml?: string;
    });
    show(): void;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class ipcMain {
    static handle(
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void;
    static on(
      channel: string,
      listener: (event: IpcMainEvent, ...args: unknown[]) => void,
    ): void;
    static removeHandler(channel: string): void;
  }

  export interface IpcMainEvent {
    sender: WebContents;
  }

  export interface IpcMainInvokeEvent {
    sender: WebContents;
  }

  export class ipcRenderer {
    static invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    static send(channel: string, ...args: unknown[]): void;
    static on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    static removeAllListeners(channel: string): void;
  }

  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  };

  export const shell: {
    openExternal(url: string): Promise<void>;
  };

  export const clipboard: {
    writeText(text: string): void;
    readText(): string;
  };

  export const app: {
    whenReady(): Promise<void>;
    quit(): void;
    exit(code?: number): void;
    getPath(name: string): string;
    getName(): string;
    setName(name: string): void;
    setAppUserModelId(id: string): void;
    requestSingleInstanceLock(): boolean;
    on(event: string, listener: (...args: unknown[]) => void): void;
    isReady(): boolean;
    getLoginItemSettings(): { openAtLogin: boolean; openAsHidden?: boolean };
    setLoginItemSettings(settings: { openAtLogin: boolean; openAsHidden?: boolean }): void;
    commandLine: {
      appendSwitch(switchName: string, value?: string): void;
    };
    dock?: {
      hide(): void;
    };
  };

  export const nativeImage: {
    createFromPath(path: string): NativeImage;
    createEmpty(): NativeImage;
    createFromDataURL(dataURL: string): NativeImage;
  };

  export const screen: {
    getPrimaryDisplay(): { workArea: Rectangle; bounds: Rectangle };
    getCursorScreenPoint(): { x: number; y: number };
  };

  export const nativeTheme: {
    shouldUseDarkColors: boolean;
    on(event: string, listener: () => void): void;
  };

  export const systemPreferences: {
    getAnimationSettings?: () => { prefersReducedMotion?: boolean };
  };
}
