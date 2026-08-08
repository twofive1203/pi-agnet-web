"use client";

import { memo } from "react";
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";
import { formatRelativeTime } from "./sidebar-utils";
import { WorktreeBadge } from "./WorktreeBadge";

export interface SessionSearchResultsProps {
  loading: boolean;
  error: string | null;
  results: SessionInfo[];
  total: number;
  hasMore: boolean;
  query: string;
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo) => void;
}

/**
 * Flat workspace search results (active + archived). Intentionally not a fork tree
 * and not merged into the recent-session pagination window.
 */
export const SessionSearchResults = memo(function SessionSearchResults({
  loading,
  error,
  results,
  total,
  hasMore,
  query,
  selectedSessionId,
  onSelectSession,
}: SessionSearchResultsProps) {
  const { t, locale } = useI18n();
  const trimmed = query.trim();

  return (
    <div className="session-search-results">
      <div className="session-search-results-header">
        {t("sidebar.searchResultsTitle", { query: trimmed })}
      </div>

      {loading && (
        <div className="sidebar-list-state">{t("sidebar.searching")}</div>
      )}

      {!loading && error && (
        <div className="sidebar-list-state is-danger">{error}</div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="sidebar-list-state">{t("sidebar.noSearchResults")}</div>
      )}

      {!loading && !error && results.length > 0 && (
        <>
          {results.map((session) => {
            const title =
              session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
            const summary =
              session.name && session.firstMessage
                ? session.firstMessage
                : t("sidebar.messageCount", { count: session.messageCount });
            const isSelected = session.id === selectedSessionId;
            return (
              <div
                key={`${session.archived ? "a" : "s"}:${session.id}`}
                role="button"
                tabIndex={0}
                aria-current={isSelected ? "page" : undefined}
                className={`session-list-item session-search-result-item${isSelected ? " is-selected" : ""}${session.archived ? " is-archived" : ""}`}
                onClick={() => onSelectSession(session)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onSelectSession(session);
                }}
              >
                <div className="session-state-slot">
                  <span
                    className={`session-status-dot${isSelected ? " active" : ""}`}
                    aria-hidden="true"
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
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
                    <span
                      className={`session-search-status-badge${session.archived ? " is-archived" : " is-active"}`}
                    >
                      {session.archived
                        ? t("sidebar.searchResultArchived")
                        : t("sidebar.searchResultActive")}
                    </span>
                    <WorktreeBadge worktree={session.worktree} />
                    <span className="session-item-time" title={session.modified}>
                      {formatRelativeTime(session.modified, t, locale)}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      color: "var(--text-2)",
                      fontSize: 11.5,
                      lineHeight: 1.35,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {summary}
                  </div>
                </div>
              </div>
            );
          })}

          <div className="session-search-results-footer">
            {hasMore
              ? t("sidebar.searchTruncated", { shown: results.length, total })
              : t("sidebar.searchMatchCount", { count: total })}
          </div>
        </>
      )}
    </div>
  );
});
