"use client";

import { useState, useCallback } from "react";
import type {
  SubagentActivityState,
  SubagentProgressSnapshot,
  SubagentRecentTool,
  SubagentRun,
} from "@/hooks/useAgentSession";

interface Props {
  runs: SubagentRun[];
}

const CURRENT_TOOL_ARGS_PREVIEW = 60;
const RECENT_TOOL_ARGS_PREVIEW = 80;
const MAX_RECENT_TOOLS_DISPLAY = 12;

export function SubagentPanel({ runs }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [childrenCache, setChildrenCache] = useState<Record<string, SubagentRun[]>>({});

  const toggleExpand = useCallback(async (run: SubagentRun) => {
    const id = run.id;
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);

    // Lazy-load children if we have a sessionFile and haven't loaded yet
    if (run.sessionFile && !childrenCache[id]) {
      try {
        const res = await fetch(`/api/agent/subagent-children?sessionFile=${encodeURIComponent(run.sessionFile)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.children && data.children.length > 0) {
            setChildrenCache((prev) => ({ ...prev, [id]: data.children }));
          }
        }
      } catch {
        // Silently fail — children just won't show
      }
    }
  }, [expandedId, childrenCache]);

  const running = runs.filter((r) => r.status === "running");
  const completed = runs.filter((r) => r.status === "completed" || r.status === "failed");

  if (runs.length === 0) {
    return (
      <div style={{ padding: "16px 20px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
        No subagent activity yet.
      </div>
    );
  }

  const renderRuns = (items: SubagentRun[], depth: number) => items.map((r) => (
    <RunItem
      key={r.id}
      run={r}
      isExpanded={expandedId === r.id}
      childrenRuns={childrenCache[r.id]}
      onToggle={() => toggleExpand(r)}
      depth={depth}
    />
  ));

  return (
    <div className="subagent-panel-root" style={{
      maxHeight: "min(500px, 60vh)",
      overflowY: "auto",
      padding: "8px 0",
      fontSize: 12,
      color: "var(--text)",
    }}>
      {running.length > 0 && (
        <>
          <div style={{ padding: "6px 16px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>
            Running ({running.length})
          </div>
          {renderRuns(running, 0)}
        </>
      )}
      {completed.length > 0 && (
        <>
          <div style={{ padding: "6px 16px 4px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", marginTop: running.length > 0 ? 8 : 0 }}>
            Completed ({completed.length})
          </div>
          {renderRuns(completed, 0)}
        </>
      )}
    </div>
  );
}

function RunItem({
  run, isExpanded, childrenRuns, onToggle, depth,
}: {
  run: SubagentRun;
  isExpanded: boolean;
  childrenRuns?: SubagentRun[];
  onToggle: () => void;
  depth: number;
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

  const displayOutput = run.result ?? run.partialOutput;
  const routingLabel = formatRouting(run.routing);
  const metadata = getRunMetadata(run.routing);
  const metadataTitle = routingLabel ?? metadata.map((item) => `${item.label}: ${item.value}`).join(" · ");
  const hasSessionFile = !!run.sessionFile;
  const hasChildren = childrenRuns && childrenRuns.length > 0;
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
        {hasSessionFile && !hasChildren && isExpanded && (
          <span style={{ color: "var(--text-dim)", fontSize: 9, flexShrink: 0, fontStyle: "italic" }}>
            {childrenRuns === undefined ? "loading..." : "no children"}
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

          {/* Show children (nested subagents) first after recent tools, then output */}
          {hasChildren && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Subagents ({childrenRuns!.length})
              </div>
              {childrenRuns!.map((child) => (
                <ChildRunItem key={child.id} run={child} depth={depth + 1} />
              ))}
            </div>
          )}
          {childrenRuns === undefined && hasSessionFile && (
            <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--text-dim)", marginBottom: 4 }}>
              Loading nested subagents...
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

function ChildRunItem({ run, depth }: { run: SubagentRun; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const indent = depth * 16;
  const isRunning = run.status === "running";
  const isFailed = run.status === "failed";
  const statusColor = isRunning ? "#f59e0b" : isFailed ? "#ef4444" : "#22c55e";
  const statusIcon = isRunning ? "○" : isFailed ? "✕" : "✓";
  const displayOutput = run.result ?? run.partialOutput;
  const routingLabel = formatRouting(run.routing);
  const metadata = getRunMetadata(run.routing);
  const metadataTitle = routingLabel ?? metadata.map((item) => `${item.label}: ${item.value}`).join(" · ");

  return (
    <div>
      <div
        className="subagent-run-row subagent-child-run-row"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 8px 3px",
          paddingLeft: 8 + indent,
          cursor: "pointer",
          userSelect: "none",
          borderRadius: 4,
          transition: "background 0.08s",
          minWidth: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
      >
        <span style={{ color: statusColor, width: 12, textAlign: "center", flexShrink: 0, fontSize: 10 }}>
          {statusIcon}
        </span>
        <span style={{ fontWeight: 500, color: "var(--text)", flexShrink: 0, maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
          {run.agent}
        </span>
        <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, minWidth: 0 }}>
          {run.task ? run.task.split("\n")[0].slice(0, 80) : ""}
        </span>
        {metadata.length > 0 && (
          <RunMetadataChips items={metadata} title={metadataTitle} />
        )}
        <span style={{ fontSize: 9, color: "var(--text-dim)", flexShrink: 0 }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && displayOutput && (
        <div style={{
          padding: "2px 8px 6px",
          paddingLeft: 8 + indent + 16,
        }}>
          <div style={{
            background: "var(--bg-subtle)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            lineHeight: 1.4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflowY: "auto",
          }}>
            {displayOutput}
          </div>
        </div>
      )}
    </div>
  );
}
