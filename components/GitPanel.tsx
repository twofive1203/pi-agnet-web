"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GitStatusInfo, GitFileChange, GitGraphData, GitGraphCommit, GitCommitDetail, GitCommitChangedFile } from "@/lib/types";
import { CommitGraph } from "./CommitGraph";
import { GitCommitDiffModal } from "./GitCommitDiffModal";
import { GitCommitDetails } from "./GitCommitDetails";
import { GitWorkingTreeDiffModal } from "./GitWorkingTreeDiffModal";
import { useI18n } from "@/components/I18nProvider";
import { buildGitWorkbenchUrl } from "@/lib/git-workbench-url";

interface Props {
  cwd: string | null;
  refreshKey: number;
  onDirtyChange?: (dirty: boolean) => void;
}

function gitStatusTone(status: string): string {
  if (["M", "A", "R", "C"].includes(status)) return "is-success";
  if (status === "D") return "is-danger";
  if (["T", "U"].includes(status)) return "is-warning";
  return "is-muted";
}

/** Cap rendered rows per file section so huge repos cannot freeze the panel. */
const MAX_FILE_ROWS = 200;

function FileChangeRow({ change, onOpenDiff }: { change: GitFileChange; onOpenDiff: (change: GitFileChange) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="git-file-row git-file-row-button"
      onClick={() => onOpenDiff(change)}
      title={t("git.openWorkingTreeDiff")}
    >
      <span className={`git-status-dot ${gitStatusTone(change.status)}`} />
      <span className="git-file-path">{change.oldFile ? `${change.oldFile} → ${change.file}` : change.file}</span>
      <span className="git-file-status">{t(`git.status.${change.status}`)}</span>
    </button>
  );
}

