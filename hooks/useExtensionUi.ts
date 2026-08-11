"use client";

import { useCallback, useRef, useState } from "react";
import type {
  ExtensionDialogRequest,
  ExtensionStatusItem,
  ExtensionToastItem,
  ExtensionWidgetItem,
} from "@/lib/types";
import { sendAgentCommand } from "@/lib/agent-client";

/** Minimal SSE/agent event shape used by the extension UI bridge. */
export interface ExtensionUiAgentEvent {
  type: string;
  [key: string]: unknown;
}

type ExtensionUiRequestEvent = ExtensionUiAgentEvent & {
  id: string;
  method: string;
  title?: string;
  message?: string;
  notifyType?: "info" | "warning" | "error";
  options?: string[];
  placeholder?: string;
  prefill?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  titleText?: string;
  text?: string;
  timeout?: number;
};

const EXTENSION_TOAST_TTL_MS = 5000;

function toDialogRequest(event: ExtensionUiRequestEvent): ExtensionDialogRequest | null {
  if (event.method === "confirm") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "confirm",
      title: event.title ?? "Confirm",
      message: event.message ?? "",
      timeout: event.timeout,
    };
  }
  if (event.method === "select") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "select",
      title: event.title ?? "Select an option",
      options: event.options ?? [],
      timeout: event.timeout,
    };
  }
  if (event.method === "input") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "input",
      title: event.title ?? "Input",
      placeholder: event.placeholder,
      timeout: event.timeout,
    };
  }
  if (event.method === "editor") {
    return {
      type: "extension_ui_request",
      id: event.id,
      method: "editor",
      title: event.title ?? "Edit",
      prefill: event.prefill,
      timeout: event.timeout,
    };
  }
  return null;
}

export interface ExtensionUiInsertHandle {
  insertIfEmpty: (content: string) => void;
}

export interface UseExtensionUiOptions {
  sessionIdRef: React.MutableRefObject<string | null>;
  chatInputRef?: React.RefObject<ExtensionUiInsertHandle | null>;
}

/**
 * Owns extension chrome state (dialog / toast / status / widget) and the
 * extension_ui_request event bridge. Keeps useAgentSession free of UI chrome maps.
 */
export function useExtensionUi(opts: UseExtensionUiOptions) {
  const { sessionIdRef, chatInputRef } = opts;

  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionDialogRequest | null>(null);
  const [extensionToasts, setExtensionToasts] = useState<ExtensionToastItem[]>([]);

  const extensionStatusMapRef = useRef<Map<string, string>>(new Map());
  const extensionWidgetMapRef = useRef<Map<string, ExtensionWidgetItem>>(new Map());
  const extensionDialogIdRef = useRef<string | null>(null);
  const toastTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearExtensionChrome = useCallback(() => {
    extensionStatusMapRef.current.clear();
    extensionWidgetMapRef.current.clear();
    setExtensionStatuses([]);
    setExtensionWidgets([]);
    setExtensionDialog(null);
    extensionDialogIdRef.current = null;
    for (const timer of toastTimersRef.current.values()) clearTimeout(timer);
    toastTimersRef.current.clear();
    setExtensionToasts([]);
  }, []);

  const dismissExtensionToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setExtensionToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const respondExtensionDialog = useCallback((response: {
    id: string;
    value?: string;
    confirmed?: boolean;
    cancelled?: true;
  }) => {
    if (extensionDialogIdRef.current !== response.id) return;
    extensionDialogIdRef.current = null;
    setExtensionDialog(null);
    const sid = sessionIdRef.current;
    if (!sid) return;
    const payload: Record<string, unknown> = { type: "extension_ui_response", id: response.id };
    if (response.cancelled) payload.cancelled = true;
    if (response.confirmed !== undefined) payload.confirmed = response.confirmed;
    if (response.value !== undefined) payload.value = response.value;
    sendAgentCommand(sid, payload).catch((error) => {
      console.error("Failed to respond to extension UI request:", error);
    });
  }, [sessionIdRef]);

  const handleExtensionUiRequest = useCallback((event: ExtensionUiAgentEvent) => {
    const request = event as ExtensionUiRequestEvent;

    if (request.method === "notify") {
      const toast: ExtensionToastItem = {
        id: request.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        message: request.message ?? "",
        notifyType: request.notifyType ?? "info",
        createdAt: Date.now(),
      };
      setExtensionToasts((prev) => [...prev, toast].slice(-6));
      const timer = setTimeout(() => dismissExtensionToast(toast.id), EXTENSION_TOAST_TTL_MS);
      toastTimersRef.current.set(toast.id, timer);
      return;
    }

    const dialog = toDialogRequest(request);
    if (dialog) {
      // If a previous dialog is still open, cancel it so the bridge cannot hang forever.
      if (extensionDialogIdRef.current && extensionDialogIdRef.current !== dialog.id) {
        const sid = sessionIdRef.current;
        if (sid) {
          sendAgentCommand(sid, {
            type: "extension_ui_response",
            id: extensionDialogIdRef.current,
            cancelled: true,
          }).catch(() => {});
        }
      }
      extensionDialogIdRef.current = dialog.id;
      setExtensionDialog(dialog);
      return;
    }

    if (request.method === "setTitle" && typeof request.title === "string") {
      document.title = request.title;
      return;
    }
    if (request.method === "set_editor_text" && typeof request.text === "string") {
      chatInputRef?.current?.insertIfEmpty(request.text);
      return;
    }
    if (request.method === "setStatus") {
      const key = request.statusKey;
      if (!key) return;
      const text = request.statusText;
      if (text === undefined || text === "") {
        extensionStatusMapRef.current.delete(key);
      } else {
        extensionStatusMapRef.current.set(key, text);
      }
      setExtensionStatuses(
        Array.from(extensionStatusMapRef.current.entries()).map(([statusKey, statusText]) => ({
          key: statusKey,
          text: statusText,
        })),
      );
      return;
    }
    if (request.method === "setWidget") {
      const key = request.widgetKey;
      if (!key) return;
      // Defense-in-depth: bridge already drops these TUI HUDs.
      if (key === "subagent-fleet-status" || key === "subagent-async") {
        extensionWidgetMapRef.current.delete(key);
        setExtensionWidgets(Array.from(extensionWidgetMapRef.current.values()));
        return;
      }
      if (request.widgetLines === undefined) {
        extensionWidgetMapRef.current.delete(key);
      } else {
        extensionWidgetMapRef.current.set(key, {
          key,
          lines: request.widgetLines,
          placement: request.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
        });
      }
      setExtensionWidgets(Array.from(extensionWidgetMapRef.current.values()));
    }
  }, [chatInputRef, dismissExtensionToast, sessionIdRef]);

  return {
    extensionStatuses,
    extensionWidgets,
    extensionDialog,
    extensionToasts,
    respondExtensionDialog,
    dismissExtensionToast,
    clearExtensionChrome,
    handleExtensionUiRequest,
  };
}
