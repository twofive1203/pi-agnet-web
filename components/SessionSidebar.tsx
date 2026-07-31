"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { GitInfo, SessionInfo, WorktreeInfo } from "@/lib/types";
import { buildSessionTree } from "@/lib/sidebar-session-tree";
import { formatWorkspaceHeaderTitle } from "@/lib/workspace-title";
import { useSessionBrowser } from "@/hooks/useSessionBrowser";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import {
  buildCwdPickerRows,
  getOrderedCwds,
  groupCwdPickerRows,
  makeTempSessionId,
  MIN_SESSION_LIST_HEIGHT,
  type SessionContextMenuState,
  type WorktreeActionResponse,
  type WorktreeActionState,
  type WorktreeCreateResponse,
} from "./sidebar/sidebar-utils";
import { WorkspacePicker } from "./sidebar/WorkspacePicker";
import { SessionList } from "./sidebar/SessionList";
import { ArchivedSessionSection } from "./sidebar/ArchivedSessionSection";
import { SidebarExplorerPane } from "./sidebar/SidebarExplorerPane";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /** Controlled workspace cwd (AppShell is the source of truth). */
  activeCwd: string | null;
  onActiveCwdChange: (cwd: string | null) => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  explorerRefreshKey?: number;
  onAtMention?: (relativePath: string) => void;
  /** Bump to open the Files explorer pane (nav pill). */
  filesPill?: number;
  /** Bump to expand the archived sessions section (nav pill). */
  archivePill?: number;
}

