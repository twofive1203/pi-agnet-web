"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useI18n } from "@/components/I18nProvider";
import type { SessionChangedFileSummary, SessionChangesSummaryResponse } from "@/lib/types";
import { FileDiffModal } from "./FileDiffModal";

interface Props {
  sessionId: string;
  agentRunning: boolean;
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

function DiffMetrics({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="session-changes-metrics">
      <span className="is-success">+{additions}</span>
      <span className="is-danger">-{deletions}</span>
    </span>
  );
}

export function SessionChangesFloatingPanel({ sessionId, agentRunning, refreshKey }: Props) {
  const { t } = useI18n();
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
    positionRef.current = next;
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

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const totals = useMemo(() => files.reduce((acc, file) => ({
    additions: acc.additions + file.additions,
    deletions: acc.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [files]);

  const fileCountText = files.length === 1
    ? t("panels.sessionChanges.capsuleOne")
    : t("panels.sessionChanges.capsule", { count: files.length });

  if (files.length === 0 && !open) return null;

  const buttonTitle = refreshing
    ? t("panels.sessionChanges.refreshingHint")
    : t("panels.sessionChanges.dragHint");

  return (
    <>
      <div
        ref={wrapperRef}
        className="session-changes-floating"
        style={position ? { left: position.left, top: position.top } : { right: DEFAULT_MARGIN, bottom: DEFAULT_BOTTOM }}
      >
        {open && (
          <div className="session-changes-desktop-panel">
            <div
              className="session-changes-panel"
              role="dialog"
              aria-label={t("panels.sessionChanges.title")}
            >
              <div className="session-changes-header">
                <span className="session-changes-icon" aria-hidden="true" />
                <div className="session-changes-title-wrap">
                  <div className="session-changes-title">{t("panels.sessionChanges.title")}</div>
                  <div className="session-changes-subtitle">
                    <span>{t("panels.sessionChanges.subtitle")}</span>
                    <DiffMetrics additions={totals.additions} deletions={totals.deletions} />
                  </div>
                </div>
                <span className="session-changes-header-count">{files.length}</span>
                <button
                  type="button"
                  onClick={close}
                  aria-label={t("panels.sessionChanges.close")}
                  title={t("panels.sessionChanges.close")}
                  className="session-changes-close"
                >
                  {"\u00d7"}
                </button>
              </div>

              <div className="session-changes-content">
                {initialLoading && files.length === 0 ? (
                  <div className="session-changes-state">{t("panels.sessionChanges.loading")}</div>
                ) : error ? (
                  <div className="session-changes-state is-error" role="alert">{error}</div>
                ) : files.length === 0 ? (
                  <div className="session-changes-state">{t("panels.sessionChanges.empty")}</div>
                ) : (
                  <div className="session-changes-list">
                    {files.map((file) => {
                      const badge = statusBadge(file);
                      const reason = file.reason ?? t("panels.sessionChanges.metadataOnly");
                      return (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() => file.diffAvailable ? setSelectedFile(file) : undefined}
                          aria-disabled={file.diffAvailable ? undefined : true}
                          title={file.diffAvailable ? file.path : reason}
                          className={[
                            "session-changes-file-row",
                            file.diffAvailable ? "" : "is-unavailable",
                          ].filter(Boolean).join(" ")}
                        >
                          <span className={`session-changes-file-badge ${badge.tone}`}>
                            {badge.label}
                          </span>
                          <span className="session-changes-file-main">
                            <span className="session-changes-file-path">{file.path}</span>
                            {!file.diffAvailable && (
                              <span className="session-changes-file-reason">{reason}</span>
                            )}
                          </span>
                          <DiffMetrics additions={file.additions} deletions={file.deletions} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
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
          aria-label={open
            ? t("panels.sessionChanges.hideWithCount", { label: fileCountText })
            : t("panels.sessionChanges.showWithCount", { label: fileCountText })}
          title={buttonTitle}
          className={[
            "session-changes-capsule",
            open ? "is-open" : "",
            dragging ? "is-dragging" : "",
            refreshing ? "is-refreshing" : "",
            files.length > 0 ? "has-files" : "",
          ].filter(Boolean).join(" ")}
        >
          <span className="session-changes-capsule-icon" aria-hidden="true" />
          <span className="session-changes-capsule-copy">
            <span className="session-changes-capsule-label">{fileCountText}</span>
            {(totals.additions > 0 || totals.deletions > 0) && (
              <DiffMetrics additions={totals.additions} deletions={totals.deletions} />
            )}
          </span>
          <span className="session-changes-capsule-chevron" aria-hidden="true" />
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
