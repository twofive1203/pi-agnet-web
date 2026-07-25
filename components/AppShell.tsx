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
import { IntercomPanel } from "./IntercomPanel";
import { UsageStatsModal } from "./UsageStatsModal";
import { ChatGptUsagePanel } from "./ChatGptUsagePanel";
import { GrokUsagePanel } from "./GrokUsagePanel";
import { SubagentPanel } from "./SubagentPanel";
import { SettingsConfig } from "./SettingsConfig";
import { TrellisPanel } from "./TrellisPanel";
import { TrellisSessionWidget } from "./TrellisSessionWidget";
import { WorkflowPanel } from "./WorkflowPanel";
import { WorkflowSessionWidget } from "./WorkflowSessionWidget";
import { BrowserBindingPanel } from "./BrowserBindingPanel";
import type { WorkflowTaskDetail } from "@/lib/workflow-types";
import type { WorkflowPhaseLabel } from "@/lib/workflow-guidance";
import type { WorkflowSessionTaskLinkResult } from "@/lib/workflow-session-link";
import { workflowTaskToChatContext, type WorkflowTaskChatContext } from "@/lib/workflow-chat-context";
import { BranchNavigator } from "./BranchNavigator";
import { GitPanel } from "./GitPanel";
import { TerminalPanel } from "./TerminalPanel";
import { getRelativeFilePath } from "@/lib/file-paths";
import { formatWorkspaceTitle } from "@/lib/workspace-title";
import { ThemePicker } from "./ThemePicker";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import type { GitInfo, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { PiWebConfig } from "@/lib/pi-web-config";
import type { TrellisSessionTaskLinkResult, TrellisTaskDetail } from "@/lib/trellis-types";
import { trellisTaskDetailToChatContext, type TrellisTaskChatContext } from "@/lib/trellis-chat-context";
import type { ChatInputHandle } from "./ChatInput";

const TOP_PANEL_SAFE_SELECTOR = ".app-top-aux-panel, .app-top-aux-tab, .branch-navigator-inline";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-web-right-panel-width-v1";
const DEFAULT_RIGHT_PANEL_RATIO = 0.42;
const MAX_RIGHT_PANEL_RATIO = 0.7;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MIN_CHAT_WIDTH = 360;
const DESKTOP_SIDEBAR_WIDTH = 260;
/** Inline dock needs sidebar + chat min + right min; below this use overlay drawer. */
const RIGHT_PANEL_INLINE_MIN_VIEWPORT =
  DESKTOP_SIDEBAR_WIDTH + MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH; // 920
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
  if (typeof window === "undefined") return MIN_RIGHT_PANEL_WIDTH;
  return Math.round(window.innerWidth * DEFAULT_RIGHT_PANEL_RATIO);
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

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    setContextUsage(usage);
  }, []);

  // Subagent runs — populated by ChatWindow, displayed in top bar panel
  const [subagentRuns, setSubagentRuns] = useState<import("@/hooks/useAgentSession").SubagentRun[]>([]);
  const handleSubagentChange = useCallback((runs: import("@/hooks/useAgentSession").SubagentRun[]) => {
    setSubagentRuns(runs);
  }, []);
  useEffect(() => {
    setSubagentRuns([]);
  }, [sessionKey]);

  const handleInteractiveShellRequest = useCallback((request: { cwd: string; command?: string; reason?: string }) => {
    // When config is still loading, optimistically open; createTerminalSession enforces enablement.
    if (webConfig && !webConfig.terminal.enabled) return;
    setTerminalOpen(true);
    setTerminalCollapsed(false);
    setTerminalDockCwd(request.cwd);
    if (request.command?.trim()) {
      setTerminalSeedCommand(request.command.trim());
    }
  }, [webConfig]);

  // Git panel state
  const [gitDirty, setGitDirty] = useState(false);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "subagents" | "git" | "intercom" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [terminalSeedCommand, setTerminalSeedCommand] = useState<string | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "subagents" | "git" | "intercom") => {
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

  // Right panel — file tabs and optional Trellis task drawer
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelMode, setRightPanelMode] = useState<"files" | "trellis" | "workflow">("files");
  const [rightPanelWidth, setRightPanelWidth] = useState(MIN_RIGHT_PANEL_WIDTH);
  const [rightPanelResizing, setRightPanelResizing] = useState(false);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [rightPanelInline, setRightPanelInline] = useState(false);
  const rightPanelWidthRef = useRef(rightPanelWidth);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelResizable = isDesktopLayout && rightPanelInline;
  const [focusedTrellisTaskKey, setFocusedTrellisTaskKey] = useState<string | null>(null);
  const [trellisSessionTask, setTrellisSessionTask] = useState<TrellisSessionTaskLinkResult | null>(null);
  const [trellisSessionTaskRefreshKey, setTrellisSessionTaskRefreshKey] = useState(0);
  const [pendingTrellisTaskContext, setPendingTrellisTaskContext] = useState<TrellisTaskChatContext | null>(null);
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
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  const handleAddChat = useCallback((filePath: string, selection?: { startLine: number; endLine: number }) => {
    const relativePath = getRelativeFilePath(filePath, activeCwd ?? undefined);
    chatInputRef.current?.addFileReference(relativePath, selection);
  }, [activeCwd]);

  const handleCwdChange = useCallback((cwd: string | null) => {
    if (cwd !== activeCwd) {
      setFileTabs([]);
      setActiveFileTabId(null);
      if (rightPanelMode === "files") setRightPanelOpen(false);
    }
    setActiveCwd(cwd);
    // Keep an already-open terminal pinned to the cwd captured when it was opened;
    // terminal processes are ephemeral and should not be silently killed or retargeted
    // just because the selected chat/workspace changed.
    // Skip if cwd is null (initial mount) or during the initial URL restore.
    if (!cwd || suppressCwdBumpRef.current) return;
    // Close any session that belongs to a different cwd — it no longer
    // matches the selected project directory.
    setSelectedSession((prev) => {
      if (prev && prev.cwd !== cwd) return null;
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
  }, [activeCwd, rightPanelMode, router]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setNewSessionCwd(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
      setTimeout(() => { suppressCwdBumpRef.current = false; }, 0);
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [router]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string) => {
    setSelectedSession(null);
    setNewSessionCwd(cwd);
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
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router]);

  const handleAgentEnd = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    setGitRefreshKey((k) => k + 1);
    setTrellisSessionTaskRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [router]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === sessionId) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [selectedSession, router]);

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
      if (next.length === 0 && rightPanelMode === "files") setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [fileTabs, rightPanelMode]);

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
  const trellisEnabled = webConfig?.trellis.enabled ?? false;
  const terminalEnabled = webConfig?.terminal.enabled ?? false;
  const trellisIncludeArchivedDefault = webConfig?.trellis.includeArchived ?? false;
  const workflowIncludeArchivedDefault = webConfig?.workflow.includeArchived ?? false;
  const trellisCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  const workflowCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const terminalCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd;
  const browserTitleCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  const browserTitleGit = selectedSession?.cwd === browserTitleCwd ? selectedSession.git : activeCwdGit;

  const loadTrellisSessionTask = useCallback(async (signal?: AbortSignal) => {
    if (!trellisEnabled || !selectedSession || selectedSession.archived) {
      setTrellisSessionTask(null);
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(selectedSession.id)}/trellis-task`, { signal });
      const data = await res.json() as TrellisSessionTaskLinkResult & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTrellisSessionTask(data.task ? data : null);
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") setTrellisSessionTask(null);
    }
  }, [selectedSession, trellisEnabled]);

  useEffect(() => {
    setFocusedTrellisTaskKey(null);
  }, [selectedSession?.id]);

  useEffect(() => {
    setFocusedWorkflowTaskId(null);
  }, [workflowCwd]);

  // Clear the session widget when changing sessions — the pointer is
  // session-scoped and an old task should not surface in a new session.
  useEffect(() => {
    setWorkflowCurrentTask(null);
  }, [selectedSession?.id]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTrellisSessionTask(controller.signal);
    return () => controller.abort();
  }, [loadTrellisSessionTask, trellisSessionTaskRefreshKey]);

  const trellisSessionTaskKey = trellisSessionTask?.task?.key ?? null;

  useEffect(() => {
    if (!trellisSessionTaskKey) return;
    const interval = window.setInterval(() => {
      setTrellisSessionTaskRefreshKey((key) => key + 1);
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [trellisSessionTaskKey]);

  const handleOpenTrellisSessionTask = useCallback(() => {
    if (!trellisSessionTask?.task) return;
    setFocusedTrellisTaskKey(trellisSessionTask.task.key);
    setRightPanelMode("trellis");
    setRightPanelOpen(true);
  }, [trellisSessionTask]);

  const handleJoinTrellisTaskChat = useCallback((task: TrellisTaskDetail) => {
    if (task.isArchived || !trellisCwd) return;

    const context = trellisTaskDetailToChatContext(task);
    setPendingTrellisTaskContext(context);

    if (!selectedSession || selectedSession.cwd !== trellisCwd || selectedSession.archived) {
      setSelectedSession(null);
      setNewSessionCwd(trellisCwd);
      setSessionKey((key) => key + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      router.replace("/", { scroll: false });
    }
  }, [router, selectedSession, trellisCwd]);

  useEffect(() => {
    if (!pendingTrellisTaskContext || !showChat) return;

    let cancelled = false;
    let attempts = 0;
    const tryInsert = () => {
      if (cancelled) return;
      if (chatInputRef.current) {
        chatInputRef.current.addTrellisTaskContext(pendingTrellisTaskContext);
        setPendingTrellisTaskContext(null);
        return;
      }
      attempts += 1;
      if (attempts < 12) window.requestAnimationFrame(tryInsert);
    };

    window.requestAnimationFrame(tryInsert);
    return () => { cancelled = true; };
  }, [pendingTrellisTaskContext, sessionKey, showChat]);

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

  useEffect(() => {
    if (!trellisEnabled && rightPanelMode === "trellis") {
      setRightPanelMode("files");
      if (fileTabs.length === 0) setRightPanelOpen(false);
    }
  }, [trellisEnabled, rightPanelMode, fileTabs.length]);

  const rightToggleCount = 1 + (trellisEnabled ? 1 : 0) + 1; /* files + optional trellis + always-on SnFlow */
  const rightTogglePad = rightPanelOpen ? 12 : 12 + rightToggleCount * 36;

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
        selectedCwd={selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        explorerRefreshKey={explorerRefreshKey}
        onAtMention={handleAtMention}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
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
            id: "usage",
            label: t("sidebar.usage"),
            onClick: () => setUsageStatsOpen(true),
            disabled: false,
            icon: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6" />
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
            onClick={onClick}
            disabled={disabled}
            title={label}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              height: 32, padding: 0, background: "none", border: "none",
              borderRadius: 9, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
              fontSize: 12, opacity: disabled ? 0.35 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { if (!disabled) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {icon}
            {label}
          </button>
        ))}
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
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} className="app-top-bar" style={{ display: "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: 36, background: "var(--bg-panel)" }}>
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
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
          <ThemePicker />
          <button
            type="button"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            title={t("app.languageSwitch")}
            aria-label={t("app.languageSwitch")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 36, height: 36, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
              fontSize: 11, fontWeight: 700, letterSpacing: "-0.02em",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {locale === "zh" ? "EN" : "中"}
          </button>
          {showChat && (
            <div className="app-top-actions" style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              <button
                className="app-top-pill"
                onClick={handleExportSession}
                disabled={!selectedSession}
                title={selectedSession ? t("app.exportHtml") : t("app.exportHtmlDisabled")}
                aria-label={t("app.exportHtml")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  height: "100%",
                  padding: "0 12px",
                  background: "none",
                  border: "none",
                  borderTop: "2px solid transparent",
                  borderRight: "1px solid var(--border)",
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
                <span className="app-top-label">{t("app.export")}</span>
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
                className={`app-top-aux-tab app-top-pill${activeTopPanel === "system" ? " app-top-pill-active" : ""}`}
                onClick={() => toggleTopPanel("system")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
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
                <span className="app-top-label">{t("app.system")}</span>
              </button>
              <button
                className={`app-top-aux-tab app-top-pill${activeTopPanel === "subagents" ? " app-top-pill-active" : ""}`}
                onClick={() => toggleTopPanel("subagents")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "subagents" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "subagents" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "subagents" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                  position: "relative",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "subagents" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                <span className="app-top-label">{t("app.subagents")}</span>
                {(() => {
                  const running = subagentRuns.filter((r) => r.status === "running").length;
                  const completed = subagentRuns.filter((r) => r.status === "completed" || r.status === "failed").length;
                  if (running > 0) {
                    return (
                      <span style={{
                        position: "absolute", top: 4, right: 4,
                        width: 7, height: 7, borderRadius: "50%",
                        background: "#f59e0b",
                      }} />
                    );
                  }
                  if (completed > 0) {
                    return (
                      <span style={{
                        fontSize: 10, color: "#22c55e",
                        marginLeft: 2,
                      }}>✓</span>
                    );
                  }
                  return null;
                })()}
              </button>
              <button
                className={`app-top-aux-tab app-top-pill${activeTopPanel === "intercom" ? " app-top-pill-active" : ""}`}
                onClick={() => toggleTopPanel("intercom")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "intercom" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "intercom" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "intercom" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                  position: "relative",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "intercom" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span className="app-top-label">{t("app.intercom")}</span>
              </button>
              <button
                className={`app-top-aux-tab app-top-pill${activeTopPanel === "git" ? " app-top-pill-active" : ""}`}
                onClick={() => toggleTopPanel("git")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "git" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "git" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "git" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                  position: "relative",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "git" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span className="app-top-label">{t("app.git")}</span>
                {gitDirty && (
                  <span style={{
                    position: "absolute", top: 4, right: 4,
                    width: 7, height: 7, borderRadius: "50%",
                    background: "#f59e0b",
                  }} />
                )}
              </button>
            </div>
          )}
          {terminalEnabled && terminalCwd && (
            <button
              className={`app-top-pill${terminalOpen ? " app-top-pill-active" : ""}`}
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
                display: "flex", alignItems: "center", gap: 6,
                height: "100%", padding: "0 12px",
                background: terminalOpen ? "var(--bg-selected)" : "none",
                border: "none",
                borderTop: terminalOpen ? "2px solid var(--accent)" : "2px solid transparent",
                borderRight: "1px solid var(--border)",
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
              <span className="app-top-label">{t("app.terminal")}</span>
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
                className="app-top-stats"
                title={tooltip}
                style={{
                  marginLeft: "auto",
                  display: "flex", alignItems: "center", gap: 10,
                  paddingLeft: 12,
                  paddingRight: (webConfig?.chatgpt.usagePanelEnabled || webConfig?.grok.usagePanelEnabled) ? 12 : rightTogglePad,
                  height: "100%",
                  fontSize: 11, color: "var(--text-muted)",
                  whiteSpace: "nowrap", cursor: "default",
                  fontVariantNumeric: "tabular-nums",
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
          {(webConfig?.chatgpt.usagePanelEnabled || webConfig?.grok.usagePanelEnabled) && (
            <div className="app-top-usage-panel" style={{ marginLeft: showChat && (sessionStats || contextUsage) ? 0 : "auto", paddingRight: rightTogglePad, height: "100%", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
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
                  <SubagentPanel runs={subagentRuns} />
                </div>
              )}
              {activeTopPanel === "intercom" && (
                <IntercomPanel cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null} />
              )}
              {activeTopPanel === "git" && (
                <div style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                }}>
                  <GitPanel cwd={trellisCwd} refreshKey={gitRefreshKey} onDirtyChange={setGitDirty} />
                </div>
              )}
            </div>
          ), document.body)}

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
              onInteractiveShellRequest={handleInteractiveShellRequest}
            />
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                {t("app.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("app.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{t("app.getStartedStep1")}<br />
                    <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{t("app.getStartedStep2Before")} <strong style={{ color: "var(--text)" }}>{t("app.getStartedStep2Strong")}</strong> {t("app.getStartedStep2After")}
                  </div>
                </div>
              </div>
            )
          ) : null}
          {showChat && trellisSessionTask?.task && !(rightPanelOpen && rightPanelMode === "trellis" && focusedTrellisTaskKey === trellisSessionTask.task.key) && (
            <TrellisSessionWidget task={trellisSessionTask.task} onClick={handleOpenTrellisSessionTask} />
          )}
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
          {showChat && (
            <div
              style={{
                position: "absolute",
                left: 12,
                bottom: 12,
                zIndex: 20,
                width: 320,
                maxWidth: "calc(100% - 24px)",
              }}
            >
              <BrowserBindingPanel
                sessionId={selectedSession?.id ?? null}
                sessionLabel={selectedSession?.name || selectedSession?.id?.slice(0, 8)}
                compact
              />
            </div>
          )}
          </div>
          {terminalOpen && terminalEnabled && terminalDockCwd && (
            <TerminalPanel
              cwd={terminalDockCwd}
              collapsed={terminalCollapsed}
              seedCommand={terminalSeedCommand}
              onSeedCommandConsumed={() => setTerminalSeedCommand(null)}
              onToggleCollapsed={() => setTerminalCollapsed((collapsed) => !collapsed)}
              onClose={() => {
                setTerminalOpen(false);
                setTerminalDockCwd(null);
                setTerminalCollapsed(false);
                setTerminalSeedCommand(null);
              }}
            />
          )}
        </div>
      </div>

      {/* Right panel: file viewer or Trellis — always mounted, width animated via CSS */}
      <div
        ref={rightPanelRef}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
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
        {rightPanelMode === "files" ? (
          <>
            {/* Right panel tab bar */}
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36 }}>
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
            <div style={{ flex: 1, overflow: "hidden" }}>
              {activeFileTab?.filePath ? (
                <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} initialLine={activeFileTab.line} editorConfig={webConfig?.editor} onAddChat={handleAddChat} onOpenFile={handleOpenFile} />
              ) : (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                  {t("app.noOpenFile")}
                </div>
              )}
            </div>
          </>
        ) : rightPanelMode === "workflow" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36, padding: "0 12px", gap: 8 }}>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{t("workflow.panelTitle")}</span>
              {workflowCwd && <span title={workflowCwd} style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{workflowCwd}</span>}
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <WorkflowPanel
                cwd={workflowCwd}
                includeArchivedDefault={workflowIncludeArchivedDefault}
                focusedTaskId={focusedWorkflowTaskId}
                sessionId={selectedSession?.id ?? null}
                onTaskCreated={handleWorkflowTaskCreated}
              />
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", flexShrink: 0, background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", height: 36, padding: "0 12px", gap: 8 }}>
              <span style={{ color: "var(--text)", fontSize: 13, fontWeight: 700 }}>{t("trellis.panelTitle")}</span>
              {trellisCwd && <span title={trellisCwd} style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trellisCwd}</span>}
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <TrellisPanel cwd={trellisCwd} includeArchivedDefault={trellisIncludeArchivedDefault} focusedTaskKey={focusedTrellisTaskKey} onOpenFile={handleOpenFile} onJoinTaskChat={handleJoinTrellisTaskChat} />
            </div>
          </>
        )}
      </div>
    </div>
    {/* Right panel mode toggles — Preview first, optional Trellis to its right. */}
    <div className="right-panel-toggle-strip" style={{ position: "fixed", top: 0, right: 0, zIndex: 300, display: "flex", flexDirection: "row" }}>
      <button
        className={`right-panel-toggle${rightPanelOpen && rightPanelMode === "files" ? " right-panel-toggle-active" : ""}`}
        onClick={() => {
          if (rightPanelOpen && rightPanelMode === "files") setRightPanelOpen(false);
          else {
            setRightPanelMode("files");
            setRightPanelOpen(true);
          }
        }}
        title={rightPanelOpen && rightPanelMode === "files" ? t("app.hidePreview") : t("app.showPreview")}
        aria-label={rightPanelOpen && rightPanelMode === "files" ? t("app.hidePreview") : t("app.showPreview")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 36, height: 36, padding: 0,
          background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
          color: rightPanelOpen && rightPanelMode === "files" ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer", transition: "color 0.12s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen && rightPanelMode === "files" ? "var(--text)" : "var(--text-muted)"; }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <button
          className={`right-panel-toggle${rightPanelOpen && rightPanelMode === "workflow" ? " right-panel-toggle-active" : ""}`}
          onClick={(e) => {
            // Alt/Option+click: create SnFlow task from current chat (Trellis-like, no manual "+").
            if (e.altKey && selectedSession?.id && workflowCwd) {
              void handleStartWorkflowFromChat();
              return;
            }
            if (rightPanelOpen && rightPanelMode === "workflow") setRightPanelOpen(false);
            else {
              setRightPanelMode("workflow");
              setRightPanelOpen(true);
            }
          }}
          title={selectedSession?.id ? t("app.workflowToggleWithCreate") : (rightPanelOpen && rightPanelMode === "workflow" ? t("app.hideWorkflow") : t("app.showWorkflow"))}
          aria-label={rightPanelOpen && rightPanelMode === "workflow" ? t("app.hideWorkflow") : t("app.showWorkflow")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, padding: 0,
            background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
            color: rightPanelOpen && rightPanelMode === "workflow" ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
            fontSize: 12, fontWeight: 800,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen && rightPanelMode === "workflow" ? "var(--accent)" : "var(--text-muted)"; }}
        >
          SF
        </button>
      {trellisEnabled && (
        <button
          className={`right-panel-toggle${rightPanelOpen && rightPanelMode === "trellis" ? " right-panel-toggle-active" : ""}`}
          onClick={() => {
            if (rightPanelOpen && rightPanelMode === "trellis") setRightPanelOpen(false);
            else {
              setRightPanelMode("trellis");
              setRightPanelOpen(true);
            }
          }}
          title={rightPanelOpen && rightPanelMode === "trellis" ? t("app.hideTrellis") : t("app.showTrellis")}
          aria-label={rightPanelOpen && rightPanelMode === "trellis" ? t("app.hideTrellis") : t("app.showTrellis")}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, padding: 0,
            background: "var(--bg-panel)", border: "none", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
            color: rightPanelOpen && rightPanelMode === "trellis" ? "var(--accent)" : "var(--text-muted)",
            cursor: "pointer", transition: "color 0.12s",
            fontSize: 12, fontWeight: 800,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = rightPanelOpen && rightPanelMode === "trellis" ? "var(--accent)" : "var(--text-muted)"; }}
        >
          T
        </button>
      )}
    </div>
    {modelsConfigOpen && <ModelsConfig cwd={trellisCwd ?? null} onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
    {skillsConfigOpen && (activeCwd ?? selectedSession?.cwd ?? newSessionCwd) && (
      <SkillsConfig cwd={(activeCwd ?? selectedSession?.cwd ?? newSessionCwd)!} onClose={() => setSkillsConfigOpen(false)} />
    )}
    {usageStatsOpen && (
      <UsageStatsModal cwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd} onClose={() => setUsageStatsOpen(false)} />
    )}
    {settingsConfigOpen && (
      <SettingsConfig
        cwd={trellisCwd}
        onConfigChange={() => { void loadWebConfig(); }}
        onClose={() => { setSettingsConfigOpen(false); void loadWebConfig(); }}
      />
    )}
    </>
  );
}
