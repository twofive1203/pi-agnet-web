"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useI18n } from "@/components/I18nProvider";
import { useGitWorkbench, type GitWorkbenchOperationDraft } from "@/hooks/useGitWorkbench";
import {
  clampGitWorkbenchColumns,
  DEFAULT_GIT_WORKBENCH_LAYOUT,
  getGitWorkbenchInspectorWidthBounds,
  getGitWorkbenchRefsWidthBounds,
  GIT_WORKBENCH_LAYOUT_STORAGE_KEY,
  GIT_WORKBENCH_RESIZE_STEP,
  GIT_WORKBENCH_RESIZE_STEP_LARGE,
  parseGitWorkbenchLayoutPreference,
  type GitWorkbenchLayoutPreference,
} from "@/lib/git-workbench-client";
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
  const [layoutPreference, setLayoutPreference] = useState<GitWorkbenchLayoutPreference>(DEFAULT_GIT_WORKBENCH_LAYOUT);
  const [activeColumnResize, setActiveColumnResize] = useState<"refs" | "inspector" | null>(null);
  const layoutPreferenceRef = useRef(layoutPreference);
  const layoutRef = useRef<HTMLDivElement>(null);
  const overviewReady = Boolean(workbench.overview);

  const persistLayoutPreference = useCallback((preference: GitWorkbenchLayoutPreference) => {
    try {
      window.localStorage.setItem(GIT_WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(preference));
    } catch {
      // Browser privacy/storage policies can reject persistence; resizing still works for this page.
    }
  }, []);

  const commitLayoutPreference = useCallback((preference: GitWorkbenchLayoutPreference, persist: boolean) => {
    layoutPreferenceRef.current = preference;
    setLayoutPreference(preference);
    if (persist) persistLayoutPreference(preference);
  }, [persistLayoutPreference]);

  useEffect(() => {
    let stored = DEFAULT_GIT_WORKBENCH_LAYOUT;
    try {
      stored = parseGitWorkbenchLayoutPreference(window.localStorage.getItem(GIT_WORKBENCH_LAYOUT_STORAGE_KEY));
    } catch {
      stored = { ...DEFAULT_GIT_WORKBENCH_LAYOUT };
    }
    commitLayoutPreference(stored, false);
  }, [commitLayoutPreference]);

  useLayoutEffect(() => {
    if (!overviewReady) return;
    const reclamp = () => {
      const layout = layoutRef.current;
      if (!layout) return;
      const current = layoutPreferenceRef.current;
      const next = clampGitWorkbenchColumns(layout.clientWidth, current);
      if (next.refsWidth !== current.refsWidth || next.inspectorWidth !== current.inspectorWidth) {
        commitLayoutPreference(next, false);
      }
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [commitLayoutPreference, overviewReady]);

  const previewColumnPreference = useCallback((preference: GitWorkbenchLayoutPreference) => {
    layoutPreferenceRef.current = preference;
    const layout = layoutRef.current;
    if (!layout) return;
    layout.style.setProperty("--git-workbench-refs-width", `${preference.refsWidth}px`);
    layout.style.setProperty("--git-workbench-inspector-width", `${preference.inspectorWidth}px`);
  }, []);

  const handleColumnResizePointerDown = useCallback((
    target: "refs" | "inspector",
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const layout = layoutRef.current;
    if (!layout) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = layout.getBoundingClientRect();
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    setActiveColumnResize(target);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const current = layoutPreferenceRef.current;
      if (target === "refs") {
        const bounds = getGitWorkbenchRefsWidthBounds(rect.width, current.inspectorWidth);
        const refsWidth = Math.round(Math.min(bounds.max, Math.max(bounds.min, moveEvent.clientX - rect.left)));
        previewColumnPreference({ ...current, refsWidth });
      } else {
        const bounds = getGitWorkbenchInspectorWidthBounds(rect.width, current.refsWidth);
        const inspectorWidth = Math.round(Math.min(bounds.max, Math.max(bounds.min, rect.right - moveEvent.clientX)));
        previewColumnPreference({ ...current, inspectorWidth });
      }
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setActiveColumnResize(null);
      commitLayoutPreference(layoutPreferenceRef.current, true);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  }, [commitLayoutPreference, previewColumnPreference]);

  const handleColumnResizeKeyDown = useCallback((
    target: "refs" | "inspector",
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const layout = layoutRef.current;
    if (!layout) return;
    const current = layoutPreferenceRef.current;
    const step = event.shiftKey ? GIT_WORKBENCH_RESIZE_STEP_LARGE : GIT_WORKBENCH_RESIZE_STEP;
    const bounds = target === "refs"
      ? getGitWorkbenchRefsWidthBounds(layout.clientWidth, current.inspectorWidth)
      : getGitWorkbenchInspectorWidthBounds(layout.clientWidth, current.refsWidth);
    const currentValue = target === "refs" ? current.refsWidth : current.inspectorWidth;
    let nextValue: number;
    if (event.key === "Home") nextValue = bounds.min;
    else if (event.key === "End") nextValue = bounds.max;
    else if (target === "refs" && event.key === "ArrowLeft") nextValue = currentValue - step;
    else if (target === "refs" && event.key === "ArrowRight") nextValue = currentValue + step;
    else if (target === "inspector" && event.key === "ArrowLeft") nextValue = currentValue + step;
    else if (target === "inspector" && event.key === "ArrowRight") nextValue = currentValue - step;
    else return;
    event.preventDefault();
    const clamped = Math.round(Math.min(bounds.max, Math.max(bounds.min, nextValue)));
    commitLayoutPreference({
      ...current,
      [target === "refs" ? "refsWidth" : "inspectorWidth"]: clamped,
    }, true);
  }, [commitLayoutPreference]);

  const handleChangesRatioChange = useCallback((changesRatio: number, persist: boolean) => {
    commitLayoutPreference({ ...layoutPreferenceRef.current, changesRatio }, persist);
  }, [commitLayoutPreference]);

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
  const writesDisabled = !overview.revisionComplete || workbench.operationBusy || workbench.recoveryRequired || Boolean(overview.operationState);
  const layoutWidth = layoutRef.current?.clientWidth ?? 1280;
  const refsWidthBounds = getGitWorkbenchRefsWidthBounds(layoutWidth, layoutPreference.inspectorWidth);
  const inspectorWidthBounds = getGitWorkbenchInspectorWidthBounds(layoutWidth, layoutPreference.refsWidth);
  const layoutStyle = {
    "--git-workbench-refs-width": `${layoutPreference.refsWidth}px`,
    "--git-workbench-inspector-width": `${layoutPreference.inspectorWidth}px`,
  } as CSSProperties;

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
      {!overview.revisionComplete && (
        <div className="git-workbench-warning-banner" role="status">
          {t("git.workbench.snapshotIncomplete")}
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
      <div
        ref={layoutRef}
        className={`git-workbench-layout${refsDrawerOpen ? " is-refs-open" : ""}`}
        style={layoutStyle}
      >
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
        <div
          className={`panel-resize-handle git-workbench-resize-handle is-column${activeColumnResize === "refs" ? " is-active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={refsWidthBounds.min}
          aria-valuemax={refsWidthBounds.max}
          aria-valuenow={layoutPreference.refsWidth}
          aria-label={t("git.workbench.resizeRefs")}
          title={t("git.workbench.resizeRefs")}
          tabIndex={0}
          onPointerDown={(event) => handleColumnResizePointerDown("refs", event)}
          onKeyDown={(event) => handleColumnResizeKeyDown("refs", event)}
        />
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
        <div
          className={`panel-resize-handle git-workbench-resize-handle is-column${activeColumnResize === "inspector" ? " is-active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={inspectorWidthBounds.min}
          aria-valuemax={inspectorWidthBounds.max}
          aria-valuenow={layoutPreference.inspectorWidth}
          aria-label={t("git.workbench.resizeInspector")}
          title={t("git.workbench.resizeInspector")}
          tabIndex={0}
          onPointerDown={(event) => handleColumnResizePointerDown("inspector", event)}
          onKeyDown={(event) => handleColumnResizeKeyDown("inspector", event)}
        />
        <GitCommitInspector
          cwd={cwd}
          detail={workbench.detail}
          loading={workbench.detailLoading}
          error={workbench.detailError}
          splitRatio={layoutPreference.changesRatio}
          onSplitRatioChange={handleChangesRatioChange}
        />
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
