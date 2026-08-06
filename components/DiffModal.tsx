"use client";

import { useI18n } from "@/components/I18nProvider";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DiffView, type DiffMode } from "./DiffView";

interface Props {
  ariaLabel: string;
  header: ReactNode;
  loading: boolean;
  error: string | null;
  diff?: string;
  fallback: ReactNode;
  onClose: () => void;
  loadingLabel?: string;
  /**
   * true: absolute overlay inside the nearest positioned ancestor (compact host).
   * false: full-viewport fixed overlay; always portaled to document.body so parent
   * overflow/transform/backdrop-filter cannot trap the dialog inside a narrow panel.
   */
  contained?: boolean;
}

function ModeButton({ mode, selected, onSelect, disabled, label }: { mode: DiffMode; selected: boolean; onSelect: (mode: DiffMode) => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      disabled={disabled}
      aria-pressed={selected}
      className={`diff-modal-mode${selected ? " is-selected" : ""}`}
    >
      {label}
    </button>
  );
}

export function DiffModal({
  ariaLabel,
  header,
  loading,
  error,
  diff,
  fallback,
  onClose,
  loadingLabel,
  contained = false,
}: Props) {
  const { t } = useI18n();
  const resolvedLoadingLabel = loadingLabel ?? t("panels.diff.loading");
  const modeLabels: Record<DiffMode, string> = {
    "side-by-side": t("panels.diff.sideBySide"),
    unified: t("panels.diff.unified"),
  };
  const [mode, setMode] = useState<DiffMode>("side-by-side");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const hasDiff = Boolean(diff);

  const dialog = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className={`diff-modal-overlay${contained ? " is-contained" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="diff-modal-panel">
        <div className="diff-modal-header">
          <div className="diff-modal-heading">{header}</div>
          <div className="diff-modal-actions">
            <ModeButton mode="side-by-side" selected={mode === "side-by-side"} onSelect={setMode} disabled={!hasDiff} label={modeLabels["side-by-side"]} />
            <ModeButton mode="unified" selected={mode === "unified"} onSelect={setMode} disabled={!hasDiff} label={modeLabels.unified} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close diff"
              className="diff-modal-close"
            >
              Close
            </button>
          </div>
        </div>

        <div className={`diff-modal-body${mode === "side-by-side" && hasDiff ? " is-split" : ""}`}>
          {loading ? (
            <div className="inspector-state inspector-state-loading diff-modal-state">{resolvedLoadingLabel}</div>
          ) : error ? (
            <div className="inspector-state inspector-state-error diff-modal-state" role="alert">{error}</div>
          ) : diff ? (
            <DiffView diff={diff} mode={mode} />
          ) : (
            <div className="inspector-state inspector-state-empty diff-modal-state">{fallback}</div>
          )}
        </div>
      </div>
    </div>
  );

  // Full-viewport diffs must leave transformed/filtered/overflow-clipped hosts
  // (inspector drawer, glass panels, chat root) or position:fixed is trapped.
  if (!contained) {
    if (!mounted || typeof document === "undefined") return null;
    return createPortal(dialog, document.body);
  }

  return dialog;
}
