"use client";

import { memo } from "react";
import type { WorktreeInfo } from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";

export const WorktreeBadge = memo(function WorktreeBadge({ worktree }: { worktree?: WorktreeInfo }) {
  const { t } = useI18n();
  if (!worktree) return null;
  return (
    <span
      title={worktree.branch ? t("sidebar.gitWorktreeNamed", { branch: worktree.branch }) : t("sidebar.gitWorktree")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        maxWidth: 120,
        padding: "1px 5px",
        borderRadius: 999,
        background: "rgba(37,99,235,0.12)",
        border: "1px solid rgba(37,99,235,0.22)",
        color: "var(--accent)",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: 1.35,
        flexShrink: 0,
      }}
    >
      <span>WT</span>
      {worktree.branch && (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
          {worktree.branch}
        </span>
      )}
    </span>
  );
});
