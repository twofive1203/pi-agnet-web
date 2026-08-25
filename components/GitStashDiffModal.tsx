"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { DiffModal } from "@/components/DiffModal";
import { fetchGitStashDiff } from "@/lib/git-stash-client";
import type { GitStashEntry, GitStashFile, GitStashFileDiffResponse } from "@/lib/types";

function fallbackLabel(
  reason: GitStashFileDiffResponse["reason"],
  t: (key: string) => string,
): string {
  switch (reason) {
    case "binary": return t("panels.diff.binary");
    case "too-large": return t("panels.diff.tooLargeBrowser");
    case "unavailable":
    default:
      return t("git.stashManager.diffUnavailable");
  }
}

export function GitStashDiffModal({
  cwd,
  entry,
  file,
  onClose,
}: {
  cwd: string;
  entry: GitStashEntry;
  file: GitStashFile;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<GitStashFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchGitStashDiff(cwd, entry.oid, file, signal));
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [cwd, entry.oid, file]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const displayPath = file.oldFile ? `${file.oldFile} → ${file.file}` : file.file;
  return (
    <DiffModal
      ariaLabel={t("git.stashManager.diffAria", { file: file.file })}
      loading={loading}
      error={error}
      diff={data?.diffAvailable ? data.diff : undefined}
      fallback={fallbackLabel(data?.reason, t)}
      onClose={onClose}
      header={(
        <>
          <div className="diff-modal-title-row">
            <span className="diff-modal-revision">{entry.shortOid}</span>
            <span className="diff-modal-path">{displayPath}</span>
          </div>
          <div className="diff-modal-meta">
            <span>{entry.name}</span>
            <span>{file.source === "untracked" ? t("git.stashManager.untrackedSource") : t("git.stashManager.trackedSource")}</span>
          </div>
        </>
      )}
    />
  );
}
