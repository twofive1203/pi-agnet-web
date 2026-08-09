"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pi-completion-notification-enabled";

export type CompletionNotificationState = "enabled" | "disabled" | "denied" | "unsupported";

function readStoredEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Notification permission remains usable even when browser storage is unavailable.
  }
}

function detectState(): CompletionNotificationState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (window.Notification.permission === "denied") return "denied";
  return readStoredEnabled() && window.Notification.permission === "granted" ? "enabled" : "disabled";
}

export function useCompletionNotification() {
  const [state, setState] = useState<CompletionNotificationState>(detectState);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const syncPermission = () => setState(detectState());
    syncPermission();
    document.addEventListener("visibilitychange", syncPermission);
    return () => document.removeEventListener("visibilitychange", syncPermission);
  }, []);

  const toggle = useCallback(async () => {
    if (!("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (stateRef.current === "enabled") {
      writeStoredEnabled(false);
      setState("disabled");
      return;
    }
    if (window.Notification.permission === "denied") {
      writeStoredEnabled(false);
      setState("denied");
      return;
    }

    try {
      const permission = window.Notification.permission === "granted"
        ? "granted"
        : await window.Notification.requestPermission();
      const enabled = permission === "granted";
      writeStoredEnabled(enabled);
      setState(enabled ? "enabled" : permission === "denied" ? "denied" : "disabled");
    } catch {
      writeStoredEnabled(false);
      setState("disabled");
    }
  }, []);

  const notify = useCallback((options: { title: string; body: string; tag: string }) => {
    if (
      stateRef.current !== "enabled" ||
      document.visibilityState === "visible" ||
      !("Notification" in window) ||
      window.Notification.permission !== "granted"
    ) {
      return;
    }

    try {
      const notification = new window.Notification(options.title, {
        body: options.body,
        icon: "/snail-pi-logo.svg",
        tag: options.tag,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // Browser/OS notification delivery is best-effort after permission is granted.
    }
  }, []);

  return { notificationState: state, onNotificationToggle: toggle, notifyCompletion: notify };
}
