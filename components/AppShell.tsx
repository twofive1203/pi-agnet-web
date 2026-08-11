"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { ChatGptUsagePanel } from "./ChatGptUsagePanel";
import { GrokUsagePanel } from "./GrokUsagePanel";
import { SessionResourcePanel } from "./SessionResourcePanel";
import type { SessionPerformanceSummary } from "@/lib/types";
import { StoredSubagentPanel, SubagentBadgeIndicator } from "./SubagentObservation";
import { WorkflowSessionWidget } from "./WorkflowSessionWidget";
import type { WorkflowTaskDetail } from "@/lib/workflow-types";
import type { WorkflowPhaseLabel } from "@/lib/workflow-guidance";
import type { WorkflowSessionTaskLinkResult } from "@/lib/workflow-session-link";
import { workflowTaskToChatContext, type WorkflowTaskChatContext } from "@/lib/workflow-chat-context";
import { BranchNavigator } from "./BranchNavigator";
import { GitPanel } from "./GitPanel";
import { InspectorChangesPanel } from "./InspectorChangesPanel";
import { getRelativeFilePath } from "@/lib/file-paths";
import { formatWorkspaceHeaderTitle, formatWorkspaceTitle } from "@/lib/workspace-title";
import { ThemePicker } from "./ThemePicker";
import Tooltip from "./Tooltip";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useAutomationUnread } from "@/hooks/useAutomationUnread";
import type { GitInfo, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { PiWebConfig } from "@/lib/pi-web-config";
import type { ChatInputHandle } from "./ChatInput";
import { recordSubagentClientMetric } from "@/lib/subagent-observability-client";
import { SubagentStore } from "@/lib/subagent-store";
import { makeTempSessionId } from "./sidebar/sidebar-utils";

// Settings-class surfaces stay out of the initial chat shell chunk.
// loading: null — never inject an in-flow placeholder (that flashed the chat shell).
// Hover/focus prefetch on open controls usually finishes the chunk before click.
const loadModelsConfig = () => import("./ModelsConfig");
const loadSettingsConfig = () => import("./SettingsConfig");
const loadUsageStatsModal = () => import("./UsageStatsModal");
const loadTerminalPanel = () => import("./TerminalPanel");
const loadWorkflowPanel = () => import("./WorkflowPanel");
const loadAutomationPanel = () => import("./AutomationPanel");

const ModelsConfig = dynamic(
  () => loadModelsConfig().then((mod) => mod.ModelsConfig),
  { ssr: false, loading: () => null },
);
const SettingsConfig = dynamic(
  () => loadSettingsConfig().then((mod) => mod.SettingsConfig),
  { ssr: false, loading: () => null },
);
const UsageStatsModal = dynamic(
  () => loadUsageStatsModal().then((mod) => mod.UsageStatsModal),
  { ssr: false, loading: () => null },
);
const TerminalPanel = dynamic(
  () => loadTerminalPanel().then((mod) => mod.TerminalPanel),
  { ssr: false, loading: () => null },
);
const WorkflowPanel = dynamic(
  () => loadWorkflowPanel().then((mod) => mod.WorkflowPanel),
  { ssr: false, loading: () => null },
);
const AutomationPanel = dynamic(
  () => loadAutomationPanel().then((mod) => mod.AutomationPanel),
  { ssr: false, loading: () => null },
);

const TOP_PANEL_SAFE_SELECTOR = ".app-top-aux-panel, .app-top-more-portal, .app-top-aux-tab, .branch-navigator-inline, .theme-picker-popover";
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-web-right-panel-width-v2";
const DEFAULT_RIGHT_PANEL_WIDTH = 380;
const MAX_RIGHT_PANEL_RATIO = 0.7;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MIN_CHAT_WIDTH = 360;
const DESKTOP_SIDEBAR_WIDTH = 300;
const MAX_WORKBENCH_GUTTER = 12;
/** Inline dock needs sidebar + chat min + right min; below this use overlay drawer. */
const RIGHT_PANEL_INLINE_MIN_VIEWPORT =
  DESKTOP_SIDEBAR_WIDTH + MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH; // 960
const RIGHT_PANEL_RESIZE_STEP = 10;
const RIGHT_PANEL_RESIZE_STEP_LARGE = 40;
const INSPECTOR_PANEL_ID = "workbench-inspector-panel";
const SYSTEM_PROMPT_PANEL_ID = "workbench-system-prompt-panel";
const SIDEBAR_ID = "workbench-sidebar";

type InspectorMode = "files" | "workflow" | "changes" | "git" | "agents";

const INSPECTOR_MODES: readonly InspectorMode[] = ["changes", "files", "git", "workflow", "agents"];

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

function isMobileLayoutViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches;
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

function getWorkbenchInlineChromeWidth(viewportWidth: number): number {
  const gutter = clampNumber((viewportWidth - RIGHT_PANEL_INLINE_MIN_VIEWPORT) * 0.25, 0, MAX_WORKBENCH_GUTTER);
  // Two outer paddings plus the two gaps between the three workbench columns.
  return gutter * 4;
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
  const maxByChat = window.innerWidth - sidebarWidth - MIN_CHAT_WIDTH - getWorkbenchInlineChromeWidth(window.innerWidth);
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
  const [usageStatsOpen, setUsageStatsOpen] = useState(false);
  const [settingsConfigOpen, setSettingsConfigOpen] = useState(false);
  const [webConfig, setWebConfig] = useState<PiWebConfig | null>(null);
  const [serverAuthRequired, setServerAuthRequired] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [terminalDockCwd, setTerminalDockCwd] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/server-auth/status", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = await res.json() as { authRequired?: boolean };
        if (data.authRequired === true) setServerAuthRequired(true);
      } catch {
        // local/default: hide logout
      }
    })();
    return () => controller.abort();
  }, []);

  const handleServerLogout = useCallback(async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await fetch("/api/server-auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch {
      // still leave the UI
    } finally {
      window.location.replace("/unlock");
    }
  }, [logoutBusy]);

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
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const systemPanelRef = useRef<HTMLDivElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<{ tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null>(null);
  const handleSessionStatsChange = useCallback((stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => {
    setSessionStats(stats);
  }, []);

  // Durable session performance summary — independent of billing stats.
  const [sessionPerformance, setSessionPerformance] = useState<SessionPerformanceSummary | null>(null);
  const handleSessionPerformanceChange = useCallback((performance: SessionPerformanceSummary | null) => {
    setSessionPerformance(performance);
  }, []);

  // Agent running state drives the Inspector attention signal and Changes polling.
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

  // Single active top-bar surface keeps branches, system prompt, and overflow mutually exclusive.
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "more" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const toggleTopPanel = useCallback((panel: "branches" | "system" | "more") => {
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
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActiveTopPanel(null);
      if (activeTopPanel === "system" || activeTopPanel === "more") {
        window.requestAnimationFrame(() => moreButtonRef.current?.focus());
      }
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

  useEffect(() => {
    if (activeTopPanel !== "system" || !topPanelPos) return;
    const frame = window.requestAnimationFrame(() => systemPanelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeTopPanel, topPanelPos]);

  // Right panel — file tabs and optional SnFlow task drawer
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [activeFileDirty, setActiveFileDirty] = useState(false);
  // Inspector starts collapsed by default; the focused top-bar trigger reopens the last tab.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  /** Inspector tabs: files(Preview) / workflow(SnFlow) / changes / git / agents. */
  const [rightPanelMode, setRightPanelMode] = useState<InspectorMode>("changes");
  const inspectorTabRefs = useRef<Partial<Record<InspectorMode, HTMLButtonElement | null>>>({});
  const inspectorButtonRef = useRef<HTMLButtonElement>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  // Lightweight owner keeps badge live while the heavy drawer stays code-split.
  // While open, the drawer owns updates; keep last polled value until it reports.
  const polledAutomationUnread = useAutomationUnread(!automationOpen);
  const [automationUnread, setAutomationUnread] = useState(0);
  useEffect(() => {
    if (!automationOpen) setAutomationUnread(polledAutomationUnread);
  }, [automationOpen, polledAutomationUnread]);
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

  useLayoutEffect(() => {
    const desktopMedia = window.matchMedia("(min-width: 641px)");
    const inlineMedia = window.matchMedia(`(min-width: ${RIGHT_PANEL_INLINE_MIN_VIEWPORT}px)`);
    const sync = () => {
      setIsDesktopLayout(desktopMedia.matches);
      setRightPanelInline(inlineMedia.matches);
      if (!desktopMedia.matches) {
        // Mobile drawers overlay the chat, so neither should cover it on load or after resize.
        setSidebarOpen(false);
        setRightPanelOpen(false);
      }
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

  const confirmDiscardActiveFile = useCallback(async (): Promise<boolean> => {
    if (!activeFileDirty) return true;
    const confirmed = await appDialog.confirm({
      message: t("panels.fileViewer.discardChanges"),
      tone: "danger",
    });
    if (confirmed) setActiveFileDirty(false);
    return confirmed;
  }, [activeFileDirty, appDialog, t]);

  /** Workspace picker / explicit project change — may clear cross-cwd session state. */
  const handleActiveCwdChange = useCallback(async (cwd: string | null) => {
    if (cwd === activeCwdRef.current) return;
    if (!(await confirmDiscardActiveFile())) return;
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
  }, [confirmDiscardActiveFile, router]);

  const handleSelectSession = useCallback(async (session: SessionInfo, isRestore = false) => {
    if (session.cwd && session.cwd !== activeCwdRef.current && !(await confirmDiscardActiveFile())) return;
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
  }, [confirmDiscardActiveFile, router]);

  const handleNewSession = useCallback(async (_sessionId: string, cwd: string) => {
    if (cwd !== activeCwdRef.current && !(await confirmDiscardActiveFile())) return;
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
  }, [confirmDiscardActiveFile, router]);

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

  const openInspectorTab = useCallback(async (mode: InspectorMode): Promise<boolean> => {
    if (mode !== "files" && rightPanelMode === "files" && !(await confirmDiscardActiveFile())) return false;
    if (mode === "workflow") void loadWorkflowPanel();
    if (isMobileLayoutViewport()) setSidebarOpen(false);
    setRightPanelMode(mode);
    setRightPanelOpen(true);
    return true;
  }, [confirmDiscardActiveFile, rightPanelMode]);

  const handleInspectorTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, mode: InspectorMode) => {
    const currentIndex = INSPECTOR_MODES.indexOf(mode);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % INSPECTOR_MODES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + INSPECTOR_MODES.length) % INSPECTOR_MODES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = INSPECTOR_MODES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = INSPECTOR_MODES[nextIndex];
    void openInspectorTab(nextMode).then((opened) => {
      if (opened) window.requestAnimationFrame(() => inspectorTabRefs.current[nextMode]?.focus());
    });
  }, [openInspectorTab]);

  const handleOpenFile = useCallback(async (filePath: string, fileName: string, line?: number) => {
    const tabId = `file:${filePath}`;
    if (tabId !== activeFileTabId && !(await confirmDiscardActiveFile())) return;
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (existing) return prev.map((tab) => tab.id === tabId ? { ...tab, line } : tab);
      return [...prev, { id: tabId, label: fileName, filePath, line }];
    });
    setActiveFileTabId(tabId);
    void openInspectorTab("files");
  }, [activeFileTabId, confirmDiscardActiveFile, openInspectorTab]);

  const handleSelectFileTab = useCallback(async (tabId: string) => {
    if (tabId === activeFileTabId) return;
    if (!(await confirmDiscardActiveFile())) return;
    setActiveFileTabId(tabId);
  }, [activeFileTabId, confirmDiscardActiveFile]);

  const handleCloseFileTab = useCallback(async (tabId: string) => {
    if (tabId === activeFileTabId && !(await confirmDiscardActiveFile())) return;
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      const remaining = fileTabs.filter((t) => t.id !== tabId);
      return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    });
  }, [activeFileTabId, confirmDiscardActiveFile, fileTabs]);

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
    openInspectorTab("workflow");
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
  }, [openInspectorTab, selectedSession]);

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
    </>
  );

  return (
    <>
    <div
      className="app-shell-root"
      style={{ ["--right-panel-width" as string]: `${rightPanelWidth}px` }}
    >
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${sidebarOpen ? " is-open" : ""}`}
        onClick={() => {
          setSidebarOpen(false);
          window.requestAnimationFrame(() => sidebarToggleRef.current?.focus());
        }}
      />

      {/* Left sidebar */}
      <div id={SIDEBAR_ID} className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}`} aria-hidden={!sidebarOpen} inert={!sidebarOpen}>
        {sidebarContent}
      </div>

      {/* Center: chat */}
      <div className="center-column">
        <div className="center-panel">
        {/* Context strip — merged top bar */}
        <div ref={topBarRef} className="top-context">
          <Tooltip content={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")} position="bottom">
          <button
            ref={sidebarToggleRef}
            className="icon-round context-icon-compact top-sidebar-trigger"
            onClick={() => {
              if (!sidebarOpen && isMobileLayoutViewport()) setRightPanelOpen(false);
              setSidebarOpen((open) => !open);
            }}
            aria-label={sidebarOpen ? t("app.hideSidebar") : t("app.showSidebar")}
            aria-controls={SIDEBAR_ID}
            aria-expanded={sidebarOpen}
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
          </Tooltip>

          {/* Breadcrumb: workspace / session */}
          <Tooltip content={workspaceCwd ?? undefined} position="bottom">
          <div className="breadcrumb">
            <span className="workspace-breadcrumb-label">{t("common.workspace")}</span>
            <span className="breadcrumb-separator">/</span>
            <strong className="breadcrumb-workspace">
              {formatWorkspaceHeaderTitle(workspaceCwd, activeCwdGit)}
            </strong>
            {showChat && (
              <>
                <span className="breadcrumb-separator">/</span>
                <strong className="breadcrumb-session">
                  {selectedSession?.name || selectedSession?.firstMessage?.slice(0, 40) || (selectedSession ? selectedSession.id.slice(0, 8) : t("sidebar.newSession"))}
                </strong>
              </>
            )}
          </div>
          </Tooltip>

          {showChat && (
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
          )}
          <div className="top-primary-tools" aria-label={t("app.primaryTools")}>
            <ThemePicker />
            <Tooltip content={t("app.languageSwitch")} position="bottom">
              <button
                className="icon-round context-action language-switch"
                type="button"
                onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
                aria-label={t("app.languageSwitch")}
              >
                {locale === "zh" ? "EN" : "中"}
              </button>
            </Tooltip>
            {terminalEnabled && terminalCwd && (
              <Tooltip content={terminalOpen && terminalDockCwd && terminalDockCwd !== terminalCwd ? t("app.openTerminalForWorkspace") : t("app.openTerminal")} position="bottom">
              <button
                className={`icon-round context-action${terminalOpen ? " on" : ""}`}
                onPointerEnter={() => { void loadTerminalPanel(); }}
                onFocus={() => { void loadTerminalPanel(); }}
                onClick={async () => {
                  if (!terminalOpen) {
                    void loadTerminalPanel();
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
                aria-label={terminalOpen && terminalDockCwd && terminalDockCwd !== terminalCwd ? t("app.openTerminalForWorkspace") : t("app.openTerminal")}
                aria-pressed={terminalOpen}
              >
                <svg className="context-action-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </button>
              </Tooltip>
            )}
            <Tooltip content={t("sidebar.models")} position="bottom">
            <button
              className="icon-round context-action"
              type="button"
              onPointerEnter={() => { void loadModelsConfig(); }}
              onFocus={() => { void loadModelsConfig(); }}
              onClick={() => {
                void loadModelsConfig();
                setModelsConfigOpen(true);
              }}
              aria-label={t("sidebar.models")}
            >
              <svg className="context-action-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21 8-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" />
              </svg>
            </button>
            </Tooltip>
            <Tooltip content={t("sidebar.settings")} position="bottom">
            <button
              className="icon-round context-action"
              type="button"
              onPointerEnter={() => { void loadSettingsConfig(); }}
              onFocus={() => { void loadSettingsConfig(); }}
              onClick={() => {
                void loadSettingsConfig();
                setSettingsConfigOpen(true);
              }}
              aria-label={t("sidebar.settings")}
            >
              <svg className="context-action-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05-2.83 2.83-.05-.05A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21h-4v-.05A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.05.05-2.83-2.83.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.05-.05 2.83-2.83.05.05A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3h4v.05A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.05-.05 2.83 2.83-.05.05A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21v4h-.05A1.7 1.7 0 0 0 19.4 15Z" />
              </svg>
            </button>
            </Tooltip>
          </div>
          {((showChat && (sessionStats || contextUsage || sessionPerformance)) || webConfig?.chatgpt.usagePanelEnabled || webConfig?.grok.usagePanelEnabled) && (
            <div className="app-resource-cluster" aria-label={t("app.resources")}>
              {showChat && (sessionStats || contextUsage || sessionPerformance) && (
                <SessionResourcePanel
                  sessionStats={sessionStats}
                  sessionPerformance={sessionPerformance}
                  contextUsage={contextUsage}
                  onOpenGlobalUsage={() => {
                    void loadUsageStatsModal();
                    setUsageStatsOpen(true);
                  }}
                />
              )}
              {(webConfig?.chatgpt.usagePanelEnabled || webConfig?.grok.usagePanelEnabled) && (
                <div className="app-resource-providers">
                  {webConfig?.chatgpt.usagePanelEnabled && <ChatGptUsagePanel />}
                  {webConfig?.grok.usagePanelEnabled && <GrokUsagePanel />}
                </div>
              )}
            </div>
          )}
          <Tooltip content={rightPanelOpen ? t("app.closeInspector") : t("app.openInspector")} position="bottom">
          <button
            ref={inspectorButtonRef}
            className={`icon-round context-action top-inspector-trigger${rightPanelOpen ? " on" : ""}`}
            type="button"
            onClick={() => {
              if (rightPanelOpen) setRightPanelOpen(false);
              else openInspectorTab(rightPanelMode);
            }}
            aria-label={rightPanelOpen ? t("app.closeInspector") : t("app.openInspector")}
            aria-controls={INSPECTOR_PANEL_ID}
            aria-expanded={rightPanelOpen}
          >
            <svg className="context-action-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
            <span className="top-inspector-signals" aria-hidden="true">
              {(agentRunning || todoActive || gitDirty) && <span className={`top-inspector-dot${gitDirty ? " is-warning" : ""}`} />}
              <SubagentBadgeIndicator store={subagentStore} />
            </span>
          </button>
          </Tooltip>
          <Tooltip content={t("common.more")} position="bottom">
          <button
            ref={moreButtonRef}
            className={`app-top-aux-tab icon-round context-action top-more-trigger${activeTopPanel === "more" ? " on" : ""}`}
            type="button"
            onClick={() => toggleTopPanel("more")}
            aria-label={t("common.more")}
            aria-expanded={activeTopPanel === "more"}
            aria-haspopup="menu"
          >
            <svg className="context-action-svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
            </svg>
          </button>
          </Tooltip>
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && activeTopPanel !== "branches" && topPanelPos && typeof document !== "undefined" && createPortal((
            <div
              ref={activeTopPanel === "system" ? systemPanelRef : undefined}
              id={activeTopPanel === "system" ? SYSTEM_PROMPT_PANEL_ID : undefined}
              className={activeTopPanel === "more" ? "app-top-more-portal" : "app-top-aux-panel"}
              role={activeTopPanel === "more" ? "presentation" : "region"}
              aria-label={activeTopPanel === "system" ? t("app.system") : undefined}
              tabIndex={activeTopPanel === "system" ? -1 : undefined}
              style={{
                top: topPanelPos.top,
                left: topPanelPos.left,
                width: topPanelPos.width,
              }}
            >
              {activeTopPanel === "system" && (
                <div className="app-top-aux-surface">
                  {systemPrompt ? (
                    <div className="app-system-prompt-content">{systemPrompt}</div>
                  ) : (
                    <div className="app-system-prompt-empty">
                      {systemPrompt === "" ? t("common.workbench.systemPromptEmpty") : t("common.workbench.systemPromptPending")}
                    </div>
                  )}
                </div>
              )}
              {activeTopPanel === "more" && (
                <div className="top-more-menu" role="menu" aria-label={t("common.more")}>
                  {showChat && (
                    <>
                      <div className="top-more-menu-label">{t("app.sessionActions")}</div>
                      <button
                        type="button"
                        role="menuitem"
                        className="top-more-menu-item"
                        disabled={!selectedSession}
                        onClick={() => {
                          setActiveTopPanel(null);
                          void handleExportSession();
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        <span>{t("app.exportHtml")}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="top-more-menu-item"
                        onClick={() => setActiveTopPanel("system")}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span>{t("app.system")}</span>
                        {systemPrompt && <span className="top-more-menu-status" />}
                      </button>
                    </>
                  )}
                  <div className="top-more-menu-label">{t("app.applicationActions")}</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="top-more-menu-item"
                    onPointerEnter={() => { void loadAutomationPanel(); }}
                    onFocus={() => { void loadAutomationPanel(); }}
                    onClick={() => {
                      setActiveTopPanel(null);
                      setAutomationOpen((open) => {
                        if (!open) void loadAutomationPanel();
                        return !open;
                      });
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" />
                    </svg>
                    <span>{t("automation.title")}</span>
                    {automationUnread > 0 && <span className="top-more-menu-badge">{automationUnread > 9 ? "9+" : automationUnread}</span>}
                  </button>
                  {serverAuthRequired && (
                    <button
                      type="button"
                      role="menuitem"
                      className="top-more-menu-item"
                      disabled={logoutBusy}
                      onClick={() => {
                        setActiveTopPanel(null);
                        void handleServerLogout();
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      <span>{logoutBusy ? t("access.loggingOut") : t("access.logout")}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          ), document.body)}

        </div>

        {/* Chat content + optional bottom terminal dock */}
        <div className="workbench-content-stack">
          <div className="workbench-chat-region">
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
              onSessionPerformanceChange={handleSessionPerformanceChange}
              onContextUsageChange={handleContextUsageChange}
              onSubagentChange={handleSubagentChange}
              onAgentRunningChange={handleAgentRunningChange}
              onTodoActiveChange={handleTodoActiveChange}
              onOpenModels={() => {
                void loadModelsConfig();
                setModelsConfigOpen(true);
              }}
            />
          ) : showPlaceholder ? (
            <div className="workbench-empty-state">
              <div className="hero-mark">π</div>
              <h3>{t("app.getStarted")}</h3>
              {activeCwd ? (
                <p>{t("app.selectSession")}</p>
              ) : (
                <p>
                  <span className="workbench-empty-step">1.</span>{t("app.getStartedStep1")}<br />
                  <span className="workbench-empty-step">2.</span>{t("app.getStartedStep2Before")} <strong>{t("app.getStartedStep2Strong")}</strong> {t("app.getStartedStep2After")}
                </p>
              )}
              <div className="workbench-empty-actions">
                <button
                  className="workbench-primary-action"
                  disabled={!activeCwd && !newSessionCwd}
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
                openInspectorTab("workflow");
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
        id={INSPECTOR_PANEL_ID}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizing ? " right-panel-resizing" : ""}`}
        aria-hidden={!rightPanelOpen}
        inert={!rightPanelOpen}
      >
        {rightPanelOpen && rightPanelResizable && (
          <Tooltip content={t("app.resizeRightPanel")} position="left">
            <div
              className={`panel-resize-handle panel-resize-handle-vertical${rightPanelResizing ? " is-active" : ""}`}
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={getRightPanelWidthBounds(sidebarOpen).min}
              aria-valuemax={getRightPanelWidthBounds(sidebarOpen).max}
              aria-valuenow={clampRightPanelWidth(rightPanelWidth, sidebarOpen)}
              aria-label={t("app.resizeRightPanel")}
              tabIndex={0}
              onPointerDown={handleRightPanelResizePointerDown}
              onKeyDown={handleRightPanelResizeKeyDown}
            />
          </Tooltip>
        )}
        {(rightPanelOpen || (rightPanelMode === "files" && activeFileTabId !== null)) && (
          <>
            <div className="insp-head">
              <h3>{t("common.workbench.inspector")}</h3>
              <Tooltip content={t("app.hidePreview")} position="bottom">
                <button
                  className="chip insp-close"
                  onClick={() => {
                    setRightPanelOpen(false);
                    window.requestAnimationFrame(() => {
                      inspectorButtonRef.current?.focus();
                    });
                  }}
                  aria-label={t("app.hidePreview")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Tooltip>
            </div>
            <div className="insp-tabs" role="tablist" aria-label={t("common.workbench.inspector")}>
              <button ref={(node) => { inspectorTabRefs.current.changes = node; }} id="inspector-tab-changes" role="tab" aria-controls="inspector-active-panel" aria-selected={rightPanelMode === "changes"} tabIndex={rightPanelMode === "changes" ? 0 : -1} className={rightPanelMode === "changes" ? "on" : ""} onKeyDown={(event) => handleInspectorTabKeyDown(event, "changes")} onClick={() => openInspectorTab("changes")}>{t("common.workbench.changes")}</button>
              <button ref={(node) => { inspectorTabRefs.current.files = node; }} id="inspector-tab-files" role="tab" aria-controls="inspector-active-panel" aria-selected={rightPanelMode === "files"} tabIndex={rightPanelMode === "files" ? 0 : -1} className={rightPanelMode === "files" ? "on" : ""} onKeyDown={(event) => handleInspectorTabKeyDown(event, "files")} onClick={() => openInspectorTab("files")}>{t("common.workbench.preview")}</button>
              <button ref={(node) => { inspectorTabRefs.current.git = node; }} id="inspector-tab-git" role="tab" aria-controls="inspector-active-panel" aria-selected={rightPanelMode === "git"} tabIndex={rightPanelMode === "git" ? 0 : -1} className={rightPanelMode === "git" ? "on" : ""} onKeyDown={(event) => handleInspectorTabKeyDown(event, "git")} onClick={() => openInspectorTab("git")}>{t("common.workbench.git")}</button>
              <Tooltip content={selectedSession?.id ? t("app.workflowToggleWithCreate") : undefined} position="bottom">
              <button
                ref={(node) => { inspectorTabRefs.current.workflow = node; }}
                id="inspector-tab-workflow"
                role="tab"
                aria-controls="inspector-active-panel"
                aria-selected={rightPanelMode === "workflow"}
                tabIndex={rightPanelMode === "workflow" ? 0 : -1}
                className={rightPanelMode === "workflow" ? "on" : ""}
                onPointerEnter={() => { void loadWorkflowPanel(); }}
                onFocus={() => { void loadWorkflowPanel(); }}
                onKeyDown={(event) => handleInspectorTabKeyDown(event, "workflow")}
                onClick={(e) => {
                  // Alt+click: create SnFlow task from current chat without opening the create form.
                  if (e.altKey && selectedSession?.id && workflowCwd) {
                    void handleStartWorkflowFromChat();
                    return;
                  }
                  openInspectorTab("workflow");
                }}
              >{t("common.workbench.snflow")}</button>
              </Tooltip>
              <button ref={(node) => { inspectorTabRefs.current.agents = node; }} id="inspector-tab-agents" role="tab" aria-controls="inspector-active-panel" aria-selected={rightPanelMode === "agents"} tabIndex={rightPanelMode === "agents" ? 0 : -1} className={rightPanelMode === "agents" ? "on" : ""} onKeyDown={(event) => handleInspectorTabKeyDown(event, "agents")} onClick={() => openInspectorTab("agents")}>{t("common.workbench.agents")}</button>
            </div>
            <div id="inspector-active-panel" className="insp-body" role="tabpanel" aria-labelledby={`inspector-tab-${rightPanelMode}`} tabIndex={0}>
              {rightPanelMode === "changes" && (
                <InspectorChangesPanel sessionId={selectedSession?.id ?? null} agentRunning={agentRunning} refreshKey={refreshKey} />
              )}
              {rightPanelMode === "files" && (
                <div className="insp-panel-column">
                  {/* File tabs */}
                  <div className="insp-panel-toolbar">
                    <div className="insp-panel-toolbar-content">
                      <TabBar
                        tabs={fileTabs}
                        activeTabId={activeFileTabId ?? ""}
                        onSelectTab={(tabId) => { void handleSelectFileTab(tabId); }}
                        onCloseTab={(tabId) => { void handleCloseFileTab(tabId); }}
                      />
                    </div>
                  </div>

                  {/* File content */}
                  <div className="insp-panel-content">
                    {activeFileTab?.filePath ? (
                      <FileViewer filePath={activeFileTab.filePath} cwd={activeCwd ?? undefined} initialLine={activeFileTab.line} editorConfig={webConfig?.editor} onAddChat={handleAddChat} onOpenFile={handleOpenFile} onDirtyChange={setActiveFileDirty} />
                    ) : (
                      <div className="insp-empty-state">{t("app.noOpenFile")}</div>
                    )}
                  </div>
                </div>
              )}
              {rightPanelMode === "git" && (
                <div className="insp-panel-scroll">
                  <GitPanel cwd={workspaceCwd} refreshKey={gitRefreshKey} onDirtyChange={setGitDirty} />
                </div>
              )}
              {rightPanelMode === "workflow" && (
                <div className="insp-panel-column">
                  <div className="insp-panel-toolbar insp-workflow-toolbar">
                    <span className="insp-panel-title">{t("workflow.panelTitle")}</span>
                    {workflowCwd && (
                      <Tooltip content={workflowCwd} position="bottom">
                        <span className="insp-panel-context">{workflowCwd}</span>
                      </Tooltip>
                    )}
                  </div>
                  <div className="insp-panel-scroll">
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
                <div className="insp-panel-scroll">
                  <StoredSubagentPanel store={subagentStore} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
    {/* Drawer mounts only while open; unread badge is owned by useAutomationUnread when closed. */}
    {automationOpen && (
      <div
        id="automation-drawer"
        className="automation-drawer-overlay"
        style={{
          display: "block",
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(480px, 100vw)",
          zIndex: "var(--z-automation-drawer)",
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
    )}
    {modelsConfigOpen && <ModelsConfig cwd={workspaceCwd ?? null} onClose={() => { setModelsConfigOpen(false); setModelsRefreshKey((k) => k + 1); }} />}
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
