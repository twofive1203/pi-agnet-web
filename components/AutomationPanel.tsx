"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/components/I18nProvider";
import { useAppDialog } from "@/components/AppDialogProvider";
import { useAutomations } from "@/hooks/useAutomations";
import { AutomationTaskEditor, type AutomationEditorValue } from "./AutomationTaskEditor";
import { AutomationRunList } from "./AutomationRunList";
import { AutomationRunViewer } from "./AutomationRunViewer";
import { canLeaveEditor, type InboxItem } from "@/lib/automation-ui-state";
import {
  formatAuthoritySummaryLines,
  formatEnumLabel,
  formatOmissionKindLabel,
  formatSchedulerDiagnosticRows,
  formatStatusLabel,
  formatTriggerLabel,
  formatUnavailableReasonLabel,
} from "@/lib/automation-locale-format";

function formatInboxTitle(
  item: InboxItem,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  // Titles from buildInboxFromRuns may be machine keys or already-localized strings.
  if (item.title.startsWith("inbox:")) {
    if (item.kind === "succeeded") return t("automation.inboxTitleSucceeded", { summary: "" });
    if (item.kind === "blocked") return t("automation.inboxTitleBlocked", { summary: "" });
    if (item.kind === "ambiguous") return t("automation.inboxTitleAmbiguous");
    if (item.kind === "missed") {
      const m = /^inbox:missed:([^x]*)x(\d+)/.exec(item.title);
      const rawKind = m?.[1] ?? "";
      return t("automation.inboxTitleMissed", {
        kind: formatOmissionKindLabel(rawKind, t),
        count: m?.[2] ?? 1,
        range: "",
      });
    }
  }
  // Prefer re-localizing by kind when title looks like a raw fallback.
  if (item.kind === "succeeded" && (!item.title || item.title === "Automation succeeded")) {
    return t("automation.inboxTitleSucceeded", { summary: "" });
  }
  if (item.kind === "blocked" && (!item.title || item.title === "Automation blocked")) {
    return t("automation.inboxTitleBlocked", { summary: "" });
  }
  if (item.kind === "ambiguous") return t("automation.inboxTitleAmbiguous");
  if (item.kind === "missed") {
    // Localize omission kind even when title already carries a partial English sentence.
    const kindMatch = /(dst_gap|misfire_aggregate)/.exec(item.title);
    if (kindMatch || item.title.startsWith("Missed") || item.title.includes("dst_")) {
      return t("automation.inboxTitleMissed", {
        kind: formatOmissionKindLabel(kindMatch?.[1] ?? item.title, t),
        count: 1,
        range: "",
      });
    }
  }
  // Summary-bearing titles: show as-is (user/run content) with optional kind already labeled.
  return item.title;
}

