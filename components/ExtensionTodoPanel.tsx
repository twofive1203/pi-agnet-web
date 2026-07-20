"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ExtensionWidgetItem } from "@/lib/types";

interface Props {
  item: ExtensionWidgetItem | null;
}

interface TodoEntry {
  id: string;
  label: string;
  completed: boolean;
  active: boolean;
}

interface TodoModel {
  title: string;
  entries: TodoEntry[];
  completed: number;
  total: number;
}

const TODO_KEY_RE = /^todo[-_]list$/i;
const TODO_TITLE_RE = /^\s*Todo List\s*[-\u2013\u2014]\s*(\d+)\s*\/\s*(\d+)\s+completed/i;
const TODO_ITEM_RE = /^\s*(?:([\u2713\u2714\u2611\u2612\u25cb\u25ef\u00b7xX])\s*)?(\d+)[.)]\s+(.+)$/;
const TODO_ACTIVE_RE = /^\s*(?:[\u2022\u25c9\u25cf\u25b6>]|\u2192)\s*(\d+)[.)]\s+(.+)$/;
const MOBILE_MEDIA_QUERY = "(max-width: 640px)";
const TODO_WIDGET_STORAGE_KEY = "pi-web:extension-todo-widget-position";
const TODO_WIDGET_MARGIN = 18;
const TODO_WIDGET_BOTTOM = 92;
const TODO_WIDGET_INPUT_GAP = 8;
const DRAG_THRESHOLD_PX = 4;

interface WidgetPosition {
  left: number;
  top: number;
}

function getDefaultPosition(parent: HTMLElement, widget: HTMLElement): WidgetPosition {
  const inputInner = parent.querySelector<HTMLElement>(".chat-input-inner");
  if (inputInner) {
    const parentRect = parent.getBoundingClientRect();
    const inputRect = inputInner.getBoundingClientRect();
    return {
      left: inputRect.left - parentRect.left,
      top: inputRect.top - parentRect.top - widget.offsetHeight - TODO_WIDGET_INPUT_GAP,
    };
  }

  return {
    left: TODO_WIDGET_MARGIN,
    top: Math.max(TODO_WIDGET_MARGIN, parent.clientHeight - widget.offsetHeight - TODO_WIDGET_BOTTOM),
  };
}

function clampPosition(position: WidgetPosition, parent: HTMLElement, widget: HTMLElement): WidgetPosition {
  const maxLeft = Math.max(TODO_WIDGET_MARGIN, parent.clientWidth - widget.offsetWidth - TODO_WIDGET_MARGIN);
  const maxTop = Math.max(TODO_WIDGET_MARGIN, parent.clientHeight - widget.offsetHeight - TODO_WIDGET_MARGIN);
  return {
    left: Math.min(Math.max(TODO_WIDGET_MARGIN, position.left), maxLeft),
    top: Math.min(Math.max(TODO_WIDGET_MARGIN, position.top), maxTop),
  };
}

function readStoredPosition(): WidgetPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TODO_WIDGET_STORAGE_KEY) ?? "null") as Partial<WidgetPosition> | null;
    if (typeof parsed?.left === "number" && typeof parsed.top === "number") return { left: parsed.left, top: parsed.top };
  } catch {
    // Ignore malformed persisted UI state.
  }
  return null;
}

