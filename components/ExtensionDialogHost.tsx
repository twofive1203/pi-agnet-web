"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SettingsButton, SettingsInput, SettingsState, SettingsTextarea } from "@/components/ui/SettingsPrimitives";
import type { ExtensionDialogRequest } from "@/lib/types";

interface Props {
  dialog: ExtensionDialogRequest | null;
  onRespond: (response: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) => void;
}

/**
 * Application modal host for blocking Pi extension dialogs (confirm/select/input/editor).
 */
export function ExtensionDialogHost({ dialog, onRespond }: Props) {
  const [draft, setDraft] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const options = useMemo(
    () => (dialog?.method === "select" ? dialog.options ?? [] : []),
    [dialog],
  );

  useEffect(() => {
    if (!dialog) return;
    if (dialog.method === "editor") {
      setDraft(dialog.prefill ?? "");
    } else {
      setDraft("");
    }
    setSelectedIndex(0);
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      } else {
        panelRef.current?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
      }
      if (dialog.method === "editor" && inputRef.current instanceof HTMLTextAreaElement) {
        const len = inputRef.current.value.length;
        inputRef.current.setSelectionRange(len, len);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous?.isConnected) requestAnimationFrame(() => previous.focus());
    };
  }, [dialog]);

  const trapFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable || focusable.length === 0) {
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
  }, []);

  const cancel = useCallback(() => {
    if (!dialog) return;
    if (dialog.method === "confirm") {
      onRespond({ id: dialog.id, confirmed: false });
      return;
    }
    onRespond({ id: dialog.id, cancelled: true });
  }, [dialog, onRespond]);

  const confirm = useCallback(() => {
    if (!dialog) return;
    if (dialog.method === "confirm") {
      onRespond({ id: dialog.id, confirmed: true });
      return;
    }
    if (dialog.method === "select") {
      const value = options[selectedIndex];
      if (value === undefined) {
        onRespond({ id: dialog.id, cancelled: true });
        return;
      }
      onRespond({ id: dialog.id, value });
      return;
    }
    if (dialog.method === "input" || dialog.method === "editor") {
      onRespond({ id: dialog.id, value: draft });
    }
  }, [dialog, draft, onRespond, options, selectedIndex]);

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (dialog.method === "select") {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(options.length - 1, prev + 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          confirm();
        }
        return;
      }
      if ((dialog.method === "input" || dialog.method === "confirm") && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        confirm();
      }
      if (dialog.method === "editor" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        confirm();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel, confirm, dialog, options.length]);

  useEffect(() => {
    if (!dialog || dialog.method !== "select") return;
    const active = listRef.current?.querySelector<HTMLElement>(`[data-option-index="${selectedIndex}"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [dialog, selectedIndex]);

  useEffect(() => {
    if (!dialog?.timeout || dialog.timeout <= 0) return;
    const timer = setTimeout(() => cancel(), dialog.timeout);
    return () => clearTimeout(timer);
  }, [cancel, dialog]);

  if (!dialog || typeof document === "undefined") return null;

  const title =
    dialog.method === "confirm" ? (dialog.title || "Confirm")
      : dialog.method === "select" ? (dialog.title || "Select an option")
        : dialog.method === "input" ? (dialog.title || "Input")
          : (dialog.title || "Edit");

  const ariaLabel =
    dialog.method === "confirm" ? "Extension confirm dialog"
      : dialog.method === "select" ? "Extension select dialog"
        : dialog.method === "input" ? "Extension input dialog"
          : "Extension editor dialog";

  return createPortal(
    <div
      className="pi-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div ref={panelRef} className="pi-modal-panel pi-extension-dialog-panel" tabIndex={-1} onKeyDown={trapFocus}>
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div className="pi-modal-title">{title}</div>
          </div>
          <button type="button" onClick={cancel} className="pi-modal-close" aria-label="Close">×</button>
        </div>

        <div className="pi-modal-body">
          {dialog.method === "confirm" && (
            <div className="pi-modal-message">
              {dialog.message || ""}
            </div>
          )}

          {dialog.method === "select" && (
            <div ref={listRef} className="pi-dialog-options">
              {options.length === 0 ? (
                <SettingsState title="No options available." />
              ) : (
                options.map((option, index) => {
                  const active = index === selectedIndex;
                  return (
                    <button
                      key={`${index}-${option.slice(0, 24)}`}
                      type="button"
                      data-option-index={index}
                      onClick={() => onRespond({ id: dialog.id, value: option })}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`pi-dialog-option${active ? " pi-dialog-option-active" : ""}`}
                    >
                      <span className="pi-dialog-option-index">
                        {index + 1}.
                      </span>
                      {option}
                    </button>
                  );
                })
              )}
            </div>
          )}

          {dialog.method === "input" && (
            <SettingsInput
              ref={(node) => { inputRef.current = node; }}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={dialog.placeholder || undefined}
            />
          )}

          {dialog.method === "editor" && (
            <SettingsTextarea
              ref={(node) => { inputRef.current = node; }}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={12}
              className="pi-extension-dialog-editor settings-control-mono"
            />
          )}
        </div>

        <div className="pi-modal-footer">
          <SettingsButton onClick={cancel}>Cancel</SettingsButton>
          {(dialog.method === "confirm" || dialog.method === "input" || dialog.method === "editor" || dialog.method === "select") && (
            <SettingsButton
              variant="primary"
              onClick={confirm}
              disabled={dialog.method === "select" && options.length === 0}
            >
              {dialog.method === "confirm" ? "Confirm" : dialog.method === "select" ? "Select" : "OK"}
            </SettingsButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
