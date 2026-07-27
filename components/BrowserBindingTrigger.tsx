"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserBindingPanel } from "@/components/BrowserBindingPanel";
import { useI18n } from "@/components/I18nProvider";
import {
  browserToneColor,
  browserToneLabel,
  useBrowserBridgeStatus,
} from "@/hooks/useBrowserBridgeStatus";

interface Props {
  sessionId: string | null;
  sessionLabel?: string;
}

interface PopoverRect {
  bottom: number;
  left: number;
}

const POPOVER_WIDTH = 360;

function getPopoverRect(button: HTMLElement): PopoverRect {
  const rect = button.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - POPOVER_WIDTH - 8));
  return {
    bottom: viewportHeight - rect.top + 6,
    left,
  };
}

export function BrowserBindingTrigger({ sessionId, sessionLabel }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [popoverRect, setPopoverRect] = useState<PopoverRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { status, error, tone, refresh } = useBrowserBridgeStatus({
    sessionId,
    active: open,
  });

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const handleResize = () => {
      if (buttonRef.current) setPopoverRect(getPopoverRect(buttonRef.current));
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, [open]);

  const toneLabel = browserToneLabel(tone, t);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        title={`${t("panels.browser.triggerTitle")} · ${toneLabel}`}
        onPointerDown={(event) => {
          event.preventDefault();
          setPopoverRect(getPopoverRect(event.currentTarget));
          setOpen((value) => !value);
          void refresh();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (buttonRef.current) setPopoverRect(getPopoverRect(buttonRef.current));
          setOpen((value) => !value);
          void refresh();
        }}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          width: 36,
          height: 32,
          padding: 0,
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 9,
          color: open ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)";
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: browserToneColor(tone),
            boxShadow: `0 0 0 2px color-mix(in srgb, ${browserToneColor(tone)} 18%, transparent)`,
            flexShrink: 0,
          }}
        />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8" />
          <path d="M12 17v4" />
          <path d="M8 9h8" />
          <path d="M8 12h5" />
        </svg>
      </button>
      {open && popoverRect && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          className="browser-binding-popover"
          style={{
            position: "fixed",
            bottom: popoverRect.bottom,
            left: popoverRect.left,
            zIndex: 520,
            width: POPOVER_WIDTH,
            maxWidth: "calc(100vw - 16px)",
          }}
        >
          <BrowserBindingPanel
            sessionId={sessionId}
            sessionLabel={sessionLabel}
            popover
            sharedStatus={status}
            sharedError={error}
            onSharedRefresh={refresh}
          />
        </div>
      ), document.body)}
    </>
  );
}
