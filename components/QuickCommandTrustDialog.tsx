"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import { SettingsButton } from "@/components/ui/SettingsPrimitives";
import type { QuickCommandTrustPreview } from "@/lib/quick-command-types";

interface Props {
  trust: QuickCommandTrustPreview;
  onConfirm: () => void;
  onCancel: () => void;
}

export function QuickCommandTrustDialog({ trust, onConfirm, onCancel }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialogRef.current;
    node?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onCancel]);

  const reasonText =
    trust.reason === "always_confirm"
      ? t("panels.quickCommands.trustReasonAlways")
      : trust.reason === "changed"
        ? t("panels.quickCommands.trustReasonChanged")
        : t("panels.quickCommands.trustReasonFirst");

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="quick-command-trust-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="quick-command-trust-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId} className="quick-command-trust-title">{t("panels.quickCommands.trustTitle")}</h2>
        <p className="quick-command-trust-reason">{reasonText}</p>
        <dl className="quick-command-trust-fields">
          <div>
            <dt>{t("panels.quickCommands.trustName")}</dt>
            <dd>{trust.name}</dd>
          </div>
          <div>
            <dt>{t("panels.quickCommands.trustCommand")}</dt>
            <dd className="is-mono">{trust.command}</dd>
          </div>
          <div>
            <dt>{t("panels.quickCommands.trustCwd")}</dt>
            <dd className="is-mono">{trust.resolvedCwd}</dd>
          </div>
          <div>
            <dt>{t("panels.quickCommands.trustEnvKeys")}</dt>
            <dd className="is-mono">
              {trust.envKeys.length > 0 ? trust.envKeys.join(", ") : t("panels.quickCommands.trustNoEnv")}
            </dd>
          </div>
        </dl>
        <p className="quick-command-trust-note">{t("panels.quickCommands.trustNote")}</p>
        <div className="quick-command-trust-actions">
          <SettingsButton type="button" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </SettingsButton>
          <SettingsButton type="button" variant="primary" onClick={onConfirm}>
            {t("panels.quickCommands.trustConfirm")}
          </SettingsButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
