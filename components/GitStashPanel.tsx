"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { GitStashDiffModal } from "@/components/GitStashDiffModal";
import type { GitStashDialogRequest } from "@/components/GitStashDialogs";
import type { GitStashClientError } from "@/lib/git-stash-client";
import type { GitStashDetailResponse, GitStashFile, GitStashListResponse } from "@/lib/types";

function statusTone(status: string): string {
  if (["M", "A", "R", "C"].includes(status)) return "is-success";
  if (status === "D") return "is-danger";
  if (["T", "U"].includes(status)) return "is-warning";
  return "is-muted";
}

export function GitStashPanel({
  cwd,
  projection,
  selectedOid,
  detail,
  listLoading,
  detailLoading,
  listError,
  detailError,
  operationError,
  operationBusy,
  agentRunning,
  onSelect,
  onRefresh,
  onRequestAction,
}: {
  cwd: string;
  projection: GitStashListResponse | null;
  selectedOid: string | null;
  detail: GitStashDetailResponse | null;
  listLoading: boolean;
  detailLoading: boolean;
  listError: string | null;
  detailError: string | null;
  operationError: GitStashClientError | null;
  operationBusy: boolean;
  agentRunning: boolean;
  onSelect: (oid: string) => void;
  onRefresh: () => void;
  onRequestAction: (request: GitStashDialogRequest) => void;
}) {
  const { locale, t } = useI18n();
  const [diffFile, setDiffFile] = useState<GitStashFile | null>(null);
  const [nowSeconds, setNowSeconds] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNowSeconds(Math.floor(Date.now() / 1_000));
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const selectedEntry = projection?.entries.find((entry) => entry.oid === selectedOid) ?? null;
  const targetLabel = projection?.target.isDetached
    ? t("git.stashManager.detachedTarget", { hash: projection.target.head?.slice(0, 8) ?? "?" })
    : projection?.target.branch ?? t("git.stashManager.unknownTarget");
  const applyBlocked = Boolean(
    agentRunning
    || projection?.target.isDirty
    || projection?.target.hasUnmerged
    || projection?.target.operationState,
  );
  const applyBlockedTitle = agentRunning
    ? t("git.stashManager.agentRunningDisabled")
    : projection?.target.operationState
      ? t("git.stashManager.operationDisabled", { state: projection.target.operationState })
      : projection?.target.isDirty || projection?.target.hasUnmerged
        ? t("git.stashManager.cleanRequired")
        : undefined;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }), [locale]);
  const relativeFormatter = useMemo(() => new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto" }), [locale]);
  const formatRelative = (timestamp: number) => {
    if (nowSeconds === null) return dateFormatter.format(new Date(timestamp * 1_000));
    const seconds = timestamp - nowSeconds;
    if (Math.abs(seconds) < 60) return relativeFormatter.format(seconds, "second");
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return relativeFormatter.format(hours, "hour");
    return relativeFormatter.format(Math.round(hours / 24), "day");
  };

  if (!projection && listLoading) {
    return <div className="inspector-state inspector-state-loading">{t("git.stashManager.loading")}</div>;
  }
  if (!projection && listError) {
    return (
      <div className="inspector-state inspector-state-error" role="alert">
        <div>{listError}</div>
        <button type="button" className="git-switch-button" onClick={onRefresh}>{t("git.retry")}</button>
      </div>
    );
  }
  if (!projection) return null;

  return (
    <div className="git-stash-panel">
      <section className="inspector-section git-stash-target">
        <div>
          <div className="inspector-section-title">{t("git.stashManager.currentTarget")}</div>
          <div className="git-stash-target-row">
            <strong>{targetLabel}</strong>
            {projection.target.isWorktree && <span className="inspector-badge is-info">worktree</span>}
            {projection.target.isDirty && <span className="inspector-badge is-warning">{t("git.dirty")}</span>}
          </div>
          <div className="git-stash-help">{t("git.stashManager.sharedRepositoryHelp")}</div>
        </div>
        <button type="button" className="git-refresh-button" onClick={onRefresh} disabled={listLoading || operationBusy} title={t("git.stashManager.refresh")}>
          <svg className={listLoading ? "is-spinning" : undefined} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </section>

      {operationError && (
        <div className={`git-stash-banner${operationError.code === "STASH_CONFLICT" ? " is-warning" : " is-error"}`} role="alert">
          <strong>{t(`git.stashManager.errors.${operationError.code}`)}</strong>
          {operationError.code === "STASH_CONFLICT" && <span>{t("git.stashManager.conflictHelp")}</span>}
          {operationError.details && <details><summary>{t("git.workbench.errorDetails")}</summary><pre>{operationError.details}</pre></details>}
        </div>
      )}

      <section className="inspector-section">
        <div className="inspector-section-title">
          {t("git.stashManager.entries")} <span>({projection.totalCount})</span>
        </div>
        {projection.entries.length === 0 ? (
          <div className="inspector-state inspector-state-empty">{t("git.noStash")}</div>
        ) : (
          <div className="git-stash-list" role="listbox" aria-label={t("git.stashManager.entries")}>
            {projection.entries.map((entry) => {
              const absolute = dateFormatter.format(new Date(entry.createdAt));
              const selected = entry.oid === selectedOid;
              return (
                <button
                  key={entry.oid}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`git-stash-row${selected ? " is-selected" : ""}`}
                  onClick={() => onSelect(entry.oid)}
                  title={`${entry.subject}\n${absolute}`}
                >
                  <span className="git-stash-row-main"><strong>{entry.name}</strong><code>{entry.displayRef}</code></span>
                  <span className="git-stash-row-meta">
                    <span>{entry.sourceBranch ?? t("git.stashManager.unknownSource")}</span>
                    <time dateTime={entry.createdAt}>{formatRelative(entry.timestamp)}</time>
                    {selected && detail?.entry.oid === entry.oid && <span>{t("git.stashManager.fileCount", { count: detail.fileCount })}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {projection.truncated && <div className="git-stash-truncated">{t("git.stashManager.listTruncated", { count: projection.entries.length })}</div>}
      </section>

      {selectedEntry && (
        <section className="inspector-section git-stash-detail">
          <div className="git-stash-detail-header">
            <div>
              <div className="inspector-section-title">{selectedEntry.name}</div>
              <div className="git-stash-detail-meta">
                <code>{selectedEntry.shortOid}</code>
                <span>{t("git.stashManager.createdOn", { branch: selectedEntry.sourceBranch ?? t("git.stashManager.unknownSource") })}</span>
                <span>{t("git.stashManager.appliesTo", { target: targetLabel })}</span>
              </div>
            </div>
            <div className="git-stash-actions">
              <button
                type="button"
                className="git-switch-button"
                disabled={operationBusy || applyBlocked}
                title={applyBlockedTitle}
                onClick={(event) => onRequestAction({ type: "action", action: "apply", entry: selectedEntry, trigger: event.currentTarget, expectedRevision: projection.revision, expectedTargetRevision: projection.target.revision, targetLabel })}
              >{t("git.stashManager.apply")}</button>
              <button
                type="button"
                className="git-switch-button"
                disabled={operationBusy || applyBlocked}
                title={applyBlockedTitle}
                onClick={(event) => onRequestAction({ type: "action", action: "pop", entry: selectedEntry, trigger: event.currentTarget, expectedRevision: projection.revision, expectedTargetRevision: projection.target.revision, targetLabel })}
              >{t("git.stashManager.pop")}</button>
              <button
                type="button"
                className="git-stash-drop-button"
                disabled={operationBusy || Boolean(projection.target.operationState)}
                onClick={(event) => onRequestAction({ type: "action", action: "drop", entry: selectedEntry, trigger: event.currentTarget, expectedRevision: projection.revision, expectedTargetRevision: projection.target.revision, targetLabel })}
              >{t("git.stashManager.drop")}</button>
            </div>
          </div>

          {detailLoading ? <div className="inspector-state inspector-state-loading">{t("git.stashManager.loadingFiles")}</div>
            : detailError ? <div className="inspector-state inspector-state-error" role="alert">{detailError}</div>
              : detail ? (
                <>
                  {detail.files.length === 0 ? <div className="git-empty-inline">{t("git.stashManager.noFiles")}</div> : (
                    <div className="git-file-list git-stash-file-list">
                      {detail.files.map((file) => (
                        <button
                          key={`${file.source}:${file.oldFile ?? ""}:${file.file}`}
                          type="button"
                          className="git-file-row git-file-row-button"
                          onClick={() => setDiffFile(file)}
                          title={t("git.stashManager.openDiff")}
                        >
                          <span className={`git-status-dot ${statusTone(file.status)}`} />
                          <span className="git-file-path">{file.oldFile ? `${file.oldFile} → ${file.file}` : file.file}</span>
                          <span className="git-file-status">{file.source === "untracked" ? t("git.stashManager.untrackedShort") : t(`git.status.${file.status}`)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {detail.filesTruncated && <div className="git-stash-truncated">{t("git.stashManager.filesTruncated", { count: detail.files.length })}</div>}
                </>
              ) : null}
        </section>
      )}

      {diffFile && selectedEntry && (
        <GitStashDiffModal cwd={cwd} entry={selectedEntry} file={diffFile} onClose={() => setDiffFile(null)} />
      )}
    </div>
  );
}
