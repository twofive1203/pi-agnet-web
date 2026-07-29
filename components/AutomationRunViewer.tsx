"use client";

import { MessageView } from "./MessageView";

type TranscriptEntry = {
  type?: string;
  role?: string;
  message?: unknown;
  content?: unknown;
  id?: string;
  entryId?: string;
};

function asAgentMessage(entry: TranscriptEntry): unknown | null {
  if (!entry || typeof entry !== "object") return null;
  // Normalized session entries often nest message; others are already message-shaped.
  if (entry.message && typeof entry.message === "object") return entry.message;
  if (entry.role || entry.type === "message") return entry;
  return null;
}

export function AutomationRunViewer(props: {
  run: {
    id: string;
    status: string;
    summary?: string | null;
    errorMessage?: string | null;
    errorCategory?: string | null;
    blockedReason?: string | null;
    trigger?: string;
    scheduledForUtc?: string | null;
    createdAt?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    requestedModel?: { provider?: string; modelId?: string; thinking?: string | null } | null;
    actualModel?: { provider?: string; modelId?: string; thinking?: string | null } | null;
    effectiveTools?: string[];
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number | null } | null;
    session?: {
      availability?: string;
      sealed?: boolean;
      sessionId?: string | null;
      unavailableReason?: string | null;
    };
    promoteEligible?: boolean;
    cwd?: string;
  } | null;
  transcript: { entries?: unknown[]; total?: number; session?: { availability?: string } } | null;
  changes?: { files?: unknown[]; available?: boolean } | null;
  labels: {
    promote: string;
    noSession: string;
    export: string;
    cancel?: string;
    deleteArtifacts?: string;
    changes?: string;
    trigger?: string;
    scheduled?: string;
    actualStart?: string;
    completed?: string;
    requestedModel?: string;
    actualModel?: string;
    effectiveTools?: string;
    usageCost?: string;
    session?: string;
    cwd?: string;
    blocked?: string;
    runDetail?: string;
    transcript?: string;
    back?: string;
    pagePrev?: string;
    pageNext?: string;
    loadMore?: string;
    artifactsUnavailable?: string;
    usageLine?: string;
    toolsNone?: string;
    sealed?: string;
    unsealed?: string;
    fallbackNone?: string;
    /** Pre-localized status/trigger/diagnostic values */
    status?: string;
    triggerValue?: string;
    blockedReason?: string;
    errorCategory?: string;
    availability?: string;
    unavailableReason?: string;
    /** Technical field labels (identifiers stay copyable beside localized text). */
    technicalCode?: string;
    technicalSessionId?: string;
    fallbackUnknown?: string;
  };
  transcriptOffset?: number;
  transcriptTotal?: number;
  /** Fixed request page size — Previous must not use the short final-page length. */
  transcriptPageSize?: number;
  onTranscriptPage?: (offset: number) => void;
  onPromote?: () => void;
  onExport?: () => void;
  onCancel?: () => void;
  onDeleteArtifacts?: () => void;
  onBack: () => void;
}) {
  if (!props.run) return null;
  const noSession =
    !props.transcript?.entries?.length &&
    (props.run.session?.availability === "unavailable" ||
      props.transcript?.session?.availability === "unavailable");

  const entries = (props.transcript?.entries ?? []) as TranscriptEntry[];
  const req = props.run.requestedModel;
  const act = props.run.actualModel;
  const transcriptTotal = props.transcriptTotal ?? props.transcript?.total ?? entries.length;
  const transcriptOffset = props.transcriptOffset ?? 0;
  // Never derive page size from the current page length (final page is shorter).
  const pageSize = Math.max(1, props.transcriptPageSize ?? 100);

  return (
    <div className="automation-run-viewer">
      <button type="button" onClick={props.onBack} aria-label={props.labels.back ?? "Back"}>
        ← {props.labels.back ?? ""}
      </button>
      <h3>
        {props.labels.runDetail ?? "Run"} {props.run.id}
      </h3>
      <div className={`status status-${props.run.status}`} aria-live="polite">
        {props.labels.status ?? props.run.status}
      </div>

      {(() => {
        const dash = props.labels.fallbackNone ?? "—";
        const toolsNone = props.labels.toolsNone ?? "(none)";
        const usage =
          props.run.usage != null
            ? (props.labels.usageLine ??
                "{total} tokens (in {input} / out {output}) · ${cost}")
                .replace("{total}", String(props.run.usage.totalTokens ?? 0))
                .replace("{input}", String(props.run.usage.inputTokens ?? 0))
                .replace("{output}", String(props.run.usage.outputTokens ?? 0))
                .replace("{cost}", String(props.run.usage.costUsd ?? 0))
            : dash;
        const sealedLabel = props.run.session?.sealed
          ? props.labels.sealed ?? "sealed"
          : props.labels.unsealed ?? "unsealed";
        return (
          <dl className="automation-run-diagnostics">
            <div>
              <dt>{props.labels.trigger ?? "Trigger"}</dt>
              <dd>{props.labels.triggerValue ?? props.run.trigger ?? dash}</dd>
            </div>
            <div>
              <dt>{props.labels.scheduled ?? "Scheduled"}</dt>
              <dd>{props.run.scheduledForUtc ?? dash}</dd>
            </div>
            <div>
              <dt>{props.labels.actualStart ?? "Actual start"}</dt>
              <dd>{props.run.startedAt ?? dash}</dd>
            </div>
            <div>
              <dt>{props.labels.completed ?? "Completed"}</dt>
              <dd>{props.run.completedAt ?? dash}</dd>
            </div>
            <div>
              <dt>{props.labels.requestedModel ?? "Requested model"}</dt>
              <dd>
                {req ? `${req.provider}/${req.modelId}${req.thinking ? ` (${req.thinking})` : ""}` : dash}
              </dd>
            </div>
            <div>
              <dt>{props.labels.actualModel ?? "Actual model"}</dt>
              <dd>
                {act ? `${act.provider}/${act.modelId}${act.thinking ? ` (${act.thinking})` : ""}` : dash}
              </dd>
            </div>
            <div>
              <dt>{props.labels.effectiveTools ?? "Effective tools"}</dt>
              <dd>
                {props.run.effectiveTools?.length ? props.run.effectiveTools.join(", ") : toolsNone}
              </dd>
            </div>
            <div>
              <dt>{props.labels.usageCost ?? "Usage / cost"}</dt>
              <dd>{usage}</dd>
            </div>
            <div>
              <dt>{props.labels.session ?? "Session"}</dt>
              <dd>
                {props.labels.availability ??
                  props.labels.fallbackUnknown ??
                  dash}
                {` · ${sealedLabel}`}
                {props.labels.unavailableReason
                  ? ` · ${props.labels.unavailableReason}`
                  : ""}
              </dd>
            </div>
            {props.run.session?.sessionId ? (
              <div>
                <dt>{props.labels.technicalSessionId ?? "Session ID"}</dt>
                <dd>
                  <code className="automation-technical-id">{props.run.session.sessionId}</code>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>{props.labels.cwd ?? "Cwd"}</dt>
              <dd>
                <code className="automation-technical-id">{props.run.cwd ?? dash}</code>
              </dd>
            </div>
            {props.run.blockedReason || props.run.errorCategory ? (
              <div>
                <dt>{props.labels.blocked ?? "Blocked / ambiguous"}</dt>
                <dd className="error" role="status">
                  {[
                    props.labels.blockedReason ?? props.labels.fallbackUnknown,
                    props.labels.errorCategory ?? props.labels.fallbackUnknown,
                    props.run.errorMessage,
                  ]
                    .filter(Boolean)
                    .join(" — ")}
                </dd>
              </div>
            ) : null}
            {props.run.blockedReason || props.run.errorCategory ? (
              <div>
                <dt>{props.labels.technicalCode ?? "Technical code"}</dt>
                <dd>
                  <code className="automation-technical-id">
                    {[props.run.blockedReason, props.run.errorCategory].filter(Boolean).join(" / ")}
                  </code>
                </dd>
              </div>
            ) : null}
          </dl>
        );
      })()}

      {props.run.summary ? <p>{props.run.summary}</p> : null}
      {props.run.errorMessage && !props.run.blockedReason ? (
        <p className="error">{props.run.errorMessage}</p>
      ) : null}
      {noSession ? (
        <p className="muted" role="status">
          {props.run.session?.unavailableReason?.includes("retention") ||
          props.run.session?.unavailableReason?.includes("artifacts")
            ? props.labels.artifactsUnavailable ?? props.labels.noSession
            : props.labels.noSession}
        </p>
      ) : null}
      {!noSession && entries.length ? (
        <div
          className="automation-transcript read-only"
          aria-label={props.labels.transcript ?? "Automation transcript"}
        >
          {entries.map((entry, idx) => {
            const message = asAgentMessage(entry);
            if (message) {
              return (
                <div key={(entry.entryId as string) || (entry.id as string) || idx} className="automation-message">
                  {/* Read-only: no fork/edit/navigate handlers */}
                  <MessageView
                    message={message as never}
                    isStreaming={false}
                    modelNames={{}}
                    showTimestamp
                  />
                </div>
              );
            }
            return (
              <pre key={idx} className="automation-transcript-entry">
                {typeof entry === "string" ? entry : JSON.stringify(entry, null, 2)}
              </pre>
            );
          })}
          {props.onTranscriptPage && transcriptTotal > pageSize ? (
            <div className="automation-pagination" role="navigation" aria-label={props.labels.transcript}>
              <button
                type="button"
                disabled={transcriptOffset <= 0}
                onClick={() => props.onTranscriptPage?.(Math.max(0, transcriptOffset - pageSize))}
              >
                {props.labels.pagePrev ?? "Previous"}
              </button>
              <span className="muted" aria-live="polite">
                {transcriptOffset + 1}–{Math.min(transcriptOffset + pageSize, transcriptTotal)} /{" "}
                {transcriptTotal}
              </span>
              <button
                type="button"
                disabled={transcriptOffset + pageSize >= transcriptTotal}
                onClick={() => props.onTranscriptPage?.(transcriptOffset + pageSize)}
              >
                {props.labels.pageNext ?? props.labels.loadMore ?? "Next"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {props.changes?.available && props.changes.files?.length ? (
        <div className="automation-run-changes">
          <h4>{props.labels.changes ?? "Changes"}</h4>
          <ul>
            {(props.changes.files as Array<{ path?: string; relativePath?: string }>).map((f, i) => (
              <li key={i}>{f.relativePath || f.path || JSON.stringify(f)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="automation-run-actions">
        {props.run.promoteEligible && props.onPromote ? (
          <button type="button" onClick={props.onPromote}>
            {props.labels.promote}
          </button>
        ) : null}
        {props.onExport ? (
          <button type="button" onClick={props.onExport}>
            {props.labels.export}
          </button>
        ) : null}
        {props.onCancel &&
        (props.run.status === "running" ||
          props.run.status === "claimed" ||
          props.run.status === "queued") ? (
          <button type="button" onClick={props.onCancel}>
            {props.labels.cancel ?? "Cancel"}
          </button>
        ) : null}
        {props.onDeleteArtifacts && props.run.session?.sealed ? (
          <button type="button" onClick={props.onDeleteArtifacts}>
            {props.labels.deleteArtifacts ?? "Delete artifacts"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
