"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { SessionChangedFileSummary, SessionChangesSummaryResponse } from "@/lib/types";
import { FileDiffModal } from "./FileDiffModal";

interface Props {
  sessionId: string;
  agentRunning: boolean;
  refreshKey?: number;
}

function statusBadge(file: SessionChangedFileSummary): { label: string; color: string } {
  switch (file.status) {
    case "added": return { label: "A", color: "#16a34a" };
    case "deleted": return { label: "D", color: "#dc2626" };
    case "metadata-only": return { label: "?", color: "var(--text-muted)" };
    case "modified":
    default:
      return { label: "M", color: "var(--accent)" };
  }
}

function fileCountLabel(count: number): string {
  return count === 1 ? "1 file changed" : `${count} files changed`;
}

/**
 * Produce a stable string signature for a list of changed-file summaries.
 * Used to avoid calling setFiles when the data hasn't meaningfully changed.
 */
function changesSignature(files: SessionChangedFileSummary[]): string {
  return files
    .map((file) =>
      [
        file.path,
        file.status,
        file.additions,
        file.deletions,
        file.diffAvailable ? "1" : "0",
        file.reason ?? "",
        file.firstChangedAt ?? "",
        file.lastChangedAt ?? "",
        [...(file.toolNames ?? [])].sort().join(","),
        [...(file.sourceKinds ?? [])].sort().join(","),
      ].join("\u001f"),
    )
    .join("\u001e");
}

interface WidgetPosition {
  left: number;
  top: number;
}

const STORAGE_KEY = "pi-web:session-changes-widget-position";
const DEFAULT_MARGIN = 18;
const DEFAULT_BOTTOM = 92;
const DRAG_THRESHOLD_PX = 4;
const POLL_INTERVAL_MS = 10_000;

function clampPosition(position: WidgetPosition, parent: HTMLElement, widget: HTMLElement): WidgetPosition {
  const maxLeft = Math.max(DEFAULT_MARGIN, parent.clientWidth - widget.offsetWidth - DEFAULT_MARGIN);
  const maxTop = Math.max(DEFAULT_MARGIN, parent.clientHeight - widget.offsetHeight - DEFAULT_MARGIN);
  return {
    left: Math.min(Math.max(DEFAULT_MARGIN, position.left), maxLeft),
    top: Math.min(Math.max(DEFAULT_MARGIN, position.top), maxTop),
  };
}

function readStoredPosition(): WidgetPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<WidgetPosition> | null;
    if (typeof parsed?.left === "number" && typeof parsed.top === "number") return { left: parsed.left, top: parsed.top };
  } catch {
    // Ignore malformed persisted UI state.
  }
  return null;
}

function writeStoredPosition(position: WidgetPosition): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Best-effort UI preference only.
  }
}

