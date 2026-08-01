"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionChangedFileSummary, SessionChangesSummaryResponse } from "@/lib/types";
import { FileDiffModal } from "./FileDiffModal";

interface Props {
  sessionId: string | null;
  agentRunning: boolean;
  /** Bump to force a refresh (e.g. after agent end). */
  refreshKey?: number;
}

function statusBadge(file: SessionChangedFileSummary): { label: string; tone: string } {
  switch (file.status) {
    case "added": return { label: "A", tone: "is-success" };
    case "deleted": return { label: "D", tone: "is-danger" };
    case "metadata-only": return { label: "?", tone: "is-muted" };
    case "modified":
    default:
      return { label: "M", tone: "is-accent" };
  }
}

const POLL_INTERVAL_MS = 8_000;

/**
 * Embedded "Changes" view for the right Inspector tab.
 * Mirrors the same /api/sessions/{id}/changes data the floating pill uses,
 * rendered as a full-height file list with per-file diffs.
 */
export function InspectorChangesPanel({ sessionId, agentRunning, refreshKey }: Props) {
  const [files, setFiles] = useState<SessionChangedFileSummary[]>([]);
  const [initialLoading, setInitialLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SessionChangedFileSummary | null>(null);

  const currentSessionIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const lastRefreshKeyRef = useRef<number | undefined>(undefined);

  const load = useCallback(async (mode: "initial" | "event" | "poll") => {
    const sid = currentSessionIdRef.current;
    if (!sid) {
      setFiles([]);
      return;
    }
    if (inFlightRef.current) {
      if (mode === "poll") return;
      queuedRef.current = true;
      return;
    }
    if (mode === "initial") setInitialLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;
    inFlightRef.current = true;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/changes`, { signal: controller.signal });
      const body = await res.json() as SessionChangesSummaryResponse | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      setFiles(((body as SessionChangesSummaryResponse).files ?? []).slice().sort((a, b) => a.path.localeCompare(b.path)));
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlightRef.current = false;
      abortRef.current = null;
      if (mode === "initial") setInitialLoading(false);
      if (queuedRef.current) {
        queuedRef.current = false;
        void load("event");
      }
    }
  }, []);

  // Session change: reset + initial load.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    queuedRef.current = false;
    currentSessionIdRef.current = sessionId;
    setFiles([]);
    setError(null);
    setSelectedFile(null);
    void load("initial");
  }, [sessionId, load]);

  // Refresh on explicit refreshKey bumps (agent end, session events).
  useEffect(() => {
    if (refreshKey === undefined) return;
    if (lastRefreshKeyRef.current === undefined) {
      lastRefreshKeyRef.current = refreshKey;
      return;
    }
    if (refreshKey === lastRefreshKeyRef.current) return;
    lastRefreshKeyRef.current = refreshKey;
    void load("event");
  }, [refreshKey, load]);

  // Poll while the agent is running.
  useEffect(() => {
    if (!agentRunning) return;
    const interval = setInterval(() => void load("poll"), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [agentRunning, load]);

  // Abort in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const totals = useMemo(() => files.reduce(
    (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  ), [files]);

  if (!sessionId) {
    return (
      <div className="inspector-state inspector-state-empty">
        打开一个会话后显示本次会话的编辑/写入文件变更。
      </div>
    );
  }

  return (
    <div className="inspector-content inspector-changes-content">
      <div className="inspector-stat-grid">
        <div className="inspector-stat-card">
          <div className="inspector-stat-label">Files</div>
          <div className="inspector-stat-value">{files.length}</div>
        </div>
        <div className="inspector-stat-card">
          <div className="inspector-stat-label">Added</div>
          <div className="inspector-stat-value is-success">+{totals.additions}</div>
        </div>
        <div className="inspector-stat-card">
          <div className="inspector-stat-label">Removed</div>
          <div className="inspector-stat-value is-danger">-{totals.deletions}</div>
        </div>
      </div>

      <div className="inspector-scroll inspector-file-list">
        {initialLoading && files.length === 0 ? (
          <div className="inspector-state inspector-state-loading">加载变更文件…</div>
        ) : error ? (
          <div className="inspector-state inspector-state-error" role="alert">{error}</div>
        ) : files.length === 0 ? (
          <div className="inspector-state inspector-state-empty">暂无跟踪的编辑/写入变更。</div>
        ) : files.map((file) => {
          const badge = statusBadge(file);
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => file.diffAvailable ? setSelectedFile(file) : undefined}
              aria-disabled={file.diffAvailable ? undefined : true}
              title={file.diffAvailable ? file.path : (file.reason ?? "metadata only")}
              className={`inspector-list-row inspector-file-row${file.diffAvailable ? "" : " is-unavailable"}`}
            >
              <span className={`inspector-badge inspector-file-badge ${badge.tone}`}>
                {badge.label}
              </span>
              <span className="inspector-file-main">
                <span className="inspector-file-path">{file.path}</span>
                {!file.diffAvailable && (
                  <span className="inspector-file-reason">{file.reason ?? "metadata only"}</span>
                )}
              </span>
              <span className="inspector-file-metrics">
                <span className="is-success">+{file.additions}</span>{" "}
                <span className="is-danger">-{file.deletions}</span>
              </span>
            </button>
          );
        })}
      </div>

      {selectedFile && (
        <FileDiffModal
          sessionId={sessionId}
          file={selectedFile}
          onClose={() => setSelectedFile(null)}
        />
      )}
    </div>
  );
}
