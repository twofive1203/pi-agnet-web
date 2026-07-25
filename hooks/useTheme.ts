"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  isThemePreference,
  resolveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

const THEME_STORAGE_KEY = "pi-theme";
const listeners = new Set<() => void>();

type ThemeSnapshot = `${ThemePreference}:${ResolvedTheme}`;
type ToggleOrigin = { x: number; y: number };

function getSystemIsDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function readPreference(): ThemePreference {
  if (typeof document === "undefined") return "system";
  const value = document.documentElement.dataset.themePreference;
  return isThemePreference(value) ? value : "system";
}

function getSnapshot(): ThemeSnapshot {
  const preference = readPreference();
  const resolved = typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  return `${preference}:${resolved}`;
}

function getServerSnapshot(): ThemeSnapshot {
  return "system:light";
}

function notifyThemeListeners(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const handleSystemChange = () => {
    if (readPreference() !== "system") return;
    applyThemeToDocument("system");
    callback();
  };
  media?.addEventListener("change", handleSystemChange);

  return () => {
    listeners.delete(callback);
    media?.removeEventListener("change", handleSystemChange);
  };
}

function applyThemeToDocument(preference: ThemePreference): void {
  const root = document.documentElement;
  const resolved = resolveThemePreference(preference, getSystemIsDark());
  root.dataset.themePreference = preference;
  if (preference === "paper" || preference === "graphite" || preference === "ocean" || preference === "forest") {
    root.dataset.themeSkin = preference;
  } else {
    delete root.dataset.themeSkin;
  }
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

function persistPreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignore storage errors in private mode or restricted browser contexts.
  }
}

function runThemeTransition(apply: () => void, origin?: ToggleOrigin): void {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const supportsViewTransition = typeof document.startViewTransition === "function";
  if (!supportsViewTransition || reduceMotion) {
    apply();
    return;
  }

  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
      {
        duration: 360,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        pseudoElement: "::view-transition-new(root)",
      },
    );
  }).catch(() => {
    // A cancelled transition has already applied the requested theme.
  });
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [preference, theme] = snapshot.split(":") as [ThemePreference, ResolvedTheme];

  const setTheme = useCallback((next: ThemePreference, origin?: ToggleOrigin) => {
    runThemeTransition(() => {
      applyThemeToDocument(next);
      persistPreference(next);
      notifyThemeListeners();
    }, origin);
  }, []);

  const toggleTheme = useCallback((origin?: ToggleOrigin) => {
    setTheme(theme === "dark" ? "light" : "dark", origin);
  }, [setTheme, theme]);

  return {
    theme,
    preference,
    setTheme,
    toggleTheme,
    isDark: theme === "dark",
  };
}