function writeStoredPosition(position: WidgetPosition): void {
  try {
    window.localStorage.setItem(TODO_WIDGET_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Best-effort UI preference only.
  }
}

export function isTodoWidget(item: ExtensionWidgetItem): boolean {
  return TODO_KEY_RE.test(item.key.trim());
}

function parseTodoWidget(item: ExtensionWidgetItem): TodoModel {
  const [firstLine = "", ...rest] = item.lines;
  const titleMatch = firstLine.match(TODO_TITLE_RE);
  const title = titleMatch ? "Todo List" : "Todo List";
  const entries: TodoEntry[] = [];
  const taskLines = titleMatch ? rest : item.lines;

  for (const line of taskLines) {
    const completedMatch = line.match(TODO_ITEM_RE);
    if (completedMatch) {
      const marker = completedMatch[1] ?? "";
      const completed = /[\u2713\u2714\u2611\u2612xX]/.test(marker);
      entries.push({
        id: `${completedMatch[2]}-${entries.length}`,
        label: completedMatch[3].trim(),
        completed,
        active: false,
      });
      continue;
    }

    const activeMatch = line.match(TODO_ACTIVE_RE);
    if (activeMatch) {
      entries.push({
        id: `${activeMatch[1]}-${entries.length}`,
        label: activeMatch[2].trim(),
        completed: false,
        active: true,
      });
    }
  }

  const completed = titleMatch ? Number(titleMatch[1]) : entries.filter((entry) => entry.completed).length;
  const total = titleMatch ? Number(titleMatch[2]) : entries.length;
  return {
    title,
    entries,
    completed: Number.isFinite(completed) ? completed : 0,
    total: Number.isFinite(total) ? total : entries.length,
  };
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function TodoEntryRow({ entry }: { entry: TodoEntry }) {
  const color = entry.completed ? "#22c55e" : entry.active ? "var(--accent)" : "var(--text-dim)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr)",
        gap: 8,
        alignItems: "start",
        padding: "7px 9px",
        borderRadius: 7,
        background: entry.active ? "var(--bg-selected)" : "transparent",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          marginTop: 1,
          border: `1px solid ${entry.completed ? "#22c55e" : color}`,
          borderRadius: 4,
          background: entry.completed ? "rgba(34,197,94,0.13)" : "transparent",
          color,
          fontSize: 11,
          fontWeight: 900,
          lineHeight: 1,
        }}
      >
        {entry.completed ? "\u2713" : entry.active ? "\u2022" : ""}
      </span>
      <span
        style={{
          minWidth: 0,
          color: entry.completed ? "var(--text-muted)" : "var(--text)",
          fontSize: 12,
          lineHeight: 1.45,
          textDecoration: entry.completed ? "line-through" : undefined,
          overflowWrap: "anywhere",
        }}
      >
        {entry.label}
      </span>
    </div>
  );
}

