"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { UsageStatsModal } from "./UsageStatsModal";
import { ChatGptUsagePanel } from "./ChatGptUsagePanel";
import { GrokUsagePanel } from "./GrokUsagePanel";
import { StoredSubagentPanel, SubagentBadgeIndicator } from "./SubagentObservation";
import { SettingsConfig } from "./SettingsConfig";
import { WorkflowPanel } from "./WorkflowPanel";
import { AutomationPanel } from "./AutomationPanel";
import { WorkflowSessionWidget } from "./WorkflowSessionWidget";
import type { WorkflowTaskDetail } from "@/lib/workflow-types";
import type { WorkflowPhaseLabel } from "@/lib/workflow-guidance";
import type { WorkflowSessionTaskLinkResult } from "@/lib/workflow-session-link";
import { workflowTaskToChatContext, type WorkflowTaskChatContext } from "@/lib/workflow-chat-context";
import { BranchNavigator } from "./BranchNavigator";
import { GitPanel } from "./GitPanel";
import { InspectorChangesPanel } from "./InspectorChangesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { getRelativeFilePath } from "@/lib/file-paths";
import { formatWorkspaceHeaderTitle, formatWorkspaceTitle } from "@/lib/workspace-title";
import { ThemePicker } from "./ThemePicker";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import type { GitInfo, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { PiWebConfig } from "@/lib/pi-web-config";
import type { ChatInputHandle } from "./ChatInput";
import { recordSubagentClientMetric } from "@/lib/subagent-observability-client";
import { SubagentStore } from "@/lib/subagent-store";
import { makeTempSessionId } from "./sidebar/sidebar-utils";

const TOP_PANEL_SAFE_SELECTOR = ".app-top-aux-panel, .app-top-aux-tab, .branch-navigator-inline";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-web-right-panel-width-v2";
const DEFAULT_RIGHT_PANEL_WIDTH = 380;
const MAX_RIGHT_PANEL_RATIO = 0.7;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MIN_CHAT_WIDTH = 360;
const DESKTOP_SIDEBAR_WIDTH = 300;
/** Inline dock needs sidebar + chat min + right min; below this use overlay drawer. */
const RIGHT_PANEL_INLINE_MIN_VIEWPORT =
  DESKTOP_SIDEBAR_WIDTH + MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH; // 960
const RIGHT_PANEL_RESIZE_STEP = 10;
const RIGHT_PANEL_RESIZE_STEP_LARGE = 40;

function isTopPanelSafeTarget(target: EventTarget | null): boolean {
  if (target instanceof Element) return Boolean(target.closest(TOP_PANEL_SAFE_SELECTOR));
  if (target instanceof Node) return Boolean(target.parentElement?.closest(TOP_PANEL_SAFE_SELECTOR));
  return false;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isDesktopLayoutViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 641px)").matches;
}

function isRightPanelInlineViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia(`(min-width: ${RIGHT_PANEL_INLINE_MIN_VIEWPORT}px)`).matches
  );
}

function getDefaultRightPanelWidth(): number {
  return DEFAULT_RIGHT_PANEL_WIDTH;
}

function readStoredRightPanelWidth(): number {
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    if (raw == null) return getDefaultRightPanelWidth();
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : getDefaultRightPanelWidth();
  } catch {
    return getDefaultRightPanelWidth();
  }
}

function writeStoredRightPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function getRightPanelWidthBounds(sidebarOpen: boolean): { min: number; max: number } {
  if (typeof window === "undefined") {
    return { min: MIN_RIGHT_PANEL_WIDTH, max: MIN_RIGHT_PANEL_WIDTH };
  }
  const maxByRatio = Math.floor(window.innerWidth * MAX_RIGHT_PANEL_RATIO);
  // Overlay / non-inline: drawer floats over chat, so only ratio/viewport bounds apply.
  if (!isRightPanelInlineViewport()) {
    const max = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(window.innerWidth, maxByRatio || window.innerWidth));
    const min = Math.min(MIN_RIGHT_PANEL_WIDTH, max);
    return { min, max };
  }
  const sidebarWidth = sidebarOpen && isDesktopLayoutViewport() ? DESKTOP_SIDEBAR_WIDTH : 0;
  const maxByChat = window.innerWidth - sidebarWidth - MIN_CHAT_WIDTH;
  const max = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(maxByChat, maxByRatio));
  return { min: MIN_RIGHT_PANEL_WIDTH, max };
}

