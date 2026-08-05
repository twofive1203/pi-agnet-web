"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsButton,
  SettingsInput,
  SettingsNotice,
} from "@/components/ui/SettingsPrimitives";

interface BrowseEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parent?: string | null;
  entries?: BrowseEntry[];
  truncated?: boolean;
  home?: string;
  error?: string;
}

export interface DirectoryPickerDialogProps {
  open: boolean;
  /** Preferred starting directory when the dialog opens. */
  initialPath?: string | null;
  onClose: () => void;
  /** Called with the validated canonical cwd after save succeeds. */
  onSelect: (cwd: string) => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function DirectoryPickerDialog({
  open,
  initialPath,
  onClose,
  onSelect,
}: DirectoryPickerDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const [draftPath, setDraftPath] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadDirectory = useCallback(async (targetPath: string, signal?: AbortSignal) => {
    setLoading(true);
    setBrowseError(null);
    setSaveError(null);
    try {
      const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
      const res = await fetch(`/api/cwd/browse${query}`, { signal });
      const data = await res.json().catch(() => ({})) as BrowseResponse;
      if (!res.ok || data.error) {
        setBrowseError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const nextPath = data.path ?? "";
      setCurrentPath(nextPath);
      setParentPath(data.parent ?? null);
      setEntries(data.entries ?? []);
      setTruncated(Boolean(data.truncated));
      setDraftPath(nextPath);
    } catch (error) {
      if (signal?.aborted) return;
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const controller = new AbortController();
    const start = (initialPath ?? "").trim();
    void loadDirectory(start, controller.signal);

    const focusTimer = window.setTimeout(() => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }, 0);

    return () => {
      controller.abort();
      window.clearTimeout(focusTimer);
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous && typeof previous.focus === "function") {
        window.requestAnimationFrame(() => previous.focus());
      }
    };
  }, [initialPath, loadDirectory, open]);

  const trapFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!saving) onClose();
      return;
    }
    trapFocus(event);
  }, [onClose, saving, trapFocus]);

  const goToDraftPath = useCallback(() => {
    void loadDirectory(draftPath.trim());
  }, [draftPath, loadDirectory]);

  const handleSave = useCallback(async () => {
    const path = (draftPath.trim() || currentPath).trim();
    if (!path || saving) return;

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!res.ok || data.error) {
        setSaveError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onSelect(data.cwd ?? path);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [currentPath, draftPath, onSelect, saving]);

  if (!open || typeof document === "undefined") return null;

  const canGoUp = parentPath != null || currentPath !== "";
  const saveDisabled = saving || !(draftPath.trim() || currentPath);

  return createPortal(
    <div
      className="pi-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="pi-modal-panel directory-picker-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id={titleId} className="pi-modal-title">{t("sidebar.addProject")}</div>
            <div id={subtitleId} className="pi-modal-subtitle">{t("sidebar.directoryPickerSubtitle")}</div>
          </div>
          <button
            type="button"
            className="pi-modal-close"
            aria-label={t("common.close")}
            onClick={() => {
              if (!saving) onClose();
            }}
          >
            ×
          </button>
        </div>

        <div className="pi-modal-body directory-picker-body">
          <div className="directory-picker-path-row">
            <SettingsInput
              ref={pathInputRef}
              value={draftPath}
              onChange={(event) => {
                setDraftPath(event.target.value);
                setSaveError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  goToDraftPath();
                }
              }}
              placeholder={t("sidebar.pathPlaceholder")}
              aria-label={t("sidebar.directoryPickerPathAria")}
              spellCheck={false}
              className="settings-control-mono directory-picker-path-input"
            />
            <SettingsButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={goToDraftPath}
              disabled={loading || saving}
            >
              {t("sidebar.directoryPickerGo")}
            </SettingsButton>
          </div>

          <div className="directory-picker-toolbar">
            <SettingsButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadDirectory(parentPath ?? "")}
              disabled={!canGoUp || loading || saving}
              title={t("sidebar.directoryPickerUp")}
            >
              ← {t("sidebar.directoryPickerUp")}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadDirectory("")}
              disabled={loading || saving}
            >
              {t("sidebar.directoryPickerRoots")}
            </SettingsButton>
            <span className="directory-picker-location" title={currentPath || t("sidebar.directoryPickerRoots")}>
              {currentPath || t("sidebar.directoryPickerRoots")}
            </span>
          </div>

          {(browseError || saveError) && (
            <SettingsNotice tone="danger">{browseError || saveError}</SettingsNotice>
          )}

          <div
            className="directory-picker-list"
            role="list"
            aria-label={t("sidebar.directoryPickerListAria")}
            aria-busy={loading || undefined}
          >
            {loading && entries.length === 0 ? (
              <div className="directory-picker-empty" role="status">{t("sidebar.loading")}</div>
            ) : entries.length === 0 ? (
              <div className="directory-picker-empty" role="status">{t("sidebar.directoryPickerEmpty")}</div>
            ) : (
              entries.map((entry) => (
                <div key={entry.path} role="listitem" className="directory-picker-entry-wrap">
                  <button
                    type="button"
                    className="directory-picker-entry"
                    title={entry.path}
                    disabled={loading || saving}
                    onClick={() => void loadDirectory(entry.path)}
                  >
                    <span className="directory-picker-entry-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                    <span className="directory-picker-entry-name">{entry.name}</span>
                  </button>
                </div>
              ))
            )}
          </div>

          {truncated && (
            <div className="directory-picker-meta" role="status">
              {t("sidebar.directoryPickerTruncated")}
            </div>
          )}
        </div>

        <div className="pi-modal-footer">
          <SettingsActionRow>
            <SettingsButton type="button" variant="secondary" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="primary"
              busy={saving}
              disabled={saveDisabled}
              onClick={() => void handleSave()}
            >
              {saving ? t("sidebar.checkingPath") : t("sidebar.directoryPickerSave")}
            </SettingsButton>
          </SettingsActionRow>
        </div>
      </div>
    </div>,
    document.body,
  );
}
