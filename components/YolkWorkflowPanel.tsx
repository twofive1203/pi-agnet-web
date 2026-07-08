"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import type { YolkTaskDetail, YolkTaskDocumentName, YolkTaskSummary, YolkTasksResponse } from "@/lib/yolk-types";

type ArtifactTab = "overview" | YolkTaskDocumentName;

interface TasksResponse extends YolkTasksResponse {
  error?: string;
}

interface DetailResponse {
  task?: YolkTaskDetail;
  error?: string;
}

interface CreateResponse {
  task?: YolkTaskDetail;
  error?: string;
}

interface YolkWorkflowPanelProps {
  cwd: string | null;
  focusedTaskKey?: string | null;
  onJoinTaskChat?: (task: YolkTaskDetail) => void;
}

const STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  in_progress: "执行中",
  review: "检查中",
  completed: "已完成",
};

const DOC_LABELS: Record<YolkTaskDocumentName, string> = {
  "prd.md": "PRD",
  "design.md": "Design",
  "implement.md": "Implement",
  "check.md": "Check",
};

function formatStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function statusColor(status: string): string {
  if (status === "in_progress") return "#60a5fa";
  if (status === "review") return "#a78bfa";
  if (status === "completed") return "#22c55e";
  if (status === "planning") return "#f59e0b";
  return "var(--text-dim)";
}

