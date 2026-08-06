"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { WorktreeInfo } from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsButton,
  SettingsInput,
} from "@/components/ui/SettingsPrimitives";
import {
  displayCwdPath,
  filterCwdPickerGroups,
  getCwdPickerRowTitle,
  getProjectAvatarHue,
  getProjectInitials,
  shortenCwd,
  type CwdPickerRow,
} from "./sidebar-utils";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface ProjectPickerDialogProps {
  open: boolean;
  activeCwd: string | null;
  homeDir: string;
  cwdGroups: CwdPickerRow[][];
  archivedOnlyCwds: Set<string>;
  onClose: () => void;
  onSelect: (cwd: string) => void;
  onUseDefaultDirectory: () => void;
  onAddProject: () => void;
  onWorktreeContextMenu: (payload: {
    x: number;
    y: number;
    cwd: string;
    worktree: WorktreeInfo;
  }) => void;
}

function ProjectAvatar({ name, seed }: { name: string; seed: string }) {
  const initials = getProjectInitials(name);
  const hue = getProjectAvatarHue(seed);
  const style = {
    "--project-avatar-hue": String(hue),
  } as CSSProperties;

  return (
    <span className="project-picker-avatar" style={style} aria-hidden="true">
      {initials}
    </span>
  );
}

export function ProjectPickerDialog({
  open,
  activeCwd,
  homeDir,
  cwdGroups,
  archivedOnlyCwds,
  onClose,
  onSelect,
  onUseDefaultDirectory,
  onAddProject,
  onWorktreeContextMenu,
}: ProjectPickerDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const subtitleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [cwdSearch, setCwdSearch] = useState("");

  const filteredGroups = filterCwdPickerGroups(cwdGroups, cwdSearch);
  const displayedRows = filteredGroups.flat();

  useEffect(() => {
    if (!open) {
      setCwdSearch("");
      return;
    }

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTimer = window.setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
      const previous = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [open]);

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
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey) {
      if (!active || active === first || !panelRef.current.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!active || active === last || !panelRef.current.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    trapFocus(event);
  }, [onClose, trapFocus]);

  const handleRowContextMenu = useCallback((
    event: ReactMouseEvent<HTMLButtonElement>,
    row: CwdPickerRow,
  ) => {
    if (!row.worktree) return;
    event.preventDefault();
    event.stopPropagation();
    onWorktreeContextMenu({
      x: event.clientX,
      y: event.clientY,
      cwd: row.cwd,
      worktree: row.worktree,
    });
  }, [onWorktreeContextMenu]);

  if (!open || typeof document === "undefined") return null;

  const subtitle = activeCwd
    ? t("sidebar.projectPickerCurrent", { cwd: shortenCwd(activeCwd, homeDir) })
    : t("sidebar.projectPickerSubtitle");

  return createPortal(
    <div
      className="pi-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="pi-modal-panel project-picker-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <div id={titleId} className="pi-modal-title">{t("sidebar.switchProject")}</div>
            <div id={subtitleId} className="pi-modal-subtitle" title={activeCwd ?? undefined}>
              {subtitle}
            </div>
          </div>
          <button
            type="button"
            className="pi-modal-close"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="pi-modal-body project-picker-body">
          <div className="project-picker-search-row">
            <SettingsInput
              ref={searchInputRef}
              type="search"
              value={cwdSearch}
              onChange={(event) => setCwdSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  if (cwdSearch) {
                    setCwdSearch("");
                    return;
                  }
                  onClose();
                }
              }}
              placeholder={t("sidebar.searchProjectsPlaceholder")}
              aria-label={t("sidebar.searchProjectsAria")}
              spellCheck={false}
              className="project-picker-search-input"
            />
            <span className="project-picker-count" aria-live="polite">
              {t("sidebar.projectCount", { count: cwdGroups.length })}
            </span>
          </div>

          <div
            className="project-picker-list"
            role="listbox"
            aria-label={t("sidebar.projectPickerListAria")}
          >
            {displayedRows.length === 0 ? (
              <div className="project-picker-empty" role="status">
                {cwdSearch.trim() ? t("sidebar.noProjectsMatch") : t("sidebar.noProjects")}
              </div>
            ) : (
              displayedRows.map((row) => {
                const selected = row.cwd === activeCwd;
                const isWorktree = row.kind === "worktree";
                const title = getCwdPickerRowTitle(row);
                const pathLabel = displayCwdPath(row.cwd, homeDir);
                const branch = row.worktree?.branch;
                const avatarSeed = isWorktree
                  ? (row.worktree?.mainWorktreePath || row.cwd)
                  : row.cwd;

                return (
                  <button
                    key={`${row.kind}:${row.cwd}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={[
                      "project-picker-entry",
                      selected ? "is-selected" : "",
                      isWorktree ? "is-worktree" : "",
                    ].filter(Boolean).join(" ")}
                    title={row.worktree ? `${row.cwd}\n${t("sidebar.worktreeContextHint")}` : row.cwd}
                    onClick={() => onSelect(row.cwd)}
                    onContextMenu={(event) => handleRowContextMenu(event, row)}
                  >
                    <ProjectAvatar name={title} seed={avatarSeed} />

                    <span className="project-picker-entry-copy">
                      <span className="project-picker-entry-title-row">
                        <span className="project-picker-entry-name">{title}</span>
                        {row.syntheticParent && (
                          <span className="project-picker-entry-badge">
                            {t("sidebar.mainWorkspaceBadge")}
                          </span>
                        )}
                        {archivedOnlyCwds.has(row.cwd) && (
                          <span className="project-picker-entry-badge is-muted">
                            {t("sidebar.archivedWorkspaceBadge")}
                          </span>
                        )}
                      </span>
                      <span className="project-picker-entry-path" title={row.cwd}>
                        {pathLabel}
                      </span>
                      {branch && (
                        <span className="project-picker-entry-branch" title={branch}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="6" cy="18" r="3" />
                            <circle cx="18" cy="6" r="3" />
                            <path d="M6 15V9a3 3 0 0 1 3-3h6" />
                            <path d="M9 18h6a3 3 0 0 0 3-3V9" />
                          </svg>
                          <span>{branch}</span>
                        </span>
                      )}
                    </span>

                    <span className="project-picker-entry-trailing" aria-hidden="true">
                      {selected && (
                        <svg width="14" height="14" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="1.5 5 4 7.5 8.5 2.5" />
                        </svg>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="pi-modal-footer project-picker-footer">
          <SettingsActionRow>
            <SettingsButton type="button" variant="ghost" onClick={onUseDefaultDirectory}>
              {t("sidebar.useDefaultDirectory")}
            </SettingsButton>
            <SettingsButton type="button" variant="secondary" onClick={onAddProject}>
              {t("sidebar.addProject")}
            </SettingsButton>
            <SettingsButton type="button" variant="primary" onClick={onClose}>
              {t("common.close")}
            </SettingsButton>
          </SettingsActionRow>
        </div>
      </div>
    </div>,
    document.body,
  );
}
