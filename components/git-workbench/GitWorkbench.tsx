"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/I18nProvider";
import { useGitWorkbench, type GitWorkbenchOperationDraft } from "@/hooks/useGitWorkbench";
import type { GitGraphCommit, GitWorkbenchRef } from "@/lib/types";
import { GitCommitInspector } from "./GitCommitInspector";
import { GitLogPane, type CommitAction } from "./GitLogPane";
import { GitRefTree } from "./GitRefTree";
import { GitWorkbenchDialogs, type GitWorkbenchDialogRequest } from "./GitWorkbenchDialogs";
import { GitWorkbenchHeader } from "./GitWorkbenchHeader";

type MobilePane = "refs" | "log" | "changes" | "details";

export function GitWorkbench({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const workbench = useGitWorkbench(cwd);
  const [dialog, setDialog] = useState<GitWorkbenchDialogRequest | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>("log");
  const [refsDrawerOpen, setRefsDrawerOpen] = useState(false);

  const operationMessage = workbench.operationError
    ? (() => {
      const key = `git.workbench.errors.${workbench.operationError.code}`;
      const translated = t(key);
      return translated === key ? workbench.operationError.message : translated;
    })()
    : null;

  const handleRefAction = useCallback((action: "checkout" | "push", ref: GitWorkbenchRef, trigger: HTMLElement) => {
    setDialog({ type: "ref", action, ref, trigger });
  }, []);

  const handleCommitAction = useCallback((action: CommitAction, commit: GitGraphCommit, trigger: HTMLElement) => {
    if (!workbench.detail || workbench.detail.hash !== commit.hash) return;
    setDialog({ type: "commit", action, commit, detail: workbench.detail, trigger });
  }, [workbench.detail]);

  const handleSubmit = useCallback(async (draft: GitWorkbenchOperationDraft): Promise<boolean> => {
    return Boolean(await workbench.operate(draft));
  }, [workbench]);

  if (!cwd) {
    return (
      <main className="git-workbench-root">
        <div className="git-workbench-fatal-state">
          <strong>{t("git.workbench.missingCwd")}</strong>
          <Link href="/">{t("git.workbench.back")}</Link>
        </div>
      </main>
    );
  }

  if (!workbench.overview && workbench.overviewLoading) {
    return (
      <main className="git-workbench-root">
        <GitWorkbenchHeader overview={null} cwd={cwd} loading onRefresh={workbench.refresh} />
        <div className="git-workbench-fatal-state is-loading">{t("git.workbench.loading")}</div>
      </main>
    );
  }

  if (!workbench.overview) {
    return (
      <main className="git-workbench-root">
        <GitWorkbenchHeader overview={null} cwd={cwd} loading={false} onRefresh={workbench.refresh} />
        <div className="git-workbench-fatal-state" role="alert">
          <strong>{workbench.error ?? t("git.workbench.unavailable")}</strong>
          <div className="git-workbench-fatal-actions">
            <button type="button" className="git-workbench-button" onClick={workbench.refresh}>{t("git.retry")}</button>
            <Link href="/">{t("git.workbench.back")}</Link>
          </div>
        </div>
      </main>
    );
  }

  const overview = workbench.overview;
  const writesDisabled = workbench.operationBusy || workbench.recoveryRequired || Boolean(overview.operationState);

  return (
    <main className="git-workbench-root" data-mobile-pane={mobilePane}>
      <GitWorkbenchHeader overview={overview} cwd={cwd} loading={workbench.overviewLoading} onRefresh={workbench.refresh} />
      {workbench.recoveryRequired && (
        <div className="git-workbench-blocking-banner" role="alert">
          <strong>{t("git.workbench.recoveryRequired")}</strong>
          <span>{t("git.workbench.recoveryHelp", { cwd: overview.cwd, state: overview.operationState ?? "unknown" })}</span>
          <Link href="/">{t("git.workbench.openWorkspace")}</Link>
        </div>
      )}
      {overview.operationState && !workbench.recoveryRequired && (
        <div className="git-workbench-warning-banner" role="status">
          {t("git.workbench.operationInProgress", { state: overview.operationState })}
        </div>
      )}
      {operationMessage && (
        <div className="git-workbench-operation-error" role="alert">
          <span>{operationMessage}</span>
          {workbench.operationError?.details && <details><summary>{t("git.workbench.errorDetails")}</summary><pre>{workbench.operationError.details}</pre></details>}
          <button type="button" onClick={workbench.clearOperationError} aria-label={t("common.close")}>×</button>
        </div>
      )}
      <nav className="git-workbench-mobile-tabs" role="tablist" aria-label={t("git.workbench.mobileSections")}>
        {(["refs", "log", "changes", "details"] as MobilePane[]).map((pane) => (
          <button
            key={pane}
            type="button"
            role="tab"
            aria-selected={mobilePane === pane}
            className={mobilePane === pane ? "is-active" : undefined}
            onClick={() => setMobilePane(pane)}
          >
            {t(`git.workbench.mobile.${pane}`)}
          </button>
        ))}
      </nav>
      <div className={`git-workbench-layout${refsDrawerOpen ? " is-refs-open" : ""}`}>
        <div className="git-workbench-refs-shell">
          <GitRefTree
            overview={overview}
            selectedScope={workbench.selectedScope}
            writesDisabled={writesDisabled}
            onSelectScope={(scope) => {
              workbench.selectScope(scope);
              setRefsDrawerOpen(false);
              setMobilePane("log");
            }}
            onAction={handleRefAction}
          />
        </div>
        <div className="git-workbench-log-shell">
          <button type="button" className="git-workbench-refs-drawer-trigger" onClick={() => setRefsDrawerOpen((open) => !open)} aria-expanded={refsDrawerOpen}>
            {t("git.workbench.refs")}
          </button>
          <GitLogPane
            overview={overview}
            commits={workbench.commits}
            detail={workbench.detail}
            selectedScope={workbench.selectedScope}
            selectedHash={workbench.selectedHash}
            query={workbench.query}
            authorId={workbench.authorId}
            loading={workbench.logLoading}
            loadingMore={workbench.loadingMore}
            hasMore={workbench.hasMore}
            writesDisabled={writesDisabled}
            onQueryChange={workbench.setQuery}
            onAuthorChange={workbench.setAuthorId}
            onScopeChange={workbench.selectScope}
            onSelectCommit={workbench.selectCommit}
            onLoadMore={() => void workbench.loadMore()}
            onAction={handleCommitAction}
          />
        </div>
        <GitCommitInspector cwd={cwd} detail={workbench.detail} loading={workbench.detailLoading} error={workbench.detailError} />
      </div>
      {dialog && (
        <GitWorkbenchDialogs
          request={dialog}
          overview={overview}
          busy={workbench.operationBusy}
          error={operationMessage}
          onClose={() => setDialog(null)}
          onSubmit={handleSubmit}
        />
      )}
    </main>
  );
}
