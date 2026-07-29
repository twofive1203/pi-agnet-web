"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addPersistedInboxReadId,
  buildInboxFromRuns,
  initialAutomationView,
  isSchedulerDegraded,
  loadPersistedInboxReadIds,
  markInboxRead,
  openEditor,
  openRun,
  openTask,
  unreadInboxCount,
  type AutomationView,
  type InboxItem,
} from "@/lib/automation-ui-state";

type Task = Record<string, unknown> & {
  id: string;
  revision: string;
  name: string;
  status: string;
  nextRunAt?: string | null;
  nextPreview?: Array<{ utc: string; localWallTime: string; offsetMinutes: number }>;
  authoritySummary?: string[];
  authoritySummaryStructured?: Record<string, unknown>;
  consecutiveFailures?: number;
  approvedConfig?: Record<string, unknown>;
  pendingConfig?: Record<string, unknown> | null;
};
type Run = Record<string, unknown> & {
  id: string;
  taskId: string;
  status: string;
  summary?: string | null;
  completedAt?: string | null;
  createdAt: string;
  cwd?: string;
  promoteEligible?: boolean;
  usage?: { totalTokens?: number; costUsd?: number | null } | null;
  session?: { availability?: string; sealed?: boolean };
};

type ApprovalChallenge = {
  challengeId: string;
  summary: string[];
  /** Structured authority fields for locale-aware AppDialog formatting. */
  summaryStructured?: Record<string, unknown> | null;
  expiresAt: number;
  requiresConfirmation?: boolean;
  secret?: string;
};

export type ConfirmDialogFn = (input: {
  title: string;
  message: string;
}) => Promise<boolean>;

/** Format server approval payload into a locale-aware confirmation message. */
export type FormatApprovalSummaryFn = (challenge: {
  summary?: string[];
  summaryStructured?: Record<string, unknown> | null;
  action?: string;
}) => string;

async function ensureControlSession(): Promise<void> {
  await fetch("/api/automations/session", { method: "POST", credentials: "same-origin" });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) {
    throw Object.assign(new Error((data as { error?: string }).error || res.statusText), {
      status: res.status,
      code: (data as { code?: string }).code,
      data,
    });
  }
  return data;
}

/**
 * Create challenge → show locale-formatted authority summary in AppDialog → confirm → receive secret.
 * Never auto-consumes a returned proof without a real UI confirmation.
 * Never displays raw English server summary/action/status/cwd-source enums when a formatter is provided.
 */
async function requestConfirmedApproval(
  body: Record<string, unknown>,
  confirm: ConfirmDialogFn,
  title: string,
  formatSummary?: FormatApprovalSummaryFn,
): Promise<{ challengeId: string; secret: string; summary: string[] }> {
  await ensureControlSession();
  const challenge = await api<ApprovalChallenge>("/api/automations/approvals", {
    method: "POST",
    body: JSON.stringify(body),
  });

  // Prefer structured locale formatting; English summary is audit/binding only.
  const summaryText = formatSummary
    ? formatSummary({
        summary: challenge.summary,
        summaryStructured: challenge.summaryStructured,
        action: String(body.action ?? ""),
      })
    : (challenge.summary ?? []).join("\n");
  const ok = await confirm({
    title,
    message: summaryText || String(body.action ?? ""),
  });
  if (!ok) {
    throw Object.assign(new Error("User cancelled approval"), {
      status: 403,
      code: "approval_required",
    });
  }

  if (challenge.secret) {
    return {
      challengeId: challenge.challengeId,
      secret: challenge.secret,
      summary: challenge.summary ?? [],
    };
  }

  const confirmed = await api<{
    challengeId: string;
    secret: string;
    summary: string[];
    summaryStructured?: Record<string, unknown> | null;
  }>("/api/automations/approvals/confirm", {
    method: "POST",
    body: JSON.stringify({ challengeId: challenge.challengeId }),
  });
  return {
    challengeId: confirmed.challengeId,
    secret: confirmed.secret,
    summary: confirmed.summary ?? challenge.summary ?? [],
  };
}

