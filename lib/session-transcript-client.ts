/**
 * Client-safe transcript page merge helpers.
 * Dedupes by entryId only — never by message text globally.
 */
import type { AgentMessage, SessionTranscriptPage } from "./types";
import {
  TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE,
  TRANSCRIPT_COMPACTION_CUSTOM_TYPE,
} from "./types";

export {
  TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE,
  TRANSCRIPT_COMPACTION_CUSTOM_TYPE,
};

export interface TranscriptClientState {
  messages: AgentMessage[];
  entryIds: string[];
  leafId: string | null;
  hasMoreBefore: boolean;
  nextBeforeEntryId: string | null;
  messageCount: number;
  firstMessage: string;
}

export function isTranscriptCompactionMessage(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === TRANSCRIPT_COMPACTION_CUSTOM_TYPE;
}

export function isTranscriptBranchSummaryMessage(message: AgentMessage): boolean {
  return message.role === "custom" && message.customType === TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE;
}

export function emptyTranscriptClientState(leafId: string | null = null): TranscriptClientState {
  return {
    messages: [],
    entryIds: [],
    leafId,
    hasMoreBefore: false,
    nextBeforeEntryId: null,
    messageCount: 0,
    firstMessage: "(no messages)",
  };
}

export function replaceTranscriptPage(page: SessionTranscriptPage): TranscriptClientState {
  return {
    messages: page.messages.slice(),
    entryIds: page.entryIds.slice(),
    leafId: page.leafId,
    hasMoreBefore: page.hasMoreBefore,
    nextBeforeEntryId: page.nextBeforeEntryId,
    messageCount: page.messageCount,
    firstMessage: page.firstMessage,
  };
}

export function prependTranscriptPage(
  current: TranscriptClientState,
  older: SessionTranscriptPage,
): TranscriptClientState {
  const existing = new Set(current.entryIds.filter(Boolean));
  const prependedMessages: AgentMessage[] = [];
  const prependedIds: string[] = [];
  for (let index = 0; index < older.entryIds.length; index += 1) {
    const entryId = older.entryIds[index];
    if (!entryId || existing.has(entryId)) continue;
    prependedMessages.push(older.messages[index]);
    prependedIds.push(entryId);
  }
  const entryIds = [...prependedIds, ...current.entryIds];
  return {
    messages: [...prependedMessages, ...current.messages],
    entryIds,
    leafId: current.leafId ?? older.leafId,
    hasMoreBefore: older.hasMoreBefore,
    nextBeforeEntryId: older.hasMoreBefore ? older.nextBeforeEntryId : null,
    messageCount: older.messageCount || current.messageCount,
    firstMessage: older.firstMessage || current.firstMessage,
  };
}

export function mergeTranscriptTail(
  current: TranscriptClientState,
  latest: SessionTranscriptPage,
): TranscriptClientState {
  const latestIds = new Set(latest.entryIds.filter(Boolean));
  const keptMessages: AgentMessage[] = [];
  const keptIds: string[] = [];
  for (let index = 0; index < current.messages.length; index += 1) {
    const entryId = current.entryIds[index];
    if (!entryId) continue;
    if (latestIds.has(entryId)) continue;
    keptMessages.push(current.messages[index]);
    keptIds.push(entryId);
  }

  // Rows without entryId are optimistic/SSE tails. The persisted latest page is
  // authoritative for the overlapping end of the transcript.
  const messages = [...keptMessages, ...latest.messages];
  const entryIds = [...keptIds, ...latest.entryIds];
  const hasMoreBefore = current.hasMoreBefore || latest.hasMoreBefore;
  return {
    messages,
    entryIds,
    leafId: latest.leafId,
    hasMoreBefore,
    nextBeforeEntryId: hasMoreBefore ? (entryIds.find(Boolean) ?? latest.nextBeforeEntryId) : null,
    messageCount: latest.messageCount || current.messageCount,
    firstMessage: current.firstMessage !== "(no messages)" ? current.firstMessage : latest.firstMessage,
  };
}

export function restoreScrollAfterPrepend(
  before: { scrollHeight: number; scrollTop: number },
  afterScrollHeight: number,
): number {
  return before.scrollTop + (afterScrollHeight - before.scrollHeight);
}

export function isStaleTranscriptResponse(args: {
  requestSessionId: string;
  currentSessionId: string | null;
  requestLeafId: string | null;
  currentLeafId: string | null;
  requestSeq: number;
  currentSeq: number;
}): boolean {
  return (
    args.requestSessionId !== args.currentSessionId
    || args.requestLeafId !== args.currentLeafId
    || args.requestSeq !== args.currentSeq
  );
}