function TodoProgress({ model }: { model: TodoModel }) {
  const percent = model.total > 0 ? Math.min(100, Math.max(0, (model.completed / model.total) * 100)) : 0;
  return (
    <div style={{ padding: "0 12px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 7 }}>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>Progress</span>
        <span style={{ color: percent === 100 ? "#22c55e" : "var(--accent)", fontSize: 11, fontWeight: 800 }}>
          {model.completed}/{model.total}
        </span>
      </div>
      <div style={{ height: 4, borderRadius: 999, background: "var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: percent === 100 ? "#22c55e" : "var(--accent)", transition: "width 180ms ease" }} />
      </div>
    </div>
  );
}

function TodoPanelBody({ model, onClose, mobile }: { model: TodoModel; onClose: () => void; mobile?: boolean }) {
  return (
    <div
      role="dialog"
      aria-label="Todo list"
      aria-modal={mobile ? true : undefined}
      style={{
        width: mobile ? "100%" : "min(360px, calc(100vw - 36px))",
        maxHeight: mobile ? "min(72dvh, 560px)" : "min(62dvh, 520px)",
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border)",
        borderRadius: mobile ? "16px 16px 0 0" : 14,
        background: "color-mix(in srgb, var(--bg-panel) 97%, transparent)",
        color: "var(--text)",
        boxShadow: "0 18px 42px rgba(0,0,0,0.2)",
        backdropFilter: "blur(12px)",
        overflow: "hidden",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span aria-hidden="true" style={{ color: model.completed === model.total && model.total > 0 ? "#22c55e" : "var(--accent)", fontSize: 16, lineHeight: 1 }}>{"\u2611"}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model.title}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>extension widget / todo-list</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close todo list"
          title="Close todo list"
          style={{ width: 28, height: 28, border: 0, borderRadius: 7, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
        >
          {"\u00d7"}
        </button>
      </div>
      <div style={{ overflowY: "auto", minHeight: 0, padding: "10px 6px 4px" }}>
        <TodoProgress model={model} />
        {model.entries.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {model.entries.map((entry) => <TodoEntryRow key={entry.id} entry={entry} />)}
          </div>
        ) : (
          <pre style={{ margin: 0, padding: "0 6px 10px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {model.title}
          </pre>
        )}
      </div>
    </div>
  );
}

interface TodoCapsuleProps {
  model: TodoModel;
  open: boolean;
  dragging: boolean;
  onClick: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
}

function TodoCapsule({ model, open, dragging, onClick, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: TodoCapsuleProps) {
  const complete = model.total > 0 && model.completed >= model.total;
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      aria-expanded={open}
      aria-label={open ? "Hide todo list" : "Show todo list"}
      title={open ? "Hide todo list" : "Show todo list"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minHeight: 36,
        padding: "0 11px",
        border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
        borderRadius: 999,
        background: "color-mix(in srgb, var(--bg-panel) 94%, transparent)",
        color: "var(--text)",
        boxShadow: "0 10px 26px rgba(0,0,0,0.16)",
        backdropFilter: "blur(10px)",
        cursor: dragging ? "grabbing" : "grab",
        fontSize: 12,
        fontWeight: 800,
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <span aria-hidden="true" style={{ color: complete ? "#22c55e" : "var(--accent)", fontSize: 15, lineHeight: 1 }}>{"\u2611"}</span>
      <span>Todo</span>
      <span style={{ color: complete ? "#22c55e" : "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{model.completed}/{model.total}</span>
      <span aria-hidden="true" style={{ color: "var(--text-dim)", fontSize: 12 }}>{open ? "\u2212" : "\u2304"}</span>
    </button>
  );
}

export function ExtensionTodoPanel({ item }: Props) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<WidgetPosition | null>(null);
  const [dragging, setDragging] = useState(false);
  const model = useMemo(() => item ? parseTodoWidget(item) : null, [item]);
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

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    if (!widget || !parent) return;

    const applyDefault = () => {
      const stored = readStoredPosition();
      const next = stored ?? getDefaultPosition(parent, widget);
      setPosition(clampPosition(next, parent, widget));
    };

    applyDefault();
    const resizeObserver = new ResizeObserver(() => {
      const latest = positionRef.current;
      if (latest) setPosition(clampPosition(latest, parent, widget));
      else applyDefault();
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

  const handlePointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    suppressClickRef.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }

    const widget = wrapperRef.current;
    const parent = widget?.parentElement;
    const latestPosition = positionRef.current;
    if (widget && parent && latestPosition) writeStoredPosition(clampPosition(latestPosition, parent, widget));
  }, []);

  const handleCapsuleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [item?.key]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);
  if (!model) return null;

  const mobilePanel = isMobile && open && typeof document !== "undefined"
    ? createPortal(
      <div
        style={{ position: "fixed", inset: 0, zIndex: 420, display: "flex", alignItems: "flex-end", background: "rgba(0,0,0,0.32)" }}
        onClick={close}
      >
        <TodoPanelBody model={model} onClose={close} mobile />
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div
        ref={wrapperRef}
        style={{
          position: "absolute",
          ...(position ? { left: position.left, top: position.top } : { left: TODO_WIDGET_MARGIN, bottom: TODO_WIDGET_BOTTOM }),
          zIndex: 140,
          pointerEvents: "auto",
        }}
      >
        {open && !isMobile && (
          <div style={{ position: "absolute", left: 0, bottom: "calc(100% + 8px)" }}>
            <TodoPanelBody model={model} onClose={close} />
          </div>
        )}
        <TodoCapsule
          model={model}
          open={open}
          dragging={dragging}
          onClick={handleCapsuleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      </div>
      {mobilePanel}
    </>
  );
}
