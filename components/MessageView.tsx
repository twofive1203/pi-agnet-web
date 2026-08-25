"use client";

import { memo, useState, useRef, useEffect, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";
import { useI18n } from "@/components/I18nProvider";
import { classifyChatProviderError } from "@/lib/chat-provider-errors";
import { localizeError } from "@/lib/i18n";
import { isTranscriptCompactionMessage } from "@/lib/session-transcript-client";

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve();
  } catch {
    return Promise.reject();
  }
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if (isTranscriptCompactionMessage(message)) {
      return <CompactionMarkerView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} />;
  }
  return null;
});

function UserMessageView({ message, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {
  message: UserMessage;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => {
    copyText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="message-view message-view-user">
      <div className="message-bubble-row message-bubble-row-user">
        <div className="message-user-bubble">
          {imageBlocks.length > 0 && (
            <div className={content ? "message-media-grid has-content" : "message-media-grid"}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={src}
                    alt=""
                    className="message-media-preview"
                  />
                );
              })}
            </div>
          )}
          {content && <MarkdownBody className="markdown-user-message">{content}</MarkdownBody>}
        </div>

      </div>

      <div className="message-action-row message-action-row-user">
          <div className="message-hover-actions">
            <button
              className={copied ? "message-action-button is-active" : "message-action-button"}
              onClick={copyContent}
              title={t("chat.copyMessage")}
            >
              {copied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
              {copied ? t("chat.copied") : t("chat.copy")}
            </button>
          </div>
          {(canFork || canNavigate) && (
            <div className={forking ? "message-hover-actions is-visible" : "message-hover-actions"}>
              {canNavigate && (
                <button
                  onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(content); }}
                  className="message-action-button"
                  title={t("chat.editFromHere")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                  {t("chat.edit")}
                </button>
              )}
              {canFork && (
                <button
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                  className={forking ? "message-action-button is-active" : "message-action-button"}
                  title={forking ? t("chat.forking") : t("chat.forkSession")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  {forking ? t("chat.creatingSession") : t("chat.newSession")}
                </button>
              )}
            </div>
          )}
          {time && <span className="message-timestamp">{time}</span>}
        </div>
    </div>
  );
}