export function AutomationPanel(props: {
  open: boolean;
  onClose: () => void;
  /** Optional external unread badge consumer */
  onUnreadChange?: (count: number) => void;
  /** Open a promoted normal session in the main chat UI using canonical cwd/path. */
  onOpenSession?: (session: { id: string; cwd: string; path: string }) => void;
  /** One-time desktop-pet deep link; consumed once while open. */
  initialDeepLink?: { taskId: string; runId: string } | null;
  onInitialDeepLinkConsumed?: () => void;
}) {
  const { t } = useI18n();
  const dialog = useAppDialog();
  // Poll when closed so AppShell unread badge is real (not fixed zero).
  // Sensitive actions require real AppDialog confirmation with server authority summary.
  const auto = useAutomations({
    enabled: true,
    pollWhenHidden: true,
    confirmDialog: (input) =>
      dialog.confirm({
        ...input,
        // Hook may pass i18n keys (automation.*) or already-localized titles.
        title: input.title.startsWith("automation.")
          ? t(input.title as "automation.title")
          : input.title,
        // Message is pre-localized via formatApprovalSummary (structured authority).
        message: input.message.startsWith("automation.")
          ? t(input.message as "automation.title")
          : input.message,
      }),
    formatApprovalSummary: (challenge) => {
      const structured = {
        ...(challenge.summaryStructured ?? {}),
        action:
          (challenge.summaryStructured?.action as string | undefined) ??
          challenge.action ??
          "",
      } as Record<string, unknown>;
      const lines = formatAuthoritySummaryLines(structured, challenge.summary, t);
      return lines.join("\n");
    },
    onPromotedSession: (session) => {
      props.onOpenSession?.(session);
    },
  });
  const [editorDirty, setEditorDirty] = useState(false);
  const [deepLinkUnavailable, setDeepLinkUnavailable] = useState(false);
  const deepLinkConsumedKeyRef = useRef<string | null>(null);

  // One-time desktop deep link: open the intended run once per intent key.
  useEffect(() => {
    if (!props.open || !props.initialDeepLink) return;
    const key = `${props.initialDeepLink.taskId}\0${props.initialDeepLink.runId}`;
    if (deepLinkConsumedKeyRef.current === key) return;
    deepLinkConsumedKeyRef.current = key;
    const { taskId, runId } = props.initialDeepLink;
    let cancelled = false;
    void (async () => {
      const found = await auto.openRunWithDetails(taskId, runId);
      if (cancelled) return;
      setDeepLinkUnavailable(!found);
      props.onInitialDeepLinkConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally only reacts to open + intent identity; auto methods are stable enough for one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.initialDeepLink?.taskId, props.initialDeepLink?.runId]);

  const selectedTask = useMemo(() => {
    if (auto.view.kind !== "task" && auto.view.kind !== "run" && auto.view.kind !== "editor") return null;
    const taskId =
      auto.view.kind === "editor"
        ? auto.view.taskId
        : auto.view.kind === "task" || auto.view.kind === "run"
          ? auto.view.taskId
          : null;
    return auto.tasks.find((t) => t.id === taskId) ?? null;
  }, [auto.tasks, auto.view]);

  const selectedRun = useMemo(() => {
    if (auto.view.kind !== "run") return null;
    const runId = auto.view.runId;
    return auto.runs.find((r) => r.id === runId) ?? null;
  }, [auto.runs, auto.view]);

  // Notify parent of real unread count (not fixed zero).
  useEffect(() => {
    props.onUnreadChange?.(auto.unread);
  }, [auto.unread, props]);

  // When editor opens, resolve stable default cwd (canonical) and load target resources.
  useEffect(() => {
    if (!props.open || auto.view.kind !== "editor") return;
    const editorTaskId = auto.view.kind === "editor" ? auto.view.taskId : null;
    const task =
      editorTaskId != null ? auto.tasks.find((t) => t.id === editorTaskId) ?? null : null;
    const cfg = (task?.pendingConfig ?? task?.approvedConfig) as
      | {
          schedule?: { cron?: string; timezone?: string };
          target?: { cwd?: string; cwdSource?: "project" | "default" };
        }
      | undefined;
    const cwdSource = cfg?.target?.cwdSource ?? "default";
    void auto.loadTargetResources({
      cwd: cwdSource === "project" ? cfg?.target?.cwd : undefined,
      cwdSource,
      cron: cfg?.schedule?.cron,
      timezone: cfg?.schedule?.timezone,
    });
    // Intentionally depends on view identity + open, not the whole auto object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, auto.view, auto.tasks, auto.loadTargetResources]);

  if (!props.open) return null;

  async function leaveIfClean(next: () => void) {
    if (auto.view.kind === "editor" && (editorDirty || !canLeaveEditor({ ...auto.view, dirty: editorDirty }))) {
      const ok = await dialog.confirm({
        title: t("automation.title"),
        message: t("automation.dirtyLeave"),
      });
      if (!ok) return;
    }
    next();
  }

  function taskToEditorValue(task: typeof selectedTask): Partial<AutomationEditorValue> | undefined {
    if (!task) return undefined;
    const cfg = (task.pendingConfig ?? task.approvedConfig) as
      | {
          name?: string;
          description?: string;
          schedule?: { cron?: string; timezone?: string };
          target?: { cwd?: string; cwdSource?: "project" | "default" };
          agent?: {
            provider?: string;
            modelId?: string;
            thinking?: string | null;
            prompt?: string;
            maxRuntimeMs?: number;
          };
          authority?: {
            tools?: Array<{ name: string }>;
            budgets?: {
              maxRunsPerDay?: number;
              maxTokensPerRun?: number;
              maxMonthlyCostUsd?: number;
              consecutiveFailureThreshold?: number;
            };
            approvalExpiresAt?: string | null;
          };
        }
      | undefined;
    if (!cfg) return { name: task.name };
    return {
      name: cfg.name ?? task.name,
      description: cfg.description ?? "",
      cron: cfg.schedule?.cron ?? "0 8 * * *",
      timezone: cfg.schedule?.timezone ?? "Asia/Shanghai",
      cwdSource: cfg.target?.cwdSource ?? "default",
      cwd: cfg.target?.cwd ?? "",
      provider: cfg.agent?.provider ?? "anthropic",
      modelId: cfg.agent?.modelId ?? "",
      thinking: cfg.agent?.thinking ?? "",
      prompt: cfg.agent?.prompt ?? "",
      maxRuntimeMs: cfg.agent?.maxRuntimeMs ?? 30 * 60 * 1000,
      toolNames: (cfg.authority?.tools ?? []).map((x) => x.name),
      maxRunsPerDay: cfg.authority?.budgets?.maxRunsPerDay ?? 48,
      maxTokensPerRun: cfg.authority?.budgets?.maxTokensPerRun ?? 200_000,
      maxMonthlyCostUsd: cfg.authority?.budgets?.maxMonthlyCostUsd ?? 50,
      consecutiveFailureThreshold: cfg.authority?.budgets?.consecutiveFailureThreshold ?? 3,
      approvalExpiresAt: cfg.authority?.approvalExpiresAt ?? "",
    };
  }

  function budgetsPayload(value: AutomationEditorValue) {
    return {
      budgets: {
        maxRunsPerDay: value.maxRunsPerDay,
        maxTokensPerRun: value.maxTokensPerRun,
        maxMonthlyCostUsd: value.maxMonthlyCostUsd,
        consecutiveFailureThreshold: value.consecutiveFailureThreshold,
      },
      approvalExpiresAt: value.approvalExpiresAt || null,
    };
  }

  async function handleSaveDraft(value: AutomationEditorValue) {
    const body = {
      name: value.name,
      description: value.description,
      cron: value.cron,
      timezone: value.timezone,
      cwdSource: value.cwdSource,
      cwd: value.cwdSource === "project" ? value.cwd : undefined,
      provider: value.provider,
      modelId: value.modelId,
      thinking: value.thinking || null,
      prompt: value.prompt,
      maxRuntimeMs: value.maxRuntimeMs,
      tools: value.toolNames.map((name) => ({
        name,
        origin: name === "web_search" || name === "web_fetch" ? "custom" : "builtin",
      })),
      ...budgetsPayload(value),
    };
    if (selectedTask && auto.view.kind === "editor" && auto.view.taskId) {
      await auto.updateTask(selectedTask.id, selectedTask.revision, body);
    } else {
      await auto.createDraft(body);
    }
    auto.setView({ kind: "list" });
  }

  async function handleReviewActivate(value: AutomationEditorValue) {
    // Authority summary + confirmation happen inside activate()/updateTask() via AppDialog.
    const body = {
      name: value.name,
      description: value.description,
      cron: value.cron,
      timezone: value.timezone,
      cwdSource: value.cwdSource,
      cwd: value.cwdSource === "project" ? value.cwd : undefined,
      provider: value.provider,
      modelId: value.modelId,
      thinking: value.thinking || null,
      prompt: value.prompt,
      maxRuntimeMs: value.maxRuntimeMs,
      tools: value.toolNames.map((name) => ({
        name,
        origin: name === "web_search" || name === "web_fetch" ? "custom" : "builtin",
      })),
      ...budgetsPayload(value),
    };
    let task = selectedTask;
    if (task && auto.view.kind === "editor" && auto.view.taskId) {
      task = await auto.updateTask(task.id, task.revision, body);
    } else {
      task = await auto.createDraft(body);
    }
    await auto.activate(task.id, task.revision, task.status);
    auto.setView({ kind: "task", taskId: task.id, tab: "overview" });
  }

  return (
    <div className="automation-panel" role="dialog" aria-label={t("automation.title")}>
      <header className="automation-panel-header">
        <h2>{t("automation.title")}</h2>
        <button type="button" onClick={() => void leaveIfClean(props.onClose)} aria-label={t("automation.close")}>
          ×
        </button>
      </header>

      <p className="muted" aria-live="polite">
        {auto.degraded ? t("automation.schedulerUnavailable") : t("automation.schedulerOk")}
        {" · "}
        {t("automation.localOnly")}
        {auto.unread > 0 ? ` · ${auto.unread}` : ""}
      </p>

      {auto.loading ? <div>{t("automation.loading")}</div> : null}
      {auto.error ? (
        <div className="error" role="alert">
          {auto.error}
        </div>
      ) : null}
      {deepLinkUnavailable ? (
        <div className="error" role="status">
          {t("automation.deepLinkUnavailable")}
        </div>
      ) : null}

      {auto.view.kind === "list" ? (
        <div className="automation-list">
          <div className="automation-list-actions">
            <button type="button" onClick={() => auto.openEditor(null)}>
              {t("automation.create")}
            </button>
            {auto.scheduler?.repairRequired ? (
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const ok = await dialog.confirm({
                      title: t("automation.title"),
                      message: t("automation.confirmRepairLock"),
                    });
                    if (ok) await auto.repairScheduler();
                  })();
                }}
              >
                {t("automation.repairLock")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const enabling = Boolean(auto.scheduler?.globalDisabled);
                  const ok = await dialog.confirm({
                    title: t("automation.title"),
                    message: enabling
                      ? t("automation.confirmGlobalEnable")
                      : t("automation.confirmGlobalDisable"),
                  });
                  if (ok) await auto.setGlobalDisabled(!auto.scheduler?.globalDisabled);
                })();
              }}
            >
              {auto.scheduler?.globalDisabled
                ? t("automation.globalEnable")
                : t("automation.globalDisable")}
            </button>
          </div>
          {auto.schedulerDiagnostics.length ? (
            <details className="automation-scheduler-diagnostics">
              <summary>{t("automation.schedulerDiagnostics")}</summary>
              <pre aria-live="polite">
                {formatSchedulerDiagnosticRows(auto.schedulerDiagnostics as never, t).join("\n")}
              </pre>
              <p className="muted">{t("automation.localOnlyTrust")}</p>
            </details>
          ) : null}
          {!auto.tasks.length ? (
            <div className="automation-empty">{t("automation.empty")}</div>
          ) : (
            <ul>
              {auto.tasks.map((task) => (
                <li key={task.id}>
                  <button type="button" className="linkish" onClick={() => auto.openTask(task.id)}>
                    <strong>{task.name}</strong>
                    <span className={`status status-${task.status}`}>{formatStatusLabel(task.status, t)}</span>
                    <span className="muted">{String(task.nextRunAt ?? "")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {auto.inbox.length || auto.inboxTotal > 0 ? (
            <div className="automation-inbox">
              <h4>
                {t("automation.badge")}
                {auto.unread > 0 ? ` (${auto.unread})` : ""}
              </h4>
              {!auto.inbox.length ? (
                <div className="muted">{t("automation.inboxEmpty")}</div>
              ) : (
                <ul>
                  {auto.inbox.map((item) => {
                    const kindLabel =
                      item.kind === "succeeded"
                        ? t("automation.kindSucceeded")
                        : item.kind === "blocked"
                          ? t("automation.kindBlocked")
                          : item.kind === "ambiguous"
                            ? t("automation.kindAmbiguous")
                            : t("automation.kindMissed");
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className={item.read ? "muted" : undefined}
                          onClick={() => {
                            auto.markRead(item.id);
                            if (item.runId) {
                              // Deep link: fetch run record + open details (works outside loaded page).
                              void auto.openRunWithDetails(item.taskId, item.runId);
                            } else {
                              auto.openTask(item.taskId);
                            }
                          }}
                        >
                          [{kindLabel}] {formatInboxTitle(item, t)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {auto.inboxTotal > auto.inboxLimit ? (
                <div className="automation-pagination" role="navigation" aria-label={t("automation.inboxPage")}>
                  <button
                    type="button"
                    disabled={auto.inboxOffset <= 0}
                    onClick={() => void auto.loadInboxPage(Math.max(0, auto.inboxOffset - auto.inboxLimit))}
                  >
                    {t("automation.pagePrev")}
                  </button>
                  <span className="muted" aria-live="polite">
                    {t("automation.pageOf", {
                      page: String(Math.floor(auto.inboxOffset / Math.max(1, auto.inboxLimit)) + 1),
                      total: String(auto.inboxTotal),
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={auto.inboxOffset + auto.inboxLimit >= auto.inboxTotal}
                    onClick={() => void auto.loadInboxPage(auto.inboxOffset + auto.inboxLimit)}
                  >
                    {t("automation.pageNext")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {auto.view.kind === "editor" ? (
        <AutomationTaskEditor
          initial={taskToEditorValue(selectedTask)}
          catalog={auto.catalog as never}
          models={auto.models}
          nextPreview={auto.editorPreview}
          schedulerOnline={!auto.degraded}
          authoritySummary={formatAuthoritySummaryLines(
            selectedTask?.authoritySummaryStructured as Record<string, unknown> | undefined,
            Array.isArray(selectedTask?.authoritySummary)
              ? (selectedTask?.authoritySummary as string[])
              : undefined,
            t,
          )}
          labels={{
            saveDraft: t("automation.saveDraft"),
            reviewActivate: t("automation.reviewActivate"),
            tools: t("automation.tools"),
            prompt: t("automation.prompt"),
            model: t("automation.model"),
            cron: t("automation.cron"),
            timezone: t("automation.timezone"),
            cwd: t("automation.cwd"),
            budgets: t("automation.budgets"),
            nextPreview: t("automation.nextPreview"),
            authoritySummary: t("automation.authoritySummary"),
            approvalExpiry: t("automation.approvalExpiry"),
            schedulerOnline: t("automation.schedulerOk"),
            name: t("automation.name"),
            description: t("automation.description"),
            thinking: t("automation.thinking"),
            maxRunsPerDay: t("automation.maxRunsPerDay"),
            maxTokensPerRun: t("automation.maxTokensPerRun"),
            maxMonthlyCost: t("automation.maxMonthlyCost"),
            consecutiveFailureThreshold: t("automation.consecutiveFailureThreshold"),
            approvalExpiresNone: t("automation.approvalExpiresNone"),
            approvalExpiresAt: t("automation.approvalExpiresAt"),
            schedulerOnlineRequired: t("automation.schedulerOnlineRequired"),
            schedulerOfflineHint: t("automation.schedulerOfflineHint"),
            schedulerOfflineActivateHint: t("automation.schedulerOfflineActivateHint"),
            budgetsLine: t("automation.budgetsLine"),
            cwdDefaultOption: t("automation.cwdDefaultOption"),
            cwdProjectOption: t("automation.cwdProjectOption"),
            cwdProjectPlaceholder: t("automation.cwdProjectPlaceholder"),
            modelHint: t("automation.modelHint"),
            riskLocalMutation: t("automation.riskLocalMutation"),
            riskNetworkEgress: t("automation.riskNetworkEgress"),
            riskCredentialUse: t("automation.riskCredentialUse"),
            riskInteractionRequired: t("automation.riskInteractionRequired"),
            riskBlocked: t("automation.riskBlocked"),
          }}
          onDirty={setEditorDirty}
          onChangeMeta={(value) => {
            void auto.loadTargetResources({
              cwd: value.cwdSource === "project" ? value.cwd : undefined,
              cwdSource: value.cwdSource,
              cron: value.cron,
              timezone: value.timezone,
            });
          }}
          onSaveDraft={handleSaveDraft}
          onReviewActivate={handleReviewActivate}
        />
      ) : null}

      {auto.view.kind === "task" && selectedTask ? (
        <div className="automation-task-detail">
          <button type="button" onClick={() => auto.setView({ kind: "list" })}>
            ←
          </button>
          <h3>{selectedTask.name}</h3>
          <div className={`status status-${selectedTask.status}`} aria-live="polite">
            {formatStatusLabel(selectedTask.status, t)}
          </div>
          <p className="muted">
            {t("automation.nextRun")}: {String(selectedTask.nextRunAt ?? "—")}
          </p>
          {Array.isArray(selectedTask.nextPreview) && selectedTask.nextPreview.length ? (
            <div className="automation-next-preview">
              <h4>{t("automation.nextPreview")}</h4>
              <ul>
                {(selectedTask.nextPreview as Array<{ utc: string; localWallTime: string }>).map((p) => (
                  <li key={p.utc}>
                    <span>{p.localWallTime}</span>
                    <span className="muted"> ({p.utc})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {(() => {
            const lines = formatAuthoritySummaryLines(
              selectedTask.authoritySummaryStructured as Record<string, unknown> | undefined,
              Array.isArray(selectedTask.authoritySummary)
                ? (selectedTask.authoritySummary as string[])
                : undefined,
              t,
            );
            if (!lines.length) return null;
            return (
              <details className="automation-authority-summary">
                <summary>{t("automation.authoritySummary")}</summary>
                <pre>{lines.join("\n")}</pre>
              </details>
            );
          })()}
          {(() => {
            const cfg = (selectedTask.pendingConfig ?? selectedTask.approvedConfig) as
              | { authority?: { budgets?: Record<string, number> } }
              | undefined;
            const budgets = cfg?.authority?.budgets;
            if (!budgets) return null;
            return (
              <div className="automation-budgets muted">
                <strong>{t("automation.budgets")}</strong>
                <div>
                  {t("automation.budgetsDetail", {
                    runs: String(budgets.maxRunsPerDay ?? "—"),
                    tokens: String(budgets.maxTokensPerRun ?? "—"),
                    cost: String(budgets.maxMonthlyCostUsd ?? "—"),
                    threshold: String(budgets.consecutiveFailureThreshold ?? "—"),
                  })}
                </div>
                <div>
                  {t("automation.consecutiveFailures")}: {String(selectedTask.consecutiveFailures ?? 0)}
                </div>
              </div>
            );
          })()}
          <div className="automation-actions">
            <button type="button" onClick={() => auto.openEditor(selectedTask.id)}>
              {t("automation.edit")}
            </button>
            {selectedTask.status === "draft" ||
            selectedTask.status === "paused" ||
            selectedTask.status === "blocked" ? (
              <button
                type="button"
                onClick={() => void auto.activate(selectedTask.id, selectedTask.revision, selectedTask.status)}
              >
                {selectedTask.status === "draft" ? t("automation.activate") : t("automation.resume")}
              </button>
            ) : null}
            {selectedTask.status === "active" ? (
              <button type="button" onClick={() => void auto.pause(selectedTask.id, selectedTask.revision)}>
                {t("automation.pause")}
              </button>
            ) : null}
            {selectedTask.status === "active" || selectedTask.status === "paused" ? (
              <button type="button" onClick={() => void auto.runNow(selectedTask.id, selectedTask.revision)}>
                {t("automation.runNow")}
              </button>
            ) : null}
            {selectedTask.status !== "archived" ? (
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const ok = await dialog.confirm({
                      title: t("automation.archive"),
                      message: selectedTask.name,
                    });
                    if (ok) await auto.archive(selectedTask.id, selectedTask.revision);
                  })();
                }}
              >
                {t("automation.archive")}
              </button>
            ) : null}
          </div>
          <AutomationRunList
            title={t("automation.runs")}
            runs={auto.runs.filter((r) => r.taskId === selectedTask.id)}
            offset={
              auto.taskRunsTaskId === selectedTask.id ? auto.taskRunsOffset : 0
            }
            limit={auto.runsLimit}
            total={
              auto.taskRunsTaskId === selectedTask.id
                ? auto.taskRunsTotal
                : auto.runs.filter((r) => r.taskId === selectedTask.id).length
            }
            onPageChange={(off) => void auto.loadRunsPage(selectedTask.id, off)}
            formatStatus={(s) => formatStatusLabel(s, t)}
            formatTrigger={(tr) => formatTriggerLabel(tr, t)}
            formatDiag={(run) => {
              const parts = [
                formatEnumLabel("blockedReason", run.blockedReason, t),
                formatEnumLabel("errorCategory", run.errorCategory, t),
              ].filter((p) => p && p !== t("automation.fallbackNone"));
              if (parts.length) return parts.join(" — ");
              if (run.status === "ambiguous") return formatStatusLabel("ambiguous", t);
              return null;
            }}
            labels={{
              pagePrev: t("automation.pagePrev"),
              pageNext: t("automation.pageNext"),
              pageOf: t("automation.pageOf"),
              modelMissing: t("automation.modelMissing"),
              usageShort: t("automation.usageShort"),
              schedActual: t("automation.schedActual"),
              toolsNone: t("automation.toolsNone"),
              fallbackNone: t("automation.fallbackNone"),
            }}
            onOpen={(runId) => {
              void auto.openRunWithDetails(selectedTask.id, runId);
            }}
          />
        </div>
      ) : null}

      {auto.view.kind === "run" && selectedRun ? (
        <AutomationRunViewer
          run={selectedRun as never}
          transcript={auto.selectedRunTranscript as never}
          changes={auto.selectedRunChanges as never}
          transcriptOffset={auto.transcriptOffset}
          transcriptTotal={auto.transcriptTotal}
          transcriptPageSize={auto.transcriptLimit}
          onTranscriptPage={(off) =>
            void auto.loadRunSession(selectedRun.id, off, auto.transcriptLimit)
          }
          labels={{
            promote: t("automation.promote"),
            noSession: t("automation.noSession"),
            export: t("automation.export"),
            cancel: t("automation.cancel"),
            deleteArtifacts: t("automation.deleteArtifacts"),
            changes: t("automation.changes"),
            trigger: t("automation.trigger"),
            scheduled: t("automation.scheduled"),
            actualStart: t("automation.actualStart"),
            completed: t("automation.completed"),
            requestedModel: t("automation.requestedModel"),
            actualModel: t("automation.actualModel"),
            effectiveTools: t("automation.effectiveTools"),
            usageCost: t("automation.usageCost"),
            session: t("automation.session"),
            cwd: t("automation.cwd"),
            blocked: t("automation.blocked"),
            runDetail: t("automation.runDetail"),
            transcript: t("automation.transcript"),
            back: t("automation.back"),
            pagePrev: t("automation.pagePrev"),
            pageNext: t("automation.pageNext"),
            loadMore: t("automation.loadMore"),
            artifactsUnavailable: t("automation.artifactsUnavailable"),
            usageLine: t("automation.usageLine"),
            toolsNone: t("automation.toolsNone"),
            sealed: t("automation.sealed"),
            unsealed: t("automation.unsealed"),
            fallbackNone: t("automation.fallbackNone"),
            status: formatStatusLabel(selectedRun.status, t),
            triggerValue: formatTriggerLabel(
              typeof selectedRun.trigger === "string" ? selectedRun.trigger : undefined,
              t,
            ),
            blockedReason: formatEnumLabel(
              "blockedReason",
              typeof selectedRun.blockedReason === "string" ? selectedRun.blockedReason : null,
              t,
            ),
            errorCategory: formatEnumLabel(
              "errorCategory",
              typeof selectedRun.errorCategory === "string" ? selectedRun.errorCategory : null,
              t,
            ),
            availability: formatEnumLabel(
              "availability",
              typeof selectedRun.session === "object" &&
                selectedRun.session &&
                typeof (selectedRun.session as { availability?: string }).availability === "string"
                ? (selectedRun.session as { availability?: string }).availability
                : null,
              t,
            ),
            unavailableReason: formatUnavailableReasonLabel(
              typeof selectedRun.session === "object" &&
                selectedRun.session &&
                typeof (selectedRun.session as { unavailableReason?: string }).unavailableReason ===
                  "string"
                ? (selectedRun.session as { unavailableReason?: string }).unavailableReason
                : null,
              typeof selectedRun.session === "object" &&
                selectedRun.session &&
                typeof (selectedRun.session as { unavailableDetail?: string | null })
                  .unavailableDetail === "string"
                ? (selectedRun.session as { unavailableDetail?: string }).unavailableDetail
                : null,
              t,
            ),
            technicalCode: t("automation.technicalCode"),
            technicalSessionId: t("automation.technicalSessionId"),
            fallbackUnknown: t("automation.fallbackUnknown"),
          }}
          onBack={() => {
            if (auto.view.kind === "run") auto.openTask(auto.view.taskId);
            else auto.setView({ kind: "list" });
          }}
          onPromote={() => {
            void (async () => {
              const promo = (await auto.promote(selectedRun.id)) as {
                destinationSessionId?: string | null;
                destinationSessionFile?: string | null;
                destinationCwd?: string | null;
              } | null;
              const sid = promo?.destinationSessionId;
              if (sid && props.onOpenSession) {
                props.onOpenSession({
                  id: sid,
                  cwd: promo?.destinationCwd || String(selectedRun.cwd || ""),
                  path: promo?.destinationSessionFile || "",
                });
                props.onClose();
              }
            })();
          }}
          onExport={() => void auto.exportRun(selectedRun.id)}
          onCancel={() => void auto.cancelRun(selectedRun.id)}
          onDeleteArtifacts={() => void auto.deleteArtifacts(selectedRun.id)}
        />
      ) : null}
    </div>
  );
}
