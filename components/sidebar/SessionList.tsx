"use client";

import { memo, useCallback, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { SidebarSessionTreeNode } from "@/lib/sidebar-session-tree";
import { useI18n } from "@/components/I18nProvider";
import { formatRelativeTime } from "./sidebar-utils";
import { WorktreeBadge } from "./WorktreeBadge";

export type SessionTreeNode = SidebarSessionTreeNode;

export interface SessionListProps {
  loading: boolean;
  error: string | null;
  sessionTree: SessionTreeNode[];
  filteredSessions: SessionInfo[];
  selectedSessionId: string | null;
  projectSessionTotal: number;
  hasMoreSessions: boolean;
  loadingMore: boolean;
  selectedForArchive: Set<string>;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (id: string) => void;
  onArchive: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, session: SessionInfo) => void;
  onToggleSelect: (id: string) => void;
  onLoadMore: () => void;
  onClearSelection: () => void;
  onBatchArchive: () => void;
  /** Surface rename/delete HTTP failures without mutating list state first. */
  onActionError?: (message: string) => void;
}

export const SessionList = memo(function SessionList({
  loading,
  error,
  sessionTree,
  filteredSessions,
  selectedSessionId,
  projectSessionTotal,
  hasMoreSessions,
  loadingMore,
  selectedForArchive,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onArchive,
  onContextMenu,
  onToggleSelect,
  onLoadMore,
  onClearSelection,
  onBatchArchive,
  onActionError,
}: SessionListProps) {
  const { t } = useI18n();
  const groupedSessionTree = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const todayStart = today.getTime();
    const yesterdayStart = yesterday.getTime();
    const groups = [
      { label: t("sidebar.today"), nodes: [] as SessionTreeNode[] },
      { label: t("sidebar.yesterday"), nodes: [] as SessionTreeNode[] },
      { label: t("sidebar.earlier"), nodes: [] as SessionTreeNode[] },
    ];
    for (const node of sessionTree) {
      const modified = new Date(node.session.modified).getTime();
      if (Number.isFinite(modified) && modified >= todayStart) groups[0].nodes.push(node);
      else if (Number.isFinite(modified) && modified >= yesterdayStart) groups[1].nodes.push(node);
      else groups[2].nodes.push(node);
    }
    return groups.filter((group) => group.nodes.length > 0);
  }, [sessionTree, t]);

  return (
    <>
      {loading && (
        <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
          {t("sidebar.loading")}
        </div>
      )}
      {error && (
        <div className="sidebar-list-state is-danger">{error}</div>
      )}
      {!loading && !error && filteredSessions.length === 0 && (
        <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
          {t("sidebar.noSessions")}
        </div>
      )}
      {groupedSessionTree.map((group) => (
        <div key={group.label} className="session-day-group">
          <div className="session-day-label">{group.label}</div>
          {group.nodes.map((node) => (
            <SessionTreeItem
              key={node.session.id}
              node={node}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onArchive={onArchive}
              onContextMenu={onContextMenu}
              onActionError={onActionError}
              depth={0}
              selectedForArchive={selectedForArchive}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      ))}

      {!loading && !error && filteredSessions.length > 0 && projectSessionTotal > 0 && (
        <div style={{ padding: "8px 14px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("sidebar.shownOfTotal", {
              loaded: filteredSessions.length,
              total: projectSessionTotal,
            })}
          </div>
          {hasMoreSessions && (
            <button
              type="button"
              onClick={() => void onLoadMore()}
              disabled={loadingMore}
              style={{
                alignSelf: "flex-start",
                padding: "6px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-muted)",
                cursor: loadingMore ? "not-allowed" : "pointer",
                fontSize: 11,
                fontWeight: 600,
                opacity: loadingMore ? 0.7 : 1,
              }}
            >
              {loadingMore ? t("sidebar.loadingMore") : t("sidebar.loadOlder")}
            </button>
          )}
        </div>
      )}

      {selectedForArchive.size > 0 && (
        <div style={{
          borderTop: "1px solid var(--border)",
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {t("sidebar.selectedSessions", { count: selectedForArchive.size })}
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={onClearSelection}
              style={{ padding: "6px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 500 }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => void onBatchArchive()}
              disabled={selectedForArchive.size === 0}
              style={{
                padding: "6px 12px", borderRadius: 7, border: "none",
                background: selectedForArchive.size === 0 ? "var(--border)" : "var(--accent)",
                color: selectedForArchive.size === 0 ? "var(--text-dim)" : "var(--text-inverse)",
                cursor: selectedForArchive.size === 0 ? "not-allowed" : "pointer",
                fontSize: 11, fontWeight: 600,
              }}
            >
              {selectedForArchive.size > 0 ? t("sidebar.archiveWithCount", { count: selectedForArchive.size }) : t("common.archive")}
            </button>
          </div>
        </div>
      )}
    </>
  );
});

const SessionTreeItem = memo(function SessionTreeItem({
  node,
  selectedSessionId,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onArchive,
  onContextMenu,
  onActionError,
  depth,
  selectedForArchive,
  onToggleSelect,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  onArchive?: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent, session: SessionInfo) => void;
  onActionError?: (message: string) => void;
  depth: number;
  selectedForArchive?: Set<string>;
  onToggleSelect?: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  // Keep SessionItem props identity-stable across common parent renders
  // (selection / archive multi-select), so React.memo can skip unaffected rows.
  const handleClick = useCallback(() => {
    onSelectSession(node.session);
  }, [onSelectSession, node.session]);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((v) => !v);
  }, []);

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          onClick={handleClick}
          onRenamed={onRenamed}
          onDeleted={onSessionDeleted}
          onArchive={onArchive}
          onContextMenu={onContextMenu}
          onActionError={onActionError}
          depth={depth}
          hasChildren={hasChildren}
          selectedForArchive={selectedForArchive?.has(node.session.id)}
          onToggleSelect={onToggleSelect}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onArchive={onArchive}
              onContextMenu={onContextMenu}
              onActionError={onActionError}
              depth={depth + 1}
              selectedForArchive={selectedForArchive}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
});

async function readSessionActionError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    // ignore
  }
  return fallback;
}

