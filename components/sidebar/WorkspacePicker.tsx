"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { WorktreeInfo } from "@/lib/types";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useI18n } from "@/components/I18nProvider";
import {
  filterCwdPickerGroups,
  shortenCwd,
  type CwdPickerRow,
  type WorktreeContextMenuState,
} from "./sidebar-utils";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog";
import { WorktreeBadge } from "./WorktreeBadge";

export interface WorkspacePickerProps {
  activeCwd: string | null;
  homeDir: string;
  workspaceTitle: string;
  worktreeByCwd: Map<string, WorktreeInfo>;
  cwdGroups: CwdPickerRow[][];
  archivedOnlyCwds: Set<string>;
  creatingWorktree: boolean;
  worktreeError: string | null;
  sessionRefreshDone: boolean;
  /** While true, suppress the empty-cwd placeholder (URL session restore in flight). */
  suppressEmptyPlaceholder?: boolean;
  onActiveCwdChange: (cwd: string | null) => void;
  onNewWorktree: () => void;
  onRefresh: () => void;
  onRequestArchiveAll: () => void;
  onWorktreeAction: (kind: "delete" | "archive", cwd: string, worktree: WorktreeInfo) => void;
  onClearWorktreeError?: () => void;
}

export const WorkspacePicker = memo(function WorkspacePicker({
  activeCwd,
  homeDir,
  workspaceTitle,
  worktreeByCwd,
  cwdGroups,
  archivedOnlyCwds,
  creatingWorktree,
  worktreeError,
  sessionRefreshDone,
  suppressEmptyPlaceholder = false,
  onActiveCwdChange,
  onNewWorktree,
  onRefresh,
  onRequestArchiveAll,
  onWorktreeAction,
  onClearWorktreeError,
}: WorkspacePickerProps) {
  const { t } = useI18n();
  const appDialog = useAppDialog();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [folderActionStatus, setFolderActionStatus] = useState<string | null>(null);
  const folderStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [allProjectsOpen, setAllProjectsOpen] = useState(false);
  const [cwdSearch, setCwdSearch] = useState("");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [nativePicking, setNativePicking] = useState(false);
  const [nativePickerAvailable, setNativePickerAvailable] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [worktreeContextMenu, setWorktreeContextMenu] = useState<WorktreeContextMenuState | null>(null);

  const cwdSearchInputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const pickCapabilitiesRef = useRef<{
    preferNative: boolean;
    localAccess: boolean;
    nativePickerSupported: boolean;
  } | null>(null);
  const nativePickAbortRef = useRef<AbortController | null>(null);

  const resetCwdPickerView = useCallback(() => {
    setAllProjectsOpen(false);
    setCwdSearch("");
  }, []);

  const closeCwdPicker = useCallback(() => {
    setDropdownOpen(false);
    resetCwdPickerView();
  }, [resetCwdPickerView]);

  // Close picker when workspace changes externally (WorkTree create, restore, etc.).
  useEffect(() => {
    closeCwdPicker();
    setWorkspaceMenuOpen(false);
    setWorktreeContextMenu(null);
  }, [activeCwd, closeCwdPicker]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setWorktreeContextMenu(null);
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeCwdPicker();
      }
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [closeCwdPicker]);

  const showFolderStatus = useCallback((message: string, clearMs = 2500) => {
    if (folderStatusTimerRef.current) {
      clearTimeout(folderStatusTimerRef.current);
      folderStatusTimerRef.current = null;
    }
    setFolderActionStatus(message);
    if (clearMs > 0) {
      folderStatusTimerRef.current = setTimeout(() => {
        setFolderActionStatus(null);
        folderStatusTimerRef.current = null;
      }, clearMs);
    }
  }, []);

  const handleDirectoryPicked = useCallback((cwd: string) => {
    setDirectoryPickerOpen(false);
    setNativePicking(false);
    onActiveCwdChange(cwd);
    onClearWorktreeError?.();
  }, [onActiveCwdChange, onClearWorktreeError]);

  const loadPickCapabilities = useCallback(async (signal?: AbortSignal) => {
    if (pickCapabilitiesRef.current) return pickCapabilitiesRef.current;

    // Browser-side hint only: when the page itself is on loopback, it is worth
    // attempting the native chooser even if the server could not prove the peer
    // yet (connection capture cold start). POST still enforces loopback.
    const browserLoopback = (() => {
      if (typeof window === "undefined") return false;
      const host = window.location.hostname.toLowerCase();
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    })();

    try {
      const res = await fetch("/api/cwd/pick-native", { signal });
      const data = await res.json().catch(() => ({})) as {
        preferNative?: boolean;
        localAccess?: boolean;
        nativePickerSupported?: boolean;
        localAccessReason?: string | null;
      };
      const nativeSupported = Boolean(data.nativePickerSupported);
      const serverLocal = Boolean(data.localAccess);
      const preferNative =
        Boolean(data.preferNative) ||
        (nativeSupported && (serverLocal || (
          browserLoopback && data.localAccessReason === "remote_address_unavailable"
        )));
      const caps = {
        preferNative,
        localAccess: serverLocal || browserLoopback,
        nativePickerSupported: nativeSupported,
      };
      pickCapabilitiesRef.current = caps;
      setNativePickerAvailable(caps.preferNative);
      return caps;
    } catch {
      if (signal?.aborted) return null;
      const caps = {
        preferNative: browserLoopback,
        localAccess: browserLoopback,
        nativePickerSupported: browserLoopback,
      };
      pickCapabilitiesRef.current = caps;
      setNativePickerAvailable(caps.preferNative);
      return caps;
    }
  }, []);

  // Warm local/native capability so Add Project can decide without an extra round-trip.
  useEffect(() => {
    const controller = new AbortController();
    void loadPickCapabilities(controller.signal);
    return () => controller.abort();
  }, [loadPickCapabilities]);

  useEffect(() => {
    return () => {
      nativePickAbortRef.current?.abort();
      nativePickAbortRef.current = null;
    };
  }, []);

  const validateAndSelectCwd = useCallback(async (path: string) => {
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: path }),
    });
    const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
    if (!res.ok || data.error) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    handleDirectoryPicked(data.cwd ?? path);
  }, [handleDirectoryPicked]);

  /**
   * Try host-OS folder chooser when browser↔server look local.
   * Returns:
   *  - "selected" when a path was validated and applied
   *  - "cancelled" when the user dismissed the native dialog (no web fallback)
   *  - "fallback" when native is unavailable / failed (open web browser)
   */
  const tryNativeDirectoryPick = useCallback(async (options?: {
    /** When true, open web picker first is already done — keep it open on fallback. */
    fromWebDialog?: boolean;
  }): Promise<"selected" | "cancelled" | "fallback"> => {
    if (nativePicking) return "fallback";

    const caps = await loadPickCapabilities();
    if (!caps?.preferNative) return "fallback";

    nativePickAbortRef.current?.abort();
    const controller = new AbortController();
    nativePickAbortRef.current = controller;
    setNativePicking(true);
    if (!options?.fromWebDialog) {
      closeCwdPicker();
      showFolderStatus(t("sidebar.nativePickingProject"), 0);
    }

    try {
      const res = await fetch("/api/cwd/pick-native", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialPath: activeCwd }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({})) as {
        path?: string;
        error?: string;
        code?: string;
        cancelled?: boolean;
      };

      if (res.ok && data.path) {
        await validateAndSelectCwd(data.path);
        setFolderActionStatus(null);
        return "selected";
      }

      if (data.cancelled || data.code === "cancelled") {
        setFolderActionStatus(null);
        return "cancelled";
      }

      if (data.code === "busy") {
        showFolderStatus(t("sidebar.nativePickBusy"), 4000);
        return options?.fromWebDialog ? "cancelled" : "fallback";
      }

      // Permanent capability miss — stop preferring native this session.
      if (
        res.status === 403 ||
        data.code === "not_loopback" ||
        data.code === "remote_address_unavailable" ||
        data.code === "forwarded_non_loopback" ||
        data.code === "host_not_loopback" ||
        data.code === "unavailable"
      ) {
        pickCapabilitiesRef.current = {
          preferNative: false,
          localAccess: false,
          nativePickerSupported: caps.nativePickerSupported && data.code !== "unavailable",
        };
        setNativePickerAvailable(false);
      }

      if (!options?.fromWebDialog) {
        showFolderStatus(t("sidebar.nativePickFallback"), 2500);
      }
      return "fallback";
    } catch (error) {
      if (controller.signal.aborted) return "cancelled";
      if (!options?.fromWebDialog) {
        showFolderStatus(t("sidebar.nativePickFallback"), 2500);
      }
      void error;
      return "fallback";
    } finally {
      if (nativePickAbortRef.current === controller) {
        nativePickAbortRef.current = null;
      }
      setNativePicking(false);
    }
  }, [
    activeCwd,
    closeCwdPicker,
    loadPickCapabilities,
    nativePicking,
    showFolderStatus,
    t,
    validateAndSelectCwd,
  ]);

  const openDirectoryPicker = useCallback(async () => {
    closeCwdPicker();
    const outcome = await tryNativeDirectoryPick();
    if (outcome === "selected" || outcome === "cancelled") return;
    setDirectoryPickerOpen(true);
  }, [closeCwdPicker, tryNativeDirectoryPick]);

  const handleRequestNativeFromWeb = useCallback(() => {
    void (async () => {
      const outcome = await tryNativeDirectoryPick({ fromWebDialog: true });
      if (outcome === "selected") {
        setDirectoryPickerOpen(false);
      }
    })();
  }, [tryNativeDirectoryPick]);

  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        onActiveCwdChange(data.cwd);
        closeCwdPicker();
      }
    } catch {
      // ignore
    }
  }, [closeCwdPicker, onActiveCwdChange]);

  useEffect(() => {
    return () => {
      if (folderStatusTimerRef.current) clearTimeout(folderStatusTimerRef.current);
    };
  }, []);

  // Warm allowed-root registration so open-folder can take the fast auth path.
  useEffect(() => {
    if (!activeCwd) return;
    const controller = new AbortController();
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: activeCwd }),
      signal: controller.signal,
    }).catch(() => {
      // Best-effort; open API still authorizes via full allowed-roots fallback.
    });
    return () => controller.abort();
  }, [activeCwd]);

  const handleOpenProjectFolder = useCallback(async () => {
    if (!activeCwd || openingFolder) return;
    setWorkspaceMenuOpen(false);
    setOpeningFolder(true);
    showFolderStatus(t("sidebar.openingFolder"), 0);
    try {
      const res = await fetch("/api/cwd/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; cwd?: string };
      if (!res.ok) {
        showFolderStatus(data.error || t("sidebar.openFolderFailed"), 4000);
        await appDialog.alert({
          title: t("sidebar.openFolder"),
          message: data.error || t("sidebar.openFolderFailed"),
        });
        return;
      }
      showFolderStatus(t("sidebar.openFolderOpened"), 2500);
    } catch (e) {
      const message = e instanceof Error ? e.message : t("sidebar.openFolderFailed");
      showFolderStatus(message, 4000);
      await appDialog.alert({
        title: t("sidebar.openFolder"),
        message,
      });
    } finally {
      setOpeningFolder(false);
    }
  }, [activeCwd, appDialog, openingFolder, showFolderStatus, t]);

  const openWorktreeAction = useCallback((kind: "delete" | "archive", cwd: string, worktree: WorktreeInfo) => {
    setWorktreeContextMenu(null);
    closeCwdPicker();
    onWorktreeAction(kind, cwd, worktree);
  }, [closeCwdPicker, onWorktreeAction]);

  const filteredCwdGroups = allProjectsOpen
    ? filterCwdPickerGroups(cwdGroups, cwdSearch)
    : cwdGroups.slice(0, 5);
  const displayedCwdRows = filteredCwdGroups.flat();
  const selectedWorktree = activeCwd ? worktreeByCwd.get(activeCwd) : undefined;

  return (
    <div className="workspace-picker">
      <div className="session-sidebar-actions workspace-quick-actions">
        <div ref={workspaceMenuRef} style={{ position: "relative" }}>
          <button
            className="workspace-quick-action"
            onClick={() => setWorkspaceMenuOpen((v) => !v)}
            title={openingFolder ? t("sidebar.openingFolder") : t("sidebar.workspaceActions")}
            aria-expanded={workspaceMenuOpen}
            aria-haspopup="menu"
            aria-busy={openingFolder}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {workspaceMenuOpen && (
            <>
              <div
                onClick={() => setWorkspaceMenuOpen(false)}
                className="sidebar-menu-dismiss-layer"
              />
              <div className="session-sidebar-floating-menu sidebar-floating-menu" role="menu">
                <button
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    onNewWorktree();
                  }}
                  disabled={!activeCwd || creatingWorktree}
                  title={activeCwd ? t("sidebar.createWorktreeFrom", { cwd: activeCwd }) : t("sidebar.selectProjectFirst")}
                  className="sidebar-menu-item"
                  role="menuitem"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="6" r="3" />
                    <path d="M6 15V9a3 3 0 0 1 3-3h6" />
                    <path d="M9 18h6a3 3 0 0 0 3-3V9" />
                  </svg>
                  {creatingWorktree ? t("common.creating") : t("sidebar.workTree")}
                </button>
                <button
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    onRefresh();
                  }}
                  className="sidebar-menu-item"
                  role="menuitem"
                >
                  {sessionRefreshDone ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  )}
                  {t("common.refresh")}
                </button>
                {activeCwd && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleOpenProjectFolder();
                    }}
                    disabled={openingFolder}
                    title={activeCwd}
                    className="sidebar-menu-item"
                    role="menuitem"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    {openingFolder ? t("sidebar.openingFolder") : t("sidebar.openFolder")}
                  </button>
                )}
                {activeCwd && (
                  <button
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      onRequestArchiveAll();
                    }}
                    className="sidebar-menu-item"
                    role="menuitem"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    {t("sidebar.archiveAllSessions")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {worktreeError && <div className="workspace-error">{worktreeError}</div>}
      {folderActionStatus && (
        <div className={`workspace-action-status${openingFolder ? " is-pending" : ""}`} role="status">
          {folderActionStatus}
        </div>
      )}

      <div ref={dropdownRef} style={{ position: "relative" }}>
        <button
          className={`workspace-card${activeCwd ? "" : " is-empty"}`}
          onClick={() => {
            if (dropdownOpen) {
              closeCwdPicker();
            } else {
              resetCwdPickerView();
              setDropdownOpen(true);
            }
          }}
          aria-label={activeCwd ? t("sidebar.switchProjectCurrent", { cwd: activeCwd }) : t("sidebar.switchProject")}
          aria-expanded={dropdownOpen}
          onContextMenu={(e) => {
            const worktree = activeCwd ? worktreeByCwd.get(activeCwd) : undefined;
            if (!activeCwd || !worktree) return;
            e.preventDefault();
            e.stopPropagation();
            setWorktreeContextMenu({ x: e.clientX, y: e.clientY, cwd: activeCwd, worktree });
          }}

        >
          <span className="workspace-card-copy">
            <strong>{workspaceTitle}</strong>
            <span title={selectedWorktree ? `${activeCwd ?? ""}\n${t("sidebar.worktreeContextHint")}` : activeCwd ?? ""}>
              {activeCwd
                ? shortenCwd(activeCwd, homeDir)
                : (suppressEmptyPlaceholder ? "" : t("sidebar.selectProjectPlaceholder"))}
            </span>
          </span>
          <WorktreeBadge worktree={selectedWorktree} />
          <svg className="workspace-card-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 4.5 6 7.5 9 4.5" />
          </svg>
        </button>

        {dropdownOpen && (
          <div
            className="session-sidebar-cwd-menu"
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              display: "flex",
              flexDirection: "column",
              maxHeight: "calc(100dvh - 150px)",
              overflow: "hidden",
            }}
          >
            {allProjectsOpen && (
              <div style={{ padding: "8px", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 7 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setAllProjectsOpen(false);
                      setCwdSearch("");
                    }}
                    style={{
                      padding: 0,
                      background: "none",
                      border: "none",
                      color: "var(--accent)",
                      cursor: "pointer",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    ← {t("sidebar.recentProjects")}
                  </button>
                  <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                    {t("sidebar.projectCount", { count: cwdGroups.length })}
                  </span>
                </div>
                <input
                  ref={cwdSearchInputRef}
                  type="search"
                  aria-label={t("sidebar.searchProjectsAria")}
                  placeholder={t("sidebar.searchProjectsPlaceholder")}
                  value={cwdSearch}
                  onChange={(e) => setCwdSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeCwdPicker();
                  }}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "6px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                />
              </div>
            )}

            <div style={{ maxHeight: allProjectsOpen ? 320 : 300, minHeight: 0, overflowY: "auto", flexShrink: 1 }}>
              {displayedCwdRows.map((row) => {
                const selected = row.cwd === activeCwd;
                const isWorktree = row.kind === "worktree";
                return (
                  <button
                    key={`${row.kind}:${row.cwd}`}
                    onClick={() => {
                      onActiveCwdChange(row.cwd);
                      onClearWorktreeError?.();
                      closeCwdPicker();
                    }}
                    onContextMenu={(e) => {
                      if (!row.worktree) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setWorktreeContextMenu({ x: e.clientX, y: e.clientY, cwd: row.cwd, worktree: row.worktree });
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: isWorktree ? "7px 10px 7px 28px" : "8px 10px",
                      background: selected ? "var(--bg-selected)" : isWorktree ? "var(--bg-subtle)" : "none",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: selected ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={row.worktree ? `${row.cwd}\n${t("sidebar.worktreeContextHint")}` : row.cwd}
                  >
                    {selected && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {!selected && isWorktree && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M2 1.5v4A2.5 2.5 0 0 0 4.5 8H8" />
                      </svg>
                    )}
                    {!selected && !isWorktree && <span style={{ width: 10, flexShrink: 0 }} />}
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {shortenCwd(row.cwd, homeDir)}
                      {row.syntheticParent && <span style={{ color: "var(--text-dim)", marginLeft: 5 }}>{t("sidebar.mainWorkspaceBadge")}</span>}
                      {archivedOnlyCwds.has(row.cwd) && <span style={{ color: "var(--text-dim)", fontStyle: "italic", marginLeft: 5 }}>{t("sidebar.archivedWorkspaceBadge")}</span>}
                    </span>
                    <WorktreeBadge worktree={row.worktree} />
                  </button>
                );
              })}
              {allProjectsOpen && filteredCwdGroups.length === 0 && (
                <div
                  role="status"
                  style={{ padding: "18px 12px", color: "var(--text-dim)", fontSize: 11, textAlign: "center" }}
                >
                  {cwdSearch.trim() ? t("sidebar.noProjectsMatch") : t("sidebar.noProjects")}
                </div>
              )}
            </div>

            {!allProjectsOpen && cwdGroups.length > 5 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setAllProjectsOpen(true);
                  setCwdSearch("");
                  setTimeout(() => cwdSearchInputRef.current?.focus(), 0);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  width: "100%",
                  padding: "8px 10px",
                  background: "var(--bg-subtle)",
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  color: "var(--accent)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                <span>{t("sidebar.viewAllProjects")}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10, fontWeight: 500 }}>
                  {t("sidebar.projectCount", { count: cwdGroups.length })}
                </span>
              </button>
            )}

            <button
              onClick={(e) => { e.stopPropagation(); void handleDefaultCwd(); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "8px 10px",
                background: "none",
                border: "none",
                borderTop: displayedCwdRows.length > 0 || cwdGroups.length > 5 ? "1px solid var(--border)" : "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
              </svg>
              <span>{t("sidebar.useDefaultDirectory")}</span>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation();
                void openDirectoryPicker();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                width: "100%",
                padding: "8px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                textAlign: "left",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <line x1="5" y1="1" x2="5" y2="9" />
                <line x1="1" y1="5" x2="9" y2="5" />
              </svg>
              <span>{t("sidebar.addProject")}</span>
            </button>
          </div>
        )}
      </div>

      {worktreeContextMenu && (
        <div
          className="sidebar-context-menu sidebar-context-menu-wide"
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: worktreeContextMenu.x, top: worktreeContextMenu.y }}
        >
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openWorktreeAction("archive", worktreeContextMenu.cwd, worktreeContextMenu.worktree);
            }}
            className="sidebar-menu-item"
          >
            {t("sidebar.archiveWorktreeMenu")}
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openWorktreeAction("delete", worktreeContextMenu.cwd, worktreeContextMenu.worktree);
            }}
            className="sidebar-menu-item is-danger"
          >
            {t("sidebar.deleteWorktreeMenu")}
          </button>
        </div>
      )}

      <DirectoryPickerDialog
        open={directoryPickerOpen}
        initialPath={activeCwd}
        onClose={() => {
          if (!nativePicking) setDirectoryPickerOpen(false);
        }}
        onSelect={handleDirectoryPicked}
        nativePickerAvailable={nativePickerAvailable}
        nativePicking={nativePicking}
        onRequestNativePicker={handleRequestNativeFromWeb}
      />
    </div>
  );
});
