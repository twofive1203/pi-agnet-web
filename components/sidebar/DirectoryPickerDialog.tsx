"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
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
import {
  buildDirectoryPickerShortcuts,
  directoryPickerPathsEqual,
  nextDirectoryPickerCandidate,
  normalizeDirectoryPickerPlatform,
  resolveDirectoryPickerFinalPath,
  splitDirectoryPickerBreadcrumbs,
  type DirectoryPickerPlatform,
} from "./sidebar-utils";

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
  platform?: string;
  roots?: BrowseEntry[];
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
  const listId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const currentPathRef = useRef("");

  const [draftPath, setDraftPath] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [roots, setRoots] = useState<BrowseEntry[]>([]);
  const [home, setHome] = useState<string | null>(null);
  const [candidatePath, setCandidatePath] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [platform, setPlatform] = useState<DirectoryPickerPlatform>("other");
  const [loading, setLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  currentPathRef.current = currentPath;

  const labels = useMemo(() => {
    if (platform === "win32") {
      return {
        subtitle: t("sidebar.directoryPickerSubtitleWindows"),
        roots: t("sidebar.directoryPickerRootsWindows"),
        placeholder: t("sidebar.pathPlaceholderWindows"),
      };
    }
    if (platform === "darwin") {
      return {
        subtitle: t("sidebar.directoryPickerSubtitleMac"),
        roots: t("sidebar.directoryPickerRootsMac"),
        placeholder: t("sidebar.pathPlaceholderMac"),
      };
    }
    if (platform === "linux") {
      return {
        subtitle: t("sidebar.directoryPickerSubtitleLinux"),
        roots: t("sidebar.directoryPickerRootsLinux"),
        placeholder: t("sidebar.pathPlaceholderLinux"),
      };
    }
    return {
      subtitle: t("sidebar.directoryPickerSubtitle"),
      roots: t("sidebar.directoryPickerRoots"),
      placeholder: t("sidebar.pathPlaceholder"),
    };
  }, [platform, t]);

  const breadcrumbs = useMemo(
    () => splitDirectoryPickerBreadcrumbs(currentPath, platform),
    [currentPath, platform],
  );
  const shortcuts = useMemo(
    () => buildDirectoryPickerShortcuts({
      roots,
      home,
      currentProjectPath: initialPath,
      platform,
    }),
    [home, initialPath, platform, roots],
  );
  const finalPath = resolveDirectoryPickerFinalPath(currentPath, candidatePath);
  const selectedIndex = candidatePath
    ? entries.findIndex((entry) => directoryPickerPathsEqual(entry.path, candidatePath, platform))
    : -1;
  const selectedEntryId = selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined;

  const loadDirectory = useCallback(async (targetPath: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setBrowseError(null);
    setSaveError(null);
    try {
      const query = targetPath ? `?path=${encodeURIComponent(targetPath)}` : "";
      const res = await fetch(`/api/cwd/browse${query}`, { signal: controller.signal });
      const data = await res.json().catch(() => ({})) as BrowseResponse;
      if (seq !== requestSeqRef.current) return;
      if (!res.ok || data.error) {
        setBrowseError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const nextPath = data.path ?? "";
      setCandidatePath((prev) => nextDirectoryPickerCandidate(currentPathRef.current, nextPath, prev));
      setCurrentPath(nextPath);
      setParentPath(data.parent ?? null);
      setEntries(data.entries ?? []);
      setRoots(data.roots ?? []);
      setHome(data.home ?? null);
      setTruncated(Boolean(data.truncated));
      setDraftPath(nextPath);
      if (data.platform) setPlatform(normalizeDirectoryPickerPlatform(data.platform));
    } catch (error) {
      if (controller.signal.aborted || seq !== requestSeqRef.current) return;
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    setCandidatePath(null);
    setBrowseError(null);
    setSaveError(null);
    void loadDirectory((initialPath ?? "").trim());

    const focusTimer = window.setTimeout(() => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }, 0);

    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      requestSeqRef.current += 1;
      window.clearTimeout(focusTimer);
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous && typeof previous.focus === "function") {
        window.requestAnimationFrame(() => previous.focus());
      }
    };
  }, [initialPath, loadDirectory, open]);

  useEffect(() => {
    if (!candidatePath || !listRef.current) return;
    const selected = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ block: "nearest" });
  }, [candidatePath]);

  const trapFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
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

  const moveCandidate = useCallback((delta: number) => {
    if (entries.length === 0) return;
    const currentIndex = entries.findIndex((entry) => (
      candidatePath != null && directoryPickerPathsEqual(entry.path, candidatePath, platform)
    ));
    let nextIndex = currentIndex + delta;
    if (currentIndex < 0) nextIndex = delta > 0 ? 0 : entries.length - 1;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex >= entries.length) nextIndex = entries.length - 1;
    setCandidatePath(entries[nextIndex]?.path ?? null);
    setSaveError(null);
  }, [candidatePath, entries, platform]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!saving) onClose();
      return;
    }

    const target = event.target as HTMLElement | null;
    const editingPath = Boolean(target?.closest("input, textarea, [contenteditable='true']"));
    const listFocused = listRef.current != null && (
      document.activeElement === listRef.current || listRef.current.contains(document.activeElement)
    );

    if (!editingPath && !saving && (event.key === "ArrowDown" || event.key === "ArrowUp") && listFocused) {
      event.preventDefault();
      moveCandidate(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (!editingPath && !saving && event.key === "Enter" && listFocused && candidatePath) {
      event.preventDefault();
      void loadDirectory(candidatePath);
      return;
    }

    if (!editingPath && !saving && !loading && event.key === "Backspace") {
      const canGoUp = parentPath != null || currentPath !== "";
      if (canGoUp) {
        event.preventDefault();
        void loadDirectory(parentPath ?? "");
        return;
      }
    }

    trapFocus(event);
  }, [candidatePath, currentPath, loadDirectory, loading, moveCandidate, onClose, parentPath, saving, trapFocus]);

  const goToDraftPath = useCallback(() => {
    void loadDirectory(draftPath.trim());
  }, [draftPath, loadDirectory]);

  const handleSave = useCallback(async () => {
    const path = resolveDirectoryPickerFinalPath(currentPath, candidatePath);
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
  }, [candidatePath, currentPath, onSelect, saving]);

  if (!open || typeof document === "undefined") return null;

  const canGoUp = parentPath != null || currentPath !== "";
  const navigating = loading || saving;
  const saveDisabled = saving || !finalPath;
  const rootsLabel = labels.roots;
  const locationLabel = currentPath || rootsLabel;

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
        data-server-platform={platform}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id={titleId} className="pi-modal-title">{t("sidebar.addProject")}</div>
            <div id={subtitleId} className="pi-modal-subtitle">{labels.subtitle}</div>
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
              placeholder={labels.placeholder}
              aria-label={t("sidebar.directoryPickerPathAria")}
              spellCheck={false}
              className="settings-control-mono directory-picker-path-input"
              disabled={saving}
            />
            <SettingsButton
              type="button"
              variant="secondary"
              size="sm"
              onClick={goToDraftPath}
              disabled={navigating}
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
              disabled={!canGoUp || navigating}
              title={t("sidebar.directoryPickerUp")}
            >
              ← {t("sidebar.directoryPickerUp")}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadDirectory("")}
              disabled={navigating}
            >
              {rootsLabel}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadDirectory(currentPath)}
              disabled={navigating}
            >
              {t("sidebar.directoryPickerRefresh")}
            </SettingsButton>
            <span className="directory-picker-location" title={locationLabel}>
              {locationLabel}
            </span>
          </div>

          <nav
            className="directory-picker-breadcrumbs"
            aria-label={t("sidebar.directoryPickerBreadcrumbAria")}
          >
            {breadcrumbs.length === 0 ? (
              <span className="directory-picker-crumb is-current">{rootsLabel}</span>
            ) : breadcrumbs.map((crumb, index) => {
              const current = index === breadcrumbs.length - 1;
              if (current) {
                return (
                  <span
                    key={`crumb:${crumb.path}`}
                    className="directory-picker-crumb is-current"
                    title={crumb.path}
                  >
                    {crumb.label}
                  </span>
                );
              }
              return (
                <span key={`crumb:${crumb.path}`} className="directory-picker-crumb-wrap">
                  <button
                    type="button"
                    className="directory-picker-crumb"
                    title={crumb.path}
                    disabled={navigating}
                    onClick={() => void loadDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                  <span className="directory-picker-crumb-sep" aria-hidden="true">/</span>
                </span>
              );
            })}
          </nav>

          {(browseError || saveError) && (
            <SettingsNotice tone="danger">{browseError || saveError}</SettingsNotice>
          )}

          <div className="directory-picker-layout">
            <div
              className="directory-picker-shortcuts"
              role="navigation"
              aria-label={t("sidebar.directoryPickerShortcutsAria")}
            >
              {shortcuts.map((shortcut) => {
                const active = currentPath !== "" && directoryPickerPathsEqual(shortcut.path, currentPath, platform);
                const label = shortcut.kind === "project"
                  ? t("sidebar.directoryPickerCurrentProject")
                  : shortcut.label;
                return (
                  <button
                    key={shortcut.id}
                    type="button"
                    className={`directory-picker-shortcut${active ? " is-active" : ""}`}
                    title={shortcut.path}
                    aria-current={active ? "true" : undefined}
                    disabled={navigating}
                    onClick={() => void loadDirectory(shortcut.path)}
                  >
                    <span className="directory-picker-shortcut-label">{label}</span>
                    {shortcut.kind === "project" && (
                      <span className="directory-picker-shortcut-path" title={shortcut.path}>
                        {shortcut.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="directory-picker-main">
              <div
                ref={listRef}
                className="directory-picker-list"
                role="listbox"
                tabIndex={0}
                aria-label={t("sidebar.directoryPickerListAria")}
                aria-busy={loading || undefined}
                aria-activedescendant={selectedEntryId}
              >
                {loading && entries.length === 0 ? (
                  <div className="directory-picker-empty" role="status">{t("sidebar.loading")}</div>
                ) : entries.length === 0 ? (
                  <div className="directory-picker-empty" role="status">{t("sidebar.directoryPickerEmpty")}</div>
                ) : (
                  entries.map((entry, index) => {
                    const selected = candidatePath != null
                      && directoryPickerPathsEqual(entry.path, candidatePath, platform);
                    return (
                      <div key={entry.path} className="directory-picker-entry-wrap">
                        <div
                          id={`${listId}-${index}`}
                          role="option"
                          aria-selected={selected}
                          className={`directory-picker-entry${selected ? " is-selected" : ""}`}
                          title={entry.path}
                          onClick={() => {
                            if (navigating) return;
                            setCandidatePath(entry.path);
                            setSaveError(null);
                            listRef.current?.focus();
                          }}
                          onDoubleClick={() => {
                            if (navigating) return;
                            void loadDirectory(entry.path);
                          }}
                        >
                          <span className="directory-picker-entry-icon" aria-hidden="true">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                          </span>
                          <span className="directory-picker-entry-name">{entry.name}</span>
                          {selected && (
                            <span className="directory-picker-entry-marker" aria-hidden="true">●</span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="directory-picker-enter"
                          tabIndex={-1}
                          disabled={navigating}
                          aria-label={`${t("sidebar.directoryPickerEnter")} ${entry.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void loadDirectory(entry.path);
                          }}
                        >
                          {t("sidebar.directoryPickerEnter")}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              {loading && entries.length > 0 && (
                <div className="directory-picker-meta" role="status">{t("sidebar.loading")}</div>
              )}
            </div>
          </div>

          {truncated && (
            <div className="directory-picker-meta" role="status">
              {t("sidebar.directoryPickerTruncated")}
            </div>
          )}
        </div>

        <div className="pi-modal-footer directory-picker-footer">
          <div className="directory-picker-footer-path" title={finalPath || locationLabel}>
            {t("sidebar.directoryPickerSelectedPath", { path: finalPath || locationLabel })}
          </div>
          <SettingsActionRow>
            <SettingsButton
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={saving}
            >
              {t("common.cancel")}
            </SettingsButton>
            <SettingsButton
              type="button"
              variant="primary"
              busy={saving}
              disabled={saveDisabled}
              onClick={() => void handleSave()}
            >
              {saving ? t("sidebar.checkingPath") : t("sidebar.directoryPickerSelectFolder")}
            </SettingsButton>
          </SettingsActionRow>
        </div>
      </div>
    </div>,
    document.body,
  );
}
