"use client";

import { useMemo, useState } from "react";
import { CommitGraph, type GitCommitMenuAnchor } from "@/components/CommitGraph";
import { useI18n } from "@/components/I18nProvider";
import type {
  GitCommitCapability,
  GitCommitDetail,
  GitGraphCommit,
  GitWorkbenchOverview,
} from "@/lib/types";
import { GitContextMenu, type GitContextMenuItem } from "./GitContextMenu";

export type CommitAction = "cherry-pick" | "reset" | "revert" | "reword" | "drop" | "create-branch" | "create-tag";

interface MenuState extends GitCommitMenuAnchor {
  commit: GitGraphCommit;
}

export function GitLogPane({
  overview,
  commits,
  detail,
  selectedScope,
  selectedHash,
  query,
  authorId,
  loading,
  loadingMore,
  hasMore,
  writesDisabled,
  onQueryChange,
  onAuthorChange,
  onScopeChange,
  onSelectCommit,
  onLoadMore,
  onAction,
}: {
  overview: GitWorkbenchOverview;
  commits: GitGraphCommit[];
  detail: GitCommitDetail | null;
  selectedScope: string;
  selectedHash: string | null;
  query: string;
  authorId: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  writesDisabled: boolean;
  onQueryChange: (query: string) => void;
  onAuthorChange: (authorId: string | null) => void;
  onScopeChange: (scope: string) => void;
  onSelectCommit: (commit: GitGraphCommit) => void;
  onLoadMore: () => void;
  onAction: (action: CommitAction, commit: GitGraphCommit, trigger: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const allRefs = useMemo(() => [
    ...overview.localBranches,
    ...overview.remoteBranches,
    ...overview.tags,
  ], [overview]);

  const capabilities = detail && menu && detail.hash === menu.commit.hash ? detail.capabilities : undefined;
  const reasonText = (capability: GitCommitCapability | undefined): string | undefined => {
    if (writesDisabled) return t("git.workbench.writeBlocked");
    if (!capability) return t("git.workbench.loadingCapability");
    return capability.reason ? t(`git.workbench.reason.${capability.reason}`) : undefined;
  };
  const actionItem = (
    id: CommitAction,
    label: string,
    capability: GitCommitCapability | undefined,
    danger = false,
  ): GitContextMenuItem => {
    const reason = reasonText(capability);
    return {
      id,
      label,
      disabled: Boolean(reason),
      reason,
      danger,
      onSelect: () => menu && onAction(id, menu.commit, menu.trigger),
    };
  };

  const menuItems: GitContextMenuItem[] = menu ? [
    actionItem("cherry-pick", t("git.workbench.actions.cherryPick"), capabilities?.cherryPick),
    actionItem("reset", t("git.workbench.actions.reset"), capabilities?.reset, true),
    actionItem("revert", t("git.workbench.actions.revert"), capabilities?.revert),
    actionItem("reword", t("git.workbench.actions.reword"), capabilities?.reword),
    actionItem("drop", t("git.workbench.actions.drop"), capabilities?.drop, true),
    actionItem("create-branch", t("git.workbench.actions.newBranch"), capabilities?.newBranch),
    actionItem("create-tag", t("git.workbench.actions.newTag"), capabilities?.newTag),
    {
      id: "copy-hash",
      label: t("git.workbench.actions.copyHash"),
      onSelect: () => void navigator.clipboard?.writeText(menu.commit.hash),
    },
  ] : [];

  return (
    <section className="git-workbench-log" aria-label={t("git.workbench.log") }>
      <div className="git-workbench-log-toolbar">
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          className="git-workbench-filter-input"
          placeholder={t("git.workbench.searchPlaceholder")}
          aria-label={t("git.workbench.search")}
        />
        <select value={selectedScope} onChange={(event) => onScopeChange(event.currentTarget.value)} className="git-workbench-filter-select" aria-label={t("git.workbench.branchFilter")}>
          <option value="all">{t("git.workbench.all")}</option>
          {allRefs.map((ref) => <option key={ref.ref} value={ref.ref}>{ref.kind === "tag" ? `# ${ref.name}` : ref.name}</option>)}
        </select>
        <select value={authorId ?? ""} onChange={(event) => onAuthorChange(event.currentTarget.value || null)} className="git-workbench-filter-select" aria-label={t("git.workbench.authorFilter")}>
          <option value="">{t("git.workbench.allAuthors")}</option>
          {overview.authors.map((author) => <option key={author.id} value={author.id}>{author.label}</option>)}
        </select>
      </div>
      <div className="git-workbench-log-body">
        {loading ? (
          <div className="git-workbench-state is-loading">{t("git.workbench.loadingLog")}</div>
        ) : commits.length === 0 ? (
          <div className="git-workbench-state">{overview.isEmpty ? t("git.workbench.emptyRepository") : t("git.workbench.noMatches")}</div>
        ) : (
          <CommitGraph
            commits={commits}
            currentBranch={overview.currentBranch}
            maxDisplay={500}
            selectedHash={selectedHash}
            onSelectCommit={onSelectCommit}
            variant="workbench"
            onContextMenu={(commit, anchor) => setMenu({ commit, ...anchor })}
          />
        )}
        {commits.length > 0 && (
          <div className="git-workbench-load-row">
            {hasMore && commits.length < 500 ? (
              <button type="button" onClick={onLoadMore} disabled={loadingMore} className="git-workbench-button">
                {loadingMore ? t("git.workbench.loadingMore") : t("git.workbench.loadMore")}
              </button>
            ) : commits.length >= 500 ? (
              <span>{t("git.workbench.commitLimit")}</span>
            ) : <span>{t("git.workbench.endOfHistory")}</span>}
          </div>
        )}
      </div>
      {menu && (
        <GitContextMenu x={menu.x} y={menu.y} trigger={menu.trigger} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </section>
  );
}
