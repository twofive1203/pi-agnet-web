"use client";

export function AutomationRunList(props: {
  runs: Array<{
    id: string;
    status: string;
    trigger?: string;
    summary?: string | null;
    createdAt: string;
    completedAt?: string | null;
    startedAt?: string | null;
    scheduledForUtc?: string | null;
    requestedModel?: { provider?: string; modelId?: string } | null;
    actualModel?: { provider?: string; modelId?: string } | null;
    effectiveTools?: string[];
    usage?: { totalTokens?: number; costUsd?: number | null } | null;
    blockedReason?: string | null;
    errorMessage?: string | null;
    errorCategory?: string | null;
  }>;
  onOpen: (runId: string) => void;
  title: string;
  /** Pagination */
  offset?: number;
  limit?: number;
  total?: number;
  onPageChange?: (offset: number) => void;
  formatStatus?: (status: string) => string;
  formatTrigger?: (trigger: string | undefined) => string;
  formatDiag?: (run: {
    blockedReason?: string | null;
    errorCategory?: string | null;
    status?: string;
  }) => string | null;
  labels?: {
    pagePrev?: string;
    pageNext?: string;
    pageOf?: string;
    modelMissing?: string;
    usageShort?: string;
    schedActual?: string;
    toolsNone?: string;
    fallbackNone?: string;
  };
}) {
  const offset = props.offset ?? 0;
  const limit = props.limit ?? (props.runs.length || 50);
  const total = props.total ?? props.runs.length;
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const dash = props.labels?.fallbackNone ?? "—";

  if (!props.runs.length && total === 0) {
    return (
      <div className="automation-empty muted">
        {props.title}: {dash}
      </div>
    );
  }
  return (
    <div className="automation-run-list">
      <h4>{props.title}</h4>
      <ul>
        {props.runs.map((run) => {
          const scheduled = run.scheduledForUtc || null;
          const actual = run.startedAt || run.completedAt || null;
          const model =
            run.actualModel?.modelId ||
            run.requestedModel?.modelId ||
            null;
          const provider =
            run.actualModel?.provider ||
            run.requestedModel?.provider ||
            null;
          const tools = run.effectiveTools?.length
            ? run.effectiveTools.join(", ")
            : props.labels?.toolsNone ?? dash;
          const usage =
            run.usage != null
              ? (props.labels?.usageShort ?? "{total} tok / ${cost}")
                  .replace("{total}", String(run.usage.totalTokens ?? 0))
                  .replace("{cost}", String(run.usage.costUsd ?? 0))
              : dash;
          const diag =
            props.formatDiag?.(run) ??
            (run.blockedReason ||
              run.errorCategory ||
              (run.status === "ambiguous" ? "ambiguous" : null));
          const statusLabel = props.formatStatus?.(run.status) ?? run.status;
          const triggerLabel = props.formatTrigger?.(run.trigger) ?? run.trigger ?? "";
          const schedLine = (props.labels?.schedActual ?? "sched={scheduled} · actual={actual}")
            .replace("{scheduled}", scheduled ? new Date(scheduled).toLocaleString() : dash)
            .replace("{actual}", actual ? new Date(actual).toLocaleString() : dash);
          const modelLine =
            provider && model
              ? `${provider}/${model}`
              : props.labels?.modelMissing ?? dash;
          return (
            <li key={run.id}>
              <button type="button" className="linkish" onClick={() => props.onOpen(run.id)}>
                <span className={`status status-${run.status}`}>{statusLabel}</span>
                <span className="muted">{triggerLabel}</span>
                <span>{run.summary || run.id}</span>
                <span className="muted" title="scheduled vs actual">
                  {schedLine}
                </span>
                <span className="muted">
                  {modelLine} · {tools}
                </span>
                <span className="muted">{usage}</span>
                {diag ? (
                  <span className="error">
                    {diag}
                    {run.errorMessage ? `: ${run.errorMessage}` : ""}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {props.onPageChange && total > limit ? (
        <div className="automation-pagination" role="navigation" aria-label={props.title}>
          <button
            type="button"
            disabled={!hasPrev}
            onClick={() => props.onPageChange?.(Math.max(0, offset - limit))}
          >
            {props.labels?.pagePrev ?? "Previous"}
          </button>
          <span className="muted" aria-live="polite">
            {(props.labels?.pageOf ?? "Page {page} · {total} total")
              .replace("{page}", String(page))
              .replace("{total}", String(total))}
          </span>
          <button
            type="button"
            disabled={!hasNext}
            onClick={() => props.onPageChange?.(offset + limit)}
          >
            {props.labels?.pageNext ?? "Next"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
