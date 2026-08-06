"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTheme } from "@/hooks/useTheme";
import { useWorkbenchSkin } from "@/hooks/useWorkbenchSkin";
import {
  WORKBENCH_GRADIENT_IDS,
  WORKBENCH_GRADIENT_META,
  WORKBENCH_SKIN_LEVEL_MAX,
  WORKBENCH_SKIN_LEVEL_MIN,
  WORKBENCH_SKIN_SOURCE_MAX_BYTES,
  type WorkbenchGradientId,
} from "@/lib/theme-skin";
import { THEME_META, THEME_PREFERENCES } from "@/lib/theme";
import { useI18n } from "./I18nProvider";
import Tooltip from "./Tooltip";

const OPTIONS = THEME_PREFERENCES.map((id) => ({ id, ...THEME_META[id] }));

// Group options by resolved mode so the picker shows light themes first, then dark themes.
const SYSTEM_OPTIONS = OPTIONS.filter((option) => option.id === "system");
const LIGHT_OPTIONS = OPTIONS.filter((option) => option.id !== "system" && option.mode === "light");
const DARK_OPTIONS = OPTIONS.filter((option) => option.mode === "dark");
const ORDERED_OPTIONS = [...SYSTEM_OPTIONS, ...LIGHT_OPTIONS, ...DARK_OPTIONS];
const SECTIONS = [
  { labelKey: null, options: SYSTEM_OPTIONS },
  { labelKey: "app.themeGroupLight", options: LIGHT_OPTIONS },
  { labelKey: "app.themeGroupDark", options: DARK_OPTIONS },
] as const;

const GRADIENT_OPTIONS = WORKBENCH_GRADIENT_IDS.map((id) => WORKBENCH_GRADIENT_META[id]);

const POPOVER_WIDTH = 312;
const THEME_PICKER_ID = "theme-picker-popover";

