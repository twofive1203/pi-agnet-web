"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n, useT } from "./I18nProvider";
import { formatDateTime, type Locale } from "@/lib/i18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { joinFilePath } from "@/lib/file-paths";
import { buildStandaloneFileUrl } from "@/lib/file-viewer-url";
import type {
  WorkflowPriority,
  WorkflowRunRecord,
  WorkflowTaskDetail,
  WorkflowTaskStatus,
  WorkflowTaskSummary,
  WorkflowTasksListResponse,
} from "@/lib/workflow-types";

interface WorkflowPanelProps {
  cwd: string | null;
  includeArchivedDefault?: boolean;
  focusedTaskId?: string | null;
  /** Current chat session id — enables one-click create-from-conversation. */
  sessionId?: string | null;
  /** After auto/session create, parent can inject chat context and open the drawer. */
  onTaskCreated?: (task: WorkflowTaskDetail) => void;
}

type DocTab = "requirements" | "design" | "plan" | "runs";
type ViewMode = "edit" | "preview";

interface TasksResponse extends WorkflowTasksListResponse {
  error?: string;
}

interface DetailResponse {
  task?: WorkflowTaskDetail;
  dispatchPrompt?: string;
  error?: string;
  code?: string;
}

function workflowStatusTone(status: string): string {
  if (["completed", "ready_to_commit"].includes(status)) return "is-success";
  if (["failed", "changes_requested"].includes(status)) return "is-danger";
  if (status === "planning") return "is-warning";
  if (["ready", "implementing"].includes(status)) return "is-info";
  if (["review_ready", "checking"].includes(status)) return "is-accent";
  return "is-muted";
}

function shortPath(value: string, max = 48): string {
  return value.length > max ? `…${value.slice(-(max - 1))}` : value;
}

function formatTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function WorkflowPanel({
  cwd,
  includeArchivedDefault = false,
  focusedTaskId = null,
  sessionId = null,
  onTaskCreated,
}: WorkflowPanelProps) {
  const t = useT();
  const [includeArchived, setIncludeArchived] = useState(includeArchivedDefault);
  const [tasks, setTasks] = useState<WorkflowTaskSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listDiagnostics, setListDiagnostics] = useState<Array<{ id?: string; pathLabel?: string; message: string }>>([]);
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [exists, setExists] = useState(true);
  const [activeCwdRunId, setActiveCwdRunId] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowTaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [docTab, setDocTab] = useState<DocTab>("requirements");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [bundledVersion, setBundledVersion] = useState<string | null>(null);
  const [projectVersion, setProjectVersion] = useState<string | null>(null);
  const [deepLinkUnavailable, setDeepLinkUnavailable] = useState(false);
  const tasksLoadedOnceRef = useRef(false);

  // Draft fields
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPriority, setDraftPriority] = useState<WorkflowPriority>("P2");
  const [draftRequirements, setDraftRequirements] = useState("");
  const [draftDesign, setDraftDesign] = useState("");
  const [draftPlan, setDraftPlan] = useState("");
  const [commitHash, setCommitHash] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createPriority, setCreatePriority] = useState<WorkflowPriority>("P2");
  const [createParentTaskId, setCreateParentTaskId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);

  const dirty = useMemo(() => {
    if (!detail) return false;
    return (
      draftTitle !== detail.title ||
      draftDescription !== detail.description ||
      draftPriority !== detail.priority ||
      draftRequirements !== detail.documents.requirements ||
      draftDesign !== detail.documents.design ||
      draftPlan !== detail.documents.plan
    );
  }, [detail, draftTitle, draftDescription, draftPriority, draftRequirements, draftDesign, draftPlan]);

  const applyDetail = useCallback((task: WorkflowTaskDetail) => {
    setDetail(task);
    setDraftTitle(task.title);
    setDraftDescription(task.description);
    setDraftPriority(task.priority);
    setDraftRequirements(task.documents.requirements);
    setDraftDesign(task.documents.design);
    setDraftPlan(task.documents.plan);
    setCommitHash(task.commit?.hash ?? "");
    setConflictNote(null);
  }, []);

  const loadTasks = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!cwd) {
      setTasks([]);
      setListError(null);
      setListDiagnostics([]);
      setResolvedCwd(null);
      setExists(true);
      setActiveCwdRunId(null);
      return;
    }
    if (!silent) {
      setListLoading(true);
      setListError(null);
    }
    try {
      const res = await fetch(
        // Always fetch the full task set (active + archived); the checkbox
        // filters client-side so toggling it never reloads the whole list.
        `/api/workflows/tasks?cwd=${encodeURIComponent(cwd)}&includeArchived=true`,
      );
      const body = (await res.json()) as TasksResponse;
      if (!res.ok) {
        // Silent polls keep the last good list on transient failures.
        if (silent) return;
        setListError(body.error || `HTTP ${res.status}`);
        setTasks([]);
        setListDiagnostics([]);
        return;
      }
      const nextTasks = body.tasks ?? [];
      setTasks(nextTasks);
      setListError(null);
      setExists(body.exists !== false);
      setActiveCwdRunId(body.activeCwdRunId ?? null);
      setCurrentTaskId(body.currentTaskId ?? null);
      setResolvedCwd(body.cwd ?? null);
      setListDiagnostics(body.errors ?? []);
      // Prefer the current task pointer, then fall back to the first valid task in this cwd.
      const nextSelectedId = body.currentTaskId ?? nextTasks[0]?.id ?? null;
      setSelectedId((prev) => {
        if (prev && nextTasks.some((task) => task.id === prev)) return prev;
        return nextSelectedId;
      });
    } catch (error) {
      if (silent) return;
      setListError(error instanceof Error ? error.message : String(error));
      setTasks([]);
      setListDiagnostics([]);
    } finally {
      if (!silent) setListLoading(false);
    }
  }, [cwd]);

  const loadDetail = useCallback(
    async (taskId: string) => {
      if (!cwd) return;
      detailAbortRef.current?.abort();
      const controller = new AbortController();
      detailAbortRef.current = controller;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const res = await fetch(
          `/api/workflows/tasks/${encodeURIComponent(taskId)}?cwd=${encodeURIComponent(cwd)}`,
          { signal: controller.signal },
        );
        const body = (await res.json()) as DetailResponse;
        if (!res.ok) {
          setDetailError(body.error || `HTTP ${res.status}`);
          setDetail(null);
          return;
        }
        if (body.task) applyDetail(body.task);
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return;
        setDetailError(error instanceof Error ? error.message : String(error));
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [cwd, applyDetail],
  );

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const loadSetupStatus = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) {
      setUpdateAvailable(false);
      setBundledVersion(null);
      setProjectVersion(null);
      return;
    }
    try {
      const res = await fetch(`/api/workflows/setup/status?cwd=${encodeURIComponent(cwd)}`, { signal });
      const body = (await res.json()) as {
        status?: {
          updateAvailable?: boolean;
          bundledVersion?: string;
          projectVersion?: string;
        };
        error?: string;
      };
      if (!res.ok || !body.status) return;
      setUpdateAvailable(!!body.status.updateAvailable);
      setBundledVersion(body.status.bundledVersion ?? null);
      setProjectVersion(body.status.projectVersion ?? null);
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      // Setup status is advisory in the panel.
    }
  }, [cwd]);

  // Per-project SnFlow enablement: create the .pi/snflows store + managed assets.
  // "update" rewrites missing/outdated extension/skill/agent files without touching tasks.
  const handleSetupAction = useCallback(async (action: "init" | "update") => {
    if (!cwd || initializing) return;
    setInitializing(true);
    setInitError(null);
    try {
      const res = await fetch(`/api/workflows/setup/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        error?: string;
        output?: string;
        status?: {
          missingManagedFiles?: string[];
          updateAvailable?: boolean;
          projectVersion?: string;
          bundledVersion?: string;
        };
      };
      if (!res.ok || !body.success) {
        const missing = body.status?.missingManagedFiles?.length
          ? ` missing: ${body.status.missingManagedFiles.join(", ")}`
          : "";
        throw new Error(`${body.error ?? `HTTP ${res.status}`}${missing}`);
      }
      if (body.status) {
        setUpdateAvailable(!!body.status.updateAvailable);
        setBundledVersion(body.status.bundledVersion ?? null);
        setProjectVersion(body.status.projectVersion ?? null);
      }
      await loadTasks();
      await loadSetupStatus();
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitializing(false);
    }
  }, [cwd, initializing, loadSetupStatus, loadTasks]);

  const handleInitialize = useCallback(async () => {
    await handleSetupAction("init");
  }, [handleSetupAction]);

  const handleUpdateAssets = useCallback(async () => {
    await handleSetupAction("update");
  }, [handleSetupAction]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSetupStatus(controller.signal);
    return () => controller.abort();
  }, [loadSetupStatus]);

  useEffect(() => {
    setIncludeArchived(includeArchivedDefault);
  }, [includeArchivedDefault]);

  useEffect(() => {
    if (!listLoading && cwd) tasksLoadedOnceRef.current = true;
  }, [listLoading, cwd]);

  useEffect(() => {
    tasksLoadedOnceRef.current = false;
    setDeepLinkUnavailable(false);
  }, [cwd]);

  useEffect(() => {
    if (!focusedTaskId) {
      setDeepLinkUnavailable(false);
      return;
    }
    // Wait until the first list load for this cwd finishes before declaring miss.
    if (!tasksLoadedOnceRef.current || listLoading) return;
    if (tasks.some((task) => task.id === focusedTaskId)) {
      setSelectedId(focusedTaskId);
      setDeepLinkUnavailable(false);
      return;
    }
    setDeepLinkUnavailable(true);
  }, [focusedTaskId, tasks, listLoading]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    // Clear selection when cwd changes.
    setSelectedId(null);
    setDetail(null);
    setActionError(null);
  }, [cwd]);

  // Agents mutate task files outside this panel (CLI start/implement/archive);
  // poll the list so status changes show up without manual refresh.
  useEffect(() => {
    if (!cwd) return;
    const timer = setInterval(() => {
      void loadTasks({ silent: true });
    }, 5000);
    return () => clearInterval(timer);
  }, [cwd, loadTasks]);

  // Reload the selected detail when the list reveals an external revision change,
  // unless the user has unsaved local edits.
  useEffect(() => {
    if (!detail || dirty || detailLoading) return;
    const summary = tasks.find((task) => task.id === detail.id);
    if (summary && summary.revision !== detail.revision) void loadDetail(detail.id);
  }, [tasks, detail, dirty, detailLoading, loadDetail]);

  const activeRunId = detail?.activeRunId ?? null;

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!cwd || !activeRunId) return;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/workflows/runs/${encodeURIComponent(activeRunId)}?cwd=${encodeURIComponent(cwd)}`,
        );
        const body = (await res.json()) as { task?: WorkflowTaskDetail; run?: WorkflowRunRecord; error?: string };
        if (!res.ok) return;
        if (body.task) {
          // Preserve dirty local edits for docs while refreshing run/status.
          if (dirty) {
            setDetail((prev) =>
              prev
                ? {
                    ...body.task!,
                    documents: {
                      requirements: draftRequirements,
                      design: draftDesign,
                      plan: draftPlan,
                    },
                  }
                : body.task!,
            );
          } else {
            applyDetail(body.task);
          }
        }
        void loadTasks({ silent: true });
      } catch {
        // ignore transient poll errors
      }
    };

    void poll();
    pollRef.current = setInterval(() => {
      void poll();
    }, 2500);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [cwd, activeRunId, dirty, draftRequirements, draftDesign, draftPlan, applyDetail, loadTasks]);

  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = tasks.filter((task) => {
      if (!includeArchived && task.archived) return false;
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (!q) return true;
      return [task.title, task.id, task.description, task.status, task.priority]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    const parentIds = new Set(matches.map((task) => task.parentTaskId).filter((id): id is string => Boolean(id)));
    return tasks.filter((task) => (!task.archived || includeArchived) && (matches.includes(task) || parentIds.has(task.id)));
  }, [tasks, query, statusFilter, includeArchived]);

  async function runAction(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!cwd || !createTitle.trim()) return;
    await runAction(async () => {
      const res = await fetch(`/api/workflows/tasks?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: createTitle.trim(),
          priority: createPriority,
          parentTaskId: createParentTaskId ?? undefined,
          sessionId: sessionId || undefined,
        }),
      });
      const body = (await res.json()) as DetailResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setShowCreate(false);
      setCreateTitle("");
      setCreateParentTaskId(null);
      await loadTasks();
      if (body.task) {
        setSelectedId(body.task.id);
        applyDetail(body.task);
        onTaskCreated?.(body.task);
      }
    });
  }

  const handleCreateChild = useCallback(() => {
    if (!detail) return;
    setCreateParentTaskId(detail.id);
    setCreateTitle("");
    setShowCreate(true);
  }, [detail]);

  async function handleCreateFromSession() {
    if (!cwd || !sessionId) return;
    await runAction(async () => {
      const res = await fetch(`/api/workflows/tasks?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          priority: "P1",
        }),
      });
      const body = (await res.json()) as DetailResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadTasks();
      if (body.task) {
        setSelectedId(body.task.id);
        applyDetail(body.task);
        onTaskCreated?.(body.task);
      }
    });
  }

  async function handleSave() {
    if (!cwd || !detail) return;
    await runAction(async () => {
      const res = await fetch(
        `/api/workflows/tasks/${encodeURIComponent(detail.id)}?cwd=${encodeURIComponent(cwd)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: detail.revision,
            title: draftTitle,
            description: draftDescription,
            priority: draftPriority,
            requirements: draftRequirements,
            design: draftDesign,
            plan: draftPlan,
          }),
        },
      );
      const body = (await res.json()) as DetailResponse;
      if (res.status === 409) {
        setConflictNote(body.error || t("workflow.revisionConflict"));
        throw new Error(body.error || t("workflow.revisionConflict"));
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.task) applyDetail(body.task);
      await loadTasks();
    });
  }

  async function postTaskAction(pathSuffix: string, body: Record<string, unknown>) {
    if (!cwd || !detail) return;
    const res = await fetch(
      `/api/workflows/tasks/${encodeURIComponent(detail.id)}${pathSuffix}?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await res.json()) as DetailResponse & { run?: WorkflowRunRecord };
    if (res.status === 409) {
      setConflictNote(data.error || t("workflow.revisionConflict"));
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.task) applyDetail(data.task);
    await loadTasks();
  }

  async function handleMarkReady() {
    if (!detail) return;
    await runAction(async () => {
      const res = await fetch(
        `/api/workflows/tasks/${encodeURIComponent(detail.id)}?cwd=${encodeURIComponent(cwd!)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision: detail.revision, status: "ready" }),
        },
      );
      const body = (await res.json()) as DetailResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.task) applyDetail(body.task);
      await loadTasks();
    });
  }

  async function handleStartRun(phase: "implement" | "check") {
    if (!cwd || !detail) return;
    if (!sessionId) {
      setActionError("Open a chat session in this workspace to run SnFlow through the native subagent tool.");
      return;
    }
    await runAction(async () => {
      const res = await fetch(
        `/api/workflows/tasks/${encodeURIComponent(detail.id)}/runs?cwd=${encodeURIComponent(resolvedCwd ?? cwd)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase, expectedRevision: detail.revision }),
        },
      );
      const body = (await res.json()) as DetailResponse;
      if (!res.ok || !body.dispatchPrompt) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await sendAgentCommand(sessionId, {
        type: "prompt",
        message: body.dispatchPrompt,
      });
      setDocTab("runs");
      await loadTasks({ silent: true });
    });
  }

  async function handleCancelRun() {
    if (!cwd || !detail?.activeRunId) return;
    await runAction(async () => {
      const activeRun = detail.runs.find((run) => run.id === detail.activeRunId);
      if (sessionId && activeRun?.parentSessionId === sessionId) {
        await sendAgentCommand(sessionId, { type: "abort" });
        await loadTasks({ silent: true });
        return;
      }
      const res = await fetch(
        `/api/workflows/runs/${encodeURIComponent(detail.activeRunId!)}/cancel?cwd=${encodeURIComponent(cwd)}`,
        { method: "POST" },
      );
      const body = (await res.json()) as DetailResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.task) applyDetail(body.task);
      await loadTasks();
    });
  }

  async function handleRecordCommit() {
    if (!detail) return;
    await runAction(async () => {
      await postTaskAction("/complete", {
        mode: "record-commit",
        expectedRevision: detail.revision,
        commitHash,
      });
    });
  }

  async function handleComplete() {
    if (!detail) return;
    await runAction(async () => {
      await postTaskAction("/complete", {
        expectedRevision: detail.revision,
        commitHash: commitHash || undefined,
      });
    });
  }

  async function handleArchive() {
    if (!detail) return;
    await runAction(async () => {
      await postTaskAction("/archive", { expectedRevision: detail.revision });
      setSelectedId(null);
      setDetail(null);
      await loadTasks();
    });
  }

  const currentDoc =
    docTab === "requirements"
      ? draftRequirements
      : docTab === "design"
        ? draftDesign
        : docTab === "plan"
          ? draftPlan
          : "";

  const setCurrentDoc = (value: string) => {
    if (docTab === "requirements") setDraftRequirements(value);
    else if (docTab === "design") setDraftDesign(value);
    else if (docTab === "plan") setDraftPlan(value);
  };

  if (!cwd) {
    return (
      <div className="inspector-state inspector-state-empty workflow-no-workspace">
        <strong>{t("workflow.noWorkspace")}</strong>
        <span>{t("workflow.selectProjectHint")}</span>
      </div>
    );
  }

  return (
    <div className="workflow-panel-root">
      <div className="workflow-task-pane">
        <div className="workflow-task-toolbar">
          <div className="workflow-toolbar-row">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("workflow.searchTasks")}
              className="workflow-input"
            />
            <button type="button" onClick={() => void loadTasks()} className="workflow-icon-button" title={t("workflow.refresh")}>
              ↻
            </button>
            {sessionId && (
              <button
                type="button"
                onClick={() => void handleCreateFromSession()}
                className="workflow-icon-button is-accent"
                title={t("workflow.createFromChat")}
                disabled={busy}
              >
                ✦
              </button>
            )}
            <button type="button" onClick={() => setShowCreate(true)} className="workflow-icon-button is-accent" title={t("workflow.createTask")}>
              +
            </button>
          </div>
          <div className="workflow-toolbar-row">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="workflow-input">
              <option value="all">{t("workflow.allStatuses")}</option>
              {(
                [
                  "planning",
                  "ready",
                  "implementing",
                  "review_ready",
                  "checking",
                  "changes_requested",
                  "ready_to_commit",
                  "completed",
                  "failed",
                  "cancelled",
                ] as WorkflowTaskStatus[]
              ).map((status) => (
                <option key={status} value={status}>
                  {t(`workflow.status.${status}`)}
                </option>
              ))}
            </select>
          </div>
          <label className="workflow-checkbox-row">
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            {t("workflow.includeArchived")}
          </label>
          {currentTaskId && (
            <div className="workflow-toolbar-meta">{t("workflow.currentTask")}: {shortPath(currentTaskId, 28)}</div>
          )}
          {activeCwdRunId && (
            <div className="workflow-toolbar-meta is-warning">{t("workflow.activeCwdRun")}: {shortPath(activeCwdRunId, 28)}</div>
          )}
        </div>

        <div className="workflow-task-list">
          {listLoading && <div className="inspector-state inspector-state-loading workflow-list-state">{t("workflow.loadingTasks")}</div>}
          {listError && <div className="inspector-state inspector-state-error workflow-list-state" role="alert">{listError}</div>}
          {deepLinkUnavailable && (
            <div className="inspector-state inspector-state-error workflow-list-state" role="status">
              {t("workflow.deepLinkUnavailable")}
            </div>
          )}
          {!listLoading && resolvedCwd && (
            <div className="workflow-cwd-row" title={resolvedCwd}>
              cwd: {shortPath(resolvedCwd, 42)}
            </div>
          )}
          {!listLoading && listDiagnostics.length > 0 && (
            <div className="workflow-diagnostics" role="alert">
              <div className="workflow-diagnostics-title">
                {t("workflow.listDiagnostics", { count: listDiagnostics.length })}
              </div>
              {listDiagnostics.slice(0, 5).map((item, index) => (
                <div key={`${item.id ?? "err"}-${index}`} className="workflow-diagnostic-row">
                  <div className="workflow-mono">{item.id || item.pathLabel || "?"}</div>
                  <div>{item.message}</div>
                </div>
              ))}
              {listDiagnostics.length > 5 && (
                <div className="workflow-diagnostics-more">+{listDiagnostics.length - 5} more</div>
              )}
            </div>
          )}
          {!listLoading && !listError && !exists && (
            <div className="workflow-empty-card">
              <div className="workflow-empty-title">
                {t("workflow.notInitializedTitle")}
              </div>
              <div className="workflow-empty-description">
                {t("workflow.notInitializedHint")}
              </div>
              <button
                type="button"
                disabled={initializing}
                onClick={() => void handleInitialize()}
                className="workflow-action-button is-primary"
              >
                {initializing ? t("workflow.initializing") : t("workflow.initialize")}
              </button>
              {initError && <div className="workflow-inline-message is-error" role="alert">{initError}</div>}
            </div>
          )}
          {!listLoading && !listError && exists && updateAvailable && (
            <div className="workflow-update-card">
              <div className="workflow-update-copy">
                {t("workflow.updateAvailableHint", {
                  project: projectVersion ?? t("workflow.versionUnknown"),
                  bundled: bundledVersion ?? t("workflow.versionUnknown"),
                })}
              </div>
              <button
                type="button"
                disabled={initializing}
                onClick={() => void handleUpdateAssets()}
                className="workflow-action-button is-warning"
              >
                {initializing ? t("workflow.updatingAssets") : t("workflow.updateAssets")}
              </button>
              {initError && <div className="workflow-inline-message is-error" role="alert">{initError}</div>}
            </div>
          )}
          {!listLoading && !listError && exists && filteredTasks.length === 0 && (
            <div className="workflow-empty-card">
              <div className="workflow-empty-title">
                {listDiagnostics.length > 0 ? t("workflow.noValidTasks") : t("workflow.noTasks")}
              </div>
              {listDiagnostics.length > 0 && (
                <div className="workflow-empty-description">
                  {t("workflow.fixTaskFilesHint")}
                </div>
              )}
              {sessionId && (
                <ActionButton
                  disabled={busy}
                  onClick={() => void handleCreateFromSession()}
                  label={t("workflow.createFromChat")}
                />
              )}
            </div>
          )}
          {filteredTasks.filter((task) => !task.parentTaskId).map((task) => {
            const selected = task.id === selectedId;
            const children = filteredTasks.filter((child) => child.parentTaskId === task.id);
            return (
              <div key={task.id}>
                <TaskListButton task={task} selected={selected} onSelect={() => setSelectedId(task.id)} />
                {children.map((child) => (
                  <TaskListButton key={child.id} task={child} selected={child.id === selectedId} onSelect={() => setSelectedId(child.id)} indent />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="workflow-detail-pane">
        {detailLoading && <div className="inspector-state inspector-state-loading">{t("workflow.loadingDetail")}</div>}
        {detailError && <div className="inspector-state inspector-state-error" role="alert">{detailError}</div>}
        {!detailLoading && !detail && !detailError && <div className="inspector-state inspector-state-empty">{t("workflow.selectTask")}</div>}

        {detail && (
          <>
            <div className="workflow-detail-header">
              <div className="workflow-detail-title-row">
                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className="workflow-input workflow-title-input" />
                <select value={draftPriority} onChange={(e) => setDraftPriority(e.target.value as WorkflowPriority)} className="workflow-input workflow-priority-select">
                  {(["P0", "P1", "P2", "P3"] as WorkflowPriority[]).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <span className={`inspector-badge ${workflowStatusTone(detail.status)}`}>{t(`workflow.status.${detail.status}`)}</span>
                {dirty && <span className="workflow-unsaved">{t("workflow.unsaved")}</span>}
              </div>
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                placeholder={t("workflow.description")}
                className="workflow-input workflow-description"
              />
              <div className="workflow-detail-cwd" title={cwd}>
                {t("workflow.cwd")}: {shortPath(cwd, 64)}
              </div>
              <div className="workflow-detail-actions">
                <ActionButton disabled={busy || detail.archived} onClick={handleCreateChild} label={t("workflow.createChild")} />
                <ActionButton disabled={busy || !detail.allowedActions.save || !dirty} onClick={() => void handleSave()} label={t("workflow.save")} />
                <ActionButton disabled={busy || !detail.allowedActions.markReady} title={detail.allowedActions.reasons.markReady} onClick={() => void handleMarkReady()} label={t("workflow.markReady")} />
                <ActionButton disabled={busy || !sessionId || !detail.allowedActions.runImplement} title={!sessionId ? "Open a chat session to run the native worker" : detail.allowedActions.reasons.runImplement} onClick={() => void handleStartRun("implement")} label={t("workflow.runImplement")} />
                <ActionButton disabled={busy || !sessionId || !detail.allowedActions.runCheck} title={!sessionId ? "Open a chat session to run the native reviewer" : detail.allowedActions.reasons.runCheck} onClick={() => void handleStartRun("check")} label={t("workflow.runCheck")} />
                <ActionButton disabled={busy || !detail.allowedActions.cancelRun} title={detail.allowedActions.reasons.cancelRun} onClick={() => void handleCancelRun()} label={t("workflow.cancelRun")} />
                <ActionButton disabled={busy || !detail.allowedActions.complete} title={detail.allowedActions.reasons.complete} onClick={() => void handleComplete()} label={t("workflow.complete")} />
                <ActionButton disabled={busy || !detail.allowedActions.archive} title={detail.allowedActions.reasons.archive} onClick={() => void handleArchive()} label={t("workflow.archive")} />
              </div>
              {(detail.status === "ready_to_commit" || detail.commit) && (
                <div className="workflow-commit-row">
                  <input
                    value={commitHash}
                    onChange={(e) => setCommitHash(e.target.value)}
                    placeholder={t("workflow.commitHash")}
                    className="workflow-input workflow-commit-input"
                  />
                  <ActionButton
                    disabled={busy || !detail.allowedActions.recordCommit || !commitHash.trim()}
                    title={detail.allowedActions.reasons.recordCommit}
                    onClick={() => void handleRecordCommit()}
                    label={t("workflow.recordCommit")}
                  />
                </div>
              )}
              {actionError && <div className="workflow-inline-message is-error" role="alert">{actionError}</div>}
              {conflictNote && <div className="workflow-inline-message is-warning">{conflictNote}</div>}
            </div>

            <div className="workflow-doc-toolbar">
              {(["requirements", "design", "plan", "runs"] as DocTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDocTab(tab)}
                  className={`workflow-doc-tab${docTab === tab ? " is-active" : ""}`}
                >
                  {t(`workflow.tab.${tab}`)}
                </button>
              ))}
              {docTab !== "runs" && (
                <div className="workflow-doc-actions">
                  <button type="button" onClick={() => setViewMode("edit")} className={`workflow-icon-button${viewMode === "edit" ? " is-active" : ""}`}>
                    {t("workflow.edit")}
                  </button>
                  <button type="button" onClick={() => setViewMode("preview")} className={`workflow-icon-button${viewMode === "preview" ? " is-active" : ""}`}>
                    {t("workflow.preview")}
                  </button>
                  <a
                    href={buildStandaloneFileUrl(
                      joinFilePath(joinFilePath(cwd, detail.pathLabel), `${docTab}.md`),
                      { cwd },
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={dirty}
                    title={dirty ? t("workflow.saveBeforeStandalone") : t("workflow.openStandalone")}
                    onClick={(event) => {
                      if (dirty) event.preventDefault();
                    }}
                    className={`workflow-icon-button workflow-standalone-link${dirty ? " is-disabled" : ""}`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 3h7v7" />
                      <path d="M10 14 21 3" />
                      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                    </svg>
                    {t("workflow.openStandalone")}
                  </a>
                </div>
              )}
            </div>

            <div className="workflow-document-body">
              {docTab === "runs" ? (
                <RunsList runs={detail.runs} />
              ) : viewMode === "edit" ? (
                <textarea
                  value={currentDoc}
                  onChange={(e) => setCurrentDoc(e.target.value)}
                  className="workflow-document-editor"
                />
              ) : (
                <div className="workflow-document-preview">
                  <MarkdownBody>{currentDoc || `_${t("workflow.emptyDoc")}_`}</MarkdownBody>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <div className="workflow-create-overlay" onClick={() => !busy && setShowCreate(false)}>
          <div className="workflow-create-panel" onClick={(e) => e.stopPropagation()}>
            <div className="workflow-create-title">{t("workflow.createTask")}</div>
            {createParentTaskId && <div className="workflow-create-context">{t("workflow.createChildOf", { id: createParentTaskId })}</div>}
            <input
              autoFocus
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder={t("workflow.taskTitle")}
              className="workflow-input"
            />
            <select value={createPriority} onChange={(e) => setCreatePriority(e.target.value as WorkflowPriority)} className="workflow-input">
              {(["P0", "P1", "P2", "P3"] as WorkflowPriority[]).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <div className="workflow-create-actions">
              <button type="button" className="workflow-action-button" disabled={busy} onClick={() => setShowCreate(false)}>{t("common.cancel")}</button>
              <button type="button" className="workflow-action-button is-primary" disabled={busy || !createTitle.trim()} onClick={() => void handleCreate()}>
                {t("workflow.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskListButton({
  task,
  selected,
  onSelect,
  indent = false,
}: {
  task: WorkflowTaskSummary;
  selected: boolean;
  onSelect: () => void;
  indent?: boolean;
}) {
  const t = useT();
  return (
    <button type="button" onClick={onSelect} className={`workflow-task-row${selected ? " is-selected" : ""}${indent ? " is-child" : ""}`}>
      <div className="workflow-task-row-header">
        <span className="workflow-task-title">{indent ? "↳ " : ""}{task.title}</span>
        <span className={`inspector-badge ${workflowStatusTone(task.status)}`}>{t(`workflow.status.${task.status}`)}</span>
      </div>
      <div className="workflow-task-meta">{task.id}{task.childCount > 0 ? ` · ${task.completedChildCount}/${task.childCount}` : ""}</div>
    </button>
  );
}

function RunsList({ runs }: { runs: WorkflowRunRecord[] }) {
  const t = useT();
  const { locale } = useI18n();
  if (runs.length === 0) return <div className="inspector-state inspector-state-empty">{t("workflow.noRuns")}</div>;
  return (
    <div className="workflow-run-list">
      {runs.map((run) => (
        <div key={run.id} className="workflow-run-card">
          <div className="workflow-run-header">
            <div>{run.phase} · {run.agentName} · <span className={`workflow-status-text ${workflowStatusTone(run.state)}`}>{run.state}</span></div>
            <time>{formatTime(run.createdAt, locale)}</time>
          </div>
          <div className="workflow-run-id">{run.id}</div>
          <div className="workflow-run-meta" title={run.effectiveCwd}>cwd: {shortPath(run.effectiveCwd, 72)}</div>
          {run.model && <div className="workflow-run-meta">model: {run.model}</div>}
          {run.summary && <div className="workflow-run-summary">{run.summary}</div>}
          {run.error && <div className="workflow-run-error" role="alert">{run.error.code}: {run.error.message}</div>}
          {run.checkResult && <div className="workflow-run-summary">verdict: <strong>{run.checkResult.verdict}</strong></div>}
          {run.implementResult?.changedFiles?.length ? (
            <div className="workflow-run-files">
              files: {run.implementResult.changedFiles.slice(0, 8).join(", ")}
              {run.implementResult.changedFiles.length > 8 ? "…" : ""}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="workflow-action-button"
    >
      {label}
    </button>
  );
}
