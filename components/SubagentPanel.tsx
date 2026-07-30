"use client";

import { useState, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  SubagentActivityState,
  SubagentProgressSnapshot,
  SubagentRecentTool,
  SubagentRun,
} from "@/hooks/useAgentSession";

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
  const detailCache = useSubagentDetailCache();
  const running = runs.filter((run) => run.status === "running");
  const completed = runs.filter((run) => run.status !== "running");
  const renderRuns = (items: readonly SubagentRun[]) => items.map((run) => (
    <ObservedRunItem key={run.id} run={run} depth={0} detailCache={detailCache} />
  ));

  if (runs.length === 0) {
    return (
      <div style={{ padding: "16px 20px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
        No subagent activity yet.
      </div>
    );
  }

  return (
    <div className="subagent-panel-root" style={{
      maxHeight: "min(500px, 60vh)", overflowY: "auto", padding: "8px 0", fontSize: 12, color: "var(--text)",
    }}>
      {running.length > 0 && (
        <>
          <div style={{ padding: "6px 16px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>
            Running ({running.length})
          </div>
          {renderRuns(running)}
        </>
      )}
      {completed.length > 0 && (
        <>
          <div style={{ padding: "6px 16px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", marginTop: running.length > 0 ? 8 : 0 }}>
            Completed ({completed.length})
          </div>
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
  const indent = depth * 16;
  const progress = run.progress;
  const isDetached = progress?.status === "detached";
  const isRunning = run.status === "running";
  const isFailed = run.status === "failed" || progress?.status === "failed";
  const activityState = progress?.activityState;
  const statusColor = resolveStatusColor({ isRunning, isFailed, isDetached, activityState });
  const statusIcon = isDetached ? "◌" : isRunning ? "○" : isFailed ? "✕" : "✓";
  const statusLabel = isDetached ? "Detached" : isRunning ? "Running" : isFailed ? "Failed" : "Done";

  const taskDisplay = run.task
    ? run.task.split("\n")[0].slice(0, 120)
    : "(no task)";

  const detail = detailState?.detail;
  const terminalPreview = run.status !== "running" ? run.result : undefined;
  const displayOutput = detailState?.status === "ready"
    ? detail?.output ?? terminalPreview ?? run.partialOutput
    : terminalPreview ?? detail?.output ?? run.partialOutput;
  const outputTruncated = detail?.outputTruncated ?? run.outputTruncated ?? false;
  const routingLabel = formatRouting(run.routing);
  const metadata = getRunMetadata(run.routing);
  const metadataTitle = routingLabel ?? metadata.map((item) => `${item.label}: ${item.value}`).join(" · ");
  const hasSessionFile = !!run.sessionFile;
  const canLoadDetail = hasSessionFile && depth < MAX_SUBAGENT_DETAIL_DEPTH;
  const childrenRuns = detail?.children ?? [];
  const hasChildren = childrenRuns.length > 0;
  const recentTools = progress?.recentTools?.slice(-MAX_RECENT_TOOLS_DISPLAY) ?? [];
  const progressSummary = progress ? formatProgressActivity(progress, isRunning && !isDetached) : null;
  const progressStats = progress ? formatProgressStats(progress) : null;
  const activityBadge = formatActivityBadge(activityState);

  return (
    <div>
      <div
        className="subagent-run-row"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 16px 5px",
          paddingLeft: 16 + indent,
          cursor: "pointer",
          userSelect: "none",
          transition: "background 0.08s",
          minWidth: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <span style={{ color: statusColor, width: 14, textAlign: "center", flexShrink: 0 }}>
          {statusIcon}
        </span>
        <span style={{ fontWeight: 600, color: "var(--text)", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {run.agent}
        </span>
        <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
          {taskDisplay}
        </span>
        {metadata.length > 0 && (
          <RunMetadataChips items={metadata} title={metadataTitle} />
        )}
        {canLoadDetail && !hasChildren && isExpanded && (
          <span style={{ color: "var(--text-dim)", fontSize: 9, flexShrink: 0, fontStyle: "italic" }}>
            {detailState?.status === "loading" ? "loading..." : detailState?.status === "error" ? "detail unavailable" : "no children"}
          </span>
        )}
        <span style={{ color: statusColor, fontSize: 10, flexShrink: 0 }}>
          {statusLabel}
        </span>
        <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0, marginLeft: 4 }}>
          {isExpanded ? "▲" : "▼"}
        </span>
      </div>

      {progress && (progressSummary || progressStats || activityBadge) && (
        <div
          className="subagent-progress-row"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "4px 10px",
            padding: "0 16px 6px",
            paddingLeft: 16 + indent + 22,
            minWidth: 0,
            fontSize: 10,
            lineHeight: 1.4,
            color: "var(--text-muted)",
          }}
        >
          {progressSummary && (
            <span
              title={progressSummary.title}
              style={{
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: activityBadge?.color ?? (isDetached ? statusColor : "var(--text-muted)"),
              }}
            >
              {progressSummary.label}
            </span>
          )}
          {progressStats && (
            <span style={{ color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {progressStats}
            </span>
          )}
          {activityBadge && (
            <span
              style={{
                color: activityBadge.color,
                background: "var(--bg-subtle)",
                border: `1px solid ${activityBadge.color}`,
                borderRadius: 999,
                padding: "0 6px",
                flexShrink: 0,
                fontWeight: 600,
              }}
            >
              {activityBadge.label}
            </span>
          )}
          {progress.error && (
            <span
              title={progress.error}
              style={{
                color: "#ef4444",
                minWidth: 0,
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {progress.failedTool ? `${progress.failedTool}: ` : ""}{truncateText(progress.error, 80)}
            </span>
          )}
        </div>
      )}

      {isExpanded && (
        <div style={{
          padding: "2px 16px 8px",
          paddingLeft: 16 + indent + 22,
          minWidth: 0,
        }}>
          {recentTools.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Recent tools ({recentTools.length})
              </div>
              <div style={{
                background: "var(--bg-subtle)",
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-muted)",
                lineHeight: 1.45,
                maxHeight: 160,
                overflowY: "auto",
                minWidth: 0,
              }}>
                {recentTools.map((tool, index) => (
                  <div
                    key={`${tool.tool}-${tool.endMs}-${index}`}
                    title={formatRecentToolTitle(tool)}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: "var(--text)" }}>{tool.tool}</span>
                    {tool.args ? (
                      <span style={{ color: "var(--text-dim)" }}> {truncateText(tool.args, RECENT_TOOL_ARGS_PREVIEW)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Load exactly one nested level per expansion. */}
          {hasChildren && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Subagents ({childrenRuns.length}{detail?.childrenTruncated ? "+" : ""})
              </div>
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
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--text-dim)", marginBottom: 4 }}>
              Loading details...
            </div>
          )}
          {depth >= MAX_SUBAGENT_DETAIL_DEPTH && hasSessionFile && (
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>
              Nested detail depth limit reached.
            </div>
          )}
          {/* Output */}
          {displayOutput && (
            <div style={{
              background: "var(--bg-subtle)",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-muted)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 300,
              overflowY: "auto",
            }}>
              {displayOutput}
              {outputTruncated && (
                <div style={{ marginTop: 6, fontStyle: "italic", color: "var(--text-dim)" }}>
                  Output truncated to the most recent bounded preview.
                </div>
              )}
            </div>
          )}
          {!displayOutput && !hasChildren && recentTools.length === 0 && (
            <div style={{ fontStyle: "italic", color: "var(--text-dim)", fontSize: 11 }}>
              Waiting for output...
            </div>
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
function formatRouting(routing: SubagentRun["routing"]): string | null {
  if (!routing?.source) return null;
  const target = routing.model ?? (routing.source === "piDefault" ? "Pi default" : null);
  const thinking = routing.thinking ? `:${routing.thinking}` : "";
  const route = routing.modality && routing.tier ? ` ${routing.modality}/${routing.tier}` : "";
  const confidence = typeof routing.confidence === "number" ? ` ${(routing.confidence * 100).toFixed(0)}%` : "";
  const base = target ? `${routing.source}${route} → ${target}${thinking}${confidence}` : `${routing.source}${route}${confidence}`;
  return routing.fallbackReason ? `${base} (${routing.fallbackReason})` : base;
}

function getRunMetadata(routing: SubagentRun["routing"]): { label: string; value: string }[] {
  if (!routing) return [];
  const model = routing.model ?? (routing.source === "piDefault" ? "Pi default" : null);
  return [
    ...(model ? [{ label: "Model", value: model }] : []),
    ...(routing.thinking ? [{ label: "Thinking", value: routing.thinking }] : []),
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

export function formatProgressStats(progress: Pick<SubagentProgressSnapshot, "toolCount" | "turnCount" | "tokens" | "durationMs">): string | null {
  const parts: string[] = [];
  if (progress.toolCount > 0) parts.push(`${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}`);
  if (typeof progress.turnCount === "number" && progress.turnCount > 0) {
    parts.push(`${progress.turnCount} turn${progress.turnCount === 1 ? "" : "s"}`);
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
): { label: string; title: string } | null {
  if (progress.status === "detached") {
    return { label: "Detached", title: "Subagent detached from parent wait" };
  }
  if (progress.status === "failed") {
    const detail = progress.failedTool || progress.error || "failed";
    return { label: `Failed · ${truncateText(detail, CURRENT_TOOL_ARGS_PREVIEW)}`, title: progress.error ?? detail };
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
    return { label: "thinking…", title: "Waiting for model / next tool" };
  }
  if (progress.status === "completed") {
    return { label: "Completed", title: "Progress snapshot completed" };
  }
  return null;
}

export function formatActivityBadge(
  activityState: SubagentActivityState | undefined,
): { label: string; color: string } | null {
  if (activityState === "needs_attention") {
    return { label: "Needs attention", color: "#ef4444" };
  }
  if (activityState === "active_long_running") {
    return { label: "Long-running", color: "#f59e0b" };
  }
  return null;
}

function resolveStatusColor(input: {
  isRunning: boolean;
  isFailed: boolean;
  isDetached: boolean;
  activityState?: SubagentActivityState;
}): string {
  if (input.activityState === "needs_attention" || input.isFailed) return "#ef4444";
  if (input.isDetached) return "#8b5cf6";
  if (input.activityState === "active_long_running" || input.isRunning) return "#f59e0b";
  return "#22c55e";
}

function formatRecentToolTitle(tool: SubagentRecentTool): string {
  const args = tool.args ? ` ${tool.args}` : "";
  return `${tool.tool}${args}`;
}

function RunMetadataChips({ items, title }: { items: { label: string; value: string }[]; title?: string | null }) {
  return (
    <span
      title={title ?? undefined}
      style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0, maxWidth: 260 }}
    >
      {items.map((item) => (
        <span
          key={item.label}
          style={{
            color: "var(--text-muted)",
            background: "var(--bg-subtle)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "1px 6px",
            fontSize: 10,
            lineHeight: 1.4,
            maxWidth: item.label === "Model" ? 170 : 80,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: "var(--text-dim)" }}>{item.label}: </span>{item.value}
        </span>
      ))}
    </span>
  );
}
