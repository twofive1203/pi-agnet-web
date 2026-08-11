"use client";

import Image from "next/image";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SessionInfo, SessionTreeNode } from "@/lib/types";
import { MessageView } from "./MessageView";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ExtensionDialogHost } from "./ExtensionDialogHost";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { ExtensionToastHost } from "./ExtensionToastHost";
import { ExtensionWidgetStack } from "./ExtensionWidgetStack";
import { ExtensionTodoPanel, isTodoWidget } from "./ExtensionTodoPanel";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useAudio } from "@/hooks/useAudio";
import { useCompletionNotification } from "@/hooks/useCompletionNotification";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useSessionTabLock } from "@/hooks/useSessionTabLock";
import { SessionChangesFloatingPanel } from "./SessionChangesFloatingPanel";
import { useI18n } from "@/components/I18nProvider";
import Tooltip from "@/components/Tooltip";
import {
  chatFailureActionKey,
  chatFailureOffersModelsFix,
  chatFailureTitleKey,
} from "@/lib/chat-provider-errors";
import { localizeError } from "@/lib/i18n";
import type { PackageUpdateCheckResult } from "@/lib/package-update-check";

/**
 * Stable React keys for chat rows.
 * Prefer persisted JSONL entry ids; optimistic/steer/follow-up rows without an
 * entry id keep a WeakMap-backed local id for the message object lifetime.
 */
function useStableMessageKeys(messages: AgentMessage[], entryIds: string[]) {
  const localKeyMapRef = useRef(new WeakMap<object, string>());
  const localKeyCounterRef = useRef(0);

  return useMemo(() => {
    return messages.map((message, idx) => {
      const entryId = entryIds[idx];
      if (entryId) return entryId;
      const existing = localKeyMapRef.current.get(message as object);
      if (existing) return existing;
      const next = `local-${++localKeyCounterRef.current}`;
      localKeyMapRef.current.set(message as object, next);
      return next;
    });
  }, [messages, entryIds]);
}

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSubagentChange?: (runs: import("@/hooks/useAgentSession").SubagentRun[]) => void;
  onSessionStatsChange?: (stats: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost?: number } | null) => void;
  onSessionPerformanceChange?: (performance: import("@/lib/types").SessionPerformanceSummary | null) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  /** Agent running state — used by AppShell's observe bar / Changes tab polling. */
  onAgentRunningChange?: (running: boolean) => void;
  /** Whether an extension Todo List widget is currently active in the chat. */
  onTodoActiveChange?: (active: boolean) => void;
  /** Open Models configuration (send-block / failure fix path). */
  onOpenModels?: () => void;
}

function isPowerbarExtensionItem(item: { key: string }): boolean {
  const key = item.key.toLowerCase();
  return key === "powerbar" || key.startsWith("powerbar:");
}

/** pi-subagents TUI HUDs superseded by the top-bar SubagentPanel. */
function isSuppressedSubagentWidget(item: { key: string }): boolean {
  const key = item.key.toLowerCase();
  return key === "subagent-fleet-status" || key === "subagent-async";
}

const TYPEWRITER_KEYS = [
  "chat.typewriter01",
  "chat.typewriter02",
  "chat.typewriter03",
  "chat.typewriter04",
  "chat.typewriter05",
  "chat.typewriter06",
  "chat.typewriter07",
  "chat.typewriter08",
  "chat.typewriter09",
  "chat.typewriter10",
  "chat.typewriter11",
  "chat.typewriter12",
  "chat.typewriter13",
  "chat.typewriter14",
  "chat.typewriter15",
  "chat.typewriter16",
  "chat.typewriter17",
  "chat.typewriter18",
] as const;

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (phase?.kind === "resolving_vision") {
    return phase.model ? t("chat.phaseResolvingVisionModel", { model: phase.model }) : t("chat.phaseResolvingVision");
  }
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((tool) => tool.name);
    if (names.length === 0) return t("chat.phaseRunningTool");
    if (names.length === 1) return t("chat.phaseRunningNamed", { name: names[0] });
    if (names.length <= 3) return t("chat.phaseRunningList", { names: names.join(", ") });
    return t("chat.phaseRunningMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.phaseWaitingModel");
  return t("chat.phaseThinking");
}

