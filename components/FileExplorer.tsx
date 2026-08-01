"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { encodeFilePathForApi, getRelativeFilePath, joinFilePath } from "@/lib/file-paths";
import { buildStandaloneFileUrl } from "@/lib/file-viewer-url";
import { useI18n } from "@/components/I18nProvider";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string) => void;
}

async function fetchEntries(dirPath: string, signal?: AbortSignal): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`, { signal });
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshKey,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const open = expandedPaths.has(node.fullPath);
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // When refreshKey causes a re-render with the same node identity, reload open dirs
  const prevLoadedRef = useRef(loaded);
  useEffect(() => {
    prevLoadedRef.current = loaded;
  });

  // Re-fetch children when refreshKey changes and the directory is already open/loaded
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={false}
        aria-expanded={node.isDir ? open : undefined}
        onClick={handleClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleClick();
          }
        }}
        className="file-explorer-row"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            className={`file-explorer-chevron${open ? " is-open" : ""}`}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span className="file-explorer-chevron-spacer" />}
        <span className="file-explorer-icon">
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span className="file-explorer-name" title={node.fullPath}>
          {node.name}
        </span>
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {(!node.isDir || onAtMention) && (
          <div className="file-explorer-row-actions">
            {!node.isDir && (
              <a
                href={buildStandaloneFileUrl(node.fullPath, { cwd })}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={t("panels.fileExplorer.openStandalone")}
                aria-label={t("panels.fileExplorer.openStandalone")}
                className="file-explorer-row-action"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 3h7v7" />
                  <path d="M10 14 21 3" />
                  <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                </svg>
              </a>
            )}
            {onAtMention && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAtMention(getRelativeFilePath(node.fullPath, cwd));
                }}
                title={t("panels.fileExplorer.insertPath")}
                className="file-explorer-row-action file-explorer-mention-action"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
                </svg>
                mention
              </button>
            )}
          </div>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.fullPath} node={child} depth={depth + 1} cwd={cwd} onOpenFile={onOpenFile} onAtMention={onAtMention} expandedPaths={expandedPaths} onToggleExpanded={onToggleExpanded} refreshKey={refreshKey} />
          ))}
          {children.length === 0 && loaded && (
            <div className="file-explorer-empty-branch" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ cwd, onOpenFile, refreshKey, onAtMention }: Props) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const prevCwdRef = useRef<string | null>(null);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset project-owned state immediately so a previous workspace is never
    // displayed while the newly selected workspace is loading.
    if (cwdChanged) {
      setExpandedPaths(new Set());
      setRoots([]);
    }

    setLoading(cwdChanged);
    setError(null);
    fetchEntries(cwd, controller.signal)
      .then((entries) => {
        if (!controller.signal.aborted) setRoots(entries);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [cwd, refreshKey]);

  if (loading) {
    return <div className="inspector-state inspector-state-loading file-explorer-state">Loading files...</div>;
  }

  if (error) {
    return <div className="inspector-state inspector-state-error file-explorer-state" role="alert">{error}</div>;
  }

  return (
    <div className="file-explorer-tree" role="tree">
      {roots.map((node) => (
        <TreeNode
          key={node.fullPath}
          node={node}
          depth={0}
          cwd={cwd}
          onOpenFile={onOpenFile}
          onAtMention={onAtMention}
          expandedPaths={expandedPaths}
          onToggleExpanded={handleToggleExpanded}
          refreshKey={refreshKey}
        />
      ))}
      {roots.length === 0 && (
        <div className="inspector-state inspector-state-empty file-explorer-state">No files found</div>
      )}
    </div>
  );
}
