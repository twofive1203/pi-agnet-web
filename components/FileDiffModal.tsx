"use client";

import { useI18n } from "@/components/I18nProvider";
import { useCallback, useEffect, useState } from "react";
import type { SessionChangedFileSummary, SessionFileDiffResponse } from "@/lib/types";
import { DiffModal } from "./DiffModal";

interface Props {
  sessionId: string;
  file: SessionChangedFileSummary;
  onClose: () => void;
  /**
   * true: render the overlay inside the nearest positioned ancestor (compact host).
   * false (recommended for file diffs): full-viewport fixed overlay. DiffModal portals
   * non-contained dialogs to document.body so inspector/chat hosts cannot trap them.
   */
  contained?: boolean;
}

function statusLabel(status: SessionChangedFileSummary["status"], t: (key: string) => string): string {
  switch (status) {
    case "added": return "Added";
    case "deleted": return "Deleted";
    case "metadata-only": return t("panels.diff.metadataOnly");
    case "modified":
    default:
      return "Modified";
  }
}

function reasonLabel(reason: SessionFileDiffResponse["reason"], t: (key: string) => string): string {
  switch (reason) {
    case "binary": return t("panels.diff.binary");
    case "too-large": return t("panels.diff.tooLarge");
    case "outside-workspace": return t("panels.diff.outsideWorkspace");
    case "unreadable": return t("panels.diff.unreadable");
    case "unchanged": return t("panels.diff.noCumulative");
    default: return t("panels.diff.noText");
  }
}

export function FileDiffModal({ sessionId, file, onClose, contained = false }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<SessionFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes/file?path=${encodeURIComponent(file.path)}`);
      const body = await res.json() as SessionFileDiffResponse | { error?: string };
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      setData(body as SessionFileDiffResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [file.path, sessionId]);

  useEffect(() => {
    void loadDiff();
  }, [loadDiff]);

  const display = data ?? file;
  const diff = data?.diffAvailable && data.diff ? data.diff : undefined;

  return (
    <DiffModal
      ariaLabel={`Diff for ${file.path}`}
      loading={loading}
      error={error}
      diff={diff}
      fallback={reasonLabel(data?.reason ?? file.reason, t)}
      onClose={onClose}
      contained={contained}
      header={(
        <>
          <div className="diff-modal-path">{file.path}</div>
          <div className="diff-modal-meta">
            <span>{statusLabel(display.status, t)}</span>
            <span className="is-success">+{display.additions}</span>
            <span className="is-danger">-{display.deletions}</span>
            <span>via {display.toolNames.join(", ")}</span>
          </div>
        </>
      )}
    />
  );
}
