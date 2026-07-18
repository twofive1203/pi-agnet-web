"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ExtensionDialogRequest } from "@/lib/types";

interface Props {
  dialog: ExtensionDialogRequest | null;
  onRespond: (response: { id: string; value?: string; confirmed?: boolean; cancelled?: true }) => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 18,
  background: "rgba(0,0,0,0.44)",
};

const panelStyle: CSSProperties = {
  width: "min(520px, 100%)",
  maxHeight: "min(640px, calc(100dvh - 36px))",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxShadow: "0 22px 70px rgba(0,0,0,0.34)",
  overflow: "hidden",
};

const primaryBtn: CSSProperties = {
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  borderRadius: 7,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  borderRadius: 7,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

/**
 * Application modal host for blocking Pi extension dialogs (confirm/select/input/editor).
 */
export function ExtensionDialogHost({ dialog, onRespond }: Props) {
  const [draft, setDraft] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (dialog.method === "editor" && inputRef.current instanceof HTMLTextAreaElement) {
        const len = inputRef.current.value.length;
        inputRef.current.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [dialog]);

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
      style={overlayStyle}
    >
      <div className="pi-modal-panel" style={panelStyle}>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", minWidth: 0, flex: 1 }}>
            {title}
          </div>
          <button type="button" onClick={cancel} style={{ ...secondaryBtn, padding: "4px 8px" }} aria-label="Close">
            ×
          </button>
        </div>

        <div style={{ padding: 14, overflow: "auto", minHeight: 0, flex: 1 }}>
          {dialog.method === "confirm" && (
            <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)", whiteSpace: "pre-wrap" }}>
              {dialog.message || ""}
            </div>
          )}

          {dialog.method === "select" && (
            <div ref={listRef} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {options.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>No options available.</div>
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
                      style={{
                        textAlign: "left",
                        border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                        background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                        color: "var(--text)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        cursor: "pointer",
                        fontSize: 12,
                        lineHeight: 1.45,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginRight: 8 }}>
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
            <input
              ref={(node) => { inputRef.current = node; }}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={dialog.placeholder || undefined}
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
          )}

          {dialog.method === "editor" && (
            <textarea
              ref={(node) => { inputRef.current = node; }}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={12}
              style={{
                width: "100%",
                boxSizing: "border-box",
                minHeight: 180,
                resize: "vertical",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 11px",
                background: "var(--bg-panel)",
                color: "var(--text)",
                fontSize: 12,
                lineHeight: 1.5,
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
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
          <button type="button" onClick={cancel} style={secondaryBtn}>
            {dialog.method === "confirm" ? "Cancel" : "Cancel"}
          </button>
          {(dialog.method === "confirm" || dialog.method === "input" || dialog.method === "editor" || dialog.method === "select") && (
            <button
              type="button"
              onClick={confirm}
              style={primaryBtn}
              disabled={dialog.method === "select" && options.length === 0}
            >
              {dialog.method === "confirm" ? "Confirm" : dialog.method === "select" ? "Select" : "OK"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
