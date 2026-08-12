"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  QuickCommandListItem,
  QuickCommandRunDetail,
  QuickCommandRunSummary,
  QuickCommandStartResult,
  QuickCommandTrustPreview,
} from "@/lib/quick-command-types";
import { isQuickCommandActiveStatus, isQuickCommandTerminalStatus } from "@/lib/quick-command-types";

export interface QuickCommandEditorRow {
  id: string;
  name: string;
  command: string;
  description: string;
  cwd: string;
  envText: string;
  confirmBeforeRun: boolean;
  autoExpandOutput: boolean;
  enabled: boolean;
  order: number;
}

interface ListResponse {
  cwd?: string;
  revision?: string;
  commands?: QuickCommandListItem[];
  activeRuns?: QuickCommandRunSummary[];
  recentRuns?: QuickCommandRunSummary[];
  error?: string;
}

interface ConfigResponse {
  cwd?: string;
  configPath?: string;
  config?: {
    revision: string;
    commands: Array<{
      id: string;
      name: string;
      command: string;
      description: string;
      cwd: string;
      env: Record<string, string>;
      confirmBeforeRun: boolean;
      autoExpandOutput: boolean;
      enabled: boolean;
      order: number;
    }>;
  };
  error?: string;
  code?: string;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid env line: ${trimmed}`);
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    env[key] = value;
  }
  return env;
}

function emptyEditorRow(order: number): QuickCommandEditorRow {
  return {
    id: "",
    name: "",
    command: "",
    description: "",
    cwd: "",
    envText: "",
    confirmBeforeRun: false,
    autoExpandOutput: true,
    enabled: true,
    order,
  };
}

export function useQuickCommands(projectCwd: string | null | undefined) {
  const [commands, setCommands] = useState<QuickCommandListItem[]>([]);
  const [revision, setRevision] = useState<string>("");
  const [recentRuns, setRecentRuns] = useState<QuickCommandRunSummary[]>([]);
  const [activeRuns, setActiveRuns] = useState<QuickCommandRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<QuickCommandRunDetail | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [configOpen, setConfigOpen] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string>("");
  const [configRevision, setConfigRevision] = useState<string>("");
  const [editorRows, setEditorRows] = useState<QuickCommandEditorRow[]>([]);

  const [trustPreview, setTrustPreview] = useState<QuickCommandTrustPreview | null>(null);
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const [busyCommandId, setBusyCommandId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const cwdRef = useRef(projectCwd);
  cwdRef.current = projectCwd;
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;
  const eventSourceRef = useRef<EventSource | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3_200);
  }, []);

  const refresh = useCallback(async () => {
    const cwd = cwdRef.current;
    if (!cwd) {
      setCommands([]);
      setRecentRuns([]);
      setActiveRuns([]);
      setRevision("");
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/quick-commands?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json().catch(() => ({}))) as ListResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (cwdRef.current !== cwd) return;
      setCommands(data.commands ?? []);
      setRevision(data.revision ?? "");
      setRecentRuns(data.recentRuns ?? []);
      setActiveRuns(data.activeRuns ?? []);
      setError(null);
    } catch (err) {
      if (cwdRef.current !== cwd) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (cwdRef.current === cwd) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [projectCwd, refresh]);

  // Poll lightly while any run is active so composer chips stay fresh even if SSE is closed.
  useEffect(() => {
    if (!projectCwd || activeRuns.length === 0) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [projectCwd, activeRuns.length, refresh]);

  const detachStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const attachStream = useCallback((runId: string) => {
    detachStream();
    setStreamError(null);
    const source = new EventSource(`/api/quick-commands/runs/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: "connected"; runId: string }
          | { type: "snapshot"; run: QuickCommandRunDetail }
          | { type: "output"; chunk: string }
          | { type: "status"; run: QuickCommandRunSummary }
          | { type: "error"; error: string };
        if (payload.type === "snapshot") {
          setRunDetail(payload.run);
          setActiveRunId(payload.run.id);
          void refresh();
          return;
        }
        if (payload.type === "output") {
          setRunDetail((prev) => {
            if (!prev || prev.id !== runId) return prev;
            return {
              ...prev,
              outputText: `${prev.outputText}${payload.chunk}`,
              outputBytes: prev.outputBytes + new TextEncoder().encode(payload.chunk).length,
            };
          });
          return;
        }
        if (payload.type === "status") {
          setRunDetail((prev) => {
            if (!prev || prev.id !== payload.run.id) {
              return {
                ...payload.run,
                outputText: prev?.id === payload.run.id ? prev.outputText : "",
              };
            }
            return { ...prev, ...payload.run };
          });
          void refresh();
          return;
        }
        if (payload.type === "error") {
          setStreamError(payload.error);
        }
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : String(err));
      }
    };
    source.onerror = () => {
      // Allow automatic reconnect by EventSource; surface a soft error only.
      setStreamError((prev) => prev ?? "stream reconnecting…");
    };
  }, [detachStream, refresh]);

  useEffect(() => () => {
    detachStream();
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, [detachStream]);

  // Drop panel association when project changes.
  useEffect(() => {
    detachStream();
    setActiveRunId(null);
    setRunDetail(null);
    setPanelOpen(false);
    setPanelCollapsed(false);
    setTrustPreview(null);
    setPendingCommandId(null);
    setConfigOpen(false);
  }, [projectCwd, detachStream]);

  const focusRun = useCallback((run: QuickCommandRunSummary | QuickCommandRunDetail, options?: { expand?: boolean }) => {
    setActiveRunId(run.id);
    setPanelOpen(true);
    if (options?.expand !== false) setPanelCollapsed(false);
    if ("outputText" in run) {
      setRunDetail(run);
    } else {
      setRunDetail((prev) => (prev && prev.id === run.id ? { ...prev, ...run } : { ...run, outputText: prev?.id === run.id ? prev.outputText : "" }));
    }
    attachStream(run.id);
  }, [attachStream]);

  const startCommand = useCallback(async (
    commandId: string,
    trust?: { trustConfirmed: true; trustDigest: string },
  ) => {
    const cwd = cwdRef.current;
    if (!cwd) return;
    setBusyCommandId(commandId);
    setError(null);
    try {
      const res = await fetch("/api/quick-commands/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          commandId,
          trustConfirmed: trust?.trustConfirmed === true,
          trustDigest: trust?.trustDigest,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as QuickCommandStartResult & { error?: string };
      if (!res.ok || !("ok" in data)) {
        if (data && typeof data === "object" && "code" in data && data.code === "trust_required" && data.trust) {
          setTrustPreview(data.trust);
          setPendingCommandId(commandId);
          return;
        }
        throw new Error(("error" in data && data.error) || `HTTP ${res.status}`);
      }
      if (!data.ok) {
        if (data.code === "trust_required" && data.trust) {
          setTrustPreview(data.trust);
          setPendingCommandId(commandId);
          return;
        }
        if (data.code === "limit" || data.code === "busy") {
          showToast(data.error);
          if (data.run) focusRun(data.run);
          return;
        }
        throw new Error(data.error);
      }

      setTrustPreview(null);
      setPendingCommandId(null);
      if (data.alreadyRunning) {
        showToast("running");
      }
      const expand = data.run.autoExpandOutput || data.alreadyRunning;
      focusRun(data.run, { expand });
      if (!expand) {
        // Keep a compact result chip without forcing the dock open.
        setPanelOpen(true);
        setPanelCollapsed(true);
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyCommandId(null);
    }
  }, [focusRun, refresh, showToast]);

  const confirmTrustAndRun = useCallback(async () => {
    if (!trustPreview || !pendingCommandId) return;
    const digest = trustPreview.digest;
    const commandId = pendingCommandId;
    setTrustPreview(null);
    await startCommand(commandId, { trustConfirmed: true, trustDigest: digest });
  }, [pendingCommandId, startCommand, trustPreview]);

  const cancelTrust = useCallback(() => {
    setTrustPreview(null);
    setPendingCommandId(null);
  }, []);

  const cancelActiveRun = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    try {
      const res = await fetch(`/api/quick-commands/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { run?: QuickCommandRunSummary; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.run) {
        setRunDetail((prev) => (prev && prev.id === data.run!.id ? { ...prev, ...data.run! } : prev));
      }
      void refresh();
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : String(err));
    }
  }, [refresh]);

  const rerunActive = useCallback(async () => {
    const detail = runDetail;
    if (!detail) return;
    await startCommand(detail.commandId);
  }, [runDetail, startCommand]);

  const clearEndedView = useCallback(async () => {
    const detail = runDetail;
    if (!detail || !isQuickCommandTerminalStatus(detail.status)) return;
    try {
      await fetch(`/api/quick-commands/runs/${encodeURIComponent(detail.id)}`, { method: "DELETE" });
    } catch {
      // ignore
    }
    detachStream();
    setRunDetail(null);
    setActiveRunId(null);
    void refresh();
  }, [detachStream, refresh, runDetail]);

  const openConfig = useCallback(async () => {
    const cwd = cwdRef.current;
    if (!cwd) return;
    setConfigOpen(true);
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await fetch(`/api/quick-commands/config?cwd=${encodeURIComponent(cwd)}`);
      const data = (await res.json().catch(() => ({}))) as ConfigResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConfigPath(data.configPath ?? "");
      setConfigRevision(data.config?.revision ?? "");
      const rows = (data.config?.commands ?? []).map((command, index) => ({
        id: command.id,
        name: command.name,
        command: command.command,
        description: command.description,
        cwd: command.cwd,
        envText: envToText(command.env),
        confirmBeforeRun: command.confirmBeforeRun,
        autoExpandOutput: command.autoExpandOutput,
        enabled: command.enabled,
        order: command.order ?? index,
      }));
      setEditorRows(rows);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
      setEditorRows([]);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const addEditorRow = useCallback(() => {
    setEditorRows((rows) => [...rows, emptyEditorRow(rows.length)]);
  }, []);

  const updateEditorRow = useCallback((index: number, patch: Partial<QuickCommandEditorRow>) => {
    setEditorRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const removeEditorRow = useCallback((index: number) => {
    setEditorRows((rows) => rows.filter((_, i) => i !== index).map((row, order) => ({ ...row, order })));
  }, []);

  const saveConfig = useCallback(async () => {
    const cwd = cwdRef.current;
    if (!cwd) return false;
    setConfigSaving(true);
    setConfigError(null);
    try {
      const commandsPayload = editorRows.map((row, index) => ({
        id: row.id || undefined,
        name: row.name,
        command: row.command,
        description: row.description,
        cwd: row.cwd,
        env: parseEnvText(row.envText),
        confirmBeforeRun: row.confirmBeforeRun,
        autoExpandOutput: row.autoExpandOutput,
        enabled: row.enabled,
        order: index,
      }));
      const res = await fetch("/api/quick-commands/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          expectedRevision: configRevision || null,
          commands: commandsPayload,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ConfigResponse;
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConfigRevision(data.config?.revision ?? "");
      setConfigPath(data.configPath ?? "");
      const rows = (data.config?.commands ?? []).map((command, index) => ({
        id: command.id,
        name: command.name,
        command: command.command,
        description: command.description,
        cwd: command.cwd,
        envText: envToText(command.env),
        confirmBeforeRun: command.confirmBeforeRun,
        autoExpandOutput: command.autoExpandOutput,
        enabled: command.enabled,
        order: command.order ?? index,
      }));
      setEditorRows(rows);
      await refresh();
      return true;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setConfigSaving(false);
    }
  }, [configRevision, editorRows, refresh]);

  const latestResult = useMemo(() => {
    const terminal = recentRuns.find((run) => isQuickCommandTerminalStatus(run.status));
    return terminal ?? null;
  }, [recentRuns]);

  const runningCount = useMemo(
    () => activeRuns.filter((run) => isQuickCommandActiveStatus(run.status)).length,
    [activeRuns],
  );

  return {
    projectCwd,
    commands,
    revision,
    recentRuns,
    activeRuns,
    runningCount,
    latestResult,
    loading,
    error,
    toast,
    showToast,

    panelOpen,
    setPanelOpen,
    panelCollapsed,
    setPanelCollapsed,
    activeRunId,
    runDetail,
    streamError,
    focusRun,
    startCommand,
    cancelActiveRun,
    rerunActive,
    clearEndedView,

    trustPreview,
    confirmTrustAndRun,
    cancelTrust,

    busyCommandId,

    configOpen,
    setConfigOpen,
    configLoading,
    configSaving,
    configError,
    configPath,
    editorRows,
    openConfig,
    addEditorRow,
    updateEditorRow,
    removeEditorRow,
    saveConfig,
    refresh,
  };
}

export type QuickCommandsApi = ReturnType<typeof useQuickCommands>;
