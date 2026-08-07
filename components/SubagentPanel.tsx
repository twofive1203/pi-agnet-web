"use client";

import { useState, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useI18n } from "@/components/I18nProvider";
import type {
  SubagentActivityState,
  SubagentProgressSnapshot,
  SubagentRecentTool,
  SubagentRun,
} from "@/hooks/useAgentSession";
import type { MessageParams } from "@/lib/i18n";

type TranslateFn = (key: string, params?: MessageParams) => string;

interface Props {
  runs: readonly SubagentRun[];
}

interface SubagentDetail {
  fingerprint: string;
  depth: number;
  output: string | null;
  outputTruncated: boolean;
  children: SubagentRun[];
  childrenTruncated: boolean;
  fileTruncated: boolean;
}

type DetailState =
  | { status: "loading"; detail?: SubagentDetail }
  | { status: "ready"; detail: SubagentDetail }
  | { status: "error"; detail?: SubagentDetail };

const CURRENT_TOOL_ARGS_PREVIEW = 60;
const RECENT_TOOL_ARGS_PREVIEW = 80;
const MAX_RECENT_TOOLS_DISPLAY = 12;
const MAX_SUBAGENT_DETAIL_DEPTH = 3;
const MAX_DETAIL_CACHE_ENTRIES = 32;
const ACTIVE_DETAIL_REFRESH_MS = 2_000;
const DETAIL_REQUEST_TIMEOUT_MS = 10_000;

function detailKey(run: SubagentRun, depth: number): string | null {
  return run.sessionFile ? `${depth}\0${run.sessionFile}` : null;
}

function useSubagentDetailCache() {
  const cacheRef = useRef(new Map<string, DetailState>());
  const controllersRef = useRef(new Map<string, AbortController>());
  const [, rerender] = useReducer((value: number) => value + 1, 0);

  const abort = useCallback((key: string | null) => {
    if (!key) return;
    controllersRef.current.get(key)?.abort();
    controllersRef.current.delete(key);
    const current = cacheRef.current.get(key);
    if (current?.status === "loading") {
      if (current.detail) cacheRef.current.set(key, { status: "ready", detail: current.detail });
      else cacheRef.current.delete(key);
      rerender();
    }
  }, []);

  const load = useCallback(async (run: SubagentRun, depth: number, force = false) => {
    const key = detailKey(run, depth);
    if (!key || !run.sessionFile || depth > MAX_SUBAGENT_DETAIL_DEPTH) return;
    const current = cacheRef.current.get(key);
    if (!force && (current?.status === "ready" || current?.status === "loading")) return;

    abort(key);
    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    cacheRef.current.set(key, { status: "loading", detail: current?.detail });
    rerender();
    try {
      const headers: HeadersInit = {};
      if (current?.detail?.fingerprint) headers["If-None-Match"] = `"${current.detail.fingerprint}"`;
      const params = new URLSearchParams({ sessionFile: run.sessionFile, depth: String(depth) });
      const response = await fetch(`/api/agent/subagent-children?${params}`, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(DETAIL_REQUEST_TIMEOUT_MS),
        ]),
        headers,
      });
      if (response.status === 304 && current?.detail) {
        cacheRef.current.set(key, { status: "ready", detail: current.detail });
      } else if (response.ok) {
        const detail = await response.json() as SubagentDetail;
        cacheRef.current.delete(key);
        cacheRef.current.set(key, { status: "ready", detail });
        while (cacheRef.current.size > MAX_DETAIL_CACHE_ENTRIES) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest === undefined) break;
          abort(oldest);
          cacheRef.current.delete(oldest);
        }
      } else {
        cacheRef.current.set(key, { status: "error", detail: current?.detail });
      }
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") {
        cacheRef.current.set(key, { status: "error", detail: current?.detail });
      }
    } finally {
      if (controllersRef.current.get(key) === controller) controllersRef.current.delete(key);
      if (!controller.signal.aborted) rerender();
    }
  }, [abort]);

  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    cacheRef.current.clear();
  }, []);

  const get = useCallback((run: SubagentRun, depth: number) => {
    const key = detailKey(run, depth);
    return key ? cacheRef.current.get(key) : undefined;
  }, []);

  return useMemo(() => ({ get, load, abort }), [abort, get, load]);
}

type DetailCache = ReturnType<typeof useSubagentDetailCache>;

