"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useI18n } from "@/components/I18nProvider";
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
  const stateClass = entry.completed ? "is-completed" : entry.active ? "is-active" : "";
  return (
    <div className={`extension-todo-entry ${stateClass}`.trim()}>
      <span className="extension-todo-checkbox" aria-hidden="true">
        {entry.completed ? "\u2713" : entry.active ? "\u2022" : ""}
      </span>
      <span className="extension-todo-entry-label">{entry.label}</span>
    </div>
  );
}

function TodoProgress({ model }: { model: TodoModel }) {
  const { t } = useI18n();
  const percent = model.total > 0 ? Math.min(100, Math.max(0, (model.completed / model.total) * 100)) : 0;
  const complete = percent === 100;
  return (
    <div className="extension-todo-progress">
      <div className="extension-todo-progress-meta">
        <span>{t("chat.progress")}</span>
        <span className={complete ? "extension-todo-count is-complete" : "extension-todo-count"}>{model.completed}/{model.total}</span>
      </div>
      <div className="extension-todo-progress-track">
        <div className={complete ? "extension-todo-progress-value is-complete" : "extension-todo-progress-value"} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function TodoPanelBody({ model, onClose, mobile }: { model: TodoModel; onClose: () => void; mobile?: boolean }) {
  const { t } = useI18n();
  const complete = model.completed === model.total && model.total > 0;
  return (
    <div
      className={mobile ? "extension-todo-panel is-mobile" : "extension-todo-panel"}
      role="dialog"
      aria-label={t("chat.todoList")}
      aria-modal={mobile ? true : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="extension-todo-header">
        <span className={complete ? "extension-todo-icon is-complete" : "extension-todo-icon"} aria-hidden="true">{"\u2611"}</span>
        <div className="extension-todo-title-wrap">
          <div className="extension-todo-title">{model.title}</div>
          <div className="extension-todo-source">extension widget / todo-list</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.closeTodoList")}
          title={t("chat.closeTodoList")}
          className="extension-todo-close"
        >
          {"\u00d7"}
        </button>
      </div>
      <div className="extension-todo-content">
        <TodoProgress model={model} />
        {model.entries.length > 0 ? (
          <div className="extension-todo-list">
            {model.entries.map((entry) => <TodoEntryRow key={entry.id} entry={entry} />)}
          </div>
        ) : (
          <pre className="extension-todo-empty">
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
  const { t } = useI18n();
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
      aria-label={open ? t("chat.hideTodoList") : t("chat.showTodoList")}
      title={open ? t("chat.hideTodoList") : t("chat.showTodoList")}
      className={[
        "extension-todo-capsule",
        complete ? "is-complete" : "",
        dragging ? "is-dragging" : "",
      ].filter(Boolean).join(" ")}
    >
      <span className="extension-todo-capsule-icon" aria-hidden="true">{"\u2611"}</span>
      <span>{t("chat.todo")}</span>
      <span className="extension-todo-capsule-count">{model.completed}/{model.total}</span>
      <span className="extension-todo-capsule-chevron" aria-hidden="true">{open ? "\u2212" : "\u2304"}</span>
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
      <div className="extension-todo-mobile-overlay" onClick={close}>
        <TodoPanelBody model={model} onClose={close} mobile />
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div
        ref={wrapperRef}
        className="extension-todo-floating"
        style={position ? { left: position.left, top: position.top } : { left: TODO_WIDGET_MARGIN, bottom: TODO_WIDGET_BOTTOM }}
      >
        {open && !isMobile && (
          <div className="extension-todo-desktop-panel">
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
