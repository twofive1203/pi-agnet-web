"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useT } from "./I18nProvider";
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
  error?: string;
  code?: string;
}

const STATUS_COLORS: Record<string, string> = {
  planning: "#f59e0b",
  ready: "#38bdf8",
  implementing: "#60a5fa",
  review_ready: "#a78bfa",
  checking: "#c084fc",
  changes_requested: "#fb7185",
  ready_to_commit: "#34d399",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#94a3b8",
};

function shortPath(value: string, max = 48): string {
  return value.length > max ? `…${value.slice(-(max - 1))}` : value;
}

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
        `/api/workflows/tasks?cwd=${encodeURIComponent(cwd)}&includeArchived=${includeArchived ? "true" : "false"}`,
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
  }, [cwd, includeArchived]);

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

  // Per-project SnFlow enablement: create the .pi/snflows store for this cwd.
  const handleInitialize = useCallback(async () => {
    if (!cwd || initializing) return;
    setInitializing(true);
    setInitError(null);
    try {
      const res = await fetch("/api/workflows/setup/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const body = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) throw new Error(body.error ?? `HTTP ${res.status}`);
      await loadTasks();
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
    } finally {
      setInitializing(false);
    }
  }, [cwd, initializing, loadTasks]);

  useEffect(() => {
    setIncludeArchived(includeArchivedDefault);
  }, [includeArchivedDefault]);

  useEffect(() => {
    if (!focusedTaskId) return;
    if (tasks.some((task) => task.id === focusedTaskId)) setSelectedId(focusedTaskId);
  }, [focusedTaskId, tasks]);

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
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (!q) return true;
      return [task.title, task.id, task.description, task.status, task.priority]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [tasks, query, statusFilter]);

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
          sessionId: sessionId || undefined,
        }),
      });
      const body = (await res.json()) as DetailResponse;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setShowCreate(false);
      setCreateTitle("");
      await loadTasks();
      if (body.task) {
        setSelectedId(body.task.id);
        applyDetail(body.task);
        onTaskCreated?.(body.task);
      }
    });
  }

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
    await runAction(async () => {
      const res = await fetch(
        `/api/workflows/tasks/${encodeURIComponent(detail.id)}/runs?cwd=${encodeURIComponent(cwd)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase, expectedRevision: detail.revision }),
        },
      );
      const body = (await res.json()) as DetailResponse & { run?: WorkflowRunRecord };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.task) applyDetail(body.task);
      setDocTab("runs");
      await loadTasks();
    });
  }

  async function handleCancelRun() {
    if (!cwd || !detail?.activeRunId) return;
    await runAction(async () => {
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
      <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
        <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{t("workflow.noWorkspace")}</div>
        {t("workflow.selectProjectHint")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <div
        style={{
          width: 260,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("workflow.searchTasks")}
              style={inputStyle}
            />
            <button type="button" onClick={() => void loadTasks()} style={btnStyle} title={t("workflow.refresh")}>
              ↻
            </button>
            {sessionId && (
              <button
                type="button"
                onClick={() => void handleCreateFromSession()}
                style={{ ...btnStyle, color: "var(--accent)" }}
                title={t("workflow.createFromChat")}
                disabled={busy}
              >
                ✦
              </button>
            )}
            <button type="button" onClick={() => setShowCreate(true)} style={{ ...btnStyle, color: "var(--accent)" }} title={t("workflow.createTask")}>
              +
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
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
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
            <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
            {t("workflow.includeArchived")}
          </label>
          {currentTaskId && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {t("workflow.currentTask")}: {shortPath(currentTaskId, 28)}
            </div>
          )}
          {activeCwdRunId && (
            <div style={{ fontSize: 11, color: "#f59e0b" }}>
              {t("workflow.activeCwdRun")}: {shortPath(activeCwdRunId, 28)}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {listLoading && <div style={emptyStyle}>{t("workflow.loadingTasks")}</div>}
          {listError && <div style={{ ...emptyStyle, color: "#f87171" }}>{listError}</div>}
          {!listLoading && resolvedCwd && (
            <div style={{ padding: "6px 12px", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", borderBottom: "1px solid var(--border)" }} title={resolvedCwd}>
              cwd: {shortPath(resolvedCwd, 42)}
            </div>
          )}
          {!listLoading && listDiagnostics.length > 0 && (
            <div style={{ padding: 10, borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.08)" }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#f87171", marginBottom: 6 }}>
                {t("workflow.listDiagnostics", { count: listDiagnostics.length })}
              </div>
              {listDiagnostics.slice(0, 5).map((item, index) => (
                <div key={`${item.id ?? "err"}-${index}`} style={{ fontSize: 10, color: "#fca5a5", marginBottom: 4, lineHeight: 1.4 }}>
                  <div style={{ fontFamily: "var(--font-mono)" }}>{item.id || item.pathLabel || "?"}</div>
                  <div>{item.message}</div>
                </div>
              ))}
              {listDiagnostics.length > 5 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>+{listDiagnostics.length - 5} more</div>
              )}
            </div>
          )}
          {!listLoading && !listError && !exists && (
            <div style={emptyStyle}>
              <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                {t("workflow.notInitializedTitle")}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 10 }}>
                {t("workflow.notInitializedHint")}
              </div>
              <button
                type="button"
                disabled={initializing}
                onClick={() => void handleInitialize()}
                style={{
                  border: "1px solid var(--accent)",
                  borderRadius: 8,
                  padding: "6px 12px",
                  background: "rgba(37,99,235,0.10)",
                  color: "var(--accent)",
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: initializing ? "not-allowed" : "pointer",
                  opacity: initializing ? 0.6 : 1,
                }}
              >
                {initializing ? t("workflow.initializing") : t("workflow.initialize")}
              </button>
              {initError && (
                <div style={{ marginTop: 8, fontSize: 11, color: "#f87171" }}>{initError}</div>
              )}
            </div>
          )}
          {!listLoading && !listError && exists && filteredTasks.length === 0 && (
            <div style={emptyStyle}>
              <div style={{ marginBottom: 10 }}>
                {listDiagnostics.length > 0 ? t("workflow.noValidTasks") : t("workflow.noTasks")}
              </div>
              {listDiagnostics.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.45 }}>
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
          {filteredTasks.map((task) => {
            const selected = task.id === selectedId;
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => setSelectedId(task.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  background: selected ? "var(--bg-selected)" : "transparent",
                  padding: "10px 12px",
                  cursor: "pointer",
                  color: "var(--text)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {task.title}
                  </span>
                  <span style={{ fontSize: 10, color: STATUS_COLORS[task.status] ?? "var(--text-dim)", flexShrink: 0 }}>
                    {t(`workflow.status.${task.status}`)}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{task.id}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {detailLoading && <div style={emptyStyle}>{t("workflow.loadingDetail")}</div>}
        {detailError && <div style={{ ...emptyStyle, color: "#f87171" }}>{detailError}</div>}
        {!detailLoading && !detail && !detailError && <div style={emptyStyle}>{t("workflow.selectTask")}</div>}

        {detail && (
          <>
            <div style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} style={{ ...inputStyle, fontWeight: 700, flex: 1, minWidth: 160 }} />
                <select value={draftPriority} onChange={(e) => setDraftPriority(e.target.value as WorkflowPriority)} style={inputStyle}>
                  {(["P0", "P1", "P2", "P3"] as WorkflowPriority[]).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <span style={{ fontSize: 11, color: STATUS_COLORS[detail.status] ?? "var(--text-dim)", fontWeight: 700 }}>
                  {t(`workflow.status.${detail.status}`)}
                </span>
                {dirty && <span style={{ fontSize: 11, color: "#f59e0b" }}>{t("workflow.unsaved")}</span>}
              </div>
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                placeholder={t("workflow.description")}
                style={{ ...inputStyle, resize: "vertical", minHeight: 48 }}
              />
              <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }} title={cwd}>
                {t("workflow.cwd")}: {shortPath(cwd, 64)}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <ActionButton disabled={busy || !detail.allowedActions.save || !dirty} onClick={() => void handleSave()} label={t("workflow.save")} />
                <ActionButton disabled={busy || !detail.allowedActions.markReady} title={detail.allowedActions.reasons.markReady} onClick={() => void handleMarkReady()} label={t("workflow.markReady")} />
                <ActionButton disabled={busy || !detail.allowedActions.runImplement} title={detail.allowedActions.reasons.runImplement} onClick={() => void handleStartRun("implement")} label={t("workflow.runImplement")} />
                <ActionButton disabled={busy || !detail.allowedActions.runCheck} title={detail.allowedActions.reasons.runCheck} onClick={() => void handleStartRun("check")} label={t("workflow.runCheck")} />
                <ActionButton disabled={busy || !detail.allowedActions.cancelRun} title={detail.allowedActions.reasons.cancelRun} onClick={() => void handleCancelRun()} label={t("workflow.cancelRun")} />
                <ActionButton disabled={busy || !detail.allowedActions.complete} title={detail.allowedActions.reasons.complete} onClick={() => void handleComplete()} label={t("workflow.complete")} />
                <ActionButton disabled={busy || !detail.allowedActions.archive} title={detail.allowedActions.reasons.archive} onClick={() => void handleArchive()} label={t("workflow.archive")} />
              </div>
              {(detail.status === "ready_to_commit" || detail.commit) && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    value={commitHash}
                    onChange={(e) => setCommitHash(e.target.value)}
                    placeholder={t("workflow.commitHash")}
                    style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)" }}
                  />
                  <ActionButton
                    disabled={busy || !detail.allowedActions.recordCommit || !commitHash.trim()}
                    title={detail.allowedActions.reasons.recordCommit}
                    onClick={() => void handleRecordCommit()}
                    label={t("workflow.recordCommit")}
                  />
                </div>
              )}
              {actionError && <div style={{ color: "#f87171", fontSize: 12 }}>{actionError}</div>}
              {conflictNote && <div style={{ color: "#f59e0b", fontSize: 12 }}>{conflictNote}</div>}
            </div>

            <div style={{ display: "flex", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
              {(["requirements", "design", "plan", "runs"] as DocTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDocTab(tab)}
                  style={{
                    ...btnStyle,
                    color: docTab === tab ? "var(--accent)" : "var(--text-muted)",
                    borderBottom: docTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                    borderRadius: 0,
                  }}
                >
                  {t(`workflow.tab.${tab}`)}
                </button>
              ))}
              {docTab !== "runs" && (
                <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                  <button type="button" onClick={() => setViewMode("edit")} style={{ ...btnStyle, color: viewMode === "edit" ? "var(--accent)" : "var(--text-muted)" }}>
                    {t("workflow.edit")}
                  </button>
                  <button type="button" onClick={() => setViewMode("preview")} style={{ ...btnStyle, color: viewMode === "preview" ? "var(--accent)" : "var(--text-muted)" }}>
                    {t("workflow.preview")}
                  </button>
                </div>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
              {docTab === "runs" ? (
                <RunsList runs={detail.runs} />
              ) : viewMode === "edit" ? (
                <textarea
                  value={currentDoc}
                  onChange={(e) => setCurrentDoc(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: "100%",
                    height: "100%",
                    resize: "vertical",
                    background: "var(--bg-subtle)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: 12,
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                />
              ) : (
                <div style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                  <MarkdownBody>{currentDoc || `_${t("workflow.emptyDoc")}_`}</MarkdownBody>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showCreate && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 80,
          }}
          onClick={() => !busy && setShowCreate(false)}
        >
          <div
            style={{
              width: 420,
              maxWidth: "92vw",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 800, color: "var(--text)" }}>{t("workflow.createTask")}</div>
            <input
              autoFocus
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder={t("workflow.taskTitle")}
              style={inputStyle}
            />
            <select value={createPriority} onChange={(e) => setCreatePriority(e.target.value as WorkflowPriority)} style={inputStyle}>
              {(["P0", "P1", "P2", "P3"] as WorkflowPriority[]).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" style={btnStyle} disabled={busy} onClick={() => setShowCreate(false)}>{t("common.cancel")}</button>
              <button type="button" style={{ ...btnStyle, color: "var(--accent)" }} disabled={busy || !createTitle.trim()} onClick={() => void handleCreate()}>
                {t("workflow.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunsList({ runs }: { runs: WorkflowRunRecord[] }) {
  const t = useT();
  if (runs.length === 0) {
    return <div style={emptyStyle}>{t("workflow.noRuns")}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {runs.map((run) => (
        <div key={run.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--bg-subtle)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 12 }}>
              {run.phase} · {run.agentName} · <span style={{ color: STATUS_COLORS[run.state] ?? "var(--text-dim)" }}>{run.state}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{formatTime(run.createdAt)}</div>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>{run.id}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }} title={run.effectiveCwd}>
            cwd: {shortPath(run.effectiveCwd, 72)}
          </div>
          {run.model && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>model: {run.model}</div>}
          {run.summary && <div style={{ fontSize: 12, color: "var(--text)", marginTop: 6, whiteSpace: "pre-wrap" }}>{run.summary}</div>}
          {run.error && (
            <div style={{ fontSize: 12, color: "#f87171", marginTop: 6 }}>
              {run.error.code}: {run.error.message}
            </div>
          )}
          {run.checkResult && (
            <div style={{ fontSize: 12, marginTop: 6 }}>
              verdict: <strong>{run.checkResult.verdict}</strong>
            </div>
          )}
          {run.implementResult?.changedFiles?.length ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
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
      style={{
        ...btnStyle,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "4px 8px",
        background: "var(--bg)",
      }}
    >
      {label}
    </button>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "6px 8px",
  fontSize: 12,
};

const btnStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  padding: "4px 6px",
};

const emptyStyle: CSSProperties = {
  padding: 16,
  color: "var(--text-muted)",
  fontSize: 13,
  lineHeight: 1.5,
};