export function ThemePicker() {
  const { preference, setTheme, isDark } = useTheme();
  const {
    mode,
    gradientId,
    glass,
    bgBlur,
    vignette,
    frostClarity,
    hasBackground,
    hasWallpaper,
    isCustomized,
    setGlass,
    setBgBlur,
    setVignette,
    setFrostClarity,
    setWallpaperFile,
    setGradientId,
    clearBackground,
    resetWorkbenchSkin,
  } = useWorkbenchSkin();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [wallpaperError, setWallpaperError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickingFileRef = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const glassSliderId = useId();
  const bgBlurSliderId = useId();
  const vignetteSliderId = useId();
  const frostClaritySliderId = useId();

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
      if (pickingFileRef.current) return;
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (pickingFileRef.current) return;
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleWindowFocus = () => {
      // File dialog dismissal returns focus without a reliable cancel event.
      window.setTimeout(() => {
        pickingFileRef.current = false;
      }, 0);
    };

    window.addEventListener("resize", updatePosition);
    window.addEventListener("focus", handleWindowFocus);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("focus", handleWindowFocus);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open || !position) return;
    const selectedIndex = Math.max(0, ORDERED_OPTIONS.findIndex((option) => option.id === preference));
    const frame = window.requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, position, preference]);

  const handleOptionKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % ORDERED_OPTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + ORDERED_OPTIONS.length) % ORDERED_OPTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = ORDERED_OPTIONS.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    const option = ORDERED_OPTIONS[nextIndex];
    setTheme(option.id);
    window.requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  }, [setTheme]);

  const handleWallpaperPick = useCallback(() => {
    setWallpaperError(null);
    pickingFileRef.current = true;
    fileInputRef.current?.click();
  }, []);

  const handleWallpaperChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    pickingFileRef.current = false;
    if (!file) return;

    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setWallpaperError(t("app.themeWallpaperErrorType"));
      return;
    }
    if (file.size > WORKBENCH_SKIN_SOURCE_MAX_BYTES) {
      setWallpaperError(t("app.themeWallpaperErrorSize"));
      return;
    }

    setWallpaperBusy(true);
    setWallpaperError(null);
    try {
      await setWallpaperFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/too large|storage budget|Encoded wallpaper/i.test(message)) {
        setWallpaperError(t("app.themeWallpaperErrorSize"));
      } else if (/Unsupported image type/i.test(message)) {
        setWallpaperError(t("app.themeWallpaperErrorType"));
      } else {
        setWallpaperError(t("app.themeWallpaperErrorGeneric"));
      }
    } finally {
      setWallpaperBusy(false);
    }
  }, [setWallpaperFile, t]);

  const handleGradientSelect = useCallback((id: WorkbenchGradientId) => {
    setWallpaperError(null);
    if (mode === "gradient" && gradientId === id) {
      setGradientId(null);
      return;
    }
    setGradientId(id);
  }, [gradientId, mode, setGradientId]);

  const renderOption = (option: (typeof OPTIONS)[number], index: number) => {
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
          {option.preview.map((color) => <span key={color} style={{ background: color }} />)}
        </span>
        <span className="theme-picker-option-label">{t(option.labelKey)}</span>
        <span className="theme-picker-check" aria-hidden="true">{selected ? "✓" : ""}</span>
      </button>
    );
  };

  const renderLevelSlider = (
    id: string,
    label: string,
    hint: string,
    value: number,
    onChange: (next: number) => void,
  ) => (
    <div className="theme-picker-workbench-row theme-picker-workbench-row-stack">
      <div className="theme-picker-workbench-copy theme-picker-workbench-copy-inline">
        <label className="theme-picker-workbench-label" htmlFor={id}>
          {label}
        </label>
        <span className="theme-picker-workbench-value" aria-hidden="true">{value}</span>
      </div>
      <input
        id={id}
        className="theme-picker-glass-slider"
        type="range"
        min={WORKBENCH_SKIN_LEVEL_MIN}
        max={WORKBENCH_SKIN_LEVEL_MAX}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        aria-valuemin={WORKBENCH_SKIN_LEVEL_MIN}
        aria-valuemax={WORKBENCH_SKIN_LEVEL_MAX}
        aria-valuenow={value}
        aria-label={label}
      />
      <span className="theme-picker-workbench-hint">{hint}</span>
    </div>
  );

  return (
    <>
      <Tooltip content={t("app.openThemePicker")} position="bottom">
      <button
        ref={buttonRef}
        type="button"
        className="app-top-icon-button theme-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("app.openThemePicker")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={THEME_PICKER_ID}
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
      </Tooltip>
      {open && position && typeof document !== "undefined" && createPortal(
        <div
          ref={popoverRef}
          id={THEME_PICKER_ID}
          className="theme-picker-popover"
          role="dialog"
          aria-label={t("app.appearance")}
          style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
        >
          <div className="theme-picker-header">
            <span>{t("app.appearance")}</span>
            <span className="theme-picker-current">{t(ORDERED_OPTIONS.find((option) => option.id === preference)?.labelKey ?? "app.themeSystem")}</span>
          </div>
          <div className="theme-picker-grid" role="radiogroup" aria-label={t("app.themePickerLabel")}>
            {SECTIONS.map((section) => (
              <Fragment key={section.labelKey ?? "base"}>
                {section.labelKey ? (
                  <div className="theme-picker-section-label">{t(section.labelKey)}</div>
                ) : null}
                {section.options.map((option) => renderOption(option, ORDERED_OPTIONS.indexOf(option)))}
              </Fragment>
            ))}
          </div>

          <div className="theme-picker-workbench">
            <div className="theme-picker-section-label">{t("app.themeWorkbenchSkin")}</div>

            <div className="theme-picker-workbench-block">
              <div className="theme-picker-workbench-copy">
                <span className="theme-picker-workbench-label">{t("app.themeGradientPresets")}</span>
                <span className="theme-picker-workbench-hint">{t("app.themeGradientPresetsHint")}</span>
              </div>
              <div className="theme-picker-gradient-grid" role="listbox" aria-label={t("app.themeGradientPresets")}>
                {GRADIENT_OPTIONS.map((gradient) => {
                  const selected = mode === "gradient" && gradientId === gradient.id;
                  return (
                    <button
                      key={gradient.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`theme-picker-gradient-option${selected ? " theme-picker-gradient-option-selected" : ""}`}
                      onClick={() => handleGradientSelect(gradient.id)}
                    >
                      <span
                        className="theme-picker-gradient-swatch"
                        style={{ backgroundImage: gradient.css }}
                        aria-hidden="true"
                      />
                      <span className="theme-picker-gradient-label">{t(gradient.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="theme-picker-workbench-row">
              <div className="theme-picker-workbench-copy">
                <span className="theme-picker-workbench-label">{t("app.themeWallpaper")}</span>
                <span className="theme-picker-workbench-hint">{t("app.themeWallpaperHint")}</span>
              </div>
              <div className="theme-picker-workbench-actions">
                <button
                  type="button"
                  className="theme-picker-action-button"
                  onClick={handleWallpaperPick}
                  disabled={wallpaperBusy}
                >
                  {wallpaperBusy ? "…" : t("app.themeWallpaperChoose")}
                </button>
                {hasBackground ? (
                  <button
                    type="button"
                    className="theme-picker-action-button theme-picker-action-button-muted"
                    onClick={() => {
                      setWallpaperError(null);
                      clearBackground();
                    }}
                    disabled={wallpaperBusy}
                  >
                    {t("app.themeBackgroundClear")}
                  </button>
                ) : null}
              </div>
            </div>

            {hasBackground ? (
              <div
                className="theme-picker-wallpaper-preview"
                style={{ backgroundImage: "var(--skin-bg-image)" }}
                aria-hidden="true"
              />
            ) : null}
            {hasWallpaper ? (
              <div className="theme-picker-workbench-hint">{t("app.themeWallpaperActive")}</div>
            ) : null}
            {wallpaperError ? (
              <div className="theme-picker-workbench-error" role="alert">{wallpaperError}</div>
            ) : null}

            {renderLevelSlider(
              glassSliderId,
              t("app.themeGlass"),
              t("app.themeGlassHint"),
              glass,
              setGlass,
            )}
            {renderLevelSlider(
              frostClaritySliderId,
              t("app.themeFrostClarity"),
              t("app.themeFrostClarityHint"),
              frostClarity,
              setFrostClarity,
            )}
            {renderLevelSlider(
              bgBlurSliderId,
              t("app.themeBgBlur"),
              t("app.themeBgBlurHint"),
              bgBlur,
              setBgBlur,
            )}
            {renderLevelSlider(
              vignetteSliderId,
              t("app.themeVignette"),
              t("app.themeVignetteHint"),
              vignette,
              setVignette,
            )}

            {isCustomized ? (
              <button
                type="button"
                className="theme-picker-reset-button"
                onClick={() => {
                  setWallpaperError(null);
                  resetWorkbenchSkin();
                }}
              >
                {t("app.themeResetWorkbenchSkin")}
              </button>
            ) : null}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="theme-picker-file-input"
            onChange={handleWallpaperChange}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>,
        document.body,
      )}
    </>
  );
}