export function SessionChangesFloatingPanel({ sessionId, agentRunning, refreshKey }: Props) {
  const [files, setFiles] = useState<SessionChangedFileSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SessionChangedFileSummary | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef<WidgetPosition | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    dragged: boolean;
  } | null>(null);

  // Concurrent-fetch protection refs.
  const currentSessionIdRef = useRef<string>(sessionId);
  const abortRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);
  const requestSeqRef = useRef(0);
  const filesSignatureRef = useRef<string>("");
  const lastRefreshKeyRef = useRef<number | undefined>(undefined);
  const prevAgentRunningRef = useRef(false);

  type LoadMode = "initial" | "event" | "poll" | "final";

  const loadChanges = useCallback(
    async (mode: LoadMode = "poll") => {
      const sid = currentSessionIdRef.current;

      // If a request is already in flight, decide what to do.
      if (inFlightRef.current) {
        if (mode === "poll") return; // skip polling while busy
        // event/final: queue a follow-up after current request finishes
        queuedRefreshRef.current = true;
        return;
      }

      if (mode === "initial") {
        setInitialLoading(true);
      } else {
        setRefreshing(true);
      }

      const seq = ++requestSeqRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      inFlightRef.current = true;

      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sid)}/changes`,
          { signal: controller.signal },
        );
        const body = await res.json() as SessionChangesSummaryResponse | { error?: string };

        // Ignore stale responses.
        if (sid !== currentSessionIdRef.current) return;
        if (seq !== requestSeqRef.current) return;

        if (!res.ok) {
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }

        const nextFiles = ((body as SessionChangesSummaryResponse).files ?? [])
          .slice()
          .sort((a, b) => a.path.localeCompare(b.path));

        const nextSig = changesSignature(nextFiles);
        if (nextSig !== filesSignatureRef.current) {
          filesSignatureRef.current = nextSig;
          setFiles(nextFiles);
        }
        setError(null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        if (sid !== currentSessionIdRef.current) return;
        // Keep last successful files list; only surface error in the panel.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === requestSeqRef.current) {
          inFlightRef.current = false;
          abortRef.current = null;
        }
        if (mode === "initial") setInitialLoading(false);
        else setRefreshing(false);

        // If a refresh was queued while we were in-flight, fire it now.
        if (queuedRefreshRef.current && currentSessionIdRef.current === sid) {
          queuedRefreshRef.current = false;
          void loadChanges("event");
        }
      }
    },
    [],
  );

  // Session change: abort old, reset state, initial load.
  useEffect(() => {
    // Abort any pending request from the previous session.
    abortRef.current?.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    queuedRefreshRef.current = false;

    currentSessionIdRef.current = sessionId;
    filesSignatureRef.current = "";
    // NOTE: Do NOT reset requestSeqRef here. Keeping it monotonically increasing
    // prevents a race where an old aborted request's finally block matches the new
    // request's seq after a session switch (e.g. old seq=1, reset to 0, new seq=1).

    setFiles([]);
    setError(null);
    setOpen(false);
    setSelectedFile(null);

    void loadChanges("initial");
  }, [sessionId, loadChanges]);

  // SSE-driven refresh via refreshKey from useAgentSession.
  useEffect(() => {
    if (refreshKey === undefined) return;
    // Skip the initial render to avoid duplicating the sessionId effect.
    if (lastRefreshKeyRef.current === undefined) {
      lastRefreshKeyRef.current = refreshKey;
      return;
    }
    if (refreshKey === lastRefreshKeyRef.current) return;
    lastRefreshKeyRef.current = refreshKey;
    void loadChanges("event");
  }, [refreshKey, loadChanges]);

  // Fallback polling while agent is running (10s interval).
  useEffect(() => {
    if (!agentRunning) return;
    const interval = setInterval(() => void loadChanges("poll"), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [agentRunning, loadChanges]);

  // Final refresh when agent stops (covers missed SSE events).
  useEffect(() => {
    const wasRunning = prevAgentRunningRef.current;
    prevAgentRunningRef.current = agentRunning;
    if (wasRunning && !agentRunning) {
      void loadChanges("final");
    }
  }, [agentRunning, loadChanges]);

  // Abort in-flight request on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;

    const applyDefault = () => {
      const stored = readStoredPosition();
      const next = stored ?? {
        left: Math.max(DEFAULT_MARGIN, parent.clientWidth - widget.offsetWidth - DEFAULT_MARGIN),
        top: Math.max(DEFAULT_MARGIN, parent.clientHeight - widget.offsetHeight - DEFAULT_BOTTOM),
      };
      setPosition(clampPosition(next, parent, widget));
    };

    applyDefault();
    const resizeObserver = new ResizeObserver(() => {
      const latest = positionRef.current;
      if (!latest) applyDefault();
      else setPosition(clampPosition(latest, parent, widget));
    });
    resizeObserver.observe(parent);
    resizeObserver.observe(widget);
    return () => resizeObserver.disconnect();
  }, []);

  const moveToPointer = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    if (!drag || !widget || !parent) return;

    const parentRect = parent.getBoundingClientRect();
    const next = clampPosition({
      left: event.clientX - parentRect.left - drag.offsetX,
      top: event.clientY - parentRect.top - drag.offsetY,
    }, parent, widget);
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (moved > DRAG_THRESHOLD_PX) drag.dragged = true;
    setPosition(next);
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;

    const widgetRect = widget.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const current = position ?? {
      left: widgetRect.left - parentRect.left,
      top: widgetRect.top - parentRect.top,
    };
    const clamped = clampPosition(current, parent, widget);
    setPosition(clamped);
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - widgetRect.left,
      offsetY: event.clientY - widgetRect.top,
      startX: event.clientX,
      startY: event.clientY,
      dragged: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    moveToPointer(event);
  }, [moveToPointer]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const wasDragged = drag.dragged;
    dragRef.current = null;
    setDragging(false);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }

    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    const latestPosition = positionRef.current;
    if (widget && parent && latestPosition) writeStoredPosition(clampPosition(latestPosition, parent, widget));
    if (wasDragged) suppressClickRef.current = true;
  }, []);

  const handleButtonClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen((value) => !value);
  }, []);

  const totals = useMemo(() => files.reduce((acc, file) => ({
    additions: acc.additions + file.additions,
    deletions: acc.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [files]);

  if (files.length === 0 && !open) return null;

  const buttonTitle = refreshing
    ? "Drag to move; refreshing changed files"
    : "Drag to move; click to show changed files";

  return (
    <>
      <div
        ref={wrapperRef}
        style={{
          position: "absolute",
          ...(position ? { left: position.left, top: position.top } : { right: DEFAULT_MARGIN, bottom: DEFAULT_BOTTOM }),
          zIndex: 130,
          display: "inline-flex",
          pointerEvents: "auto",
        }}
      >
        {open && (
          <div
            style={{
              position: "absolute",
              right: 0,
              bottom: "calc(100% + 8px)",
              display: "flex",
              flexDirection: "column",
              width: "min(480px, calc(100vw - 48px))",
              maxWidth: "calc(100vw - 48px)",
              maxHeight: "min(480px, calc(100dvh - 120px))",
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 14,
              background: "color-mix(in srgb, var(--bg-panel) 96%, transparent)",
              color: "var(--text)",
              boxShadow: "0 18px 42px rgba(0,0,0,0.20)",
              backdropFilter: "blur(12px)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexShrink: 0, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>Changed files</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  Session edit/write changes · <span style={{ color: "#16a34a" }}>+{totals.additions}</span> <span style={{ color: "#dc2626" }}>-{totals.deletions}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close changed files panel"
                style={{ border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, flexShrink: 0 }}
              >
                ×
              </button>
            </div>

            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 6 }}>
              {initialLoading && files.length === 0 ? (
                <div style={{ padding: 10, color: "var(--text-muted)", fontSize: 12 }}>Loading changed files…</div>
              ) : error ? (
                <div style={{ padding: 10, color: "#dc2626", fontSize: 12 }}>{error}</div>
              ) : files.length === 0 ? (
                <div style={{ padding: 10, color: "var(--text-muted)", fontSize: 12 }}>No tracked edit/write changes yet.</div>
              ) : files.map((file) => {
                const badge = statusBadge(file);
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => file.diffAvailable ? setSelectedFile(file) : undefined}
                    aria-disabled={file.diffAvailable ? undefined : true}
                    title={file.diffAvailable ? file.path : (file.reason ?? "metadata only")}
                    style={{
                      width: "max-content",
                      minWidth: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "8px 9px",
                      border: 0,
                      borderRadius: 10,
                      background: "transparent",
                      color: "var(--text)",
                      cursor: file.diffAvailable ? "pointer" : "default",
                      textAlign: "left",
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={{ width: 20, height: 20, borderRadius: 6, display: "inline-flex", alignItems: "center", justifyContent: "center", color: badge.color, background: "var(--bg-subtle)", fontSize: 11, fontWeight: 900, flexShrink: 0 }}>
                      {badge.label}
                    </span>
                    <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                      <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "nowrap" }}>{file.path}</span>
                      {!file.diffAvailable && <span style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{file.reason ?? "metadata only"}</span>}
                    </span>
                    <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      <span style={{ color: "#16a34a" }}>+{file.additions}</span>{" "}
                      <span style={{ color: "#dc2626" }}>-{file.deletions}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={handleButtonClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          aria-expanded={open}
          aria-label={open ? `Hide changed files, ${fileCountLabel(files.length)}` : `Show changed files, ${fileCountLabel(files.length)}`}
          title={buttonTitle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "8px 12px",
            background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
            color: "var(--text)",
            boxShadow: "0 10px 28px rgba(0,0,0,0.16)",
            backdropFilter: "blur(10px)",
            cursor: dragging ? "grabbing" : "grab",
            fontSize: 12,
            fontWeight: 800,
            touchAction: "none",
            userSelect: "none",
            minWidth: "7.5em",
          }}
        >
          <span>▦</span>
          <span>{fileCountLabel(files.length)}</span>
        </button>
      </div>

      {selectedFile && (
        <FileDiffModal
          sessionId={sessionId}
          file={selectedFile}
          onClose={() => setSelectedFile(null)}
          contained={false}
        />
      )}
    </>
  );
}
