"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/hooks/useTheme";
import type { ThemePreference } from "@/lib/theme";
import { useI18n } from "./I18nProvider";

const OPTIONS: Array<{
  id: ThemePreference;
  labelKey: `app.${string}`;
  colors: [string, string, string];
}> = [
  { id: "system", labelKey: "app.themeSystem", colors: ["#f5f5f5", "#242424", "#60a5fa"] },
  { id: "light", labelKey: "app.themeLight", colors: ["#ffffff", "#e8e8e8", "#2563eb"] },
  { id: "dark", labelKey: "app.themeDark", colors: ["#1a1a1a", "#383838", "#60a5fa"] },
  { id: "paper", labelKey: "app.themePaper", colors: ["#f7f6f2", "#ddd9cf", "#306b5b"] },
  { id: "graphite", labelKey: "app.themeGraphite", colors: ["#171918", "#333834", "#a8c7b5"] },
  { id: "ocean", labelKey: "app.themeOcean", colors: ["#f3f8f9", "#d3e2e6", "#146c7c"] },
  { id: "forest", labelKey: "app.themeForest", colors: ["#17201b", "#334239", "#9bc5a2"] },
  { id: "twilight", labelKey: "app.themeTwilight", colors: ["#17212b", "#303d4b", "#f08a67"] },
  { id: "night", labelKey: "app.themeNight", colors: ["oklch(20.768% 0.039 265.754)", "oklch(27.949% 0.036 260.03)", "oklch(75.351% 0.138 232.661)"] },
  { id: "daisy-dark", labelKey: "app.themeDaisyDark", colors: ["oklch(25.33% 0.016 252.42)", "oklch(21.15% 0.012 254.09)", "oklch(58% 0.233 277.117)"] },
  { id: "dracula", labelKey: "app.themeDracula", colors: ["oklch(28.822% 0.022 277.508)", "oklch(39.445% 0.032 275.524)", "oklch(75.461% 0.183 346.812)"] },
];

const POPOVER_WIDTH = 260;

export function ThemePicker() {
  const { preference, setTheme, isDark } = useTheme();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - POPOVER_WIDTH - 8),
    );
    setPosition({ top: rect.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    window.addEventListener("resize", updatePosition);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || !position) return;
    const selectedIndex = Math.max(0, OPTIONS.findIndex((option) => option.id === preference));
    const frame = window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, position, preference]);

  const handleOptionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % OPTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + OPTIONS.length) % OPTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = OPTIONS.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    const option = OPTIONS[nextIndex];
    setTheme(option.id);
    window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  }, [setTheme]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="app-top-icon-button theme-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        title={t("app.openThemePicker")}
        aria-label={t("app.openThemePicker")}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {isDark ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        )}
      </button>
      {open && position && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          className="theme-picker-popover"
          role="dialog"
          aria-label={t("app.appearance")}
          style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
        >
          <div className="theme-picker-header">
            <span>{t("app.appearance")}</span>
            <span className="theme-picker-current">{t(OPTIONS.find((option) => option.id === preference)?.labelKey ?? "app.themeSystem")}</span>
          </div>
          <div className="theme-picker-grid" role="radiogroup" aria-label={t("app.themePickerLabel")}>
            {OPTIONS.map((option, index) => {
              const selected = preference === option.id;
              return (
                <button
                  key={option.id}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  type="button"
                  className={`theme-picker-option${selected ? " theme-picker-option-selected" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTheme(option.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                  }}
                >
                  <span className="theme-picker-swatches" aria-hidden="true">
                    {option.colors.map((color) => <span key={color} style={{ background: color }} />)}
                  </span>
                  <span className="theme-picker-option-label">{t(option.labelKey)}</span>
                  <span className="theme-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
