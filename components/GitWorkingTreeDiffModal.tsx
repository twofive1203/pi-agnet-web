"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import type {
  GitFileChange,
  GitWorkingTreeDiffScope,
  GitWorkingTreeFileDiffResponse,
} from "@/lib/types";
import { DiffModal } from "./DiffModal";

interface Props {
  cwd: string;
  scope: GitWorkingTreeDiffScope;
  file: GitFileChange;
  onClose: () => void;
}

function reasonLabel(
  reason: GitWorkingTreeFileDiffResponse["reason"],
  t: (key: string) => string,
): string {
  switch (reason) {
    case "binary": return t("panels.diff.binary");
    case "too-large": return t("panels.diff.tooLargeBrowser");
    case "unavailable":
    default:
      return t("git.noWorkingTreeDiff");
  }
}

export function GitWorkingTreeDiffModal({ cwd, scope, file, onClose }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<GitWorkingTreeFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cwd, scope, path: file.file });
      if (file.oldFile) params.set("oldPath", file.oldFile);
      const res = await fetch(`/api/git/diff?${params.toString()}`);
      const body = await res.json() as GitWorkingTreeFileDiffResponse | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      setData(body as GitWorkingTreeFileDiffResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd, file.file, file.oldFile, scope]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const displayPath = file.oldFile ? `${file.oldFile} → ${file.file}` : file.file;
  const diff = data?.diffAvailable && data.diff ? data.diff : undefined;

  return (
    <DiffModal
      ariaLabel={t("git.workingTreeDiffAria", { file: file.file })}
      loading={loading}
      error={error}
      diff={diff}
      fallback={reasonLabel(data?.reason, t)}
      onClose={onClose}
      header={(
        <>
          <div className="diff-modal-title-row">
            <span className="diff-modal-revision">
              {scope === "staged" ? t("git.stagedShort") : t("git.unstagedShort")}
            </span>
            <span className="diff-modal-path">{displayPath}</span>
          </div>
          <div className="diff-modal-meta">
            <span>{t(`git.status.${file.status}`)}</span>
          </div>
        </>
      )}
    />
  );
}