export function useAutomations(options?: {
  enabled?: boolean;
  /** Poll even when drawer closed for badge */
  pollWhenHidden?: boolean;
  /**
   * Required for sensitive mutations. Injected from AutomationPanel via useAppDialog().
   * Without it, sensitive actions fail closed (no auto-consume).
   */
  confirmDialog?: ConfirmDialogFn;
  /**
   * Locale-aware formatter for approval AppDialog bodies. Required for real UI so
   * confirmations never show English server summary / raw enums.
   */
  formatApprovalSummary?: FormatApprovalSummaryFn;
  /** Called after successful promote so AppShell can open the normal session. */
  onPromotedSession?: (session: { id: string; cwd: string; path: string }) => void;
}) {
  const enabled = options?.enabled !== false || options?.pollWhenHidden === true;
  const confirmDialog = options?.confirmDialog;
  const formatApprovalSummary = options?.formatApprovalSummary;
  const [view, setView] = useState<AutomationView>(initialAutomationView);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [scheduler, setScheduler] = useState<Record<string, unknown> | null>(null);
  const [catalog, setCatalog] = useState<unknown[]>([]);
  const [models, setModels] = useState<Array<{ provider: string; id: string; name?: string }>>([]);
  const [editorPreview, setEditorPreview] = useState<
    Array<{ utc: string; localWallTime: string; offsetMinutes: number }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [inboxOffset, setInboxOffset] = useState(0);
  const [inboxLimit] = useState(20);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [selectedRunTranscript, setSelectedRunTranscript] = useState<unknown>(null);
  const [selectedRunChanges, setSelectedRunChanges] = useState<unknown>(null);
  const [runsOffset, setRunsOffset] = useState(0);
  const [runsLimit] = useState(50);
  const [runsTotal, setRunsTotal] = useState(0);
  /** Independent task-scoped run pagination (must not share global offset/total). */
  const [taskRunsOffset, setTaskRunsOffset] = useState(0);
  const [taskRunsTotal, setTaskRunsTotal] = useState(0);
  const [taskRunsTaskId, setTaskRunsTaskId] = useState<string | null>(null);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const [transcriptLimit] = useState(100);
  const [transcriptTotal, setTranscriptTotal] = useState(0);
  const [lastPromotion, setLastPromotion] = useState<{
    runId: string;
    destinationSessionId: string | null;
    destinationSessionFile: string | null;
    destinationCwd: string | null;
  } | null>(null);

  const requireConfirm = useCallback((): ConfirmDialogFn => {
    if (!confirmDialog) {
      return async () => {
        throw Object.assign(new Error("AppDialog confirmation required for Automation approvals"), {
          code: "approval_required",
          status: 403,
        });
      };
    }
    return confirmDialog;
  }, [confirmDialog]);

  const confirmedApproval = useCallback(
    (body: Record<string, unknown>, title: string) =>
      requestConfirmedApproval(body, requireConfirm(), title, formatApprovalSummary),
    [requireConfirm, formatApprovalSummary],
  );

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      await ensureControlSession();
      // Global runs page is independent of task-scoped pagination state.
      // Inbox uses a dedicated summary API (runs + missed-DST omissions), not the 200-run page alone.
      const [tasksRes, runsRes, inboxRes, schedRes, catRes] = await Promise.all([
        api<{ tasks: Task[] }>("/api/automations/tasks"),
        api<{ runs: Run[]; total?: number; offset?: number; limit?: number }>(
          `/api/automations/runs?offset=${runsOffset}&limit=${runsLimit}`,
        ),
        api<{
          items?: unknown[];
          total?: number;
          offset?: number;
          limit?: number;
          runs: Run[];
          runsTotal?: number;
          runsOffset?: number;
          runsLimit?: number;
          omissions?: Array<{
            id: string;
            taskId: string;
            kind: string;
            reason?: string;
            count?: number;
            firstLocal?: string;
            lastLocal?: string;
            createdAt?: string;
          }>;
          omissionsTotal?: number;
        }>(`/api/automations/inbox?limit=${inboxLimit}&offset=${inboxOffset}`),
        api<{ scheduler: Record<string, unknown> }>("/api/automations/scheduler/status"),
        api<{ tools: unknown[] }>("/api/automations/catalog"),
      ]);
      setTasks(tasksRes.tasks ?? []);
      const pageRuns = runsRes.runs ?? [];
      setRunsTotal(typeof runsRes.total === "number" ? runsRes.total : pageRuns.length);
      // Do NOT clobber task-scoped run pages on global refresh — only replace global list.
      setRuns((prev) => {
        if (taskRunsTaskId) {
          const taskScoped = prev.filter((r) => r.taskId === taskRunsTaskId);
          const globalOthers = pageRuns.filter((r) => r.taskId !== taskRunsTaskId);
          // Keep task-scoped rows; merge other tasks from global page.
          const byId = new Map<string, Run>();
          for (const r of [...taskScoped, ...globalOthers]) byId.set(r.id, r);
          return [...byId.values()];
        }
        return pageRuns;
      });
      setScheduler(schedRes.scheduler ?? null);
      setCatalog(catRes.tools ?? []);
      const persistedRead = loadPersistedInboxReadIds();
      const inboxSource = inboxRes.runs ?? pageRuns;
      const omissions = inboxRes.omissions ?? [];
      const mergedTotal =
        typeof inboxRes.total === "number"
          ? inboxRes.total
          : (typeof inboxRes.runsTotal === "number" ? inboxRes.runsTotal : inboxSource.length);
      setInboxTotal(mergedTotal);
      setInbox((prev) => {
        const sessionRead = new Set(prev.filter((i) => i.read).map((i) => i.id));
        const readIds = new Set([...persistedRead, ...sessionRead]);
        return buildInboxFromRuns(inboxSource, readIds, omissions);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, runsOffset, runsLimit, taskRunsTaskId, inboxOffset, inboxLimit]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const createDraft = useCallback(
    async (input: Record<string, unknown>) => {
      await ensureControlSession();
      const res = await api<{ task: Task }>("/api/automations/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      });
      await refresh();
      return res.task;
    },
    [refresh],
  );

  const updateTask = useCallback(
    async (taskId: string, expectedRevision: string, patch: Record<string, unknown>) => {
      const proof = await confirmedApproval(
        {
          action: "update_sensitive",
          taskId,
          revision: expectedRevision,
          proposedConfig: patch,
        }, "automation.confirmUpdate",);
      const res = await api<{ task: Task }>(`/api/automations/tasks/${taskId}`, {
        method: "PUT",
        body: JSON.stringify({
          ...patch,
          expectedRevision,
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res.task;
    },
    [refresh, confirmedApproval],
  );

  const activate = useCallback(
    async (taskId: string, expectedRevision: string, status?: string) => {
      const action = status === "paused" || status === "blocked" ? "resume" : "activate";
      const proof = await confirmedApproval(
        { action, taskId, revision: expectedRevision }, action === "resume" ? "automation.confirmResume" : "automation.confirmActivate",);
      const res = await api<{ task: Task }>(`/api/automations/tasks/${taskId}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action: action === "resume" ? "activate" : "activate",
          expectedRevision,
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res.task;
    },
    [refresh, confirmedApproval],
  );

  const pause = useCallback(
    async (taskId: string, expectedRevision: string) => {
      await ensureControlSession();
      const res = await api<{ task: Task }>(`/api/automations/tasks/${taskId}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: "pause", expectedRevision }),
      });
      await refresh();
      return res.task;
    },
    [refresh],
  );

  const archive = useCallback(
    async (taskId: string, expectedRevision: string) => {
      const proof = await confirmedApproval(
        { action: "archive", taskId, revision: expectedRevision }, "automation.confirmArchive",);
      const res = await api<{ task: Task }>(`/api/automations/tasks/${taskId}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action: "archive",
          expectedRevision,
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res.task;
    },
    [refresh, confirmedApproval],
  );

  const runNow = useCallback(
    async (taskId: string, expectedRevision: string) => {
      const proof = await confirmedApproval(
        { action: "run_now", taskId, revision: expectedRevision }, "automation.confirmRunNow",);
      const res = await api<{ run: Run }>(`/api/automations/tasks/${taskId}/runs`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision,
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res.run;
    },
    [refresh, confirmedApproval],
  );

  const loadRunSession = useCallback(async (runId: string, offset = 0, limit = transcriptLimit) => {
    await ensureControlSession();
    const data = await api<{
      entries?: unknown[];
      total?: number;
      session?: unknown;
      changes?: unknown;
    }>(`/api/automations/runs/${runId}/session?offset=${offset}&limit=${limit}`);
    setSelectedRunTranscript(data);
    // Previous page math must use the request limit, not the short final-page length.
    setTranscriptOffset(offset);
    setTranscriptTotal(typeof data.total === "number" ? data.total : data.entries?.length ?? 0);
    if (data.changes != null) {
      setSelectedRunChanges(data.changes);
    }
    return data;
  }, [transcriptLimit]);

  const loadRunChanges = useCallback(async (runId: string) => {
    await ensureControlSession();
    const data = await api<unknown>(`/api/automations/runs/${runId}/changes`);
    setSelectedRunChanges(data);
    return data;
  }, []);

  const loadRunsPage = useCallback(
    async (taskId: string, offset: number) => {
      await ensureControlSession();
      // Task-scoped pagination is independent of the global runs offset/total.
      setTaskRunsTaskId(taskId);
      setTaskRunsOffset(offset);
      const data = await api<{ runs: Run[]; total?: number }>(
        `/api/automations/tasks/${encodeURIComponent(taskId)}/runs?offset=${offset}&limit=${runsLimit}`,
      );
      // Merge task-scoped page into runs list for that task without clobbering global total.
      setRuns((prev) => {
        const others = prev.filter((r) => r.taskId !== taskId);
        return [...others, ...(data.runs ?? [])];
      });
      setTaskRunsTotal(typeof data.total === "number" ? data.total : data.runs?.length ?? 0);
      return data;
    },
    [runsLimit],
  );

  const loadGlobalRunsPage = useCallback(
    async (offset: number) => {
      await ensureControlSession();
      setRunsOffset(offset);
      const data = await api<{ runs: Run[]; total?: number }>(
        `/api/automations/runs?offset=${offset}&limit=${runsLimit}`,
      );
      setRuns(data.runs ?? []);
      setRunsTotal(typeof data.total === "number" ? data.total : data.runs?.length ?? 0);
      return data;
    },
    [runsLimit],
  );

  /** Inbox/list deep link: fetch/insert the specific run record, then select + load details. */
  const openRunWithDetails = useCallback(
    async (taskId: string, runId: string) => {
      await ensureControlSession();
      // Always fetch the specific run so inbox entries outside the loaded page still resolve.
      try {
        const data = await api<{ run: Run }>(`/api/automations/runs/${encodeURIComponent(runId)}`);
        if (data.run) {
          setRuns((prev) => {
            const others = prev.filter((r) => r.id !== runId);
            return [...others, data.run];
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setView(openRun(taskId, runId));
      setTranscriptOffset(0);
      await Promise.all([loadRunSession(runId, 0), loadRunChanges(runId)]);
    },
    [loadRunSession, loadRunChanges],
  );

  const loadInboxPage = useCallback(
    async (offset: number) => {
      setInboxOffset(Math.max(0, offset));
      // refresh() depends on inboxOffset and will reload; set state then fetch immediately.
      await ensureControlSession();
      const data = await api<{
        items?: unknown[];
        total?: number;
        runs: Run[];
        runsTotal?: number;
        omissions?: Array<{
          id: string;
          taskId: string;
          kind: string;
          reason?: string;
          count?: number;
          firstLocal?: string;
          lastLocal?: string;
          createdAt?: string;
        }>;
        omissionsTotal?: number;
      }>(
        `/api/automations/inbox?limit=${inboxLimit}&offset=${Math.max(0, offset)}`,
      );
      const persistedRead = loadPersistedInboxReadIds();
      const mergedTotal =
        typeof data.total === "number"
          ? data.total
          : typeof data.runsTotal === "number"
            ? data.runsTotal
            : data.runs?.length ?? 0;
      setInboxTotal(mergedTotal);
      setInbox((prev) => {
        const sessionRead = new Set(prev.filter((i) => i.read).map((i) => i.id));
        const readIds = new Set([...persistedRead, ...sessionRead]);
        return buildInboxFromRuns(data.runs ?? [], readIds, data.omissions ?? []);
      });
      return data;
    },
    [inboxLimit],
  );

  const promote = useCallback(
    async (runId: string) => {
      const proof = await confirmedApproval(
        { action: "promote", runId }, "automation.confirmPromote",);
      const res = await api<{
        promotion: {
          destinationSessionId?: string | null;
          destinationSessionFile?: string | null;
          destinationCwd?: string | null;
          status?: string;
        };
      }>(`/api/automations/runs/${runId}/promote`, {
        method: "POST",
        body: JSON.stringify({
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      const promo = res.promotion;
      const destinationSessionId = promo?.destinationSessionId ?? null;
      const destinationCwd = promo?.destinationCwd ?? null;
      const destinationSessionFile = promo?.destinationSessionFile ?? null;
      setLastPromotion({
        runId,
        destinationSessionId,
        destinationSessionFile,
        destinationCwd,
      });
      if (destinationSessionId) {
        options?.onPromotedSession?.({
          id: destinationSessionId,
          cwd: destinationCwd || "",
          path: destinationSessionFile || "",
        });
      }
      await refresh();
      return promo;
    },
    [refresh, confirmedApproval, options],
  );

  const exportRun = useCallback(
    async (runId: string) => {
      const proof = await confirmedApproval(
        { action: "export_run", runId }, "automation.confirmExport",);
      const res = await fetch(`/api/automations/runs/${runId}/export`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || res.statusText);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `automation-${runId}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    },
    [confirmedApproval],
  );

  const cancelRun = useCallback(
    async (runId: string) => {
      const proof = await confirmedApproval(
        { action: "cancel_run", runId }, "automation.cancel",);
      const res = await api<{ run: Run }>(`/api/automations/runs/${runId}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res.run;
    },
    [refresh, confirmedApproval],
  );

  const deleteArtifacts = useCallback(
    async (runId: string) => {
      const proof = await confirmedApproval(
        { action: "delete_artifacts", runId }, "automation.confirmDeleteArtifacts",);
      const res = await api<{ ok: boolean }>(`/api/automations/runs/${runId}/artifacts`, {
        method: "DELETE",
        body: JSON.stringify({
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      await refresh();
      return res;
    },
    [refresh, confirmedApproval],
  );

  const repairScheduler = useCallback(async () => {
    const proof = await confirmedApproval(
      { action: "repair_scheduler" }, "automation.confirmRepairLock",);
    const res = await api<unknown>("/api/automations/scheduler/repair-lock", {
      method: "POST",
      body: JSON.stringify({
        challengeId: proof.challengeId,
        secret: proof.secret,
      }),
    });
    await refresh();
    return res;
  }, [refresh, confirmedApproval]);

  const setGlobalDisabled = useCallback(
    async (disabled: boolean) => {
      const proof = await confirmedApproval(
        { action: "set_global_disabled" }, disabled ? "automation.confirmGlobalDisable" : "automation.confirmGlobalEnable",);
      const res = await api<{ scheduler: Record<string, unknown> }>("/api/automations/scheduler/status", {
        method: "POST",
        body: JSON.stringify({
          action: "set_disabled",
          disabled,
          challengeId: proof.challengeId,
          secret: proof.secret,
        }),
      });
      setScheduler(res.scheduler ?? null);
      await refresh();
      return res.scheduler;
    },
    [refresh, confirmedApproval],
  );

  const markRead = useCallback((id: string) => {
    addPersistedInboxReadId(id);
    setInbox((prev) => markInboxRead(prev, id));
  }, []);

  const targetResourceGenRef = useRef(0);
  const targetResourceAbortRef = useRef<AbortController | null>(null);

  const loadTargetResources = useCallback(
    async (input: {
      cwd?: string;
      cwdSource?: "project" | "default";
      cron?: string;
      timezone?: string;
    }) => {
      await ensureControlSession();
      // Generation guard + abort so stale responses cannot overwrite a newer target.
      const gen = ++targetResourceGenRef.current;
      try {
        targetResourceAbortRef.current?.abort();
      } catch {
        // ignore
      }
      const ac = new AbortController();
      targetResourceAbortRef.current = ac;

      const qs = new URLSearchParams();
      if (input.cwdSource === "default" || (!input.cwd && input.cwdSource !== "project")) {
        qs.set("defaultCwd", "1");
      }
      if (input.cwd) qs.set("cwd", input.cwd);
      if (input.cron) qs.set("cron", input.cron);
      if (input.timezone) qs.set("timezone", input.timezone);
      try {
        const data = await api<{
          tools?: unknown[];
          models?: Array<{ provider: string; id: string; name?: string }>;
          nextPreview?: Array<{ utc: string; localWallTime: string; offsetMinutes: number }>;
          cwd?: string;
          diagnostics?: unknown;
        }>(`/api/automations/catalog?${qs.toString()}`, { signal: ac.signal });
        if (gen !== targetResourceGenRef.current) {
          // Stale response — discard.
          return data;
        }
        if (data.tools) setCatalog(data.tools);
        if (data.models) setModels(data.models);
        if (data.nextPreview) setEditorPreview(data.nextPreview);
        return data;
      } catch (error) {
        if (ac.signal.aborted || gen !== targetResourceGenRef.current) {
          return { tools: undefined, models: undefined, nextPreview: undefined };
        }
        throw error;
      }
    },
    [],
  );

  const degraded = useMemo(() => isSchedulerDegraded(scheduler as never), [scheduler]);
  const unread = useMemo(() => unreadInboxCount(inbox), [inbox]);

  const schedulerDiagnostics = useMemo(() => {
    if (!scheduler) return [] as Array<{ key: string; value: string }>;
    const rows: Array<{ key: string; value: string }> = [];
    const pick = (key: string) => {
      const v = scheduler[key];
      if (v !== undefined && v !== null && v !== "") {
        rows.push({ key, value: String(v) });
      }
    };
    pick("available");
    pick("globalDisabled");
    pick("ownerId");
    pick("epoch");
    pick("pid");
    pick("hostname");
    pick("heartbeatAt");
    pick("nextWakeAt");
    pick("lastScanAt");
    pick("lastError");
    pick("nonterminalRunCount");
    pick("activeRuns");
    pick("freeSpaceBytes");
    pick("storageBytes");
    pick("repairRequired");
    pick("repairReason");
    pick("inProcessStarted");
    pick("inProcessOwnerId");
    return rows;
  }, [scheduler]);

  return {
    view,
    setView,
    openTask: (id: string) => {
      setView(openTask(view, id));
      // Load task-scoped page so totals/pagination are accurate (not derived from global page).
      void loadRunsPage(id, 0);
    },
    openRun: (taskId: string, runId: string) => setView(openRun(taskId, runId)),
    openRunWithDetails,
    openEditor: (taskId: string | null) => setView(openEditor(taskId)),
    tasks,
    runs,
    runsOffset,
    runsLimit,
    runsTotal,
    taskRunsOffset,
    taskRunsTotal,
    taskRunsTaskId,
    transcriptOffset,
    transcriptLimit,
    transcriptTotal,
    loadRunsPage,
    loadGlobalRunsPage,
    scheduler,
    schedulerDiagnostics,
    catalog,
    models,
    editorPreview,
    loadTargetResources,
    loading,
    error,
    inbox,
    inboxOffset,
    inboxLimit,
    inboxTotal,
    loadInboxPage,
    unread,
    degraded,
    selectedRunTranscript,
    selectedRunChanges,
    lastPromotion,
    refresh,
    createDraft,
    updateTask,
    activate,
    pause,
    archive,
    runNow,
    loadRunSession,
    loadRunChanges,
    promote,
    exportRun,
    cancelRun,
    deleteArtifacts,
    repairScheduler,
    setGlobalDisabled,
    markRead,
  };
}