export function GitPanel({ cwd, refreshKey, onDirtyChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [graphData, setGraphData] = useState<GitGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  // Branch whose graph is actually loaded. Updated via debounce from dropdown
  // changes so browsing the select does not fire a fetch per keystroke.
  const [graphBranch, setGraphBranch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<GitCommitDetail | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState<string | null>(null);
  const [commitDetailRetryKey, setCommitDetailRetryKey] = useState(0);
  const [diffFile, setDiffFile] = useState<GitCommitChangedFile | null>(null);
  const [workingDiff, setWorkingDiff] = useState<{ scope: "staged" | "unstaged"; file: GitFileChange } | null>(null);
  const fetchIdRef = useRef(0);
  const commitDetailFetchIdRef = useRef(0);
  const branchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current);
    };
  }, []);

  const fetchAll = useCallback(async () => {
    if (!cwd) return;
    const id = ++fetchIdRef.current;
    const graphParams = new URLSearchParams({ cwd, maxCount: "50" });
    if (graphBranch) graphParams.set("branch", graphBranch);
    setLoading(true);
    try {
      const [statusRes, graphRes] = await Promise.all([
        fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/git/graph?${graphParams.toString()}`),
      ]);
      const statusData = await statusRes.json() as { status: GitStatusInfo | null; error?: string };
      const graphBody = await graphRes.json() as { data: GitGraphData | null; error?: string };

      if (id !== fetchIdRef.current) return;

      if (!statusRes.ok) {
        setStatus(null);
        setGraphData(null);
        setLoadError(statusData.error ?? `Failed to load git status (HTTP ${statusRes.status})`);
        setLoaded(true);
        onDirtyChange?.(false);
        return;
      }

      setLoadError(null);
      setStatus(statusData.status);
      onDirtyChange?.(statusData.status?.isDirty ?? false);

      if (!graphRes.ok) {
        setGraphData(null);
        setGraphError(graphBody.error ?? `Failed to load commit graph (HTTP ${graphRes.status})`);
      } else {
        setGraphData(graphBody.data);
        setGraphError(graphBody.error ?? null);
      }
      setLoaded(true);
    } catch (error) {
      if (id !== fetchIdRef.current) return;
      setStatus(null);
      setGraphData(null);
      setLoadError(error instanceof Error ? error.message : "Failed to load git data");
      setLoaded(true);
      onDirtyChange?.(false);
    } finally {
      if (id === fetchIdRef.current) setLoading(false);
    }
  }, [cwd, onDirtyChange, graphBranch]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll, refreshKey]);

  useEffect(() => {
    if (branchDebounceRef.current) {
      clearTimeout(branchDebounceRef.current);
      branchDebounceRef.current = null;
    }
    setSelectedBranch("");
    setGraphBranch("");
    setSwitchError(null);
    setSelectedCommitHash(null);
    setCommitDetail(null);
    setCommitDetailError(null);
    setLoadError(null);
    setGraphError(null);
    setDiffFile(null);
    setWorkingDiff(null);
  }, [cwd]);

  useEffect(() => {
    const branches = graphData?.branches ?? [];
    if (branches.length === 0) {
      if (selectedBranch) {
        setSelectedBranch("");
        setGraphBranch("");
      }
      return;
    }

    if (selectedBranch && branches.some((branch) => branch.name === selectedBranch)) return;
    const currentBranch = status?.branch
      ? branches.find((branch) => branch.name === status.branch)
      : branches.find((branch) => branch.isCurrent);
    const next = currentBranch?.name ?? branches[0]?.name ?? "";
    setSelectedBranch(next);
    setGraphBranch(next);
  }, [graphData?.branches, status?.branch, selectedBranch]);

  useEffect(() => {
    const graphCommits = graphData?.commits ?? [];
    const fallbackCommits = status?.recentCommits ?? [];
    setSelectedCommitHash((current) => {
      if (graphCommits.length > 0) {
        if (current && graphCommits.some((commit) => commit.hash === current)) return current;
        return graphCommits[0]?.hash ?? null;
      }
      if (fallbackCommits.length > 0) {
        if (current && fallbackCommits.some((commit) => commit.hash === current)) return current;
        return fallbackCommits[0]?.hash ?? null;
      }
      return null;
    });
  }, [graphData?.commits, status?.recentCommits]);

  useEffect(() => {
    if (!cwd || !selectedCommitHash) {
      setCommitDetail(null);
      setCommitDetailError(null);
      setCommitDetailLoading(false);
      return;
    }

    const id = ++commitDetailFetchIdRef.current;
    setCommitDetailLoading(true);
    setCommitDetailError(null);
    const params = new URLSearchParams({ cwd, hash: selectedCommitHash });

    fetch(`/api/git/commit?${params.toString()}`)
      .then(async (res) => {
        const body = await res.json() as { detail?: GitCommitDetail | null; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body.detail ?? null;
      })
      .then((detail) => {
        if (id !== commitDetailFetchIdRef.current) return;
        setCommitDetail(detail);
      })
      .catch((error) => {
        if (id !== commitDetailFetchIdRef.current) return;
        setCommitDetail(null);
        setCommitDetailError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (id === commitDetailFetchIdRef.current) setCommitDetailLoading(false);
      });
  }, [cwd, selectedCommitHash, commitDetailRetryKey]);

  const handleRetryCommitDetail = useCallback(() => {
    setCommitDetailRetryKey((k) => k + 1);
  }, []);

  const handleSelectCommit = useCallback((commit: GitGraphCommit) => {
    setSelectedCommitHash(commit.hash);
  }, []);

  const handleBranchSelect = useCallback((name: string) => {
    setSelectedBranch(name);
    setSwitchError(null);
    if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current);
    branchDebounceRef.current = setTimeout(() => {
      branchDebounceRef.current = null;
      setGraphBranch(name);
    }, 600);
  }, []);

  const handleOpenDiff = useCallback((file: GitCommitChangedFile) => {
    setDiffFile(file);
  }, []);

  const handleOpenWorkingDiff = useCallback((scope: "staged" | "unstaged", file: GitFileChange) => {
    setWorkingDiff({ scope, file });
  }, []);

  const handleSwitchBranch = useCallback(async () => {
    if (!cwd || !selectedBranch || status?.isDirty || switching) return;

    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch("/api/git/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch: selectedBranch }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok || body.error) {
        throw new Error(body.error ?? `Switch failed with HTTP ${res.status}`);
      }
      // Drop commit selection from the old branch so no stale detail flashes.
      setSelectedCommitHash(null);
      setCommitDetail(null);
      setCommitDetailError(null);
      setDiffFile(null);
      setWorkingDiff(null);
      if (branchDebounceRef.current) {
        clearTimeout(branchDebounceRef.current);
        branchDebounceRef.current = null;
      }
      setGraphBranch(selectedBranch);
      await fetchAll();
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : String(error));
    } finally {
      setSwitching(false);
    }
  }, [cwd, fetchAll, selectedBranch, status?.isDirty, switching]);

  if (loaded && loadError && !loading) {
    return (
      <div className="inspector-state inspector-state-error" role="alert">
        <div>{loadError}</div>
        <button type="button" onClick={() => void fetchAll()} className="git-switch-button" style={{ marginTop: 8 }}>
          {t("git.retry")}
        </button>
      </div>
    );
  }

  if (loaded && status === null && !loading) {
    return <div className="inspector-state inspector-state-empty">{t("git.notARepo")}</div>;
  }

  if (!loaded && loading) {
    return <div className="inspector-state inspector-state-loading">{t("git.loading")}</div>;
  }

  if (!status || !cwd) return null;

  const branchOptions = graphData?.branches ?? [];
  const previewBranch = graphBranch || status.branch;
  const selectedIsCurrent = selectedBranch === status.branch || branchOptions.some((branch) => branch.name === selectedBranch && branch.isCurrent);
  const canSwitchBranch = Boolean(selectedBranch) && branchOptions.length > 0 && !loading && !switching && !status.isDirty && !selectedIsCurrent;
  const switchDisabledReason = status.isDirty
    ? t("git.switchDisabledDirty")
    : branchOptions.length === 0
      ? t("git.switchDisabledNoBranches")
      : selectedIsCurrent
        ? t("git.switchDisabledCurrent")
        : null;

  return (
    <div className="git-panel-root inspector-content">
      <div className="git-panel-toolbar">
        <a
          href={buildGitWorkbenchUrl(cwd)}
          target="_blank"
          rel="noopener noreferrer"
          className="git-workbench-open-link"
          title={t("git.workbench.open")}
        >
          {t("git.workbench.open")}
        </a>
        <button type="button" onClick={() => void fetchAll()} disabled={loading} title={t("git.refreshTitle")} className="git-refresh-button">
          <svg className={loading ? "is-spinning" : undefined} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      <section className="inspector-section git-branch-section">
        <div className="inspector-section-title">{t("git.branch")}</div>
        <div className="git-branch-summary">
          <span className="git-branch-name">{status.isDetached ? "(detached)" : status.branch}</span>
          {status.isDirty && <span className="inspector-badge is-warning">{t("git.dirty")}</span>}
          {status.isWorktree && <span className="inspector-badge is-info">{t("git.worktreeBadge")}</span>}
          {status.upstream && (
            <span className="git-upstream">
              {status.upstream}
              {(status.ahead > 0 || status.behind > 0) && (
                <span className="git-upstream-counts">
                  {status.ahead > 0 && <span className="is-success">+{status.ahead}</span>}
                  {status.ahead > 0 && status.behind > 0 && " "}
                  {status.behind > 0 && <span className="is-danger">-{status.behind}</span>}
                </span>
              )}
            </span>
          )}
        </div>

        <div className="git-branch-controls">
          <div className="git-control-label">{t("git.previewSwitchLabel")}</div>
          <div className="git-branch-switch-row">
            <select
              value={selectedBranch}
              onChange={(e) => handleBranchSelect(e.currentTarget.value)}
              disabled={loading || switching || branchOptions.length === 0}
              aria-label={t("git.selectBranchAria")}
              className="git-branch-select"
            >
              {branchOptions.length === 0 ? (
                <option value="">{t("git.noLocalBranches")}</option>
              ) : branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.isCurrent ? "✓ " : ""}{branch.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleSwitchBranch()}
              disabled={!canSwitchBranch}
              title={switchDisabledReason ?? t("git.switchTo", { branch: selectedBranch })}
              className="git-switch-button"
            >
              {switching ? t("git.switching") : t("git.switch")}
            </button>
          </div>
          <div className="git-control-help">{t("git.previewSwitchHelp")}</div>
          {switchDisabledReason && <div className={`git-control-message${status.isDirty ? " is-warning" : ""}`}>{switchDisabledReason}</div>}
          {switchError && <div className="git-control-message is-error" role="alert">{switchError}</div>}
        </div>
      </section>

      <section className="inspector-section git-history-section">
        <div className="git-history-grid">
          <div className="git-history-column">
            <div className="inspector-section-title">
              {t("git.commitGraph")}
              {previewBranch && <span className="inspector-section-context">{t("git.previewingBranch", { branch: previewBranch })}</span>}
            </div>
            <div className="git-graph-scroll">
              {graphError ? (
                <div className="git-control-message is-error" role="alert">{graphError}</div>
              ) : graphData && graphData.commits && graphData.commits.length > 0 ? (
                <CommitGraph
                  commits={graphData.commits}
                  currentBranch={previewBranch}
                  maxDisplay={30}
                  selectedHash={selectedCommitHash}
                  onSelectCommit={handleSelectCommit}
                />
              ) : status.recentCommits.length > 0 ? (
                <div className="git-fallback-commits">
                  {status.recentCommits.map((commit) => (
                    <button
                      key={commit.hash}
                      type="button"
                      onClick={() => setSelectedCommitHash(commit.hash)}
                      className={`git-fallback-commit${selectedCommitHash === commit.hash ? " is-selected" : ""}`}
                    >
                      <code>{commit.hash.slice(0, 7)}</code>
                      <span>{commit.message}</span>
                      <time>{commit.relativeDate}</time>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="git-empty-inline">{t("git.noCommits")}</div>
              )}
            </div>
          </div>

          <div className="git-history-column">
            <div className="inspector-section-title">{t("git.commitDetails")}</div>
            <GitCommitDetails
              detail={commitDetail}
              loading={commitDetailLoading}
              error={commitDetailError}
              onOpenDiff={handleOpenDiff}
              onRetry={handleRetryCommitDetail}
            />
          </div>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">{t("git.staged")} <span>({status.staged.length})</span></div>
        {status.staged.length > 0
          ? (
            <div className="git-file-list">
              {status.staged.slice(0, MAX_FILE_ROWS).map((change) => (
                <FileChangeRow
                  key={`staged-${change.status}-${change.oldFile ?? ""}-${change.file}`}
                  change={change}
                  onOpenDiff={(file) => handleOpenWorkingDiff("staged", file)}
                />
              ))}
              {status.staged.length > MAX_FILE_ROWS && (
                <div className="git-empty-inline">{t("git.moreItems", { count: status.staged.length - MAX_FILE_ROWS })}</div>
              )}
            </div>
          )
          : <div className="git-empty-inline">{t("git.noStaged")}</div>}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">{t("git.unstaged")} <span>({status.unstaged.length})</span></div>
        {status.unstaged.length > 0
          ? (
            <div className="git-file-list">
              {status.unstaged.slice(0, MAX_FILE_ROWS).map((change) => (
                <FileChangeRow
                  key={`unstaged-${change.status}-${change.oldFile ?? ""}-${change.file}`}
                  change={change}
                  onOpenDiff={(file) => handleOpenWorkingDiff("unstaged", file)}
                />
              ))}
              {status.unstaged.length > MAX_FILE_ROWS && (
                <div className="git-empty-inline">{t("git.moreItems", { count: status.unstaged.length - MAX_FILE_ROWS })}</div>
              )}
            </div>
          )
          : <div className="git-empty-inline">{t("git.noUnstaged")}</div>}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-title">{t("git.untracked")} <span>({status.untracked.length})</span></div>
        {status.untracked.length > 0 ? (
          <div className="git-file-list">
            {status.untracked.slice(0, MAX_FILE_ROWS).map((file) => (
              <div key={file} className="git-file-row">
                <span className="git-status-dot is-muted" />
                <span className="git-file-path is-muted">{file}</span>
              </div>
            ))}
            {status.untracked.length > MAX_FILE_ROWS && (
              <div className="git-empty-inline">{t("git.moreItems", { count: status.untracked.length - MAX_FILE_ROWS })}</div>
            )}
          </div>
        ) : <div className="git-empty-inline">{t("git.noUntracked")}</div>}
      </section>

      <section className="inspector-section git-stash-section">
        <div className="inspector-section-title">{t("git.stash")}</div>
        {status.stashCount > 0
          ? <div className="git-stash-count">{t("git.stashEntries", { count: status.stashCount })}</div>
          : <div className="git-empty-inline">{t("git.noStash")}</div>}
      </section>

      {diffFile && cwd && selectedCommitHash && (
        <GitCommitDiffModal
          cwd={cwd}
          hash={selectedCommitHash}
          shortHash={commitDetail?.shortHash}
          file={diffFile}
          onClose={() => setDiffFile(null)}
        />
      )}
      {workingDiff && cwd && (
        <GitWorkingTreeDiffModal
          cwd={cwd}
          scope={workingDiff.scope}
          file={workingDiff.file}
          onClose={() => setWorkingDiff(null)}
        />
      )}
    </div>
  );
}
