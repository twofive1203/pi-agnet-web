"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";

type ConfirmTone = "default" | "danger";

interface AlertOptions {
  title?: string;
  message: string;
}

interface ConfirmOptions {
  title?: string;
  message: string;
  tone?: ConfirmTone;
}

interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface AppDialogContextValue {
  alert: (options: AlertOptions) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

interface AlertQueueItem {
  mode: "alert";
  options: AlertOptions;
  resolve: () => void;
}

interface ConfirmQueueItem {
  mode: "confirm";
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}

interface PromptQueueItem {
  mode: "prompt";
  options: PromptOptions;
  resolve: (value: string | null) => void;
}

type QueueItem = AlertQueueItem | ConfirmQueueItem | PromptQueueItem;

const AppDialogContext = createContext<AppDialogContextValue | null>(null);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [draft, setDraft] = useState("");

  // queueRef is authoritative; updated synchronously alongside setQueue.
  // Enqueue and settlement both mutate queueRef.current before setQueue.
  const queueRef = useRef<QueueItem[]>([]);
  const unmountedRef = useRef(false);
  // Per-item settlement latch: once an item is settled, it stays in this
  // WeakSet forever. Prevents stale event handlers from settling the next item.
  const settledItemsRef = useRef<WeakSet<QueueItem>>(new WeakSet());
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRafRef = useRef<number | null>(null);

  const activeItem = queue[0] ?? null;

  // Shift head from queueRef synchronously. Returns the removed item or undefined.
  const shiftHead = useCallback((): QueueItem | undefined => {
    const head = queueRef.current[0];
    if (head) queueRef.current = queueRef.current.slice(1);
    return head;
  }, []);

  // Enqueue: update queueRef synchronously; capture focus only when
  // previouslyFocusedRef is null; cancel pending focus restoration.
  const alert = useCallback((options: AlertOptions): Promise<void> => {
    if (unmountedRef.current) return Promise.resolve();
    if (restoreFocusRafRef.current !== null) {
      cancelAnimationFrame(restoreFocusRafRef.current);
      restoreFocusRafRef.current = null;
    }
    if (previouslyFocusedRef.current === null && typeof document !== "undefined") {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }
    return new Promise<void>((resolve) => {
      queueRef.current = [...queueRef.current, { mode: "alert", options, resolve }];
      setQueue([...queueRef.current]);
    });
  }, []);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    if (unmountedRef.current) return Promise.resolve(false);
    if (restoreFocusRafRef.current !== null) {
      cancelAnimationFrame(restoreFocusRafRef.current);
      restoreFocusRafRef.current = null;
    }
    if (previouslyFocusedRef.current === null && typeof document !== "undefined") {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }
    return new Promise<boolean>((resolve) => {
      queueRef.current = [...queueRef.current, { mode: "confirm", options, resolve }];
      setQueue([...queueRef.current]);
    });
  }, []);

  const prompt = useCallback((options: PromptOptions): Promise<string | null> => {
    if (unmountedRef.current) return Promise.resolve(null);
    if (restoreFocusRafRef.current !== null) {
      cancelAnimationFrame(restoreFocusRafRef.current);
      restoreFocusRafRef.current = null;
    }
    if (previouslyFocusedRef.current === null && typeof document !== "undefined") {
      previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    }
    return new Promise<string | null>((resolve) => {
      queueRef.current = [...queueRef.current, { mode: "prompt", options, resolve }];
      setQueue([...queueRef.current]);
    });
  }, []);

  // Settlement: accept targetItem, guard via exact-head check and WeakSet.
  const settleConfirm = useCallback((targetItem: QueueItem) => {
    if (settledItemsRef.current.has(targetItem)) return;
    if (queueRef.current[0] !== targetItem) return;
    settledItemsRef.current.add(targetItem);
    shiftHead();
    if (targetItem.mode === "alert") targetItem.resolve();
    else if (targetItem.mode === "confirm") targetItem.resolve(true);
    else targetItem.resolve(draft);
    setQueue([...queueRef.current]);
  }, [shiftHead, draft]);

  const settleCancel = useCallback((targetItem: QueueItem) => {
    if (settledItemsRef.current.has(targetItem)) return;
    if (queueRef.current[0] !== targetItem) return;
    settledItemsRef.current.add(targetItem);
    shiftHead();
    if (targetItem.mode === "alert") targetItem.resolve();
    else if (targetItem.mode === "confirm") targetItem.resolve(false);
    else targetItem.resolve(null);
    setQueue([...queueRef.current]);
  }, [shiftHead]);

  // Reset draft when a prompt dialog becomes active
  useEffect(() => {
    if (activeItem?.mode === "prompt") {
      setDraft(activeItem.options.defaultValue ?? "");
    }
  }, [activeItem]);

  // Centralized Enter/Escape keyboard handler.
  // One Enter path - only this handler; prompt input has no local Enter handler.
  useEffect(() => {
    if (!activeItem) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        settleCancel(activeItem);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        settleConfirm(activeItem);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, settleConfirm, settleCancel]);

  // Focus restoration: deferred via tracked rAF; rechecks queue emptiness.
  // New enqueue cancels pending restoration so the origin is retained.
  useEffect(() => {
    if (!activeItem) return;
    return () => {
      if (queueRef.current.length === 0) {
        const prev = previouslyFocusedRef.current;
        if (prev && typeof prev.focus === "function") {
          restoreFocusRafRef.current = requestAnimationFrame(() => {
            if (queueRef.current.length === 0) {
              prev.focus();
              previouslyFocusedRef.current = null;
            }
            restoreFocusRafRef.current = null;
          });
        }
      }
    };
  }, [activeItem]);

  // Unmount: drain queue, cancel pending restoration, restore focus once.
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (restoreFocusRafRef.current !== null) {
        cancelAnimationFrame(restoreFocusRafRef.current);
        restoreFocusRafRef.current = null;
      }
      const remaining = queueRef.current;
      for (const item of remaining) {
        if (item.mode === "alert") item.resolve();
        else if (item.mode === "confirm") item.resolve(false);
        else item.resolve(null);
      }
      queueRef.current = [];
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function") {
        requestAnimationFrame(() => prev.focus());
      }
      previouslyFocusedRef.current = null;
    };
  }, []);

  const contextValue = useMemo<AppDialogContextValue>(
    () => ({ alert, confirm, prompt }),
    [alert, confirm, prompt]
  );

  return (
    <AppDialogContext.Provider value={contextValue}>
      {children}
      {activeItem && (
        <DialogOverlay
          item={activeItem}
          draft={draft}
          onDraftChange={setDraft}
          onConfirm={() => settleConfirm(activeItem)}
          onCancel={() => settleCancel(activeItem)}
          t={t}
          dialogRef={dialogRef}
        />
      )}
    </AppDialogContext.Provider>
  );
}