export function SubagentPanel({ runs }: Props) {
  const { t } = useI18n();
  const detailCache = useSubagentDetailCache();
  const running = runs.filter((run) => run.status === "running");
  const completed = runs.filter((run) => run.status !== "running");
  const renderRuns = (items: readonly SubagentRun[]) => items.map((run) => (
    <ObservedRunItem key={run.id} run={run} depth={0} detailCache={detailCache} />
  ));

  if (runs.length === 0) {
    return <div className="inspector-state inspector-state-empty">{t("panels.subagents.emptyYet")}</div>;
  }

  return (
    <div className="subagent-panel-root inspector-content">
      {running.length > 0 && (
        <>
          <div className="subagent-section-title">{t("panels.subagents.running")} <span>({running.length})</span></div>
          {renderRuns(running)}
        </>
      )}
      {completed.length > 0 && (
        <>
          <div className={`subagent-section-title${running.length > 0 ? " has-leading-section" : ""}`}>{t("panels.subagents.completed")} <span>({completed.length})</span></div>
          {renderRuns(completed)}
        </>
      )}
    </div>
  );
}

function ObservedRunItem({ run, depth, detailCache }: { run: SubagentRun; depth: number; detailCache: DetailCache }) {
  const [expanded, setExpanded] = useState(false);
  const runRef = useRef(run);
  const previousStatusRef = useRef(run.status);
  runRef.current = run;
  const requestDepth = depth + 1;
  const key = detailKey(run, requestDepth);
  const detailState = detailCache.get(run, requestDepth);

  const toggle = useCallback(() => {
    if (expanded) {
      setExpanded(false);
      detailCache.abort(key);
      return;
    }
    setExpanded(true);
    void detailCache.load(run, requestDepth);
  }, [detailCache, expanded, key, requestDepth, run]);

  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = run.status;
    if (
      expanded
      && previousStatus === "running"
      && run.status !== "running"
      && run.sessionFile
      && requestDepth <= MAX_SUBAGENT_DETAIL_DEPTH
    ) {
      void detailCache.load(run, requestDepth, true);
    }
  }, [detailCache, expanded, requestDepth, run]);

  useEffect(() => {
    if (!expanded || run.status !== "running" || !run.sessionFile || requestDepth > MAX_SUBAGENT_DETAIL_DEPTH) return;
    const timer = setInterval(() => {
      void detailCache.load(runRef.current, requestDepth, true);
    }, ACTIVE_DETAIL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [detailCache, expanded, requestDepth, run.sessionFile, run.status]);

  return (
    <RunItem
      run={run}
      isExpanded={expanded}
      detailState={detailState}
      onToggle={toggle}
      depth={depth}
      detailCache={detailCache}
    />
  );
}

function RunItem({
  run, isExpanded, detailState, onToggle, depth, detailCache,
}: {
  run: SubagentRun;
  isExpanded: boolean;
  detailState?: DetailState;
  onToggle: () => void;
  depth: number;
  detailCache: DetailCache;
}) {
  const { t } = useI18n();
  const indent = depth * 16;
  const progress = run.progress;
  const isDetached = progress?.status === "detached";
  const isRunning = run.status === "running";
  const isFailed = run.status === "failed" || progress?.status === "failed";
  const activityState = progress?.activityState;
  const statusTone = resolveStatusTone({ isRunning, isFailed, isDetached, activityState });
  const statusIcon = isDetached ? "◌" : isRunning ? "○" : isFailed ? "✕" : "✓";
  const statusLabel = isDetached
    ? t("panels.subagents.detached")
    : isRunning
      ? t("panels.subagents.running")
      : isFailed
        ? t("panels.subagents.failed")
        : t("panels.subagents.done");

  const taskDisplay = run.task
    ? run.task.split("\n")[0].slice(0, 120)
    : t("panels.subagents.noTask");

  const detail = detailState?.detail;
  const terminalPreview = run.status !== "running" ? run.result : undefined;
  const displayOutput = detailState?.status === "ready"
    ? detail?.output ?? terminalPreview ?? run.partialOutput
    : terminalPreview ?? detail?.output ?? run.partialOutput;
  const outputTruncated = detail?.outputTruncated ?? run.outputTruncated ?? false;
  const routingLabel = formatRouting(run.routing, t);
  const metadata = getRunMetadata(run.routing, t);
  const metadataTitle = routingLabel ?? metadata.map((item) => `${item.label}: ${item.value}`).join(" · ");
  const hasSessionFile = !!run.sessionFile;
  const canLoadDetail = hasSessionFile && depth < MAX_SUBAGENT_DETAIL_DEPTH;
  const childrenRuns = detail?.children ?? [];
  const hasChildren = childrenRuns.length > 0;
  const recentTools = progress?.recentTools?.slice(-MAX_RECENT_TOOLS_DISPLAY) ?? [];
  const progressSummary = progress ? formatProgressActivity(progress, isRunning && !isDetached, t) : null;
  const progressStats = progress ? formatProgressStats(progress, t) : null;
  const activityBadge = formatActivityBadge(activityState, t);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        className="subagent-run-row"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        style={{ paddingLeft: 16 + indent }}
      >
        <span className={`subagent-status-icon ${statusTone}`}>{statusIcon}</span>
        <span className="subagent-agent-name">{run.agent}</span>
        <span className="subagent-task-title">{taskDisplay}</span>
        {metadata.length > 0 && (
          <RunMetadataChips items={metadata} title={metadataTitle} />
        )}
        {canLoadDetail && !hasChildren && isExpanded && (
          <span className="subagent-inline-state">{detailState?.status === "loading" ? t("panels.subagents.loadingInline") : detailState?.status === "error" ? t("panels.subagents.detailUnavailable") : t("panels.subagents.noChildren")}</span>
        )}
        <span className={`subagent-status-label ${statusTone}`}>{statusLabel}</span>
        <span className="subagent-row-chevron">{isExpanded ? "▲" : "▼"}</span>
      </div>

      {progress && (progressSummary || progressStats || activityBadge) && (
        <div className="subagent-progress-row" style={{ paddingLeft: 16 + indent + 22 }}>
          {progressSummary && (
            <span title={progressSummary.title} className={`subagent-progress-summary${activityBadge ? ` ${activityBadge.tone}` : isDetached ? ` ${statusTone}` : ""}`}>
              {progressSummary.label}
            </span>
          )}
          {progressStats && (
            <span className="subagent-progress-stats">{progressStats}</span>
          )}
          {activityBadge && (
            <span className={`inspector-badge subagent-activity-badge ${activityBadge.tone}`}>
              {activityBadge.label}
            </span>
          )}
          {progress.error && (
            <span title={progress.error} className="subagent-progress-error">
              {progress.failedTool ? `${progress.failedTool}: ` : ""}{truncateText(progress.error, 80)}
            </span>
          )}
        </div>
      )}

      {isExpanded && (
        <div className="subagent-detail" style={{ paddingLeft: 16 + indent + 22 }}>
          {recentTools.length > 0 && (
            <div className="subagent-detail-section">
              <div className="subagent-detail-title">{t("panels.subagents.recentTools")} <span>({recentTools.length})</span></div>
              <div className="subagent-tool-list">
                {recentTools.map((tool, index) => (
                  <div
                    key={`${tool.tool}-${tool.endMs}-${index}`}
                    title={formatRecentToolTitle(tool)}
                    className="subagent-tool-row"
                  >
                    <span className="subagent-tool-name">{tool.tool}</span>
                    {tool.args ? <span className="subagent-tool-args"> {truncateText(tool.args, RECENT_TOOL_ARGS_PREVIEW)}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Load exactly one nested level per expansion. */}
          {hasChildren && (
            <div className="subagent-detail-section">
              <div className="subagent-detail-title">{t("panels.subagents.title")} <span>({childrenRuns.length}{detail?.childrenTruncated ? "+" : ""})</span></div>
              {childrenRuns.map((child) => (
                <ObservedRunItem
                  key={`${child.sessionFile ?? child.id}-${child.id}`}
                  run={child}
                  depth={depth + 1}
                  detailCache={detailCache}
                />
              ))}
            </div>
          )}
          {detailState?.status === "loading" && !detail && canLoadDetail && (
            <div className="subagent-detail-state">{t("panels.subagents.loadingDetails")}</div>
          )}
          {depth >= MAX_SUBAGENT_DETAIL_DEPTH && hasSessionFile && (
            <div className="subagent-detail-state">{t("panels.subagents.depthLimit")}</div>
          )}
          {/* Output */}
          {displayOutput && (
            <div className="subagent-output">
              {displayOutput}
              {outputTruncated && (
                <div className="subagent-output-truncated">{t("panels.subagents.outputTruncated")}</div>
              )}
            </div>
          )}
          {!displayOutput && !hasChildren && recentTools.length === 0 && (
            <div className="subagent-detail-state">{t("panels.subagents.waitingOutput")}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A nested child run displayed within a parent's expanded section.
 * Clickable to show its own output via inline toggle.
 */
function formatRouting(routing: SubagentRun["routing"], t: TranslateFn): string | null {
  if (!routing?.source) return null;
  const target = routing.model ?? (routing.source === "piDefault" ? t("panels.subagents.piDefault") : null);
  const thinking = routing.thinking ? `:${routing.thinking}` : "";
  const route = routing.modality && routing.tier ? ` ${routing.modality}/${routing.tier}` : "";
  const confidence = typeof routing.confidence === "number" ? ` ${(routing.confidence * 100).toFixed(0)}%` : "";
  const base = target ? `${routing.source}${route} → ${target}${thinking}${confidence}` : `${routing.source}${route}${confidence}`;
  return routing.fallbackReason ? `${base} (${routing.fallbackReason})` : base;
}

function getRunMetadata(routing: SubagentRun["routing"], t: TranslateFn): { label: string; value: string }[] {
  if (!routing) return [];
  const model = routing.model ?? (routing.source === "piDefault" ? t("panels.subagents.piDefault") : null);
  return [
    ...(model ? [{ label: t("panels.subagents.model"), value: model }] : []),
    ...(routing.thinking ? [{ label: t("panels.subagents.thinking"), value: routing.thinking }] : []),
  ];
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatTokenCount(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const text = k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "");
    return `${text}k tok`;
  }
  return `${Math.floor(tokens)} tok`;
}

export function formatDurationMs(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const totalSec = Math.floor(durationMs / 1000);
  if (totalSec < 60) return `${Math.max(1, totalSec)}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export function formatProgressStats(
  progress: Pick<SubagentProgressSnapshot, "toolCount" | "turnCount" | "tokens" | "durationMs">,
  t?: TranslateFn,
): string | null {
  const parts: string[] = [];
  if (progress.toolCount > 0) {
    parts.push(t ? t("panels.subagents.toolsCount", { count: progress.toolCount }) : `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}`);
  }
  if (typeof progress.turnCount === "number" && progress.turnCount > 0) {
    parts.push(t ? t("panels.subagents.turnsCount", { count: progress.turnCount }) : `${progress.turnCount} turn${progress.turnCount === 1 ? "" : "s"}`);
  }
  const tokens = formatTokenCount(progress.tokens);
  if (tokens) parts.push(tokens);
  const duration = formatDurationMs(progress.durationMs);
  if (duration) parts.push(duration);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatProgressActivity(
  progress: SubagentProgressSnapshot,
  active: boolean,
  t?: TranslateFn,
): { label: string; title: string } | null {
  if (progress.status === "detached") {
    return {
      label: t ? t("panels.subagents.detached") : "Detached",
      title: t ? t("panels.subagents.detachedTitle") : "Subagent detached from parent wait",
    };
  }
  if (progress.status === "failed") {
    const detail = progress.failedTool || progress.error || (t ? t("panels.subagents.failed") : "failed");
    const failedLabel = t ? t("panels.subagents.failed") : "Failed";
    return { label: `${failedLabel} · ${truncateText(detail, CURRENT_TOOL_ARGS_PREVIEW)}`, title: progress.error ?? detail };
  }
  if (progress.currentTool) {
    const args = progress.currentToolArgs ? ` ${truncateText(progress.currentToolArgs, CURRENT_TOOL_ARGS_PREVIEW)}` : "";
    const label = `⚙ ${progress.currentTool}${args}`;
    const title = progress.currentToolArgs
      ? `${progress.currentTool} ${progress.currentToolArgs}`
      : progress.currentTool;
    return { label, title };
  }
  if (active && (progress.status === "pending" || progress.status === "running")) {
    return {
      label: t ? t("panels.subagents.thinkingEllipsis") : "thinking…",
      title: t ? t("panels.subagents.waitingModel") : "Waiting for model / next tool",
    };
  }
  if (progress.status === "completed") {
    return {
      label: t ? t("panels.subagents.completed") : "Completed",
      title: t ? t("panels.subagents.snapshotCompleted") : "Progress snapshot completed",
    };
  }
  return null;
}

export function formatActivityBadge(
  activityState: SubagentActivityState | undefined,
  t?: TranslateFn,
): { label: string; tone: string } | null {
  if (activityState === "needs_attention") {
    return { label: t ? t("panels.subagents.needsAttention") : "Needs attention", tone: "is-danger" };
  }
  if (activityState === "active_long_running") {
    return { label: t ? t("panels.subagents.longRunning") : "Long-running", tone: "is-warning" };
  }
  return null;
}

function resolveStatusTone(input: {
  isRunning: boolean;
  isFailed: boolean;
  isDetached: boolean;
  activityState?: SubagentActivityState;
}): string {
  if (input.activityState === "needs_attention" || input.isFailed) return "is-danger";
  if (input.isDetached) return "is-accent";
  if (input.activityState === "active_long_running" || input.isRunning) return "is-warning";
  return "is-success";
}

function formatRecentToolTitle(tool: SubagentRecentTool): string {
  const args = tool.args ? ` ${tool.args}` : "";
  return `${tool.tool}${args}`;
}

function RunMetadataChips({ items, title }: { items: { label: string; value: string }[]; title?: string | null }) {
  const { t } = useI18n();
  const modelLabel = t("panels.subagents.model");
  return (
    <span title={title ?? undefined} className="subagent-metadata-chips">
      {items.map((item) => (
        <span key={item.label} className={`subagent-metadata-chip${item.label === modelLabel || item.label === "Model" ? " is-model" : ""}`}>
          <span>{item.label}: </span>{item.value}
        </span>
      ))}
    </span>
  );
}
