"use client";

import { useI18n } from "@/components/I18nProvider";
import { useCallback, useEffect, useState } from "react";
import type { GitCommitChangedFile, GitCommitFileDiffResponse } from "@/lib/types";
import { DiffModal } from "./DiffModal";

interface Props {
  cwd: string;
  hash: string;
  shortHash?: string;
  file: GitCommitChangedFile;
  onClose: () => void;
}

function statusLabel(status: GitCommitChangedFile["status"]): string {
  switch (status) {
    case "A": return "Added";
    case "D": return "Deleted";
    case "R": return "Renamed";
    case "C": return "Copied";
    case "T": return "Type changed";
    case "U": return "Unmerged";
    case "M": return "Modified";
    default: return "Changed";
  }
}

function reasonLabel(reason: GitCommitFileDiffResponse["reason"], t: (key: string) => string): string {
  switch (reason) {
    case "binary": return t("panels.diff.binary");
    case "too-large": return t("panels.diff.tooLargeBrowser");
    case "unavailable":
    default:
      return t("panels.diff.noTextInCommit");
  }
}

export function GitCommitDiffModal({ cwd, hash, shortHash, file, onClose }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<GitCommitFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cwd, hash, path: file.file });
      if (file.oldFile) params.set("oldPath", file.oldFile);
      const res = await fetch(`/api/git/diff?${params.toString()}`);
      const body = await res.json() as GitCommitFileDiffResponse | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      setData(body as GitCommitFileDiffResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, file.file, file.oldFile, hash]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const displayPath = file.oldFile ? `${file.oldFile} → ${file.file}` : file.file;
  const diff = data?.diffAvailable && data.diff ? data.diff : undefined;

  return (
    <DiffModal
      ariaLabel={`Diff for ${file.file}`}
      loading={loading}
      error={error}
      diff={diff}
      fallback={reasonLabel(data?.reason, t)}
      onClose={onClose}
      header={(
        <>
          <div className="diff-modal-title-row">
            <span className="diff-modal-revision">{shortHash ?? hash.slice(0, 8)}</span>
            <span className="diff-modal-path">{displayPath}</span>
          </div>
          <div className="diff-modal-meta">
            <span>{statusLabel(file.status)}</span>
            {typeof file.additions === "number" && <span className="is-success">+{file.additions}</span>}
            {typeof file.deletions === "number" && <span className="is-danger">-{file.deletions}</span>}
            {file.binary && <span>binary</span>}
          </div>
        </>
      )}
    />
  );
}