function formatDateTime(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function YolkWorkflowPanel({ cwd, focusedTaskKey, onJoinTaskChat }: YolkWorkflowPanelProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tasks, setTasks] = useState<YolkTaskSummary[]>([]);
  const [exists, setExists] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [readErrors, setReadErrors] = useState<TasksResponse["errors"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<YolkTaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [artifactTab, setArtifactTab] = useState<ArtifactTab>("overview");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPriority, setNewPriority] = useState("P2");
  const [newAssignee, setNewAssignee] = useState("");
  const [newPrd, setNewPrd] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) {
      setTasks([]);
      setExists(false);
      setEnabled(false);
      setReadErrors([]);
      setSelectedKey(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/yolk/tasks?cwd=${encodeURIComponent(cwd)}`, { signal });
      const data = await res.json() as TasksResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTasks(data.tasks);
      setExists(data.exists);
      setEnabled(data.enabled);
      setReadErrors(data.errors);
      setSelectedKey((current) => {
        if (focusedTaskKey && data.tasks.some((task) => task.key === focusedTaskKey)) return focusedTaskKey;
        return current && data.tasks.some((task) => task.key === current) ? current : data.tasks[0]?.key ?? null;
      });
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setTasks([]);
      setReadErrors([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, focusedTaskKey]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTasks(controller.signal);
    return () => controller.abort();
  }, [loadTasks, refreshKey]);

  useEffect(() => {
    setArtifactTab("overview");
  }, [selectedKey]);

  useEffect(() => {
    if (!focusedTaskKey) return;
    if (tasks.some((task) => task.key === focusedTaskKey)) setSelectedKey(focusedTaskKey);
  }, [focusedTaskKey, tasks]);

  useEffect(() => {
    if (!cwd || !selectedKey || !enabled) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    fetch(`/api/yolk/tasks/${encodeURIComponent(selectedKey)}?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as DetailResponse;
        if (!res.ok || data.error || !data.task) throw new Error(data.error ?? `HTTP ${res.status}`);
        setDetail(data.task);
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [cwd, enabled, selectedKey]);

  const statusOptions = useMemo(() => ["all", ...new Set(tasks.map((task) => task.status))], [tasks]);
  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (!q) return true;
      return [task.title, task.id, task.status, task.priority, task.assignee].filter(Boolean).some((value) => value!.toLowerCase().includes(q));
    });
  }, [query, statusFilter, tasks]);

  const createTask = useCallback(async () => {
    if (!cwd || !newTitle.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/yolk/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, title: newTitle, priority: newPriority, assignee: newAssignee, prd: newPrd }),
      });
      const data = await res.json() as CreateResponse;
      if (!res.ok || data.error || !data.task) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewTitle("");
      setNewPriority("P2");
      setNewAssignee("");
      setNewPrd("");
      setNewTaskOpen(false);
      setSelectedKey(data.task.key);
      setDetail(data.task);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [cwd, newAssignee, newPrd, newPriority, newTitle]);

  if (!cwd) return <EmptyState title="未选择工作区" description="请先在侧边栏选择项目目录，再查看 Yolk Workflow。" />;
  if (error) return <EmptyState title="无法加载 Yolk Workflow" description={error} tone="error" />;
  if (!exists) return <EmptyState title="当前工作区未启用 Yolk Workflow" description="打开 Settings -> Yolk Workflow，为这个工作区启用原生工作流。" />;
  if (!enabled) return <EmptyState title="Yolk Workflow 已禁用" description="打开 Settings -> Yolk Workflow 重新启用。项目文件仍保留在 .yolk/ 和 yolk 前缀 .pi/ 资源中。" />;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", color: "var(--text)", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索任务..."
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, height: 28, padding: "0 9px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}
        />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ height: 28, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 11 }}>
          {statusOptions.map((status) => <option key={status} value={status}>{status === "all" ? "全部" : formatStatus(status)}</option>)}
        </select>
        <button type="button" onClick={() => setNewTaskOpen((open) => !open)} style={{ height: 28, padding: "0 9px", borderRadius: 8, border: "1px solid var(--border)", background: newTaskOpen ? "var(--bg-selected)" : "var(--bg)", color: newTaskOpen ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
          新任务
        </button>
        <button type="button" onClick={() => setRefreshKey((key) => key + 1)} title="刷新 Yolk 任务" style={{ height: 28, padding: "0 9px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
          ↻
        </button>
      </div>

      {newTaskOpen && (
        <div style={{ padding: 10, borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="任务标题" style={inputStyle()} />
          <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8 }}>
            <select value={newPriority} onChange={(event) => setNewPriority(event.target.value)} style={inputStyle()}>
              {['P0', 'P1', 'P2', 'P3'].map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
            <input value={newAssignee} onChange={(event) => setNewAssignee(event.target.value)} placeholder="负责人（可选）" style={inputStyle()} />
          </div>
          <textarea value={newPrd} onChange={(event) => setNewPrd(event.target.value)} rows={4} placeholder="PRD 初稿（可选）" style={{ ...inputStyle(), resize: "vertical", lineHeight: 1.45 }} />
          {createError && <div style={{ color: "#f87171", fontSize: 11 }}>{createError}</div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setNewTaskOpen(false)} style={secondaryButtonStyle()}>取消</button>
            <button type="button" onClick={() => void createTask()} disabled={!newTitle.trim() || creating} style={primaryButtonStyle(!newTitle.trim() || creating)}>{creating ? "创建中…" : "创建任务"}</button>
          </div>
        </div>
      )}

      {loading && tasks.length === 0 ? (
        <EmptyState title="正在加载任务…" description="正在读取当前工作区的 .yolk/tasks。" />
      ) : tasks.length === 0 ? (
        <EmptyState title="还没有 Yolk 任务" description="点击“新任务”创建 task.json 和 prd.md。" />
      ) : (
        <div className="trellis-panel-body">
          <div className="trellis-task-list-pane">
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", justifyContent: "space-between" }}>
              <span>任务 ({filteredTasks.length})</span>
              {loading && <span>加载中…</span>}
            </div>
            <div style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
              {filteredTasks.map((task) => <TaskRow key={task.key} task={task} selected={task.key === selectedKey} onClick={() => setSelectedKey(task.key)} />)}
              {filteredTasks.length === 0 && <div style={{ padding: 14, color: "var(--text-muted)", fontStyle: "italic" }}>没有任务匹配当前筛选条件。</div>}
            </div>
            {readErrors.length > 0 && <div style={{ borderTop: "1px solid var(--border)", padding: 8, color: "#f87171", fontSize: 10, lineHeight: 1.45 }}>有 {readErrors.length} 个任务读取问题。</div>}
          </div>
          <div className="trellis-task-detail-pane">
            {detailLoading && !detail ? (
              <EmptyState title="正在加载任务详情…" description="正在读取 task.json 和 markdown artifacts。" />
            ) : detailError ? (
              <EmptyState title="无法加载任务详情" description={detailError} tone="error" />
            ) : detail ? (
              <TaskDetail task={detail} artifactTab={artifactTab} onArtifactTabChange={setArtifactTab} onJoinTaskChat={onJoinTaskChat} />
            ) : (
              <EmptyState title="请选择任务" description="从左侧任务列表选择一个任务查看详情。" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function inputStyle(): React.CSSProperties {
  return { padding: "7px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", fontSize: 12, outline: "none", width: "100%", boxSizing: "border-box" };
}

function secondaryButtonStyle(): React.CSSProperties {
  return { padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 };
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return { padding: "7px 10px", borderRadius: 7, border: "none", background: disabled ? "var(--border)" : "var(--accent)", color: "white", cursor: disabled ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 };
}

function EmptyState({ title, description, tone = "muted" }: { title: string; description: string; tone?: "muted" | "error" }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", color: tone === "error" ? "#f87171" : "var(--text-muted)", gap: 8 }}>
      <div style={{ color: tone === "error" ? "#f87171" : "var(--text)", fontSize: 15, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 320 }}>{description}</div>
    </div>
  );
}

function Badge({ label, tone = "default" }: { label: string; tone?: "default" | "accent" | "muted" | "error" }) {
  const color = tone === "accent" ? "var(--accent)" : tone === "error" ? "#f87171" : tone === "muted" ? "var(--text-muted)" : "var(--text)";
  const bg = tone === "accent" ? "rgba(37,99,235,0.13)" : tone === "error" ? "rgba(239,68,68,0.13)" : "var(--bg-subtle)";
  return <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px", borderRadius: 999, border: "1px solid var(--border)", background: bg, color, fontSize: 10, lineHeight: 1.2, whiteSpace: "nowrap" }}>{label}</span>;
}

function TaskRow({ task, selected, onClick }: { task: YolkTaskSummary; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{ width: "100%", display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: "none", borderBottom: "1px solid var(--border)", background: selected ? "var(--bg-selected)" : "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", minWidth: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor(task.status), marginTop: 5, flexShrink: 0 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
          {task.readError && <Badge label="读取错误" tone="error" />}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.id}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", color: "var(--text-muted)", fontSize: 10 }}>
          <span>{formatStatus(task.status)}</span>
          {task.priority && <span>· {task.priority}</span>}
          {task.assignee && <span>· {task.assignee}</span>}
        </span>
      </span>
    </button>
  );
}

function ArtifactButton({ label, active, disabled, onClick }: { label: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} style={{ padding: "6px 9px", borderRadius: 8, border: "1px solid var(--border)", background: active ? "var(--bg-selected)" : "var(--bg)", color: disabled ? "var(--text-dim)" : active ? "var(--accent)" : "var(--text-muted)", cursor: disabled ? "not-allowed" : "pointer", fontSize: 11, fontWeight: active ? 700 : 500 }}>
      {label}
    </button>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, padding: "3px 0", color: "var(--text-muted)", fontSize: 12 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function TaskDetail({ task, artifactTab, onArtifactTabChange, onJoinTaskChat }: { task: YolkTaskDetail; artifactTab: ArtifactTab; onArtifactTabChange: (tab: ArtifactTab) => void; onJoinTaskChat?: (task: YolkTaskDetail) => void }) {
  const activeDocument = artifactTab === "overview" ? undefined : task.documents[artifactTab];
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, color: "var(--text)", fontSize: 17, lineHeight: 1.25 }}>{task.title}</h3>
          <div style={{ marginTop: 5, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{task.pathLabel}</div>
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Badge label={formatStatus(task.status)} tone="accent" />
          {task.priority && <Badge label={task.priority} />}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" onClick={() => onJoinTaskChat?.(task)} disabled={!onJoinTaskChat || !!task.readError} title="将这个 Yolk 任务作为上下文块加入 Chat 输入框" style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-selected)", color: "var(--accent)", cursor: !onJoinTaskChat || task.readError ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 700 }}>
          加入会话
        </button>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-subtle)", padding: 12 }}>
        <MetaLine label="任务 ID" value={task.id} />
        <MetaLine label="负责人" value={task.assignee ?? "-"} />
        <MetaLine label="创建时间" value={formatDateTime(task.createdAt)} />
        <MetaLine label="更新时间" value={formatDateTime(task.updatedAt)} />
        {task.notes && <MetaLine label="备注" value={task.notes} />}
      </div>
      <div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <ArtifactButton label="概览" active={artifactTab === "overview"} onClick={() => onArtifactTabChange("overview")} />
          {(Object.keys(DOC_LABELS) as YolkTaskDocumentName[]).map((fileName) => (
            <ArtifactButton key={fileName} label={DOC_LABELS[fileName]} active={artifactTab === fileName} disabled={!task.documents[fileName]} onClick={() => onArtifactTabChange(fileName)} />
          ))}
        </div>
        {artifactTab === "overview" ? (
          <div style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
            任务文档位于 <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{task.pathLabel}</code>。使用上方 tabs 查看已存在的 markdown artifacts。
          </div>
        ) : activeDocument ? (
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)", padding: 12 }}>
            {activeDocument.truncated && <div style={{ marginBottom: 8, color: "#f59e0b", fontSize: 11 }}>文档预览已在 256 KB 处截断。</div>}
            <MarkdownBody>{activeDocument.content}</MarkdownBody>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>这个任务文档不存在。</div>
        )}
      </div>
    </div>
  );
}