function Typewriter({ phrases }: { phrases: string[] }) {
  const [phraseIdx, setPhraseIdx] = useState(() => Math.floor(Math.random() * phrases.length));
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [caretOn, setCaretOn] = useState(true);

  useEffect(() => {
    const blink = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(blink);
  }, []);

  useEffect(() => {
    const current = phrases[phraseIdx];
    let timeout: ReturnType<typeof setTimeout>;
    if (!deleting && text === current) {
      timeout = setTimeout(() => setDeleting(true), 1800);
    } else if (deleting && text === "") {
      setDeleting(false);
      setPhraseIdx((i) => (i + 1) % phrases.length);
    } else {
      const next = deleting ? current.slice(0, text.length - 1) : current.slice(0, text.length + 1);
      timeout = setTimeout(() => setText(next), deleting ? 28 : 55);
    }
    return () => clearTimeout(timeout);
  }, [text, deleting, phraseIdx, phrases]);

  return (
    <span className="chat-empty-typewriter">
      {text}
      <span className={caretOn ? "chat-empty-caret is-visible" : "chat-empty-caret"}>▍</span>
    </span>
  );
}

export const ChatWindow = memo(function ChatWindow({ session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSubagentChange, onSessionStatsChange, onSessionPerformanceChange, onContextUsageChange, onAgentRunningChange, onTodoActiveChange, onOpenModels }: Props) {
  const { t } = useI18n();
  const typewriterPhrases = useMemo(
    () => TYPEWRITER_KEYS.map((key) => t(key)),
    [t],
  );
  const { autoScrollEnabled, onAutoScrollToggle } = useAutoScroll();
  const sessionTabLock = useSessionTabLock(session?.id ?? null);
  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelsReady, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, agentFailure, contextUsage, forkingEntryId,
    isCompacting, compactError, displayModel: displayModelValue, sessionStats,
    sessionPerformance,
    agentPhase, sessionChangesRefreshKey,
    extensionStatuses, extensionWidgets, extensionDialog, extensionToasts,
    isNew,
    messagesEndRef, scrollContainerRef,
    lastUserMsgRef,
    handleSend, handleContinueAfterFailure, dismissAgentFailure,
    handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handleAbortCompaction,
    handleToolPresetChange, handleThinkingLevelChange,
    respondExtensionDialog, dismissExtensionToast,
    handleAgentEventRef,
  } = useAgentSession({
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSubagentChange,
    autoScrollEnabled,
  });

  const { soundEnabled, onSoundToggle, playDoneSound } = useAudio();
  const { notificationState, onNotificationToggle, notifyCompletion } = useCompletionNotification();
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const notifyCompletionRef = useRef(notifyCompletion);
  notifyCompletionRef.current = notifyCompletion;
  const promptFailedRef = useRef(false);
  const sessionLabel = (session?.name || session?.id?.slice(0, 8) || t("chat.newSession")).slice(0, 80);
  const completionCopyRef = useRef({
    completeTitle: t("chat.notificationCompleteTitle"),
    completeBody: t("chat.notificationCompleteBody", { session: sessionLabel }),
    failedTitle: t("chat.notificationFailedTitle"),
    failedBody: t("chat.notificationFailedBody", { session: sessionLabel }),
    tag: `pi-session-${session?.id ?? newSessionCwd ?? "new"}`,
  });
  completionCopyRef.current = {
    completeTitle: t("chat.notificationCompleteTitle"),
    completeBody: t("chat.notificationCompleteBody", { session: sessionLabel }),
    failedTitle: t("chat.notificationFailedTitle"),
    failedBody: t("chat.notificationFailedBody", { session: sessionLabel }),
    tag: `pi-session-${session?.id ?? newSessionCwd ?? "new"}`,
  };

  // Completion cues are emitted only after the prompt lifecycle settles; browser
  // notifications additionally require an explicit user opt-in and a hidden tab.
  const origHandler = handleAgentEventRef.current;
  useEffect(() => {
    handleAgentEventRef.current = (event) => {
      if (event.type === "agent_start") promptFailedRef.current = false;
      if (event.type === "prompt_error") {
        promptFailedRef.current = true;
        const copy = completionCopyRef.current;
        notifyCompletionRef.current({ title: copy.failedTitle, body: copy.failedBody, tag: copy.tag });
      }
      if (event.type === "agent_settled") {
        if (soundEnabledRef.current) playDoneSoundRef.current();
        if (!promptFailedRef.current) {
          const copy = completionCopyRef.current;
          notifyCompletionRef.current({ title: copy.completeTitle, body: copy.completeBody, tag: copy.tag });
        }
        promptFailedRef.current = false;
      }
      origHandler?.(event);
    };
  }, [origHandler, handleAgentEventRef]);

  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? `${sessionStats.tokens.input}|${sessionStats.tokens.output}|${sessionStats.tokens.cacheRead}|${sessionStats.tokens.cacheWrite}|${sessionStats.cost ?? 0}`
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push durable session performance up to AppShell (scalar key avoids identity loops).
  const performanceKey = sessionPerformance
    ? `${sessionPerformance.sampleCount}|${sessionPerformance.totalOutputTokens}|${sessionPerformance.totalStreamDurationMs}|${sessionPerformance.totalTtftMs}|${sessionPerformance.byModel.map((row) => `${row.provider}:${row.model}:${row.sampleCount}`).join(",")}`
    : null;
  const sessionPerformanceRef = useRef(sessionPerformance);
  sessionPerformanceRef.current = sessionPerformance;
  useEffect(() => {
    onSessionPerformanceChange?.(sessionPerformanceRef.current);
  }, [performanceKey, onSessionPerformanceChange]);
  useEffect(() => () => { onSessionPerformanceChange?.(null); }, [onSessionPerformanceChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Push agent running state up to AppShell (observe bar / Changes tab polling).
  useEffect(() => {
    onAgentRunningChange?.(agentRunning);
  }, [agentRunning, onAgentRunningChange]);

  const onDrop = useCallback((files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const textFiles = files.filter((f) => !f.type.startsWith("image/"));
    if (imageFiles.length > 0) chatInputRef?.current?.addImages(imageFiles);
    if (textFiles.length > 0) chatInputRef?.current?.addFiles(textFiles);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role === "user" || m.role === "assistant"),
    [messages],
  );
  const messageKeys = useStableMessageKeys(messages, entryIds);
  const toolResultsMap = useMemo(() => {
    const results = new Map<string, import("@/lib/types").ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") {
        const toolResult = message as import("@/lib/types").ToolResultMessage;
        results.set(toolResult.toolCallId, toolResult);
      }
    }
    return results;
  }, [messages]);
  const handleEditMessage = useCallback((content: string) => {
    chatInputRef?.current?.insertIfEmpty(content);
  }, [chatInputRef]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const visibleExtensionStatuses = extensionStatuses.filter((item) => !isPowerbarExtensionItem(item));
  const visibleExtensionWidgets = extensionWidgets.filter(
    (item) => !isPowerbarExtensionItem(item) && !isSuppressedSubagentWidget(item),
  );
  const todoWidget = visibleExtensionWidgets.find(isTodoWidget) ?? null;

  // Report whether an extension Todo List widget is active in this chat.
  useEffect(() => {
    onTodoActiveChange?.(todoWidget != null);
  }, [todoWidget, onTodoActiveChange]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !agentRunning;

  // Quiet npm latest check for the empty-session version row (web/spi + pi).
  const [packageUpdates, setPackageUpdates] = useState<PackageUpdateCheckResult | null>(null);
  useEffect(() => {
    if (!isEmptyNew) return;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/version-check", {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as PackageUpdateCheckResult;
        if (!cancelled && body?.web && body?.pi) setPackageUpdates(body);
      } catch {
        // Network/registry failures stay silent — no update dots.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isEmptyNew]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const isArchived = !!session?.archived;

  const writeLocked = sessionTabLock.writeLocked;

  const archivedBannerElement = isArchived ? (
    <div className="chat-archived-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span>{t("chat.archivedBanner")}</span>
    </div>
  ) : null;

  const multiTabBannerElement = !isArchived && writeLocked ? (
    <div className="chat-multitab-banner" role="status">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
      <span>{t("chat.multiTabBanner")}</span>
      <button
        type="button"
        className="chat-multitab-takeover"
        onClick={sessionTabLock.takeOverWrite}
      >
        {t("chat.multiTabTakeOver")}
      </button>
    </div>
  ) : null;

  const chatInputElement = isArchived ? (
    <div className="chat-archived-input">
      {t("chat.archivedInputDisabled")}
    </div>
  ) : (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSend}
      cwd={session?.cwd ?? newSessionCwd}
      onAbort={handleAbort}
      onSteer={agentRunning && !writeLocked ? handleSteer : undefined}
      onFollowUp={agentRunning && !writeLocked ? handleFollowUp : undefined}
      isStreaming={agentRunning}
      model={displayModelValue}
      modelNames={modelNames}
      modelList={modelList}
      modelsReady={modelsReady}
      onModelChange={writeLocked ? undefined : handleModelChange}
      onOpenModels={onOpenModels}
      onCompact={!writeLocked && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      toolPreset={toolPreset}
      onToolPresetChange={!writeLocked && (session || isNew) ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      onThinkingLevelChange={!writeLocked && (session || isNew) ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      notificationState={notificationState}
      onNotificationToggle={onNotificationToggle}
      autoScrollEnabled={autoScrollEnabled}
      onAutoScrollToggle={onAutoScrollToggle}
      browserSessionId={session?.id ?? null}
      browserSessionLabel={session?.name || session?.id?.slice(0, 8)}
      draftScope={session?.id ? `session:${session.id}` : `new:${newSessionCwd ?? "unknown"}`}
      writeLocked={writeLocked}
    />
  );

  if (loading) {
    return (
      <div className="chat-window-state">{t("chat.loadingSession")}</div>
    );
  }

  if (error) {
    return (
      <div className="chat-window-state is-error">{error}</div>
    );
  }

  return (
    <div
      className="chat-window-root"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {archivedBannerElement}
      {multiTabBannerElement}
      {session?.id && (
        <SessionChangesFloatingPanel sessionId={session.id} agentRunning={agentRunning} refreshKey={sessionChangesRefreshKey} />
      )}
      <ExtensionTodoPanel item={todoWidget} />
      {isDragOver && (
        <div className="chat-drop-zone">
          <div className="chat-drop-ripples">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="chat-drop-ripple"
                style={{ animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="chat-drop-icon"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="var(--accent-soft)" stroke="var(--accent-border)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="var(--accent-soft)" stroke="var(--accent-border)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="var(--accent-soft)" stroke="var(--accent-primary)" strokeWidth="1.6"/>
            <g stroke="var(--accent-border)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {isEmptyNew ? (
        <div className="chat-empty-state">
          <div className="chat-empty-content">
            <div className="chat-empty-header">
              <div className="chat-empty-title-row">
                <Image className="chat-empty-logo" src="/snail-pi-logo.svg" alt={t("app.productName")} width={42} height={42} priority />
                <span className="chat-empty-product">{t("app.productName")}</span>
                <span className="chat-empty-prompt"><Typewriter phrases={typewriterPhrases} /></span>
              </div>
              <div className="chat-empty-versions">
                <span className="chat-empty-version-line">
                  <span>web <strong>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</strong></span>
                  {packageUpdates?.web.updateAvailable && packageUpdates.web.latest ? (
                    <Tooltip
                      content={t("app.versionUpdateAvailable", {
                        latest: packageUpdates.web.latest,
                        current: packageUpdates.web.current,
                      })}
                      position="left"
                      delay={120}
                    >
                      <span
                        className="chat-empty-version-update-dot"
                        role="img"
                        aria-label={t("app.versionUpdateAvailable", {
                          latest: packageUpdates.web.latest,
                          current: packageUpdates.web.current,
                        })}
                      />
                    </Tooltip>
                  ) : null}
                </span>
                <span className="chat-empty-version-line">
                  <span>pi <strong>v{process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}</strong></span>
                  {packageUpdates?.pi.updateAvailable && packageUpdates.pi.latest ? (
                    <Tooltip
                      content={t("app.versionUpdateAvailable", {
                        latest: packageUpdates.pi.latest,
                        current: packageUpdates.pi.current,
                      })}
                      position="left"
                      delay={120}
                    >
                      <span
                        className="chat-empty-version-update-dot"
                        role="img"
                        aria-label={t("app.versionUpdateAvailable", {
                          latest: packageUpdates.pi.latest,
                          current: packageUpdates.pi.current,
                        })}
                      />
                    </Tooltip>
                  ) : null}
                </span>
              </div>
            </div>
            <ExtensionStatusBar items={visibleExtensionStatuses} />
            <ExtensionWidgetStack
              items={visibleExtensionWidgets.filter((item) => item.placement === "aboveEditor")}
            />
            {chatInputElement}
            <ExtensionWidgetStack
              items={visibleExtensionWidgets.filter((item) => item.placement === "belowEditor")}
            />
          </div>
        </div>
      ) : (
      <>
      <div className="relative flex flex-1 overflow-hidden">
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pt-4 [scrollbar-width:none]">
          <div className="mx-auto max-w-[820px] px-4">

            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              let refIdx = 0;
              return messages.map((msg, idx) => {
                // Single keyed owner per row — outer wrapper for visible messages.
                const messageKey = messageKeys[idx] ?? `idx-${idx}`;
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const isVisible = msg.role === "user" || msg.role === "assistant";
                const currentRefIdx = isVisible ? refIdx++ : -1;
                let showTimestamp = false;
                if (msg.role === "assistant") {
                  showTimestamp = true;
                  for (let j = idx + 1; j < messages.length; j++) {
                    const r = messages[j].role;
                    if (r === "user") break;
                    if (r === "assistant") { showTimestamp = false; break; }
                  }
                  // Hide on the currently-streaming tail (the streaming bubble owns the live timestamp)
                  if (showTimestamp && streamState.isStreaming && idx === messages.length - 1) {
                    showTimestamp = false;
                  }
                }
                const view = (
                  <MessageView
                    message={msg}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    entryId={entryIds[idx]}
                    onFork={agentRunning || writeLocked || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={agentRunning || writeLocked ? undefined : handleNavigate}
                    prevAssistantEntryId={agentRunning ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditMessage}
                    showTimestamp={showTimestamp}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as import("@/lib/types").AgentMessage & { timestamp?: number }).timestamp : undefined}
                  />
                );
                if (!isVisible) {
                  return <Fragment key={messageKey}>{view}</Fragment>;
                }
                return (
                  <div key={messageKey} ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                    if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
                  }}>
                    {view}
                  </div>
                );
              });
            })()}

            {streamState.isStreaming && streamState.streamingMessage && (
              <MessageView
                key="streaming-assistant"
                message={streamState.streamingMessage as AgentMessage}
                isStreaming
                modelNames={modelNames}
              />
            )}

            {agentRunning && !streamState.streamingMessage && (
              <div className="py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {!agentRunning && agentFailure && (
              <div className="chat-agent-failure" role="alert">
                <div className="chat-agent-failure-header">
                  <div className="chat-agent-failure-title">
                    {t(chatFailureTitleKey(agentFailure.category))}
                  </div>
                  <button
                    type="button"
                    className="chat-agent-failure-dismiss"
                    onClick={dismissAgentFailure}
                  >
                    {t("chat.agentFailureDismiss")}
                  </button>
                </div>
                <div className="chat-agent-failure-message">
                  {localizeError(t, {
                    code: agentFailure.code,
                    message: agentFailure.errorMessage,
                    fallback: agentFailure.errorMessage,
                  })}
                </div>
                {chatFailureActionKey(agentFailure.category) && (
                  <div className="chat-agent-failure-action-hint">
                    {t(chatFailureActionKey(agentFailure.category)!)}
                  </div>
                )}
                <div className="chat-agent-failure-meta">
                  {agentFailure.provider && (
                    <span>{t("chat.agentFailureProvider")}: {agentFailure.provider}</span>
                  )}
                  {agentFailure.model && (
                    <span>{t("chat.agentFailureModel")}: {modelNames[`${agentFailure.provider}:${agentFailure.model}`] ?? agentFailure.model}</span>
                  )}
                  <span>
                    {t("chat.agentFailureRetries")}: {agentFailure.retryAttempts}
                    {agentFailure.maxAttempts ? `/${agentFailure.maxAttempts}` : ""}
                  </span>
                </div>
                <details className="chat-agent-failure-details">
                  <summary>{t("chat.agentFailureDetails")}</summary>
                  <pre>{agentFailure.technicalDetails}</pre>
                </details>
                <div className="chat-agent-failure-actions">
                  <button
                    type="button"
                    className="chat-agent-failure-continue"
                    onClick={handleContinueAfterFailure}
                    disabled={isArchived || writeLocked}
                  >
                    {t("chat.agentFailureContinue")}
                  </button>
                  {onOpenModels && chatFailureOffersModelsFix(agentFailure.category) && (
                    <button
                      type="button"
                      className="chat-agent-failure-models"
                      onClick={onOpenModels}
                    >
                      {t("chat.agentFailureOpenModels")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {agentRunning && !autoScrollEnabled && (
              <div style={{ height: scrollContainerRef.current ? scrollContainerRef.current.clientHeight : "80vh" }} />
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
        <div className="chat-minimap-wrap">
          <ChatMinimap
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
          />
        </div>
      </div>

      <div className="chat-composer-region">
        <ExtensionStatusBar items={visibleExtensionStatuses} />
        <ExtensionWidgetStack
          items={visibleExtensionWidgets.filter((item) => item.placement === "aboveEditor")}
        />
        {chatInputElement}
        <ExtensionWidgetStack
          items={visibleExtensionWidgets.filter((item) => item.placement === "belowEditor")}
        />
      </div>
      </>
      )}
      <ExtensionDialogHost dialog={extensionDialog} onRespond={respondExtensionDialog} />
      <ExtensionToastHost toasts={extensionToasts} onDismiss={dismissExtensionToast} />
    </div>
  );
});