function clampRightPanelWidth(width: number, sidebarOpen: boolean): number {
  const { min, max } = getRightPanelWidthBounds(sidebarOpen);
  return clampNumber(Math.round(width), min, max);
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { locale, setLocale, t } = useI18n();
  const appDialog = useAppDialog();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [skillsConfigOpen, setSkillsConfigOpen] = useState(false);
  const [usageStatsOpen, setUsageStatsOpen] = useState(false);
  const [settingsConfigOpen, setSettingsConfigOpen] = useState(false);
  const [webConfig, setWebConfig] = useState<PiWebConfig | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalDockCwd, setTerminalDockCwd] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  /** Latest selected session — deletion callbacks must not capture a stale snapshot. */
  const selectedSessionRef = useRef<SessionInfo | null>(null);
  /** Latest workspace cwd — deletion must not overwrite a newer project/WorkTree fallback. */
  const activeCwdRef = useRef<string | null>(null);

  const loadWebConfig = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/web-config", { signal });
      const data = await res.json() as { config?: PiWebConfig; error?: string };
      if (res.ok && data.config && !data.error) setWebConfig(data.config);
      else setWebConfig(null);
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") setWebConfig(null);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadWebConfig(controller.signal);
    return () => controller.abort();
  }, [loadWebConfig]);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<{ tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null>(null);
  const handleSessionStatsChange = useCallback((stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => {
    setSessionStats(stats);
  }, []);

  // Agent running state — driven by ChatWindow, used by observe-bar / Changes polling
  const [agentRunning, setAgentRunning] = useState(false);
  const handleAgentRunningChange = useCallback((running: boolean) => {
    setAgentRunning(running);
  }, []);

  // Extension Todo List widget active in the current chat
  const [todoActive, setTodoActive] = useState(false);
  const handleTodoActiveChange = useCallback((active: boolean) => {
    setTodoActive(active);
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Subagent progress stays outside AppShell state. The badge subscribes only to
  // counts; full rows are subscribed only while the top-bar panel is open.
  const subagentStoreRef = useRef<SubagentStore | null>(null);
  if (!subagentStoreRef.current) subagentStoreRef.current = new SubagentStore();
  const subagentStore = subagentStoreRef.current;
  const handleSubagentChange = useCallback((runs: import("@/hooks/useAgentSession").SubagentRun[]) => {
    recordSubagentClientMetric("appShellSubagentUpdates");
    subagentStore.setRuns(runs);
  }, [subagentStore]);
  useEffect(() => {
    subagentStore.reset();
  }, [sessionKey, subagentStore]);

  // Git panel state
  const [gitDirty, setGitDirty] = useState(false);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "subagents" | "git" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "subagents" | "git") => {
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, []);

  useEffect(() => {
    if (!activeTopPanel) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!isTopPanelSafeTarget(event.target)) setActiveTopPanel(null);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopPanelSafeTarget(event.target)) setActiveTopPanel(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveTopPanel(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTopPanel]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const rect = topBarRef.current!.getBoundingClientRect();
      setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel]);

  // Right panel — file tabs and optional SnFlow task drawer
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  /** Inspector tabs: files(Preview) / workflow(SnFlow) / changes / git / agents. */
  const [rightPanelMode, setRightPanelMode] = useState<"files" | "workflow" | "changes" | "git" | "agents">("changes");
  const [automationOpen, setAutomationOpen] = useState(false);
  const [automationUnread, setAutomationUnread] = useState(0);
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [rightPanelInline, setRightPanelInline] = useState(false);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelResizable = isDesktopLayout && rightPanelInline;
  const [pendingWorkflowTaskContext, setPendingWorkflowTaskContext] = useState<WorkflowTaskChatContext | null>(null);
  const [focusedWorkflowTaskId, setFocusedWorkflowTaskId] = useState<string | null>(null);
  const [workflowCurrentTask, setWorkflowCurrentTask] = useState<{
    task: Pick<WorkflowTaskDetail, "id" | "title" | "status" | "activeRunId">;
    phase: WorkflowPhaseLabel;
  } | null>(null);

  const handleAtMention = useCallback((relativePath: string) => {
    chatInputRef.current?.addFileReference(relativePath);
  }, []);

  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
  }, [rightPanelWidth]);

  useEffect(() => {
    setRightPanelWidth(clampRightPanelWidth(readStoredRightPanelWidth(), sidebarOpen));
    // Hydrate once from localStorage; later reclamps keep the in-memory value.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore
  }, []);

  useEffect(() => {
    const desktopMedia = window.matchMedia("(min-width: 641px)");
    const inlineMedia = window.matchMedia(`(min-width: ${RIGHT_PANEL_INLINE_MIN_VIEWPORT}px)`);
    const sync = () => {
      setIsDesktopLayout(desktopMedia.matches);
      setRightPanelInline(inlineMedia.matches);
    };
    sync();
    desktopMedia.addEventListener("change", sync);
    inlineMedia.addEventListener("change", sync);
    return () => {
      desktopMedia.removeEventListener("change", sync);
      inlineMedia.removeEventListener("change", sync);
    };
  }, []);

  const commitRightPanelWidth = useCallback((width: number, persist: boolean) => {
    const next = clampRightPanelWidth(width, sidebarOpen);
    rightPanelWidthRef.current = next;
    setRightPanelWidth(next);
    if (persist) writeStoredRightPanelWidth(next);
    return next;
  }, [sidebarOpen]);

  useEffect(() => {
    if (!isDesktopLayout) return;
    const reclamp = () => {
      setRightPanelWidth((current) => clampRightPanelWidth(current, sidebarOpen));
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [isDesktopLayout, rightPanelInline, sidebarOpen]);

  const handleRightPanelResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!rightPanelResizable || !rightPanelOpen) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = rightPanelRef.current;
    if (!panel) return;

    const rightEdge = panel.getBoundingClientRect().right;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    setRightPanelResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      commitRightPanelWidth(rightEdge - moveEvent.clientX, false);
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setRightPanelResizing(false);
      writeStoredRightPanelWidth(rightPanelWidthRef.current);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [commitRightPanelWidth, rightPanelOpen, rightPanelResizable]);

  const handleRightPanelResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rightPanelResizable || !rightPanelOpen) return;
    const step = event.shiftKey ? RIGHT_PANEL_RESIZE_STEP_LARGE : RIGHT_PANEL_RESIZE_STEP;
    let delta = 0;
    if (event.key === "ArrowLeft") delta = step;
    else if (event.key === "ArrowRight") delta = -step;
    else return;
    event.preventDefault();
    commitRightPanelWidth(rightPanelWidthRef.current + delta, true);
  }, [commitRightPanelWidth, rightPanelOpen, rightPanelResizable]);

  const [initialSessionId] = useState<string | null>(() => searchParams.get("session"));
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [activeCwdGit, setActiveCwdGit] = useState<GitInfo | undefined>(undefined);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !searchParams.get("session"));

  const handleAddChat = useCallback((filePath: string, selection?: { startLine: number; endLine: number }) => {
    const relativePath = getRelativeFilePath(filePath, activeCwd ?? undefined);
    chatInputRef.current?.addFileReference(relativePath, selection);
  }, [activeCwd]);

  /** Workspace picker / explicit project change — may clear cross-cwd session state. */
  const handleActiveCwdChange = useCallback((cwd: string | null) => {
    if (cwd === activeCwdRef.current) return;
    setFileTabs([]);
    setActiveFileTabId(null);
    // Keep the Inspector shell visible across workspace changes; each tab already
    // derives its content from the current workspace/session and clears stale data.
    // Eager ref updates so nested WorkTree bulk-delete onSessionDeleted callbacks
    // observe the fallback cwd / cleared selection before React re-renders.
    activeCwdRef.current = cwd;
    setActiveCwd(cwd);
    // Keep an already-open terminal pinned to the cwd captured when it was opened;
    // terminal processes are ephemeral and should not be silently killed or retargeted
    // just because the selected chat/workspace changed.
    if (!cwd) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setNewSessionCwd(null);
      return;
    }
    // Close any session that belongs to a different cwd — it no longer
    // matches the selected project directory.
    setSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) {
        selectedSessionRef.current = null;
        return null;
      }
      return prev;
    });
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    setGitRefreshKey((k) => k + 1);
    setGitDirty(false);
    router.replace("/", { scroll: false });
  }, [router]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    selectedSessionRef.current = session;
    setSelectedSession(session);
    // Sync workspace cwd with the selected session without the workspace-picker wipe path.
    if (session.cwd && session.cwd !== activeCwdRef.current) {
      setFileTabs([]);
      setActiveFileTabId(null);
    }
    if (session.cwd) {
      activeCwdRef.current = session.cwd;
      setActiveCwd(session.cwd);
    }
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    selectedSessionRef.current = null;
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    if (cwd !== activeCwdRef.current) {
      setFileTabs([]);
      setActiveFileTabId(null);
    }
    activeCwdRef.current = cwd;
    setActiveCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });
  }, [router]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    selectedSessionRef.current = session;
    setSelectedSession(session);
    if (session.cwd) {
      activeCwdRef.current = session.cwd;
      setActiveCwd(session.cwd);
    }
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    setGitRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => {
      const next = {
        ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
        id: newSessionId,
      };
      selectedSessionRef.current = next;
      return next;
    });
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  // Keep refs aligned for async deletion / WorkTree bulk-delete ordering.
  selectedSessionRef.current = selectedSession;
  activeCwdRef.current = activeCwd;

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    // Read latest refs — never the selectedSession captured when this callback was created.
    // WorkTree removal applies fallback cwd first (eagerly updating refs), then reports
    // deleted ids; a stale snapshot would restore the removed WorkTree. Same race when
    // the user switches projects before an ordinary DELETE completes.
    const current = selectedSessionRef.current;
    if (!current || current.id !== sessionId) return;

    const deletedCwd = current.cwd ?? null;
    const latestActiveCwd = activeCwdRef.current;

    selectedSessionRef.current = null;
    setSelectedSession(null);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    router.replace("/", { scroll: false });

    // Preserve new-session continuity only while workspace still matches the deleted
    // session. Never clobber a newer activeCwd (project switch or WorkTree fallback).
    if (deletedCwd && (latestActiveCwd === deletedCwd || latestActiveCwd == null)) {
      setNewSessionCwd(deletedCwd);
      if (latestActiveCwd == null) {
        activeCwdRef.current = deletedCwd;
        setActiveCwd(deletedCwd);
      }
    }
  }, [router]);

  const openInspectorTab = useCallback((mode: "files" | "workflow" | "changes" | "git" | "agents") => {
    setRightPanelMode(mode);
    setRightPanelOpen(true);
  }, []);

  const handleOpenFile = useCallback((filePath: string, fileName: string, line?: number) => {
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (existing) return prev.map((tab) => tab.id === tabId ? { ...tab, line } : tab);
      return [...prev, { id: tabId, label: fileName, filePath, line }];
    });
    setActiveFileTabId(tabId);
    setRightPanelMode("files");
    setRightPanelOpen(true);
  }, []);

  const handleCloseFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs]);

  const handleExportSession = useCallback(() => {
    if (!selectedSession) return;
    window.location.href = `/api/sessions/${encodeURIComponent(selectedSession.id)}/export`;
  }, [selectedSession]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;

  const activeFileTab = fileTabs.find((t) => t.id === activeFileTabId) ?? null;
  const terminalEnabled = webConfig?.terminal.enabled ?? false;
  const workflowIncludeArchivedDefault = webConfig?.workflow.includeArchived ?? false;
  const workspaceCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  const workflowCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const terminalCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  const browserTitleCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const browserTitleGit = selectedSession?.cwd === browserTitleCwd ? selectedSession.git : activeCwdGit;

  useEffect(() => {
    setFocusedWorkflowTaskId(null);
  }, [workflowCwd]);

  // Clear the session widget when changing sessions — the pointer is
  // session-scoped and an old task should not surface in a new session.
  useEffect(() => {
    setWorkflowCurrentTask(null);
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!pendingWorkflowTaskContext || !showChat) return;
    let cancelled = false;
    let attempts = 0;
    const tryInsert = () => {
      if (cancelled) return;
      if (chatInputRef.current) {
        chatInputRef.current.addWorkflowTaskContext(pendingWorkflowTaskContext);
        setPendingWorkflowTaskContext(null);
        return;
      }
      attempts += 1;
      if (attempts < 12) window.requestAnimationFrame(tryInsert);
    };
    window.requestAnimationFrame(tryInsert);
    return () => { cancelled = true; };
  }, [pendingWorkflowTaskContext, sessionKey, showChat]);

  const handleWorkflowTaskCreated = useCallback((task: WorkflowTaskDetail) => {
    setFocusedWorkflowTaskId(task.id);
    setRightPanelMode("workflow");
    setRightPanelOpen(true);
    setPendingWorkflowTaskContext(workflowTaskToChatContext(task));
    if (!selectedSession || selectedSession.archived) {
      setWorkflowCurrentTask(null);
      return;
    }
    setWorkflowCurrentTask({
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        activeRunId: task.activeRunId,
      },
      phase: task.status === "planning" ? "plan" : task.status === "ready_to_commit" || task.status === "completed" || task.status === "cancelled" ? "finish" : "execute",
    });
  }, [selectedSession]);

  const loadWorkflowSessionTask = useCallback(async (signal?: AbortSignal) => {
    // Only session-scoped: the widget must show a task tied to the
    // selected non-archived session, never a cwd-global pointer.
    const session = selectedSession && !selectedSession.archived ? selectedSession : null;
    if (!session) {
      setWorkflowCurrentTask(null);
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/snflow-task`, { signal });
      const data = await res.json() as WorkflowSessionTaskLinkResult & { error?: string };
      if (!res.ok || data.error) {
        setWorkflowCurrentTask(null);
        return;
      }
      if (!data.task) {
        setWorkflowCurrentTask(null);
        return;
      }
      setWorkflowCurrentTask({
        task: {
          id: data.task.id,
          title: data.task.title,
          status: data.task.status,
          activeRunId: data.task.activeRunId,
        },
        phase: data.phase ?? "idle",
      });
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      setWorkflowCurrentTask(null);
    }
  }, [selectedSession]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflowSessionTask(controller.signal);
    const timer = window.setInterval(() => {
      void loadWorkflowSessionTask(controller.signal);
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  // loadWorkflowSessionTask already captures the selected session; keep the
  // interval stable so opening the SF panel never tears down chat/session state.
  }, [loadWorkflowSessionTask]);

  const handleStartWorkflowFromChat = useCallback(async () => {
    const cwd = workflowCwd;
    if (!cwd) return;
    if (!selectedSession?.id) return;
    try {
      const res = await fetch(`/api/workflows/tasks?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: selectedSession.id, priority: "P1" }),
      });
      const data = await res.json() as { task?: WorkflowTaskDetail; error?: string };
      if (!res.ok || !data.task) throw new Error(data.error ?? `HTTP ${res.status}`);
      handleWorkflowTaskCreated(data.task);
    } catch (error) {
      console.error("Failed to create SnFlow task from chat", error);
      await appDialog.alert({ title: t("common.alertTitle"), message: error instanceof Error ? error.message : String(error) });
    }
  }, [workflowCwd, selectedSession?.id, handleWorkflowTaskCreated, appDialog, t]);

  const rightEdgePad = 12; /* context strip right padding for inspector-less layout */

  useEffect(() => {
    if (!terminalEnabled || (!terminalCwd && !terminalDockCwd)) {
      setTerminalOpen(false);
      setTerminalCollapsed(false);
      setTerminalDockCwd(null);
    }
  }, [terminalEnabled, terminalCwd, terminalDockCwd]);

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

  useEffect(() => {
    const title = formatWorkspaceTitle(browserTitleCwd, browserTitleGit);
    const applyTitle = () => {
      if (document.title !== title) document.title = title;
    };

    applyTitle();
    const animationFrame = requestAnimationFrame(applyTitle);
    const timeout = window.setTimeout(applyTitle, 0);
    const observer = new MutationObserver(applyTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });

    return () => {
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [browserTitleCwd, browserTitleGit]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        activeCwd={activeCwd}
        onActiveCwdChange={handleActiveCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
      />
      <div className="sidebar-foot">
        <div className="hub-row">
        {([
          {
            id: "models",
            label: t("sidebar.models"),
            onClick: () => setModelsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
              </svg>
            ),
          },
          {
            id: "skills",
            label: t("sidebar.skills"),
            onClick: () => setSkillsConfigOpen(true),
            disabled: !activeCwd && !selectedSession?.cwd && !newSessionCwd,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            ),
          },
          {
            id: "settings",
            label: t("sidebar.settings"),
            onClick: () => setSettingsConfigOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 .6 1.65 1.65 0 0 0-.33 1.06V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-.6-1 1.65 1.65 0 0 0-1.06-.33H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-.6 1.65 1.65 0 0 0 .33-1.06V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.4.14.74.38 1 .6.31.23.68.35 1.06.33H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
              </svg>
            ),
          },
        ] as { id: string; label: string; onClick: () => void; disabled: boolean; icon: React.ReactNode }[]).map(({ id, label, onClick, disabled, icon }) => (
          <button
            key={id}
            className="hub-btn"
            onClick={onClick}
            disabled={disabled}
            title={label}
          >
            {icon}
            {label}
          </button>
        ))}
        </div>
      </div>
    </>
  );

  return (
    <>
    <div
      className="app-shell-root"
      style={{
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--bg)",
        ["--right-panel-width" as string]: `${rightPanelWidth}px`,
      }}
    >
      {/* Mobile overlay backdrop */}
      <div
        className="sidebar-overlay-backdrop"
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`}
        style={{
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        }}
      >
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div className="center-column">
        <div className="center-panel">
        {/* Context strip — merged top bar */}
        <div ref={topBarRef} className="top-context">
          <button
            className="icon-round"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")}
            style={{ width: 30, height: 30 }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>

          {/* Breadcrumb: workspace / session */}
          <div className="breadcrumb" title={workspaceCwd ?? undefined}>
            <span className="workspace-breadcrumb-label">Workspace</span>
            <span>/</span>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
              {formatWorkspaceHeaderTitle(workspaceCwd, activeCwdGit)}
            </strong>
            {showChat && (
              <>
                <span>/</span>
                <strong style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500, color: "var(--text-2)" }}>
                  {selectedSession?.name || selectedSession?.firstMessage?.slice(0, 40) || (selectedSession ? selectedSession.id.slice(0, 8) : t("sidebar.newSession"))}
                </strong>
              </>
            )}
          </div>

          {showChat && (
            <div className="app-top-actions" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                className="icon-round context-action"
                onClick={handleExportSession}
                disabled={!selectedSession}
                title={selectedSession ? t("app.exportHtml") : t("app.exportHtmlDisabled")}
                aria-label={t("app.exportHtml")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "var(--bg-card)",
                  border: "1px solid var(--line)",
                  color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: selectedSession ? "pointer" : "not-allowed",
                  opacity: selectedSession ? 1 : 0.45,
                  flexShrink: 0,
                  fontSize: 11,
                  whiteSpace: "nowrap",
                  transition: "color 0.1s, background 0.1s, opacity 0.1s",
                }}
                onMouseEnter={(e) => {
                  if (!selectedSession) return;
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.background = "none";
                }}
              >
                <span style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: "transparent",
                  color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                  flexShrink: 0,
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </span>
              </button>
              <BranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                inline
                containerRef={topBarRef}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession
              />
              <button
                ref={systemBtnRef}
                className={`app-top-aux-tab icon-round context-action${activeTopPanel === "system" ? " on" : ""}`}
                onClick={() => toggleTopPanel("system")}
                style={{
                  display: "grid", alignItems: "center",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
              </button>
            </div>
          )}
          {terminalEnabled && terminalCwd && (
            <button
              className={`icon-round context-action${terminalOpen ? " on" : ""}`}
              onClick={async () => {
                if (!terminalOpen) {
                  setTerminalDockCwd(terminalCwd);
                  setTerminalOpen(true);
                  setTerminalCollapsed(false);
                  return;
                }
                if (terminalDockCwd && terminalDockCwd !== terminalCwd) {
                  const confirmed = await appDialog.confirm({ message: t("app.switchWorkspaceTerminalConfirm"), tone: "danger" });
                  if (!confirmed) return;
                  setTerminalOpen(false);
                  setTerminalCollapsed(false);
                  window.setTimeout(() => {
                    setTerminalDockCwd(terminalCwd);
                    setTerminalOpen(true);
                  }, 0);
                  return;
                }
                setTerminalCollapsed((collapsed) => !collapsed);
              }}
              title={terminalOpen && terminalDockCwd && terminalDockCwd !== terminalCwd ? t("app.openTerminalForWorkspace") : t("app.openTerminal")}
              style={{
                display: "grid", alignItems: "center",
                cursor: "pointer",
                color: terminalOpen ? "var(--text)" : "var(--text-muted)",
                fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = terminalOpen ? "var(--text)" : "var(--text-muted)"; }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          )}
          {/* Session stats — right-aligned in top bar */}
          {showChat && (sessionStats || contextUsage) && (() => {
            const t = sessionStats?.tokens;
            const c = sessionStats?.cost ?? 0;
            const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
            const costStr = c > 0 ? (c >= 0.01 ? `$${c.toFixed(2)}` : `<$0.01`) : null;

            let ctxColor = "var(--text-muted)";
            let ctxStr: string | null = null;
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              if (pct !== null && pct > 90) ctxColor = "#ef4444";
              else if (pct !== null && pct > 70) ctxColor = "rgba(234,179,8,0.95)";
              ctxStr = pct !== null ? `${pct.toFixed(0)}% / ${fmt(contextUsage.contextWindow)}` : `? / ${fmt(contextUsage.contextWindow)}`;
            }

            const tooltipParts: string[] = [];
            if (t) {
              tooltipParts.push(`in: ${t.input.toLocaleString()}`);
              tooltipParts.push(`out: ${t.output.toLocaleString()}`);
              tooltipParts.push(`cache read: ${t.cacheRead.toLocaleString()}`);
              tooltipParts.push(`cache write: ${t.cacheWrite.toLocaleString()}`);
              if (c > 0) tooltipParts.push(`cost: $${c.toFixed(4)}`);
            }
            if (contextUsage?.contextWindow) {
              const pct = contextUsage.percent;
              tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString()} tokens`);
            }
            const tooltip = tooltipParts.join("  |  ");

            return (
              <div
                className="app-top-stats chip"
                title={tooltip}
                onClick={() => setUsageStatsOpen(true)}
                style={{
                  marginLeft: "auto",
                  height: 28,
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "pointer",
                  fontVariantNumeric: "tabular-nums",
                  gap: 8,
                }}
              >
                {t && t.input > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
                    </svg>
                    {fmt(t.input)}
                  </span>
                )}
                {t && t.output > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {fmt(t.output)}
                  </span>
                )}
                {t && t.cacheRead > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
                    </svg>
                    {fmt(t.cacheRead)}
                  </span>
                )}
                {costStr && (
                  <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500 }}>
                    {costStr}
                  </span>
                )}
                {ctxStr && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: ctxColor }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
                    </svg>
                    {ctxStr}
                  </span>
                )}
              </div>
            );
          })()}
          <ThemePicker />
          <button
            className="icon-round"
            type="button"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            title={t("app.languageSwitch")}
            aria-label={t("app.languageSwitch")}
            style={{ width: 30, height: 30, fontSize: 11, fontWeight: 700 }}
          >
            {locale === "zh" ? "EN" : "中"}
          </button>
          {/* Automation — global badge entry */}
          <button
            className="icon-round"
            onClick={() => setAutomationOpen((open) => !open)}
            title={automationOpen ? t("automation.close") : t("automation.open")}
            aria-label={automationOpen ? t("automation.close") : t("automation.open")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {automationUnread > 0 && (
              <span className="badge">{automationUnread > 9 ? "9+" : automationUnread}</span>
            )}
          </button>
          {(webConfig?.chatgpt.usagePanelEnabled || webConfig?.grok.usagePanelEnabled) && (
            <div className="app-top-usage-panel" style={{ marginLeft: showChat && (sessionStats || contextUsage) ? 0 : "auto", paddingRight: rightEdgePad, height: "100%", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {webConfig?.chatgpt.usagePanelEnabled && <ChatGptUsagePanel />}
              {webConfig?.grok.usagePanelEnabled && <GrokUsagePanel />}
            </div>
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && activeTopPanel !== "branches" && topPanelPos && typeof document !== "undefined" && createPortal((
            <div className="app-top-aux-panel" style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              zIndex: 500,
            }}>
              {activeTopPanel === "system" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  {systemPrompt ? (
                    <div style={{
                      maxHeight: "min(600px, 75vh)",
                      overflowY: "auto",
                      padding: "12px 16px",
                      color: "var(--text-muted)",
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--font-mono)",
                    }}>
                      {systemPrompt}
                    </div>
                  ) : systemPrompt === "" ? (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      System prompt is empty (tools are disabled)
                    </div>
                  ) : (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                      Send a message to load the system prompt
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "subagents" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <StoredSubagentPanel store={subagentStore} />
                </div>
              )}
              {activeTopPanel === "git" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <GitPanel cwd={workspaceCwd} refreshKey={gitRefreshKey} onDirtyChange={setGitDirty} />
                </div>
              )}
            </div>
          ), document.body)}

        </div>

        {/* Observe bar — Changes / Git / Subagents / Todo */}
        <div className="observe-bar">
          <button
            className={`chip${rightPanelOpen && rightPanelMode === "changes" ? " on" : ""}`}
            onClick={() => {
              if (rightPanelOpen && rightPanelMode === "changes") setRightPanelOpen(false);
              else openInspectorTab("changes");
            }}
            title="本次会话编辑/写入的文件变更"
          >
            <span className="dot" />Changes
          </button>
          <button
            className={`chip${rightPanelOpen && rightPanelMode === "git" ? " on" : ""}`}
            onClick={() => {
              if (rightPanelOpen && rightPanelMode === "git") setRightPanelOpen(false);
              else openInspectorTab("git");
            }}
            title="Git 状态与历史"
          >
            {gitDirty && <span className="dot warn" />}
            {!gitDirty && <span className="dot" style={{ background: "var(--text-3)" }} />}
            Git
          </button>
          <button
            className={`chip${rightPanelOpen && rightPanelMode === "agents" ? " on" : ""}`}
            onClick={() => {
              if (rightPanelOpen && rightPanelMode === "agents") setRightPanelOpen(false);
              else openInspectorTab("agents");
            }}
            title="子代理运行情况"
          >
            <SubagentBadgeIndicator store={subagentStore} />
            Subagents
          </button>
          <span
            className={`chip${todoActive ? " on" : ""}`}
            title={todoActive ? "Todo List 插件窗口在对话中可用" : "当前无 Todo List 插件窗口"}
            style={{ cursor: "default" }}
          >
            {todoActive && <span className="dot" />}
            {!todoActive && <span className="dot" style={{ background: "var(--text-3)" }} />}
            Todo
          </span>
        </div>

        {/* Chat content + optional bottom terminal dock */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div style={{ flex: 1, overflow: "hidden", position: "relative", minHeight: 0 }}>
          {showChat ? (
            <ChatWindow
              key={sessionKey}
              session={selectedSession}
              newSessionCwd={effectiveNewSessionCwd}
              onAgentEnd={handleAgentEnd}
              onSessionCreated={handleSessionCreated}
              onSessionForked={handleSessionForked}
              modelsRefreshKey={modelsRefreshKey}
              chatInputRef={chatInputRef}
              onBranchDataChange={handleBranchDataChange}
              onSystemPromptChange={handleSystemPromptChange}
              onSessionStatsChange={handleSessionStatsChange}
              onContextUsageChange={handleContextUsageChange}
              onSubagentChange={handleSubagentChange}
              onAgentRunningChange={handleAgentRunningChange}
              onTodoActiveChange={handleTodoActiveChange}
            />
          ) : showPlaceholder ? (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 10, padding: 40, color: "var(--text-2)" }}>
              <div className="hero-mark">π</div>
              <h3 style={{ color: "var(--text)", fontSize: 18, letterSpacing: "-0.02em" }}>{t("app.getStarted")}</h3>
              {activeCwd ? (
                <p style={{ maxWidth: 380, lineHeight: 1.6, color: "var(--text-3)", fontSize: 12.5 }}>{t("app.selectSession")}</p>
              ) : (
                <p style={{ maxWidth: 380, lineHeight: 1.6, color: "var(--text-3)", fontSize: 12.5 }}>
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("app.getStartedStep1")}<br />
                  <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("app.getStartedStep2Before")} <strong style={{ color: "var(--text)" }}>{t("app.getStartedStep2Strong")}</strong> {t("app.getStartedStep2After")}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  style={{
                    height: 32, padding: "0 16px", borderRadius: 999, border: "none",
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                    color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer",
                    opacity: activeCwd ? 1 : 0.5,
                  }}
                  onClick={() => {
                    // In this placeholder branch there is no selected session; only cwd candidates remain.
                    const cwd = activeCwd ?? newSessionCwd;
                    if (!cwd) return;
                    handleNewSession(makeTempSessionId(), cwd);
                  }}
                >
                  ＋ {t("sidebar.newSession")}
                </button>
              </div>
            </div>
          ) : null}
          {showChat && workflowCurrentTask?.task && !(rightPanelOpen && rightPanelMode === "workflow" && focusedWorkflowTaskId === workflowCurrentTask.task.id) && (
            <WorkflowSessionWidget
              task={workflowCurrentTask.task}
              phase={workflowCurrentTask.phase}
              onClick={() => {
                setFocusedWorkflowTaskId(workflowCurrentTask.task.id);
                setRightPanelMode("workflow");
                setRightPanelOpen(true);
              }}
            />
          )}
          </div>
          {terminalOpen && terminalEnabled && terminalDockCwd && (
            <TerminalPanel
              cwd={terminalDockCwd}
              collapsed={terminalCollapsed}
              onToggleCollapsed={() => setTerminalCollapsed((collapsed) => !collapsed)}
              onClose={() => {
                setTerminalOpen(false);
                setTerminalDockCwd(null);
                setTerminalCollapsed(false);
              }}
            />
          )}
        </div>
        </div>
      </div>

      {/* Right panel: file viewer or SnFlow — always mounted, width animated via CSS */}
      <div
        ref={rightPanelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--line)",
          background: "var(--bg-panel)",
          position: "relative",
        }}
      >
        {rightPanelOpen && rightPanelResizable && (
          <div
            className={`panel-resize-handle panel-resize-handle-vertical${rightPanelResizing ? " is-active" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={getRightPanelWidthBounds(sidebarOpen).min}
            aria-valuemax={getRightPanelWidthBounds(sidebarOpen).max}
            aria-valuenow={clampRightPanelWidth(rightPanelWidth, sidebarOpen)}
            aria-label={t("app.resizeRightPanel")}
            title={t("app.resizeRightPanel")}
            tabIndex={0}
            onPointerDown={handleRightPanelResizePointerDown}
            onKeyDown={handleRightPanelResizeKeyDown}
          />
        )}
        {rightPanelOpen && (
          <>
            <div className="insp-head">
              <h3>Inspector</h3>
              <button
                className="chip"
                onClick={() => setRightPanelOpen(false)}
                title={t("app.hidePreview")}
                style={{ height: 26 }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="insp-tabs">
              <button className={rightPanelMode === "changes" ? "on" : ""} onClick={() => openInspectorTab("changes")}>Changes</button>
              <button className={rightPanelMode === "files" ? "on" : ""} onClick={() => openInspectorTab("files")}>Preview</button>
              <button className={rightPanelMode === "git" ? "on" : ""} onClick={() => openInspectorTab("git")}>Git</button>
              <button
                className={rightPanelMode === "workflow" ? "on" : ""}
                onClick={(e) => {
                  // Alt+click: create SnFlow task from current chat without opening the create form.
                  if (e.altKey && selectedSession?.id && workflowCwd) {
                    void handleStartWorkflowFromChat();
                    return;
                  }
                  openInspectorTab("workflow");
                }}
                title={selectedSession?.id ? t("app.workflowToggleWithCreate") : undefined}
              >SnFlow</button>
              <button className={rightPanelMode === "agents" ? "on" : ""} onClick={() => openInspectorTab("agents")}>Agents</button>
            </div>
            <div className="insp-body">
              {rightPanelMode === "changes" && (
                <InspectorChangesPanel sessionId={selectedSession?.id ?? null} agentRunning={agentRunning} refreshKey={refreshKey} />
              )}
              {rightPanelMode === "files" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                  {/* File tabs */}
                  <div style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--line-soft)", height: 36 }}>
                    <div style={{ flex: 1, overflow: "hidden" }}>
                      <TabBar
                        tabs={fileTabs}
                        activeTabId={activeFileTabId ?? ""}
                        onSelectTab={setActiveFileTabId}
                        onCloseTab={handleCloseFileTab}
                      />
                    </div>
                  </div>

                  {/* File content */}
                  <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
                    {activeFileTab?.filePath ? (
                      <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} initialLine={activeFileTab.line} editorConfig={webConfig?.editor} onAddChat={handleAddChat} onOpenFile={handleOpenFile} />
                    ) : (
                      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                        {t("app.noOpenFile")}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {rightPanelMode === "git" && (
                <div style={{ height: "100%", overflowY: "auto", minHeight: 0 }}>
                  <GitPanel cwd={workspaceCwd} refreshKey={gitRefreshKey} onDirtyChange={setGitDirty} />
                </div>
              )}
              {rightPanelMode === "workflow" && (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--line-soft)", height: 36, padding: "0 12px", gap: 8 }}>
                    <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{t("workflow.panelTitle")}</span>
                    {workflowCwd && <span title={workflowCwd} style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workflowCwd}</span>}
                  </div>
                  <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
                    <WorkflowPanel
                      cwd={workflowCwd}
                      includeArchivedDefault={workflowIncludeArchivedDefault}
                      focusedTaskId={focusedWorkflowTaskId}
                      sessionId={selectedSession?.id ?? null}
                      onTaskCreated={handleWorkflowTaskCreated}
                    />
                  </div>
                </div>
              )}
              {rightPanelMode === "agents" && (
                <div style={{ height: "100%", overflowY: "auto", minHeight: 0 }}>
                  <StoredSubagentPanel store={subagentStore} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
    {/* Keep mounted so unread badge stays live while drawer is closed. */}
    <div
      className="automation-drawer-overlay"
      hidden={!automationOpen}
      style={{
        display: automationOpen ? "block" : "none",
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(480px, 100vw)",
        zIndex: 320,
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border)",
        boxShadow: "-8px 0 24px rgba(0,0,0,0.18)",
        overflow: "auto",
      }}
    >
      <AutomationPanel
        open={automationOpen}
        onClose={() => setAutomationOpen(false)}
        onUnreadChange={setAutomationUnread}
        onOpenSession={(session) => {
          // Open/select promoted session using promotion cwd/path (not activeCwdRef synthetic empty path).
          const now = new Date().toISOString();
          const cwd = session.cwd || activeCwdRef.current || activeCwd || "";
          const path = session.path || "";
          handleSelectSession({
            id: session.id,
            path,
            cwd,
            name: session.id,
            created: now,
            modified: now,
            messageCount: 0,
            firstMessage: "",
          });
          setAutomationOpen(false);
        }}
      />
    </div>
    {modelsConfigOpen && <ModelsConfig cwd={workspaceCwd ?? null} onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {usageStatsOpen && (
      <UsageStatsModal cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd} onClose={() => setUsageStatsOpen(false)} />
    )}
    {settingsConfigOpen && (
      <SettingsConfig
        cwd={workspaceCwd}
        onConfigChange={() => { void loadWebConfig(); }}
        onClose={() => { setSettingsConfigOpen(false); void loadWebConfig(); }}
      />
    )}
    </>
  );
}
