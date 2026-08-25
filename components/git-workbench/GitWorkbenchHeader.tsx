"use client";

import Link from "next/link";
import { useI18n } from "@/components/I18nProvider";
import type { GitWorkbenchOverview } from "@/lib/types";

export function GitWorkbenchHeader({
  overview,
  cwd,
  loading,
  onRefresh,
}: {
  overview: GitWorkbenchOverview | null;
  cwd: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="git-workbench-header">
      <Link href="/" className="git-workbench-icon-button" aria-label={t("git.workbench.back")} title={t("git.workbench.back")}>
        ←
      </Link>
      <div className="git-workbench-header-copy">
        <strong>{overview?.repositoryName ?? t("git.workbench.title")}</strong>
        <span title={overview?.repoRoot ?? cwd}>{overview?.repoRoot ?? cwd}</span>
      </div>
      <div className="git-workbench-header-badges">
        <span className="git-workbench-badge">{overview?.currentBranch ?? (overview?.isDetached ? t("git.workbench.detached") : "—")}</span>
        {overview?.isDirty && <span className="git-workbench-badge is-warning">{t("git.dirty")}</span>}
        {overview?.isWorktree && <span className="git-workbench-badge is-info">{t("git.worktreeBadge")}</span>}
        <span className="git-workbench-badge is-muted" title={t("git.workbench.remoteSnapshotHelp")}>{t("git.workbench.remoteSnapshot")}</span>
      </div>
      <button type="button" className="git-workbench-icon-button" onClick={onRefresh} disabled={loading} title={t("git.workbench.refresh")}>
        <span aria-hidden="true" className={loading ? "is-spinning" : undefined}>↻</span>
        <span className="git-workbench-sr-only">{t("git.workbench.refresh")}</span>
      </button>
    </header>
  );
}
