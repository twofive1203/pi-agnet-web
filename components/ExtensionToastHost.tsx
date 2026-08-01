"use client";

import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import type { ExtensionToastItem } from "@/lib/types";

interface Props {
  toasts: ExtensionToastItem[];
  onDismiss: (id: string) => void;
}

function toastTone(type: ExtensionToastItem["notifyType"]): "danger" | "warning" | "info" {
  if (type === "error") return "danger";
  if (type === "warning") return "warning";
  return "info";
}

/**
 * Fixed body-portaled toast stack for non-blocking Pi extension `notify` events.
 */
export function ExtensionToastHost({ toasts, onDismiss }: Props) {
  const { t } = useI18n();
  if (typeof document === "undefined" || toasts.length === 0) return null;

  return createPortal(
    <div className="extension-toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const tone = toastTone(toast.notifyType);
        return (
          <div className={`extension-toast is-${tone}`} key={toast.id} role="status">
            <div className="extension-toast-body">
              <div className="extension-toast-label">{t(`chat.toast${tone === "danger" ? "Error" : tone === "warning" ? "Warning" : "Info"}`)}</div>
              <div className="extension-toast-message">{toast.message}</div>
            </div>
            <button
              type="button"
              aria-label={t("chat.dismissNotification")}
              className="extension-toast-dismiss"
              onClick={() => onDismiss(toast.id)}
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