const SessionItem = memo(function SessionItem({
  session,
  isSelected,
  onClick,
  onRenamed,
  onDeleted,
  onArchive,
  onContextMenu,
  onActionError,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  selectedForArchive,
  onToggleSelect,
}: {
  session: SessionInfo;
  isSelected: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  onArchive?: (id: string) => void;
  onContextMenu?: (event: React.MouseEvent, session: SessionInfo) => void;
  onActionError?: (message: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  selectedForArchive?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        onActionError?.(await readSessionActionError(res, t("sidebar.renameFailed")));
        return;
      }
      onRenamed?.();
    } catch (e) {
      onActionError?.(e instanceof Error ? e.message : String(e));
    }
  }, [renameValue, session.id, session.name, onRenamed, onActionError, t]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!res.ok) {
        setDeleting(false);
        onActionError?.(await readSessionActionError(res, t("sidebar.deleteFailed")));
        return;
      }
      onDeleted?.(session.id);
    } catch (e) {
      setDeleting(false);
      onActionError?.(e instanceof Error ? e.message : String(e));
    }
  }, [session.id, onDeleted, onActionError, t]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleArchiveClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onArchive?.(session.id);
  }, [session.id, onArchive]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows.
  const ITEM_HEIGHT = 62;
  const summary = session.name && session.firstMessage
    ? session.firstMessage
    : t("sidebar.messageCount", { count: session.messageCount });

  return (
    <div
      role="button"
      tabIndex={confirmDelete || renaming ? -1 : 0}
      aria-current={isSelected ? "page" : undefined}
      onClick={confirmDelete || renaming ? undefined : onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (confirmDelete || renaming || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onClick();
      }}
      onContextMenu={(event) => {
        if (confirmDelete || renaming) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event, session);
      }}
      className={`session-list-item${isSelected ? " is-selected" : ""}${confirmDelete ? " is-confirming" : ""}${deleting ? " is-deleting" : ""}`}
      style={{
        height: ITEM_HEIGHT,
        paddingLeft: depth > 0 ? depth * 12 + 10 : 10,
        cursor: confirmDelete || renaming ? "default" : "pointer",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div className="session-delete-copy">
            {t("sidebar.deleteInlineConfirm", { title: `${title.slice(0, 22)}${title.length > 22 ? "…" : ""}` })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              className="sidebar-inline-button is-danger"
              onClick={handleDeleteConfirm}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("common.delete")}
            </button>
            <button
              className="sidebar-inline-button"
              onClick={handleDeleteCancel}
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Preserve multi-select without making every row look like a checklist. */}
          <div
            className="session-state-slot"
            onClick={(e) => e.stopPropagation()}
          >
            {onToggleSelect && (
              <input
                className="session-select-checkbox"
                type="checkbox"
                checked={!!selectedForArchive}
                aria-label={`${t("sidebar.multiSelect")}: ${title}`}
                onChange={() => onToggleSelect(session.id)}
              />
            )}
            <span className={`session-status-dot${isSelected ? " active" : ""}`} aria-hidden="true" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              {depth > 0 && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              )}
              <div
                style={{
                  flex: 1,
                  fontSize: 12.5,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text)",
                  minWidth: 0,
                }}
                title={title}
              >
                {title}
              </div>
              <WorktreeBadge worktree={session.worktree} />
              <span className="session-item-time" title={session.modified}>
                {formatRelativeTime(session.modified, t, locale)}
              </span>
            </div>
            <div style={{ marginTop: 3, color: "var(--text-2)", fontSize: 11.5, lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {summary}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Actions stay mounted so keyboard focus and touch do not depend on hover. */}
          <div className="session-item-actions">
              <button
                onClick={startRename}
                title={t("common.rename")}
                className="sidebar-row-action"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              {/* Archive button — only for active (non-archived) sessions */}
              {!session.archived && (
                <button
                  onClick={handleArchiveClick}
                  title={t("common.archive")}
                  className="sidebar-row-action"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
              )}
              <button
                onClick={handleDeleteClick}
                title={t("common.delete")}
                className="sidebar-row-action is-danger"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
          </div>
        </>
      )}
    </div>
  );
});