export function useAppDialog(): AppDialogContextValue {
  const ctx = useContext(AppDialogContext);
  if (!ctx) {
    throw new Error("useAppDialog must be used within AppDialogProvider");
  }
  return ctx;
}

function DialogOverlay({
  item,
  draft,
  onDraftChange,
  onConfirm,
  onCancel,
  t,
  dialogRef,
}: {
  item: QueueItem;
  draft: string;
  onDraftChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: (key: string) => string;
  dialogRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [bodyMounted, setBodyMounted] = useState(false);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Ids for ARIA relationships - stable across renders but unique per mount
  const titleId = "app-dialog-title";
  const messageId = "app-dialog-message";

  useEffect(() => {
    setBodyMounted(true);
  }, []);

  // Assign dialogRef and focus after the portal panel mounts (bodyMounted).
  // For prompt mode, focus the text input; for alert/confirm, focus the first
  // button/control. Only runs after the portal is actually rendered in the body.
  useEffect(() => {
    if (!bodyMounted) return;
    if (dialogRef && panelRef.current) {
      (dialogRef as React.MutableRefObject<HTMLDivElement | null>).current = panelRef.current;
    }
    const frame = requestAnimationFrame(() => {
      if (item.mode === "prompt") {
        promptInputRef.current?.focus();
        if (promptInputRef.current) {
          const len = promptInputRef.current.value.length;
          promptInputRef.current.setSelectionRange(len, len);
        }
      } else {
        const panel = panelRef.current;
        if (panel) {
          const firstFocusable = panel.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          firstFocusable?.focus();
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [item, dialogRef, bodyMounted]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.nativeEvent as KeyboardEvent).isComposing) return;
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    []
  );

  const title =
    item.mode === "alert"
      ? (item.options.title ?? t("common.alertTitle"))
      : item.mode === "confirm"
        ? (item.options.title ?? t("common.confirmTitle"))
        : (item.options.title ?? t("common.promptTitle"));

  const isDanger = item.mode === "confirm" && item.options.tone === "danger";
  const hasMessage = item.mode === "alert" || item.mode === "confirm" || Boolean(item.options.message);

  // Build aria-describedby: reference messageId only when message exists
  const describedBy = hasMessage ? messageId : undefined;

  const panelContent = (
    <div
      className="pi-modal-overlay pi-app-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        background: "rgba(0,0,0,0.44)",
      }}
    >
      <div
        ref={panelRef}
        className="pi-modal-panel"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={{
          width: "min(420px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 22px 70px rgba(0,0,0,0.34)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <div
            id={titleId}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text)",
              minWidth: 0,
              flex: 1,
            }}
          >
            {title}
          </div>
          {item.mode !== "confirm" && (
            <button
              type="button"
              onClick={onCancel}
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                borderRadius: 7,
                padding: "4px 8px",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
              }}
              aria-label={t("common.close")}
            >
              {"\u00D7"}
            </button>
          )}
        </div>

        <div
          style={{
            padding: 14,
            overflow: "auto",
            minHeight: 0,
          }}
        >
          {(item.mode === "alert" || item.mode === "confirm") && (
            <div
              id={messageId}
              style={{
                fontSize: 13,
                lineHeight: 1.55,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {item.options.message}
            </div>
          )}

          {item.mode === "prompt" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {item.options.message && (
                <div
                  id={messageId}
                  style={{
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: "var(--text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {item.options.message}
                </div>
              )}
              <label htmlFor="app-dialog-input" style={{ display: "none" }}>
                {title}
              </label>
              <input
                ref={promptInputRef}
                id="app-dialog-input"
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                placeholder={item.options.placeholder ?? ""}
                aria-label={title}
                aria-describedby={item.options.message ? messageId : undefined}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "9px 11px",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          {item.mode === "alert" ? (
            <button
              type="button"
              onClick={onConfirm}
              style={{
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                borderRadius: 7,
                padding: "7px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
              aria-label={t("common.close")}
            >
              {t("common.close")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  border: "1px solid var(--border)",
                  background: "var(--bg-panel)",
                  color: "var(--text-muted)",
                  borderRadius: 7,
                  padding: "7px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                style={{
                  border: isDanger ? "1px solid #e53e3e" : "1px solid var(--accent)",
                  background: isDanger ? "#e53e3e" : "var(--accent)",
                  color: "#fff",
                  borderRadius: 7,
                  padding: "7px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {item.mode === "prompt"
                  ? (item.options.confirmLabel ?? t("common.confirm"))
                  : t("common.confirm")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

  if (!bodyMounted || typeof document === "undefined") return null;
  return createPortal(panelContent, document.body);
}
