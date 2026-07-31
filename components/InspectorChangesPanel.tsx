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

function statusBadge(file: SessionChangedFileSummary): { label: string; color: string } {
  switch (file.status) {
    case "added": return { label: "A", color: "var(--ok)" };
    case "deleted": return { label: "D", color: "var(--danger)" };
    case "metadata-only": return { label: "?", color: "var(--text-3)" };
    case "modified":
    default:
      return { label: "M", color: "var(--accent)" };
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
      <div style={{ padding: "18px 14px", color: "var(--text-3)", fontSize: 12 }}>
        打开一个会话后显示本次会话的编辑/写入文件变更。
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, flexShrink: 0, marginBottom: 10 }}>
        <div className="stat-card">
          <div className="stat-k">Files</div>
          <div className="stat-v">{files.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-k">Added</div>
          <div className="stat-v" style={{ color: "var(--ok)" }}>+{totals.additions}</div>
        </div>
        <div className="stat-card">
          <div className="stat-k">Removed</div>
          <div className="stat-v" style={{ color: "var(--danger)" }}>-{totals.deletions}</div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 2 }}>
        {initialLoading && files.length === 0 ? (
          <div style={{ padding: 10, color: "var(--text-3)", fontSize: 12 }}>加载变更文件…</div>
        ) : error ? (
          <div style={{ padding: 10, color: "var(--danger)", fontSize: 12 }}>{error}</div>
        ) : files.length === 0 ? (
          <div style={{ padding: 10, color: "var(--text-3)", fontSize: 12 }}>暂无跟踪的编辑/写入变更。</div>
        ) : files.map((file) => {
          const badge = statusBadge(file);
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => file.diffAvailable ? setSelectedFile(file) : undefined}
              aria-disabled={file.diffAvailable ? undefined : true}
              title={file.diffAvailable ? undefined : (file.reason ?? "metadata only")}
              className="insp-file-card"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "9px 10px",
                border: "1px solid var(--line)",
                borderRadius: 12,
                background: "var(--bg-card)",
                color: "var(--text)",
                cursor: file.diffAvailable ? "pointer" : "default",
                textAlign: "left",
                marginBottom: 6,
              }}
            >
              <span style={{
                width: 20, height: 20, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center",
                color: badge.color, background: "var(--bg-subtle)", fontSize: 11, fontWeight: 900, flexShrink: 0,
              }}>
                {badge.label}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.path}
                </span>
                {!file.diffAvailable && (
                  <span style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--text-3)" }}>
                    {file.reason ?? "metadata only"}
                  </span>
                )}
              </span>
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ color: "var(--ok)" }}>+{file.additions}</span>{" "}
                <span style={{ color: "var(--danger)" }}>-{file.deletions}</span>
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