function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  showTimestamp,
  prevTimestamp,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  showTimestamp?: boolean;
  prevTimestamp?: number;
}) {
  const { t } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp) : null;
  const blocks = message.content ?? [];
  const [copied, setCopied] = useState(false);
  const streamStartRef = useRef<number | null>(null);
  const [tps, setTps] = useState<number | null>(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);

  const textContent = blocks
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = Date.now();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      streamStartRef.current = null;
      setTps(null);
      return;
    }
    const tick = () => {
      const bs = blocksRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      bs.forEach((_, i) => {
        if (!blockStartTimesRef.current.has(i)) blockStartTimesRef.current.set(i, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < bs.length - 1; i++) {
          if (!next.has(i) && blockStartTimesRef.current.has(i)) {
            const start = blockStartTimesRef.current.get(i)!;
            const nextStart = blockStartTimesRef.current.get(i + 1) ?? now;
            next.set(i, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      let chars = 0;
      for (const b of bs) {
        if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
        else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
        else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
      }
      if (chars === 0) return;
      if (streamStartRef.current === null) streamStartRef.current = now;
      const elapsed = (now - streamStartRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => clearInterval(id);
  }, [isStreaming]);

  return (
    <div className={isStreaming ? "message-view message-view-assistant is-streaming" : "message-view message-view-assistant"}>
      <div className="assistant-model-row">
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
            else if (b.type === "toolCall") chars += JSON.stringify((b as ToolCallContent).input ?? {}).length;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span className="assistant-stream-stats" title={t("chat.estimatedTokens")}>
                  <span className="assistant-token-estimate">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {tps !== null && (() => {
                    const tier = tps >= 50 ? "fast" : tps >= 30 ? "steady" : tps >= 15 ? "moderate" : "slow";
                    return (
                      <span
                        className={`assistant-tps-badge is-estimate is-${tier}`}
                        title={t("chat.estimatedTps")}
                        aria-label={t("chat.estimatedTpsValue", { value: tps.toFixed(1) })}
                      >
                        ~{tps.toFixed(1)} t/s
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div className="assistant-block-stack">
        {blocks.map((block, i) => (
          <BlockView key={i} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(i) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} />
        ))}
        {!isStreaming && message.stopReason === "error" && message.errorMessage && (() => {
          const classified = classifyChatProviderError(message.errorMessage);
          return (
            <div className="message-assistant-error" role="alert">
              <div className="message-assistant-error-title">{t("chat.assistantError")}</div>
              <div className="message-assistant-error-body">
                {localizeError(t, {
                  code: classified.code,
                  message: classified.englishSummary,
                  fallback: classified.technicalDetails,
                })}
              </div>
              {classified.category !== "unknown" && classified.technicalDetails !== classified.englishSummary && (
                <div className="message-assistant-error-body" style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
                  {classified.technicalDetails}
                </div>
              )}
            </div>
          );
        })()}
      </div>

      <div className="message-action-row message-action-row-assistant">
        {message.usage && !isStreaming && (
          <div className="message-usage">
            {formatUsage(message.usage)}
          </div>
        )}
        {textContent && !isStreaming && (
          <button
            className={copied ? "message-hover-copy message-action-button is-active" : "message-hover-copy message-action-button"}
            onClick={copyContent}
            title={t("chat.copyMessage")}
          >
            {copied ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
            {copied ? t("chat.copied") : t("chat.copy")}
          </button>
        )}
        {time && !isStreaming && (
          <span className="message-timestamp message-timestamp-trailing">{time}</span>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number> }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} />;
  }
  return null;
}

function TextBlock({ block, isStreaming }: { block: TextContent; isStreaming?: boolean }) {
  return <MarkdownBody isStreaming={isStreaming}>{block.text}</MarkdownBody>;
}

function ThinkingBlock({ block, duration }: { block: ThinkingContent; duration?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="message-thinking">
      <button
        className="message-disclosure"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <svg className="message-thinking-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
        </svg>
        <span>{t("chat.thinking")}</span>
        {duration !== undefined && <span className="message-duration">{duration}s</span>}
        <svg className={expanded ? "message-disclosure-chevron is-expanded" : "message-disclosure-chevron"} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {expanded && <div className="message-thinking-body">{block.thinking}</div>}
    </div>
  );
}


// Tool icons communicate category at a glance; color stays tertiary so the
// status dot remains the loudest signal in the header.
type ToolCategory = "read" | "search" | "edit" | "write" | "terminal" | "web" | "agent" | "tool";

function getToolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (n === "read" || n === "ls") return "read";
  if (n === "grep" || n === "find" || n.includes("search") || n.includes("grep")) return "search";
  if (n === "edit") return "edit";
  if (n === "write") return "write";
  if (n === "bash" || n.includes("terminal") || n.includes("shell") || n.includes("command")) return "terminal";
  if (n.includes("web") || n.includes("fetch") || n.includes("browse")) return "web";
  if (n.includes("subagent") || n.includes("task") || n.includes("agent")) return "agent";
  return "tool";
}

const TOOL_ICON_PATHS: Record<ToolCategory, React.ReactNode> = {
  read: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </>
  ),
  edit: (
    <>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </>
  ),
  write: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </>
  ),
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </>
  ),
  agent: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
      <circle cx="17.5" cy="8.5" r="2.5" />
      <path d="M17 14.5a4 4 0 0 1 5 3.8V21" />
    </>
  ),
  tool: (
    <>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7Z" />
    </>
  ),
};

function ToolIcon({ name }: { name: string }) {
  const category = getToolCategory(name);
  return (
    <svg className="message-tool-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TOOL_ICON_PATHS[category]}
    </svg>
  );
}

function ToolCallBlock({ block, result, duration }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number }) {
  const [expanded, setExpanded] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;

  const tone = isError ? "is-error" : result ? "is-success" : "is-pending";

  return (
    <div className={`message-tool-call ${tone}`}>
      <button
        className="message-tool-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {!result && <span className="message-tool-status-dot" aria-hidden="true" />}
        <ToolIcon name={block.toolName} />
        <span className="message-tool-name">{block.toolName}</span>
        <span className="message-tool-preview">{getToolPreview(block)}</span>
        {duration !== undefined && <span className="message-duration">{duration}s</span>}
        <svg className={expanded ? "message-disclosure-chevron is-expanded" : "message-disclosure-chevron"} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      {expanded && <pre className="message-tool-input">{inputStr}</pre>}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        <PairedResult
          text={resultText ?? ""}
          isEmpty={resultIsEmpty}
          isError={isError}
        />
      )}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={isError ? "message-tool-result is-error" : "message-tool-result"}>
      <pre className={isEmpty ? "message-tool-result-content is-empty" : "message-tool-result-content"}>
        {isEmpty ? t("chat.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMarkerView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const time = formatTime(message.timestamp);
  const summary = getMessageText(message.content);

  return (
    <div className="message-view message-view-custom message-compaction-marker">
      <div className={expanded ? "message-custom-card" : "message-custom-card is-collapsed"}>
        <div className="message-custom-header">
          <span className="message-custom-title">{t("chat.compactionMarkerTitle")}</span>
          {time && <span className="message-timestamp message-timestamp-trailing">{time}</span>}
        </div>
        {expanded ? (
          <div className="message-custom-body">
            {summary
              ? <MarkdownBody className="markdown-custom-message">{summary}</MarkdownBody>
              : <span className="message-empty-content">{t("chat.noMessage")}</span>}
          </div>
        ) : null}
        <div className="message-custom-footer">
          <button
            type="button"
            className="message-action-button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t("chat.compactionMarkerCollapse") : t("chat.compactionMarkerExpand")}
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="message-view message-view-custom">
      <div className={isHiddenDisplay && !contentExpanded ? "message-custom-card is-collapsed" : "message-custom-card"}>
        <div className="message-custom-header">
          <span className="message-custom-title">{title}</span>
          {isHiddenDisplay && <span className="message-custom-meta">{t("chat.hiddenExtensionMessage")}</span>}
          {time && <span className="message-timestamp message-timestamp-trailing">{time}</span>}
        </div>

        {contentExpanded ? (
          <div className="message-custom-body">
            {images.length > 0 && (
              <div className={text ? "message-media-grid has-content" : "message-media-grid"}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={src}
                      alt=""
                      className="message-media-preview"
                    />
                  );
                })}
              </div>
            )}
            {text ? <MarkdownBody className="markdown-custom-message">{text}</MarkdownBody> : <span className="message-empty-content">{t("chat.noMessage")}</span>}
          </div>
        ) : (
          <button className="message-custom-preview" onClick={() => setContentExpanded(true)}>
            {text ? previewText(text, t("chat.showExtensionMessage")) : t("chat.showExtensionMessage")}
          </button>
        )}

        <div className="message-custom-footer">
          {text || detailsText ? (
            <button className={copied ? "message-action-button is-active" : "message-action-button"} onClick={copyContent}>
              {copied ? t("chat.copied") : t("chat.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              className="message-action-button message-action-button-trailing"
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
            >
              {isHiddenDisplay
                ? (contentExpanded ? t("chat.collapse") : t("chat.expand"))
                : (detailsExpanded ? t("chat.hideDetails") : t("chat.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre className="message-custom-details">
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function formatUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}): string {
  const parts = [];
  if (usage.input) parts.push(`${usage.input.toLocaleString()} in`);
  if (usage.output) parts.push(`${usage.output.toLocaleString()} out`);
  if (usage.cacheRead) parts.push(`${usage.cacheRead.toLocaleString()} cache`);
  if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}