export function SessionSidebar({
  selectedSessionId,
  onSelectSession,
  onNewSession,
  initialSessionId,
  onInitialRestoreDone,
  refreshKey,
  onSessionDeleted,
  activeCwd,
  onActiveCwdChange,
  onOpenFile,
  explorerRefreshKey,
  onAtMention,
  filesPill,
  archivePill,
}: Props) {
  const { t } = useI18n();
  const appDialog = useAppDialog();
  const [homeDir, setHomeDir] = useState<string>("");
  const [selectedForArchive, setSelectedForArchive] = useState<Set<string>>(new Set());
  const [archiveAllConfirming, setArchiveAllConfirming] = useState(false);
  const [archiveAllBusy, setArchiveAllBusy] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [ephemeralWorktrees, setEphemeralWorktrees] = useState<Record<string, WorktreeInfo>>({});
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [worktreeAction, setWorktreeAction] = useState<WorktreeActionState | null>(null);
  const [removedWorktreeCwds, setRemovedWorktreeCwds] = useState<string[]>([]);
  const [activeCwdGit, setActiveCwdGit] = useState<GitInfo | undefined>(undefined);
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarRootRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

  const {
    projectSummaries,
    projectSessions,
    projectSessionsCwd,
    projectSessionTotal,
    hasMoreSessions,
    loading,
    loadingMore,
    error,
    archivedCwds,
    archivedCounts,
    archivedSessions,
    archivedHasMore,
    loadingMoreArchived,
    sessionRefreshDone,
    loadSessions,
    loadMoreSessions,
    loadArchivedSessions,
    loadMoreArchivedSessions,
    setArchivedSessions,
  } = useSessionBrowser({
    selectedCwd: activeCwd,
    selectedSessionId,
    refreshKey,
  });

  useEffect(() => {
    const media = window.matchMedia("(min-width: 641px)");
    const sync = () => setIsDesktopLayout(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    setSelectedForArchive(new Set());
    setArchivedExpanded(false);
    setArchiveAllConfirming(false);
  }, [activeCwd]);

  const handleArchiveSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      if (res.ok) {
        setSelectedForArchive((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
        void loadSessions(false);
        setArchivedExpanded(false);
        setArchivedSessions([]);
      }
    } catch {
      // ignore
    }
  }, [loadSessions, setArchivedSessions]);

  const handleUnarchiveSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch("/api/sessions/unarchive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      if (res.ok) {
        void loadSessions(false);
        setArchivedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      }
    } catch {
      // ignore
    }
  }, [loadSessions, setArchivedSessions]);

  const handleBatchArchive = useCallback(async () => {
    const ids = [...selectedForArchive];
    if (ids.length === 0) return;
    try {
      const res = await fetch("/api/sessions/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds: ids }),
      });
      if (res.ok) {
        setSelectedForArchive(new Set());
        void loadSessions(false);
      }
    } catch {
      // ignore
    }
  }, [selectedForArchive, loadSessions]);

  const handleArchiveAll = useCallback(async () => {
    if (!activeCwd) return;
    setArchiveAllBusy(true);
    try {
      const res = await fetch("/api/sessions/archive-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd }),
      });
      if (res.ok) {
        setArchiveAllConfirming(false);
        void loadSessions(false);
      }
    } catch {
      // ignore
    } finally {
      setArchiveAllBusy(false);
    }
  }, [activeCwd, loadSessions]);

  const handleDeleteSession = useCallback(async (session: SessionInfo) => {
    const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
    const confirmed = await appDialog.confirm({ message: t("sidebar.deleteSessionConfirm", { title }), tone: "danger" });
    if (!confirmed) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (res.ok) {
        onSessionDeleted?.(session.id);
        setSelectedForArchive((prev) => {
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
        setArchivedSessions((prev) => prev.filter((s) => s.id !== session.id));
        void loadSessions(false);
      }
    } catch {
      // ignore
    }
  }, [loadSessions, onSessionDeleted, t, appDialog, setArchivedSessions]);

  useEffect(() => {
    if (!archivedExpanded || !activeCwd || (archivedCounts[activeCwd] ?? 0) === 0) return;
    void loadArchivedSessions(activeCwd, true);
  }, [archivedExpanded, activeCwd, archivedCounts, loadArchivedSessions]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!activeCwd) {
      setActiveCwdGit(undefined);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/git/info?cwd=${encodeURIComponent(activeCwd)}`, { signal: controller.signal })
      .then((res) => res.ok ? res.json() : null)
      .then((data: { git?: GitInfo } | null) => {
        if (!controller.signal.aborted) setActiveCwdGit(data?.git);
      })
      .catch(() => {
        if (!controller.signal.aborted) setActiveCwdGit(undefined);
      });

    return () => controller.abort();
  }, [activeCwd]);

  // Auto-select cwd and restore session from URL on first load.
  useEffect(() => {
    if (activeCwd !== null) return;
    if (loading) return;

    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(`/api/sessions/${encodeURIComponent(initialSessionId)}`);
          if (!res.ok) {
            onInitialRestoreDone?.();
            const cwds = getOrderedCwds(projectSummaries);
            if (cwds.length > 0) onActiveCwdChange(cwds[0]);
            return;
          }
          const data = await res.json() as { info?: SessionInfo | null };
          if (cancelled) return;
          if (data.info?.cwd) {
            // Session select path sets activeCwd in AppShell without workspace-change wipe.
            onSelectSession(data.info, true);
            return;
          }
          onInitialRestoreDone?.();
        } catch {
          if (!cancelled) onInitialRestoreDone?.();
        }
        if (!cancelled) {
          const cwds = getOrderedCwds(projectSummaries);
          if (cwds.length > 0) onActiveCwdChange(cwds[0]);
        }
      })();
      return () => { cancelled = true; };
    }

    const cwds = getOrderedCwds(projectSummaries);
    if (cwds.length > 0) onActiveCwdChange(cwds[0]);
  }, [
    loading,
    projectSummaries,
    activeCwd,
    initialSessionId,
    onSelectSession,
    onInitialRestoreDone,
    onActiveCwdChange,
  ]);

  useEffect(() => {
    const handler = () => {
      setSessionContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleNewWorktree = useCallback(async () => {
    if (!activeCwd || creatingWorktree) return;
    setCreatingWorktree(true);
    setWorktreeError(null);
    try {
      const res = await fetch("/api/git/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd }),
      });
      const data = await res.json().catch(() => ({})) as WorktreeCreateResponse;
      if (!res.ok || data.error || !data.cwd) {
        setWorktreeError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      const worktree: WorktreeInfo = data.worktree ?? {
        isWorktree: true,
        branch: data.branchName,
        mainWorktreePath: data.mainWorktreePath,
        mainWorktreeBranch: data.mainWorktreeBranch,
        repoRoot: data.cwd,
      };
      setEphemeralWorktrees((prev) => ({ ...prev, [data.cwd!]: worktree }));
      setRemovedWorktreeCwds((prev) => prev.filter((cwd) => cwd !== data.cwd));
      onActiveCwdChange(data.cwd);
      onNewSession?.(makeTempSessionId(), data.cwd);
      setExplorerKey((k) => k + 1);
    } catch (e) {
      setWorktreeError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingWorktree(false);
    }
  }, [activeCwd, creatingWorktree, onNewSession, onActiveCwdChange]);

  const openWorktreeAction = useCallback((kind: "delete" | "archive", cwd: string, worktree: WorktreeInfo) => {
    setWorktreeAction({ kind, cwd, worktree, force: false, busy: false, error: null });
  }, []);

  const applyWorktreeFallback = useCallback((removedCwd: string, fallbackCwd?: string) => {
    setEphemeralWorktrees((prev) => {
      const next = { ...prev };
      delete next[removedCwd];
      return next;
    });
    setRemovedWorktreeCwds((prev) => prev.includes(removedCwd) ? prev : [...prev, removedCwd]);
    if (activeCwd === removedCwd) {
      onActiveCwdChange(fallbackCwd ?? null);
    }
    setExplorerKey((k) => k + 1);
    void loadSessions(false);
  }, [loadSessions, activeCwd, onActiveCwdChange]);

  const confirmWorktreeAction = useCallback(async () => {
    if (!worktreeAction || worktreeAction.busy) return;
    setWorktreeAction((prev) => prev ? { ...prev, busy: true, error: null, dirtySummary: undefined } : prev);
    try {
      const endpoint = worktreeAction.kind === "archive"
        ? "/api/git/worktrees/archive"
        : `/api/git/worktrees?cwd=${encodeURIComponent(worktreeAction.cwd)}&force=${worktreeAction.force ? "true" : "false"}`;
      const res = await fetch(endpoint, {
        method: worktreeAction.kind === "archive" ? "POST" : "DELETE",
        headers: worktreeAction.kind === "archive" ? { "Content-Type": "application/json" } : undefined,
        body: worktreeAction.kind === "archive"
          ? JSON.stringify({ cwd: worktreeAction.cwd, confirmedRisk: true })
          : undefined,
      });
      const data = await res.json().catch(() => ({})) as WorktreeActionResponse & { dirtySummary?: string | string[] };
      if (!res.ok || data.error) {
        const dirtySummary = data.status?.dirtySummary ?? (Array.isArray(data.dirtySummary) ? data.dirtySummary : typeof data.dirtySummary === "string" ? data.dirtySummary.split(/\r?\n/).filter(Boolean) : undefined);
        setWorktreeAction((prev) => prev ? {
          ...prev,
          busy: false,
          error: data.error ?? `HTTP ${res.status}`,
          dirtySummary,
        } : prev);
        return;
      }
      applyWorktreeFallback(worktreeAction.cwd, data.fallbackCwd);
      for (const sessionId of data.deletedSessionIds ?? []) {
        onSessionDeleted?.(sessionId);
      }
      setWorktreeAction(null);
    } catch (e) {
      setWorktreeAction((prev) => prev ? { ...prev, busy: false, error: e instanceof Error ? e.message : String(e) } : prev);
    }
  }, [applyWorktreeFallback, onSessionDeleted, worktreeAction]);

  const visibleProjects = useMemo(
    () => projectSummaries.filter((project) => !removedWorktreeCwds.includes(project.cwd)),
    [projectSummaries, removedWorktreeCwds],
  );

  const visibleSessions = useMemo(
    () => projectSessions.filter((session) =>
      projectSessionsCwd === activeCwd
      && session.cwd === activeCwd
      && !removedWorktreeCwds.includes(session.cwd)
    ),
    [projectSessions, projectSessionsCwd, activeCwd, removedWorktreeCwds],
  );

  const worktreeByCwd = useMemo(() => {
    const map = new Map<string, WorktreeInfo>();
    for (const project of visibleProjects) {
      if (project.cwd && project.worktree && !map.has(project.cwd)) {
        map.set(project.cwd, project.worktree);
      }
    }
    for (const session of visibleSessions) {
      if (session.cwd && session.worktree && !map.has(session.cwd)) {
        map.set(session.cwd, session.worktree);
      }
    }
    for (const [cwd, worktree] of Object.entries(ephemeralWorktrees)) {
      if (!removedWorktreeCwds.includes(cwd)) map.set(cwd, worktree);
    }
    return map;
  }, [visibleProjects, visibleSessions, ephemeralWorktrees, removedWorktreeCwds]);

  const orderedCwds = useMemo(() => {
    const extraCwds: string[] = [];
    const pinCwd = (cwd: string | null | undefined) => {
      if (!cwd || removedWorktreeCwds.includes(cwd) || extraCwds.includes(cwd)) return;
      extraCwds.push(cwd);
    };
    pinCwd(activeCwd);
    for (const worktree of worktreeByCwd.values()) pinCwd(worktree.mainWorktreePath);
    for (const cwd of Object.keys(ephemeralWorktrees)) pinCwd(cwd);
    for (const acwd of archivedCwds) {
      if (!acwd || extraCwds.includes(acwd)) continue;
      if (!visibleProjects.some((p) => p.cwd === acwd)) {
        extraCwds.push(acwd);
      }
    }
    return getOrderedCwds(visibleProjects, extraCwds);
  }, [activeCwd, worktreeByCwd, ephemeralWorktrees, archivedCwds, visibleProjects, removedWorktreeCwds]);

  const selectedWorktree = activeCwd ? worktreeByCwd.get(activeCwd) : undefined;
  const selectedProject = useMemo(
    () => (activeCwd ? visibleProjects.find((p) => p.cwd === activeCwd) : undefined),
    [activeCwd, visibleProjects],
  );
  const sessionGit = activeCwd
    ? (selectedProject?.git ?? visibleSessions.find((s) => s.cwd === activeCwd)?.git)
    : undefined;
  const currentGit: GitInfo | undefined = sessionGit ?? activeCwdGit ?? (selectedWorktree ? {
    isWorktree: true,
    branch: selectedWorktree.branch,
    repoRoot: selectedWorktree.repoRoot,
    mainWorktreePath: selectedWorktree.mainWorktreePath,
    mainWorktreeBranch: selectedWorktree.mainWorktreeBranch,
  } : undefined);
  const workspaceTitle = formatWorkspaceHeaderTitle(activeCwd, currentGit);

  const archivedOnlyCwds = useMemo(
    () => new Set(archivedCwds.filter((acwd) => !visibleProjects.some((p) => p.cwd === acwd))),
    [archivedCwds, visibleProjects],
  );

  const cwdGroups = useMemo(
    () => groupCwdPickerRows(buildCwdPickerRows(orderedCwds, worktreeByCwd)),
    [orderedCwds, worktreeByCwd],
  );
  const filteredSessions = visibleSessions;
  const activeSessionCountForCwd = selectedProject?.sessionCount
    ?? (projectSessionTotal > 0 ? projectSessionTotal : filteredSessions.length);

  // Client-side search over the visible session rows (title / first message).
  const searchFilteredSessions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) return filteredSessions;
    return filteredSessions.filter((s) =>
      (s.name ?? "").toLowerCase().includes(query)
      || (s.firstMessage ?? "").toLowerCase().includes(query),
    );
  }, [filteredSessions, sessionSearch]);

  const sessionTree = useMemo(() => buildSessionTree(searchFilteredSessions), [searchFilteredSessions]);

  const equalShareExplorerOpen = Boolean(explorerOpen && activeCwd && !isDesktopLayout);
  const sessionListFlex = equalShareExplorerOpen ? "1 1 0" : "1 1 auto";

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedForArchive((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSessionContextMenu = useCallback((event: React.MouseEvent, session: SessionInfo) => {
    setSessionContextMenu({ x: event.clientX, y: event.clientY, session });
  }, []);

  useEffect(() => {
    if (filesPill) setExplorerOpen(true);
  }, [filesPill]);

  useEffect(() => {
    if (archivePill && activeCwd) {
      setArchivedExpanded(true);
      void loadArchivedSessions(activeCwd, true);
    }
  }, [archivePill, activeCwd, loadArchivedSessions]);

  const handleSessionDeletedFromList = useCallback((id: string) => {
    onSessionDeleted?.(id);
    void loadSessions();
  }, [onSessionDeleted, loadSessions]);

  // Stable identity for memoized ArchivedSessionItem (do not inline at call site).
  const handleArchivedSessionDeleted = useCallback((id: string) => {
    onSessionDeleted?.(id);
  }, [onSessionDeleted]);

  const handleClearArchiveSelection = useCallback(() => {
    setSelectedForArchive(new Set());
  }, []);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerKey((k) => k + 1);
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  }, []);

  const handleToggleArchived = useCallback(() => {
    if (!activeCwd) return;
    if (!archivedExpanded) {
      setArchivedExpanded(true);
      void loadArchivedSessions(activeCwd);
    } else {
      setArchivedExpanded(false);
    }
  }, [activeCwd, archivedExpanded, loadArchivedSessions]);

  const handlePickerNewWorktree = useCallback(() => {
    void handleNewWorktree();
  }, [handleNewWorktree]);

  const handlePickerRefresh = useCallback(() => {
    loadSessions(false);
  }, [loadSessions]);

  const handleRequestArchiveAll = useCallback(() => {
    setArchiveAllConfirming(true);
  }, []);

  const handleClearWorktreeError = useCallback(() => {
    setWorktreeError(null);
  }, []);

  return (
    <div ref={sidebarRootRef} className="session-sidebar-root" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <WorkspacePicker
        activeCwd={activeCwd}
        homeDir={homeDir}
        workspaceTitle={workspaceTitle}
        worktreeByCwd={worktreeByCwd}
        cwdGroups={cwdGroups}
        archivedOnlyCwds={archivedOnlyCwds}
        creatingWorktree={creatingWorktree}
        worktreeError={worktreeError}
        sessionRefreshDone={sessionRefreshDone}
        suppressEmptyPlaceholder={Boolean(initialSessionId && !restoredRef.current)}
        onActiveCwdChange={onActiveCwdChange}
        onNewWorktree={handlePickerNewWorktree}
        onRefresh={handlePickerRefresh}
        onRequestArchiveAll={handleRequestArchiveAll}
        onWorktreeAction={openWorktreeAction}
        onClearWorktreeError={handleClearWorktreeError}
      />

      {/* Nav pills: Sessions / Files / Archive */}
      <div className="sidebar-nav-pills">
        <button
          className={!explorerOpen ? "on" : ""}
          onClick={() => setExplorerOpen(false)}
          title={t("sidebar.sessions")}
        >
          {t("sidebar.sessions")}
        </button>
        <button
          className={explorerOpen ? "on" : ""}
          onClick={() => setExplorerOpen(true)}
          title={t("sidebar.files")}
        >
          {t("sidebar.files")}
        </button>
        <button
          className={archivedExpanded ? "on" : ""}
          onClick={() => {
            if (activeCwd) {
              setArchivedExpanded(true);
              void loadArchivedSessions(activeCwd, true);
            }
          }}
          title={t("sidebar.archive")}
        >
          {t("sidebar.archive")}
        </button>
      </div>

      {/* Search sessions */}
      <div className="sidebar-search-row">
        <div className="sidebar-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
            placeholder={t("sidebar.searchSessions")}
            spellCheck={false}
          />
          {sessionSearch && (
            <button
              onClick={() => setSessionSearch("")}
              title={t("common.clear")}
              style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", padding: 2, lineHeight: 1 }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {sessionContextMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: sessionContextMenu.x,
            top: sessionContextMenu.y,
            zIndex: 1000,
            minWidth: 150,
            padding: 4,
            borderRadius: 8,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            boxShadow: "0 10px 28px rgba(0,0,0,0.18)",
          }}
        >
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const session = sessionContextMenu.session;
              setSessionContextMenu(null);
              void handleArchiveSession(session.id);
            }}
            style={{ width: "100%", padding: "8px 10px", background: "none", border: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 12, borderRadius: 6 }}
          >
            {t("common.archive")}
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const session = sessionContextMenu.session;
              setSessionContextMenu(null);
              void handleDeleteSession(session);
            }}
            style={{ width: "100%", padding: "8px 10px", background: "none", border: "none", color: "#dc2626", textAlign: "left", cursor: "pointer", fontSize: 12, borderRadius: 6 }}
          >
            {t("common.delete")}
          </button>
        </div>
      )}

      {worktreeAction && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.28)", padding: 16 }}
        >
          <div style={{ width: "min(520px, 100%)", borderRadius: 12, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 18px 50px rgba(0,0,0,0.25)", padding: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              {worktreeAction.kind === "archive" ? t("sidebar.archiveWorktreeTitle") : t("sidebar.deleteWorktreeTitle")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 12 }}>
              <div><strong style={{ color: "var(--text)" }}>{t("sidebar.branchLabel")}</strong> {worktreeAction.worktree.branch ?? t("sidebar.unknownBranch")}</div>
              <div style={{ overflowWrap: "anywhere" }}><strong style={{ color: "var(--text)" }}>{t("sidebar.pathLabel")}</strong> {worktreeAction.cwd}</div>
              {worktreeAction.worktree.mainWorktreePath && (
                <div style={{ overflowWrap: "anywhere" }}><strong style={{ color: "var(--text)" }}>{t("sidebar.fallbackWorkspaceLabel")}</strong> {worktreeAction.worktree.mainWorktreePath}</div>
              )}
            </div>
            {worktreeAction.kind === "archive" ? (
              <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.25)", color: "var(--text)", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
                {t("sidebar.archiveWorktreeBody")}
              </div>
            ) : (
              <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", color: "var(--text)", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
                {t("sidebar.deleteWorktreeBody")}
              </div>
            )}
            {worktreeAction.dirtySummary?.length ? (
              <div style={{ maxHeight: 120, overflow: "auto", padding: 8, borderRadius: 7, background: "var(--bg-subtle)", border: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
                {worktreeAction.dirtySummary.map((line) => <div key={line}>{line}</div>)}
              </div>
            ) : null}
            {worktreeAction.error && (
              <div style={{ padding: "8px 10px", borderRadius: 7, background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.22)", color: "#dc2626", fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere", marginBottom: 10 }}>
                {worktreeAction.error}
              </div>
            )}
            {worktreeAction.kind === "delete" && worktreeAction.dirtySummary?.length ? (
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={worktreeAction.force}
                  onChange={(e) => setWorktreeAction((prev) => prev ? { ...prev, force: e.target.checked } : prev)}
                />
                {t("sidebar.forceDeleteDirty")}
              </label>
            ) : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setWorktreeAction(null)}
                disabled={worktreeAction.busy}
                style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: worktreeAction.busy ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void confirmWorktreeAction()}
                disabled={worktreeAction.busy || (worktreeAction.kind === "delete" && Boolean(worktreeAction.dirtySummary?.length) && !worktreeAction.force)}
                style={{ padding: "7px 12px", borderRadius: 7, border: "none", background: worktreeAction.kind === "archive" ? "var(--accent)" : "#ef4444", color: "#fff", cursor: worktreeAction.busy ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, opacity: worktreeAction.busy || (worktreeAction.kind === "delete" && Boolean(worktreeAction.dirtySummary?.length) && !worktreeAction.force) ? 0.65 : 1 }}
              >
                {worktreeAction.busy ? (worktreeAction.kind === "archive" ? t("common.archiving") : t("common.deleting")) : (worktreeAction.kind === "archive" ? t("common.archive") : t("common.delete"))}
              </button>
            </div>
          </div>
        </div>
      )}

      {archiveAllConfirming && activeCwd && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.28)", padding: 16 }}
        >
          <div style={{ width: "min(420px, 100%)", borderRadius: 12, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 18px 50px rgba(0,0,0,0.25)", padding: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              {t("sidebar.archiveAllTitle")}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 16 }}>
              {t("sidebar.archiveAllBodyBefore")} <strong>{(archivedCounts[activeCwd] ?? 0) + activeSessionCountForCwd}</strong> {t("sidebar.archiveAllBodyAfter")}
              {t("sidebar.archiveAllHint")}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                onClick={() => setArchiveAllConfirming(false)}
                disabled={archiveAllBusy}
                style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: archiveAllBusy ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => void handleArchiveAll()}
                disabled={archiveAllBusy}
                style={{ padding: "7px 12px", borderRadius: 7, border: "none", background: "var(--accent)", color: "#fff", cursor: archiveAllBusy ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700, opacity: archiveAllBusy ? 0.65 : 1 }}
              >
                {archiveAllBusy ? t("common.archiving") : t("sidebar.confirmArchive")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: sessionListFlex, overflowY: "auto", padding: "0", minHeight: MIN_SESSION_LIST_HEIGHT }}>
        <SessionList
          loading={loading}
          error={error}
          sessionTree={sessionTree}
          filteredSessions={searchFilteredSessions}
          selectedSessionId={selectedSessionId}
          projectSessionTotal={projectSessionTotal}
          hasMoreSessions={hasMoreSessions}
          loadingMore={loadingMore}
          selectedForArchive={selectedForArchive}
          onSelectSession={onSelectSession}
          onRenamed={loadSessions}
          onSessionDeleted={handleSessionDeletedFromList}
          onArchive={handleArchiveSession}
          onContextMenu={handleSessionContextMenu}
          onToggleSelect={handleToggleSelect}
          onLoadMore={loadMoreSessions}
          onClearSelection={handleClearArchiveSelection}
          onBatchArchive={handleBatchArchive}
        />

        {activeCwd && !loading && !error && (
          <ArchivedSessionSection
            archivedCount={archivedCounts[activeCwd] ?? 0}
            archivedExpanded={archivedExpanded}
            archivedSessions={archivedSessions}
            archivedHasMore={archivedHasMore}
            loadingMoreArchived={loadingMoreArchived}
            onToggleExpanded={handleToggleArchived}
            onSelect={onSelectSession}
            onUnarchive={handleUnarchiveSession}
            onDelete={handleArchivedSessionDeleted}
            onLoadMore={loadMoreArchivedSessions}
          />
        )}
      </div>

      {activeCwd && (
        <SidebarExplorerPane
          cwd={activeCwd}
          open={explorerOpen}
          onOpenChange={setExplorerOpen}
          refreshKey={explorerKey}
          onRefresh={handleExplorerRefresh}
          refreshDone={explorerRefreshDone}
          isDesktopLayout={isDesktopLayout}
          sidebarRootRef={sidebarRootRef}
          onOpenFile={onOpenFile}
          onAtMention={onAtMention}
        />
      )}
    </div>
  );
}
