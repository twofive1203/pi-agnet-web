"use client";

import { memo } from "react";
import type { WorktreeInfo } from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";

export const WorktreeBadge = memo(function WorktreeBadge({ worktree }: { worktree?: WorktreeInfo }) {
  const { t } = useI18n();
  if (!worktree) return null;
  return (
    <span
      className="worktree-badge"
      title={worktree.branch ? t("sidebar.gitWorktreeNamed", { branch: worktree.branch }) : t("sidebar.gitWorktree")}
    >
      <span>WT</span>
      {worktree.branch && (
        <span className="worktree-badge-branch">
          {worktree.branch}
        </span>
      )}
    </span>
  );
});
