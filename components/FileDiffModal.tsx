"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionChangedFileSummary, SessionFileDiffResponse } from "@/lib/types";
import { DiffModal } from "./DiffModal";

interface Props {
  sessionId: string;
  file: SessionChangedFileSummary;
  onClose: () => void;
  /**
   * true: render the overlay inside the nearest positioned ancestor (floating panel).
   * false: full-viewport fixed overlay like the Git panel diff modal; callers should
   * portal it to document.body so it escapes narrow/clipped containers.
   */
  contained?: boolean;
}

function statusLabel(status: SessionChangedFileSummary["status"]): string {
  switch (status) {
    case "added": return "Added";
    case "deleted": return "Deleted";
    case "metadata-only": return "Metadata only";
    case "modified":
    default:
      return "Modified";
  }
}

function reasonLabel(reason: SessionFileDiffResponse["reason"]): string {
  switch (reason) {
    case "binary": return "Binary file changes cannot be rendered as text.";
    case "too-large": return "This file is too large to render a safe inline diff.";
    case "outside-workspace": return "This file is outside the current workspace.";
    case "unreadable": return "The file could not be read safely.";
    case "unchanged": return "No cumulative text diff is currently available.";
    default: return "No text diff is available for this change.";
  }
}

export function FileDiffModal({ sessionId, file, onClose, contained = true }: Props) {
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
      fallback={reasonLabel(data?.reason ?? file.reason)}
      onClose={onClose}
      contained={contained}
      header={(
        <>
          <div className="diff-modal-path">{file.path}</div>
          <div className="diff-modal-meta">
            <span>{statusLabel(display.status)}</span>
            <span className="is-success">+{display.additions}</span>
            <span className="is-danger">-{display.deletions}</span>
            <span>via {display.toolNames.join(", ")}</span>
          </div>
        </>
      )}
    />
  );
}
