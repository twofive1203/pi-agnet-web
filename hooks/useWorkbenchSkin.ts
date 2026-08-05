"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  applyWorkbenchSkinToDocument,
  buildClearBackgroundSettings,
  buildGradientSettings,
  buildWallpaperSettings,
  clampWorkbenchGlass,
  clampWorkbenchLevel,
  DEFAULT_WORKBENCH_SKIN,
  encodeWorkbenchWallpaperFile,
  hasWorkbenchBackground,
  isWorkbenchSkinCustomized,
  normalizeWorkbenchSkinSettings,
  persistWorkbenchSkin,
  readWorkbenchSkinFromStorage,
  type WorkbenchGradientId,
  type WorkbenchSkinSettings,
} from "@/lib/theme-skin";

const listeners = new Set<() => void>();
let cachedSnapshot = "";
let cachedSettings: WorkbenchSkinSettings = DEFAULT_WORKBENCH_SKIN;
let hydrated = false;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function readSettings(): WorkbenchSkinSettings {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_SKIN;
  if (!hydrated) {
    cachedSettings = readWorkbenchSkinFromStorage();
    applyWorkbenchSkinToDocument(cachedSettings);
    hydrated = true;
    cachedSnapshot = serialize(cachedSettings);
  }
  return cachedSettings;
}

function serialize(settings: WorkbenchSkinSettings): string {
  return [
    settings.mode,
    settings.gradientId ?? "",
    settings.glass,
    settings.bgBlur,
    settings.vignette,
    settings.wallpaperDataUrl ? settings.wallpaperDataUrl.length : 0,
    settings.wallpaperDataUrl ? "1" : "0",
  ].join(":");
}

function commit(next: WorkbenchSkinSettings): void {
  const settings = normalizeWorkbenchSkinSettings(next);
  cachedSettings = settings;
  cachedSnapshot = serialize(settings);
  applyWorkbenchSkinToDocument(settings);
  persistWorkbenchSkin(settings);
  notify();
}

function getSnapshot(): string {
  readSettings();
  return cachedSnapshot;
}

function getServerSnapshot(): string {
  return serialize(DEFAULT_WORKBENCH_SKIN);
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  readSettings();
  return () => {
    listeners.delete(callback);
  };
}

export function useWorkbenchSkin() {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const settings = typeof window === "undefined" ? DEFAULT_WORKBENCH_SKIN : readSettings();

  const setGlass = useCallback((glass: number) => {
    commit({ ...readSettings(), glass: clampWorkbenchGlass(glass) });
  }, []);

  const setBgBlur = useCallback((bgBlur: number) => {
    commit({ ...readSettings(), bgBlur: clampWorkbenchLevel(bgBlur) });
  }, []);

  const setVignette = useCallback((vignette: number) => {
    commit({ ...readSettings(), vignette: clampWorkbenchLevel(vignette) });
  }, []);

  const setWallpaperDataUrl = useCallback((wallpaperDataUrl: string | null) => {
    commit(buildWallpaperSettings(readSettings(), wallpaperDataUrl));
  }, []);

  const setWallpaperFile = useCallback(async (file: File) => {
    const dataUrl = await encodeWorkbenchWallpaperFile(file);
    commit(buildWallpaperSettings(readSettings(), dataUrl));
    return dataUrl;
  }, []);

  const setGradientId = useCallback((gradientId: WorkbenchGradientId | null) => {
    commit(buildGradientSettings(readSettings(), gradientId));
  }, []);

  const clearBackground = useCallback(() => {
    commit(buildClearBackgroundSettings(readSettings()));
  }, []);

  const clearWallpaper = useCallback(() => {
    const current = readSettings();
    if (current.mode === "image") {
      commit(buildClearBackgroundSettings({ ...current, wallpaperDataUrl: null }));
      return;
    }
    commit({ ...current, wallpaperDataUrl: null });
  }, []);

  const resetWorkbenchSkin = useCallback(() => {
    commit(DEFAULT_WORKBENCH_SKIN);
  }, []);

  return {
    mode: settings.mode,
    wallpaperDataUrl: settings.wallpaperDataUrl,
    gradientId: settings.gradientId,
    glass: settings.glass,
    bgBlur: settings.bgBlur,
    vignette: settings.vignette,
    hasBackground: hasWorkbenchBackground(settings),
    hasWallpaper: settings.mode === "image" && Boolean(settings.wallpaperDataUrl),
    isCustomized: isWorkbenchSkinCustomized(settings),
    setGlass,
    setBgBlur,
    setVignette,
    setWallpaperDataUrl,
    setWallpaperFile,
    setGradientId,
    clearBackground,
    clearWallpaper,
    resetWorkbenchSkin,
  };
}
