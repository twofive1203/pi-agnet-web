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
        <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
          {error}
        </div>
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
                color: selectedForArchive.size === 0 ? "var(--text-dim)" : "#fff",
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

const SessionItem = memo(function SessionItem({
  session,
  isSelected,
  onClick,
  onRenamed,
  onDeleted,
  onArchive,
  onContextMenu,
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
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  selectedForArchive?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
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
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

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
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={(event) => {
        if (confirmDelete || renaming) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu?.(event, session);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      className={`session-list-item${isSelected ? " is-selected" : ""}`}
      style={{
        position: "relative",
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        margin: "0 8px 4px",
        paddingLeft: depth > 0 ? depth * 12 + 10 : 10,
        paddingRight: 10,
        borderRadius: 12,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--accent-soft)" : hovered ? "var(--bg-hover)" : "transparent",
        border: confirmDelete
          ? "1px solid rgba(239,68,68,0.35)"
          : isSelected ? "1px solid color-mix(in srgb, var(--accent) 28%, transparent)" : "1px solid transparent",
        transition: "background 0.1s, border-color 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 8,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Delete <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Delete
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              Cancel
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
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, flexShrink: 0 }}
          >
            {onToggleSelect && (hovered || selectedForArchive) ? (
              <input
                type="checkbox"
                checked={!!selectedForArchive}
                onChange={() => onToggleSelect(session.id)}
                style={{ width: 14, height: 14, cursor: "pointer", accentColor: "var(--accent)" }}
              />
            ) : (
              <span className={`session-status-dot${isSelected ? " active" : ""}`} />
            )}
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
              {!hovered && (
                <span title={session.modified} style={{ color: "var(--text-3)", fontSize: 10.5, flexShrink: 0 }}>
                  {formatRelativeTime(session.modified, t)}
                </span>
              )}
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

          {/* Action buttons — shown on hover */}
          {hovered && (
            <div className="session-item-actions" style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={t("common.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
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
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, padding: 0,
                    background: "var(--bg-hover)", border: "1px solid var(--border)",
                    borderRadius: 7, color: "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0,
                    transition: "background 0.12s, color 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-selected)";
                    e.currentTarget.style.color = "var(--accent)";
                    e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text-muted)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
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
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});
