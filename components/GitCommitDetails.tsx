"use client";

import { useI18n } from "@/components/I18nProvider";
import type { GitCommitChangedFile, GitCommitDetail } from "@/lib/types";

function gitStatusTone(status: string): string {
  if (["M", "A", "R", "C"].includes(status)) return "is-success";
  if (status === "D") return "is-danger";
  if (["T", "U"].includes(status)) return "is-warning";
  return "is-muted";
}

function formatRefLabel(ref: GitCommitDetail["refs"][number]): string {
  if (ref.type === "tag") return `tag:${ref.name}`;
  if (ref.type === "head") return `HEAD:${ref.name}`;
  return ref.name;
}

export function GitCommitChangedFileRow({
  file,
  onOpenDiff,
}: {
  file: GitCommitChangedFile;
  onOpenDiff: (file: GitCommitChangedFile) => void;
}) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => onOpenDiff(file)} title={t("git.openDiff")} className="git-commit-file-row">
      <span className={`git-commit-file-code ${gitStatusTone(file.status)}`}>{file.status}</span>
      <span className="git-file-path">{file.oldFile ? `${file.oldFile} → ${file.file}` : file.file}</span>
      {file.binary ? (
        <span className="git-file-status">{t("git.binary")}</span>
      ) : (typeof file.additions === "number" || typeof file.deletions === "number") ? (
        <span className="git-file-metrics">
          {typeof file.additions === "number" && <span className="is-success">+{file.additions}</span>}
          {typeof file.deletions === "number" && <span className="is-danger">-{file.deletions}</span>}
        </span>
      ) : null}
      <span className="git-file-status">{t(`git.status.${file.status}`)}</span>
    </button>
  );
}

export function GitCommitDetails({
  detail,
  loading,
  error,
  onOpenDiff,
  onRetry,
  showFiles = true,
}: {
  detail: GitCommitDetail | null;
  loading: boolean;
  error: string | null;
  onOpenDiff?: (file: GitCommitChangedFile) => void;
  onRetry?: () => void;
  showFiles?: boolean;
}) {
  const { t } = useI18n();
  if (loading) return <div className="inspector-state inspector-state-loading git-detail-state">{t("git.loadingCommit")}</div>;
  if (error) {
    return (
      <div className="inspector-state inspector-state-error git-detail-state" role="alert">
        <div>{error}</div>
        {onRetry && <button type="button" onClick={onRetry} className="git-switch-button">{t("git.retry")}</button>}
      </div>
    );
  }
  if (!detail) return <div className="inspector-state inspector-state-empty git-detail-state">{t("git.selectCommit")}</div>;

  return (
    <div className="git-commit-detail">
      <div className="git-commit-subject">{detail.subject || "(no subject)"}</div>
      {detail.body && <div className="git-commit-body">{detail.body}</div>}
      <div className="git-commit-meta">
        <span>{t("git.hash")}</span>
        <code title={detail.hash}>{detail.hash}</code>
        <span>{t("git.author")}</span>
        <span>{detail.author.name} &lt;{detail.author.email}&gt; · {detail.author.date}</span>
        <span>{t("git.committer")}</span>
        <span>{detail.committer.name} &lt;{detail.committer.email}&gt; · {detail.committer.date}</span>
        <span>{t("git.parents")}</span>
        <code>{detail.parents.length > 0 ? detail.parents.map((parent) => parent.slice(0, 8)).join(", ") : "—"}</code>
      </div>
      {detail.refs.length > 0 && (
        <div className="git-ref-list">
          {detail.refs.map((ref) => <span key={`${ref.type}-${ref.name}`} className="git-ref-badge">{formatRefLabel(ref)}</span>)}
        </div>
      )}
      {detail.parents.length > 1 && <div className="git-detail-hint">{t("git.workbench.firstParentHint")}</div>}
      {showFiles && (
        <>
          <div className="git-commit-files-header">
            <div className="inspector-section-title">{t("git.changedFiles")} <span>({detail.files.length})</span></div>
            <div className="git-detail-hint">{t("git.doubleClickHint")}</div>
          </div>
          {detail.files.length > 0 && onOpenDiff ? (
            <div className="git-commit-files-list">
              {detail.files.map((file) => (
                <GitCommitChangedFileRow key={`${file.status}-${file.oldFile ?? ""}-${file.file}`} file={file} onOpenDiff={onOpenDiff} />
              ))}
            </div>
          ) : <div className="git-empty-inline">{t("git.noFirstParentChanges")}</div>}
        </>
      )}
    </div>
  );
}
