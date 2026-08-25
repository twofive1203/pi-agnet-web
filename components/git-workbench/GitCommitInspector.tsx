"use client";

import { useEffect, useMemo, useState } from "react";
import { GitCommitDetails } from "@/components/GitCommitDetails";
import { GitCommitDiffModal } from "@/components/GitCommitDiffModal";
import { useI18n } from "@/components/I18nProvider";
import { buildGitChangedFileTree, type GitFileTreeNode } from "@/lib/git-workbench-client";
import type { GitCommitChangedFile, GitCommitDetail } from "@/lib/types";

export function GitCommitInspector({
  cwd,
  detail,
  loading,
  error,
}: {
  cwd: string;
  detail: GitCommitDetail | null;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<GitCommitChangedFile | null>(null);
  const [diffFile, setDiffFile] = useState<GitCommitChangedFile | null>(null);
  const tree = useMemo(() => buildGitChangedFileTree(detail?.files ?? []), [detail?.files]);

  useEffect(() => {
    setExpanded(new Set());
    setSelectedFile(null);
    setDiffFile(null);
  }, [detail?.hash]);

  const toggleFolder = (node: GitFileTreeNode) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  return (
    <aside className="git-workbench-inspector">
      <section className="git-workbench-inspector-section is-changes" aria-label={t("git.changedFiles")}>
        <div className="git-workbench-pane-title">
          <strong>{t("git.changedFiles")}</strong>
          {detail && <span>{detail.files.length}{detail.filesTruncated ? "+" : ""}</span>}
        </div>
        <div className="git-workbench-tree" role="tree">
          {loading ? <div className="git-workbench-state is-loading">{t("git.loadingCommit")}</div>
            : error ? <div className="git-workbench-state is-error">{error}</div>
              : !detail ? <div className="git-workbench-state">{t("git.selectCommit")}</div>
                : tree.length === 0 ? <div className="git-workbench-state">{t("git.noFirstParentChanges")}</div>
                  : tree.map((node) => (
                    <TreeNode
                      key={node.id}
                      node={node}
                      depth={0}
                      expanded={expanded}
                      selectedFile={selectedFile}
                      onToggle={toggleFolder}
                      onSelectFile={setSelectedFile}
                      onOpenDiff={setDiffFile}
                    />
                  ))}
          {detail?.filesTruncated && <div className="git-workbench-limit-note">{t("git.workbench.filesTruncated")}</div>}
        </div>
      </section>
      <section className="git-workbench-inspector-section is-details" aria-label={t("git.commitDetails")}>
        <div className="git-workbench-pane-title"><strong>{t("git.commitDetails")}</strong></div>
        <div className="git-workbench-detail-scroll">
          <GitCommitDetails detail={detail} loading={loading} error={error} showFiles={false} />
        </div>
      </section>
      {diffFile && detail && (
        <GitCommitDiffModal
          cwd={cwd}
          hash={detail.hash}
          shortHash={detail.shortHash}
          file={diffFile}
          onClose={() => setDiffFile(null)}
        />
      )}
    </aside>
  );
}

function TreeNode({
  node,
  depth,
  expanded,
  selectedFile,
  onToggle,
  onSelectFile,
  onOpenDiff,
}: {
  node: GitFileTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedFile: GitCommitChangedFile | null;
  onToggle: (node: GitFileTreeNode) => void;
  onSelectFile: (file: GitCommitChangedFile) => void;
  onOpenDiff: (file: GitCommitChangedFile) => void;
}) {
  const { t } = useI18n();
  const isExpanded = expanded.has(node.id);
  if (node.kind === "folder") {
    return (
      <div role="treeitem" aria-expanded={isExpanded} aria-selected={false}>
        <button
          type="button"
          className="git-workbench-tree-row is-folder"
          style={{ paddingInlineStart: 8 + depth * 14 }}
          onClick={() => onToggle(node)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" && !isExpanded) onToggle(node);
            if (event.key === "ArrowLeft" && isExpanded) onToggle(node);
          }}
        >
          <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
          <span title={node.path}>{node.name}</span>
        </button>
        {isExpanded && (
          <div role="group">
            {node.children?.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selectedFile={selectedFile}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
                onOpenDiff={onOpenDiff}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const file = node.change!;
  const selected = selectedFile?.file === file.file && selectedFile?.oldFile === file.oldFile;
  return (
    <div role="treeitem" aria-selected={selected} className={`git-workbench-tree-file${selected ? " is-selected" : ""}`}>
      <button
        type="button"
        className="git-workbench-tree-row"
        style={{ paddingInlineStart: 22 + depth * 14 }}
        onClick={() => onSelectFile(file)}
        onDoubleClick={() => onOpenDiff(file)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onOpenDiff(file);
          }
        }}
      >
        <span className={`git-workbench-file-status is-${file.status.toLowerCase()}`}>{file.status}</span>
        <span title={file.oldFile ? `${file.oldFile} → ${file.file}` : file.file}>{file.oldFile ? `${file.oldFile} → ${node.name}` : node.name}</span>
        {file.binary ? <small>{t("git.binary")}</small> : (
          <small>
            {typeof file.additions === "number" ? `+${file.additions}` : ""}
            {typeof file.deletions === "number" ? ` -${file.deletions}` : ""}
          </small>
        )}
      </button>
      <button type="button" className="git-workbench-tree-diff" onClick={() => onOpenDiff(file)} aria-label={t("git.openDiff")}>↗</button>
    </div>
  );
}
