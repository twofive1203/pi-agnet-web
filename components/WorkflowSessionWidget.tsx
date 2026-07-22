"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { WorkflowTaskDetail } from "@/lib/workflow-types";
import type { WorkflowPhaseLabel } from "@/lib/workflow-guidance";
import { useT } from "./I18nProvider";

interface Props {
  task: Pick<WorkflowTaskDetail, "id" | "title" | "status" | "activeRunId">;
  phase: WorkflowPhaseLabel;
  onClick: () => void;
}

interface WidgetPosition {
  left: number;
  top: number;
}

const STORAGE_KEY = "pi-web:workflow-session-widget-position";
const DEFAULT_MARGIN = 18;
// Default sits below the Trellis widget's top-right slot so both stay visible.
const DEFAULT_TOP = 64;
const DRAG_THRESHOLD_PX = 4;

function phaseColor(phase: WorkflowPhaseLabel): string {
  switch (phase) {
    case "finish":
      return "#22c55e";
    case "execute":
      return "#60a5fa";
    case "plan":
      return "#f59e0b";
    default:
      return "var(--text-dim)";
  }
}

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

export function WorkflowSessionWidget({ task, phase, onClick }: Props) {
  const t = useT();
  const widgetRef = useRef<HTMLButtonElement | null>(null);
  const positionRef = useRef<WidgetPosition | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    dragged: boolean;
  } | null>(null);
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const widget = widgetRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;

    const applyDefault = () => {
      const stored = readStoredPosition();
      const next = stored ?? {
        left: Math.max(DEFAULT_MARGIN, parent.clientWidth - widget.offsetWidth - DEFAULT_MARGIN),
        top: DEFAULT_TOP,
      };
      setPosition(clampPosition(next, parent, widget));
    };

    applyDefault();
    const resizeObserver = new ResizeObserver(applyDefault);
    resizeObserver.observe(parent);
    resizeObserver.observe(widget);
    return () => resizeObserver.disconnect();
  }, []);

  const moveToPointer = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const widget = widgetRef.current;
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
    const widget = widgetRef.current;
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
    const widget = widgetRef.current;
    const parent = widget?.parentElement;
    const latestPosition = positionRef.current;
    if (widget && parent && latestPosition) writeStoredPosition(clampPosition(latestPosition, parent, widget));
    if (!wasDragged) onClick();
  }, [onClick]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onClick();
  }, [onClick]);

  return (
    <button
      ref={(node) => { widgetRef.current = node; }}
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      title={t("workflow.sessionWidgetTitle")}
      aria-label={t("workflow.sessionWidgetTitle")}
      style={{
        position: "absolute",
        ...(position ? { left: position.left, top: position.top } : { right: DEFAULT_MARGIN, top: DEFAULT_TOP }),
        zIndex: 120,
        maxWidth: 280,
        textAlign: "left",
        border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--bg-panel) 92%, transparent)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
        backdropFilter: "blur(12px)",
        padding: "10px 12px",
        cursor: dragging ? "grabbing" : "grab",
        color: "var(--text)",
        userSelect: "none",
        touchAction: "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: phaseColor(phase) }}>
          SnFlow · {t(`workflow.phase.${phase}`)}
        </span>
        {task.activeRunId && (
          <span style={{ fontSize: 10, color: "#f59e0b", fontWeight: 700 }}>{t("workflow.running")}</span>
        )}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {task.title}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
        {task.id} · {t(`workflow.status.${task.status}`)}
      </div>
    </button>
  );
}
