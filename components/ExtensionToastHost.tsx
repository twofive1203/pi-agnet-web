"use client";

import { createPortal } from "react-dom";
import type { ExtensionToastItem } from "@/lib/types";

interface Props {
  toasts: ExtensionToastItem[];
  onDismiss: (id: string) => void;
}

function toneStyles(type: ExtensionToastItem["notifyType"]): { border: string; accent: string; label: string } {
  if (type === "error") {
    return { border: "rgba(239,68,68,0.45)", accent: "#ef4444", label: "Error" };
  }
  if (type === "warning") {
    return { border: "rgba(234,179,8,0.45)", accent: "#eab308", label: "Warning" };
  }
  return { border: "var(--border)", accent: "var(--accent)", label: "Info" };
}

/**
 * Fixed body-portaled toast stack for non-blocking Pi extension `notify` events.
 */
export function ExtensionToastHost({ toasts, onDismiss }: Props) {
  if (typeof document === "undefined" || toasts.length === 0) return null;

  return createPortal(
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1100,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 8,
        width: "min(360px, calc(100vw - 32px))",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => {
        const tone = toneStyles(toast.notifyType);
        return (
          <div
            key={toast.id}
            role="status"
            style={{
              pointerEvents: "auto",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${tone.border}`,
              background: "var(--bg-panel)",
              boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
              color: "var(--text)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: tone.accent, marginBottom: 4, letterSpacing: 0.3 }}>
                {tone.label}
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {toast.message}
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: 2,
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
