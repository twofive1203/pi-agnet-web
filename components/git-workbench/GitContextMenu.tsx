"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface GitContextMenuItem {
  id: string;
  label: string;
  reason?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export function GitContextMenu({
  x,
  y,
  trigger,
  items,
  onClose,
}: {
  x: number;
  y: number;
  trigger: HTMLElement;
  items: GitContextMenuItem[];
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const enabled = useMemo(() => items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled), [items]);
  const menuWidth = 290;
  const menuHeight = Math.min(items.length * 44 + 10, 520);
  const left = typeof window === "undefined" ? x : Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = typeof window === "undefined" ? y : Math.max(8, Math.min(y, (window.visualViewport?.height ?? window.innerHeight) - menuHeight - 8));

  const close = useCallback((restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) window.requestAnimationFrame(() => trigger.focus());
  }, [onClose, trigger]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;
    const frame = requestAnimationFrame(() => {
      const firstIndex = enabled[0]?.index;
      if (firstIndex !== undefined) menuRef.current?.querySelectorAll<HTMLButtonElement>("button")[firstIndex]?.focus();
      else menuRef.current?.focus();
    });
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [close, enabled, mounted]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const enabledIndexes = enabled.map(({ index }) => index);
    const activePosition = enabledIndexes.indexOf(current);
    const nextPosition = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabledIndexes.length - 1
        : (activePosition + (event.key === "ArrowDown" ? 1 : -1) + enabledIndexes.length) % enabledIndexes.length;
    buttons[enabledIndexes[nextPosition]]?.focus();
  }, [close, enabled]);

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className="git-workbench-context-menu"
      style={{ left, top }}
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-disabled={item.disabled || undefined}
          disabled={item.disabled}
          className={`git-workbench-context-item${item.danger ? " is-danger" : ""}`}
          title={item.reason}
          onClick={() => {
            if (item.disabled) return;
            close(false);
            item.onSelect();
          }}
        >
          <span>{item.label}</span>
          {item.reason && <small>{item.reason}</small>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
