"use client";

import { memo, useEffect, useRef, useState } from "react";
import { FileExplorer } from "@/components/FileExplorer";
import { useI18n } from "@/components/I18nProvider";
import {
  clampNumber,
  DEFAULT_EXPLORER_HEIGHT,
  EXPLORER_RESIZE_STEP,
  EXPLORER_RESIZE_STEP_LARGE,
  MIN_EXPLORER_HEIGHT,
  MIN_SESSION_LIST_HEIGHT,
  readStoredExplorerHeight,
  writeStoredExplorerHeight,
} from "./sidebar-utils";

export interface SidebarExplorerPaneProps {
  cwd: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refreshKey: number;
  onRefresh: () => void;
  refreshDone: boolean;
  isDesktopLayout: boolean;
  sidebarRootRef: React.RefObject<HTMLDivElement | null>;
  onOpenFile?: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
}

export const SidebarExplorerPane = memo(function SidebarExplorerPane({
  cwd,
  open,
  onOpenChange,
  refreshKey,
  onRefresh,
  refreshDone,
  isDesktopLayout,
  sidebarRootRef,
  onOpenFile,
  onAtMention,
}: SidebarExplorerPaneProps) {
  const { t } = useI18n();
  const [explorerHeight, setExplorerHeight] = useState(DEFAULT_EXPLORER_HEIGHT);
  const [explorerResizing, setExplorerResizing] = useState(false);
  const explorerHeightRef = useRef(explorerHeight);

  useEffect(() => {
    explorerHeightRef.current = explorerHeight;
  }, [explorerHeight]);

  useEffect(() => {
    setExplorerHeight(readStoredExplorerHeight());
  }, []);

  const getExplorerHeightBounds = () => {
    const root = sidebarRootRef.current;
    if (!root) {
      return { min: MIN_EXPLORER_HEIGHT, max: Math.max(MIN_EXPLORER_HEIGHT, DEFAULT_EXPLORER_HEIGHT) };
    }
    const headerEl = root.firstElementChild as HTMLElement | null;
    const headerHeight = headerEl?.offsetHeight ?? 0;
    const max = Math.max(
      MIN_EXPLORER_HEIGHT,
      root.clientHeight - headerHeight - MIN_SESSION_LIST_HEIGHT,
    );
    return { min: MIN_EXPLORER_HEIGHT, max };
  };

  const clampExplorerHeight = (value: number) => {
    const { min, max } = getExplorerHeightBounds();
    return clampNumber(Math.round(value), min, max);
  };

  const commitExplorerHeight = (value: number, persist: boolean) => {
    const next = clampExplorerHeight(value);
    explorerHeightRef.current = next;
    setExplorerHeight(next);
    if (persist) writeStoredExplorerHeight(next);
    return next;
  };

  useEffect(() => {
    if (!isDesktopLayout || !open) return;
    const reclamp = () => {
      setExplorerHeight((current) => clampExplorerHeight(current));
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [open, isDesktopLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExplorerResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDesktopLayout || !open) return;
    event.preventDefault();
    event.stopPropagation();
    const root = sidebarRootRef.current;
    if (!root) return;

    const bottom = root.getBoundingClientRect().bottom;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    setExplorerResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      commitExplorerHeight(bottom - moveEvent.clientY, false);
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setExplorerResizing(false);
      writeStoredExplorerHeight(explorerHeightRef.current);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  const handleExplorerResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isDesktopLayout || !open) return;
    const step = event.shiftKey ? EXPLORER_RESIZE_STEP_LARGE : EXPLORER_RESIZE_STEP;
    let delta = 0;
    if (event.key === "ArrowUp") delta = step;
    else if (event.key === "ArrowDown") delta = -step;
    else return;
    event.preventDefault();
    commitExplorerHeight(explorerHeightRef.current + delta, true);
  };

  const explorerHeightBounds = getExplorerHeightBounds();
  const sizedExplorerOpen = Boolean(open && isDesktopLayout);
  const explorerSectionFlex = !open
    ? "0 0 auto"
    : sizedExplorerOpen
      ? `0 0 ${explorerHeight}px`
      : "1 1 0";

  return (
    <>
      {open && isDesktopLayout && (
        <div
          className={`panel-resize-handle panel-resize-handle-horizontal${explorerResizing ? " is-active" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          aria-valuemin={explorerHeightBounds.min}
          aria-valuemax={explorerHeightBounds.max}
          aria-valuenow={clampExplorerHeight(explorerHeight)}
          aria-label={t("sidebar.resizeExplorer")}
          title={t("sidebar.resizeExplorer")}
          tabIndex={0}
          onPointerDown={handleExplorerResizePointerDown}
          onKeyDown={handleExplorerResizeKeyDown}
        />
      )}
      <div
        className="session-sidebar-explorer"
        style={{
          borderTop: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flex: explorerSectionFlex,
          height: sizedExplorerOpen ? explorerHeight : undefined,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
          <button
            onClick={() => onOpenChange(!open)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              flex: 1,
              padding: "6px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              textAlign: "left",
            }}
          >
            <svg
              width="9" height="9" viewBox="0 0 10 10" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
            >
              <polyline points="3 2 7 5 3 8" />
            </svg>
            Explorer
          </button>
          <button
            onClick={onRefresh}
            title={t("sidebar.refreshExplorer")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, padding: 0, marginRight: 6,
              background: refreshDone ? "rgba(74,222,128,0.18)" : "none",
              border: "none",
              color: refreshDone ? "#4ade80" : "var(--text-dim)",
              cursor: "pointer",
              borderRadius: 5,
              flexShrink: 0,
              transition: "color 0.3s, background 0.3s",
            }}
            onMouseEnter={(e) => { if (refreshDone) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { if (refreshDone) return; e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
          >
            {refreshDone ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            )}
          </button>
        </div>
        {open && (
          <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
            <FileExplorer
              cwd={cwd}
              onOpenFile={onOpenFile ?? (() => {})}
              refreshKey={refreshKey}
              onAtMention={onAtMention}
            />
          </div>
        )}
      </div>
    </>
  );
});
