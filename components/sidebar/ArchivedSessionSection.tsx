"use client";

import { memo, useCallback, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";
import { formatRelativeTime } from "./sidebar-utils";

export interface ArchivedSessionSectionProps {
  archivedCount: number;
  archivedExpanded: boolean;
  archivedSessions: SessionInfo[];
  archivedHasMore: boolean;
  loadingMoreArchived: boolean;
  onToggleExpanded: () => void;
  onSelect: (session: SessionInfo) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
  onLoadMore: () => void;
}

export const ArchivedSessionSection = memo(function ArchivedSessionSection({
  archivedCount,
  archivedExpanded,
  archivedSessions,
  archivedHasMore,
  loadingMoreArchived,
  onToggleExpanded,
  onSelect,
  onUnarchive,
  onDelete,
  onLoadMore,
}: ArchivedSessionSectionProps) {
  const { t } = useI18n();
  if (archivedCount <= 0) return null;

  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}>
      <button
        onClick={onToggleExpanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "10px 14px",
          background: "none",
          border: "none",
          color: "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: archivedExpanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}
        >
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
        <span>{t("sidebar.archivedSection", { count: archivedCount })}</span>
      </button>
      {archivedExpanded && archivedSessions.length > 0 && (
        <div>
          {archivedSessions.map((archivedSession) => (
            <ArchivedSessionItem
              key={archivedSession.id}
              session={archivedSession}
              onSelect={onSelect}
              onUnarchive={onUnarchive}
              onDelete={onDelete}
            />
          ))}
          {(archivedHasMore || archivedSessions.length > 0) && (
            <div style={{ padding: "6px 14px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {t("sidebar.shownOfTotal", {
                  loaded: archivedSessions.length,
                  total: archivedCount,
                })}
              </div>
              {archivedHasMore && (
                <button
                  type="button"
                  onClick={() => void onLoadMore()}
                  disabled={loadingMoreArchived}
                  style={{
                    alignSelf: "flex-start",
                    padding: "6px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text-muted)",
                    cursor: loadingMoreArchived ? "not-allowed" : "pointer",
                    fontSize: 11,
                    fontWeight: 600,
                    opacity: loadingMoreArchived ? 0.7 : 1,
                  }}
                >
                  {loadingMoreArchived ? t("sidebar.loadingMore") : t("sidebar.loadOlder")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const ArchivedSessionItem = memo(function ArchivedSessionItem({
  session,
  onSelect,
  onUnarchive,
  onDelete,
}: {
  session: SessionInfo;
  /** Parent-stable handler; item binds session locally so memo stays effective. */
  onSelect: (session: SessionInfo) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const title = session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);

  const handleSelect = useCallback(() => {
    onSelect(session);
  }, [onSelect, session]);

  const handleUnarchiveClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnarchive(session.id);
  }, [session.id, onUnarchive]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
    setDeleting(true);
    try {
      fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })
        .then(() => onDelete(session.id))
        .catch(() => setDeleting(false));
    } catch {
      setDeleting(false);
    }
  }, [session.id, onDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const ITEM_HEIGHT = 54;

  return (
    <div
      onClick={confirmDelete ? undefined : handleSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: 14,
        paddingRight: 8,
        cursor: confirmDelete ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete ? "2px solid #ef4444" : "2px solid transparent",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Delete <span style={{ fontWeight: 600 }}>&ldquo;{title.slice(0, 22)}{title.length > 22 ? "…" : ""}&rdquo;</span>?
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button onClick={handleDeleteConfirm} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, height: 30, padding: "0 11px", background: "#ef4444", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              Delete
            </button>
            <button onClick={handleDeleteCancel} style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 30, padding: "0 11px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <div style={{ flex: 1, minWidth: 0, fontStyle: "italic" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  lineHeight: 1.4,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text-dim)",
                  minWidth: 0,
                }}
                title={title}
              >
                {title}
              </div>
            </div>
            <div style={{ marginTop: 2, display: "flex", gap: 8, color: "var(--text-dim)", fontSize: 11 }}>
              <span title={session.modified}>{formatRelativeTime(session.modified, t)}</span>
              <span>{session.messageCount} msgs</span>
            </div>
          </div>
          {hovered && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={handleUnarchiveClick}
                title={t("common.unarchive")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 4, height: 30, padding: "0 10px",
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(37,99,235,0.08)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {t("common.restore")}
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("common.delete")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
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
