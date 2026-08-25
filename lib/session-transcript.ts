/**
 * Display-transcript projection for the current session branch.
 *
 * This is intentionally separate from Pi's buildSessionContext(): that helper
 * builds the compaction-aware LLM/runtime context. The WebUI chat history must
 * keep every current-branch message and only paginate for the browser.
 */
import { normalizeToolCalls } from "./normalize";
import { SESSION_FIRST_MESSAGE_MAX_CHARS } from "./session-search-summary";
import type {
  AgentMessage,
  CustomMessage,
  SessionContextState,
  SessionEntry,
  SessionMessageEntry,
  SessionTranscriptPage,
  TextContent,
} from "./types";
import {
  TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE,
  TRANSCRIPT_COMPACTION_CUSTOM_TYPE,
} from "./types";
import { stripVisualEvidenceFromMessage } from "./vision-resolver";

export const TRANSCRIPT_DEFAULT_PAGE_LIMIT = 100;
export const TRANSCRIPT_MAX_PAGE_LIMIT = 200;
export const TRANSCRIPT_FIRST_MESSAGE_FALLBACK = "(no messages)";

export type TranscriptCursorErrorCode =
  | "unknown_leaf"
  | "unknown_cursor"
  | "cursor_not_on_leaf"
  | "cursor_not_page_boundary";

export class TranscriptCursorError extends Error {
  readonly code: TranscriptCursorErrorCode;

  constructor(code: TranscriptCursorErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TranscriptCursorError";
    this.code = code;
  }
}

export interface SessionTranscriptRow {
  message: AgentMessage;
  entryId: string;
}

export interface SessionTranscriptProjection {
  rows: SessionTranscriptRow[];
  leafId: string | null;
  messageCount: number;
  firstMessage: string;
  contextState: SessionContextState;
  knownEntryIds: ReadonlySet<string>;
  pathEntryIds: ReadonlySet<string>;
}

export interface TranscriptPageOptions {
  beforeEntryId?: string | null;
  limit?: number;
}

export interface BuildTranscriptPageOptions extends TranscriptPageOptions {
  leafId?: string | null;
}

export function isTranscriptCompactionMessage(message: AgentMessage): message is CustomMessage {
  return message.role === "custom" && message.customType === TRANSCRIPT_COMPACTION_CUSTOM_TYPE;
}

export function isTranscriptBranchSummaryMessage(message: AgentMessage): message is CustomMessage {
  return message.role === "custom" && message.customType === TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE;
}

export function clampTranscriptPageLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return TRANSCRIPT_DEFAULT_PAGE_LIMIT;
  }
  return Math.min(TRANSCRIPT_MAX_PAGE_LIMIT, Math.floor(limit));
}

export function parseOptionalTranscriptLimit(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseTranscriptSearchParams(searchParams: {
  get(name: string): string | null;
}): {
  leafId?: string;
  beforeEntryId?: string;
  limit?: number;
} {
  const leafId = searchParams.get("leafId") || undefined;
  const beforeEntryId = searchParams.get("beforeEntryId") || undefined;
  return {
    ...(leafId ? { leafId } : {}),
    ...(beforeEntryId ? { beforeEntryId } : {}),
    limit: parseOptionalTranscriptLimit(searchParams.get("limit")),
  };
}

export function httpStatusForTranscriptError(error: unknown): { status: number; error: string } {
  if (error instanceof TranscriptCursorError) {
    return { status: 400, error: error.code };
  }
  return { status: 500, error: String(error) };
}

export function projectSessionTranscript(
  entries: SessionEntry[],
  leafId?: string | null,
): SessionTranscriptProjection {
  const knownEntryIds = new Set(entries.map((entry) => entry.id));
  const path = buildTranscriptPath(entries, leafId);
  const pathEntryIds = new Set(path.map((entry) => entry.id));
  const resolvedLeafId = leafId === null ? null : (path[path.length - 1]?.id ?? null);

  const rows: SessionTranscriptRow[] = [];
  let messageCount = 0;
  let firstMessage = TRANSCRIPT_FIRST_MESSAGE_FALLBACK;

  for (const entry of path) {
    const row = projectTranscriptEntry(entry);
    if (!row) continue;
    rows.push(row);
    if (entry.type === "message") {
      messageCount += 1;
      if (firstMessage === TRANSCRIPT_FIRST_MESSAGE_FALLBACK && row.message.role === "user") {
        const preview = previewUserMessage(row.message);
        if (preview) firstMessage = preview;
      }
    }
  }

  return {
    rows,
    leafId: resolvedLeafId,
    messageCount,
    firstMessage,
    contextState: contextStateFromPath(path),
    knownEntryIds,
    pathEntryIds,
  };
}

export function paginateSessionTranscript(
  projection: SessionTranscriptProjection,
  options: TranscriptPageOptions = {},
): SessionTranscriptPage {
  const limit = clampTranscriptPageLimit(options.limit);
  const turns = groupTranscriptTurns(projection.rows);
  const eligibleTurns = selectTurnsBeforeCursor(projection, turns, options.beforeEntryId);
  const pageTurns = takeLatestTurns(eligibleTurns, limit);
  const pageRows = pageTurns.flat();
  const oldestEntryId = pageRows[0]?.entryId ?? null;
  const firstSelected = pageTurns[0];
  const hasMoreBefore = Boolean(
    firstSelected && turns[0] && turns[0][0]?.entryId !== firstSelected[0]?.entryId,
  );

  return {
    messages: pageRows.map((row) => row.message),
    entryIds: pageRows.map((row) => row.entryId),
    leafId: projection.leafId,
    hasMoreBefore,
    nextBeforeEntryId: hasMoreBefore ? oldestEntryId : null,
    messageCount: projection.messageCount,
    firstMessage: projection.firstMessage,
  };
}

export function buildSessionTranscriptPage(
  entries: SessionEntry[],
  options: BuildTranscriptPageOptions = {},
): SessionTranscriptPage {
  return paginateSessionTranscript(
    projectSessionTranscript(entries, options.leafId),
    { beforeEntryId: options.beforeEntryId, limit: options.limit },
  );
}

function buildTranscriptPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  if (leafId === null || entries.length === 0) return [];

  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  let leaf: SessionEntry | undefined;
  if (leafId) {
    leaf = byId.get(leafId);
    if (!leaf) throw new TranscriptCursorError("unknown_leaf");
  } else {
    leaf = entries[entries.length - 1];
  }
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

function contextStateFromPath(path: SessionEntry[]): SessionContextState {
  let thinkingLevel = "off";
  let model: SessionContextState["model"] = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  return { thinkingLevel, model };
}

function projectTranscriptEntry(entry: SessionEntry): SessionTranscriptRow | null {
  if (entry.type === "message") {
    return { entryId: entry.id, message: projectMessageEntry(entry) };
  }
  if (entry.type === "custom_message") {
    return {
      entryId: entry.id,
      message: {
        role: "custom",
        customType: entry.customType,
        content: entry.content ?? [],
        display: entry.display,
        details: entry.details,
        timestamp: timestampMs(entry.timestamp),
      },
    };
  }
  if (entry.type === "compaction") {
    return {
      entryId: entry.id,
      message: {
        role: "custom",
        customType: TRANSCRIPT_COMPACTION_CUSTOM_TYPE,
        content: entry.summary ?? "",
        display: false,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: timestampMs(entry.timestamp),
      },
    };
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return {
      entryId: entry.id,
      message: {
        role: "custom",
        customType: TRANSCRIPT_BRANCH_SUMMARY_CUSTOM_TYPE,
        content: entry.summary,
        display: false,
        details: { fromId: entry.fromId },
        timestamp: timestampMs(entry.timestamp),
      },
    };
  }
  return null;
}

function projectMessageEntry(entry: SessionMessageEntry): AgentMessage {
  const raw = entry.message;
  const withContent = raw && typeof raw === "object"
    ? fillMissingContent(raw)
    : { role: "user" as const, content: [] };
  const normalized = normalizeToolCalls(withContent);
  if (normalized.role !== "user") {
    return withEntryTimestamp(normalized, entry.timestamp);
  }

  const content = typeof normalized.content === "string"
    ? stripVisualEvidenceFromMessage(normalized.content)
    : normalized.content.map((block) => (
      block.type === "text"
        ? { ...block, text: stripVisualEvidenceFromMessage(block.text) }
        : block
    ));
  return withEntryTimestamp({ ...normalized, content }, entry.timestamp);
}

function fillMissingContent(message: AgentMessage): AgentMessage {
  if (
    (message.role === "user" || message.role === "assistant" || message.role === "toolResult")
    && message.content == null
  ) {
    return { ...message, content: [] } as AgentMessage;
  }
  return message;
}

function withEntryTimestamp(message: AgentMessage, timestamp: string): AgentMessage {
  if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message;
  const parsed = timestampMs(timestamp);
  return parsed === undefined ? message : { ...message, timestamp: parsed };
}

function timestampMs(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function previewUserMessage(message: Extract<AgentMessage, { role: "user" }>): string | null {
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text ? text.slice(0, SESSION_FIRST_MESSAGE_MAX_CHARS) : null;
  }
  if (!Array.isArray(message.content)) return null;
  for (const block of message.content) {
    if (block.type !== "text") continue;
    const text = (block as TextContent).text.trim();
    if (text) return text.slice(0, SESSION_FIRST_MESSAGE_MAX_CHARS);
  }
  return null;
}

function groupTranscriptTurns(rows: SessionTranscriptRow[]): SessionTranscriptRow[][] {
  const turns: SessionTranscriptRow[][] = [];
  let current: SessionTranscriptRow[] = [];
  for (const row of rows) {
    if (row.message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [row];
      continue;
    }
    current.push(row);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function selectTurnsBeforeCursor(
  projection: SessionTranscriptProjection,
  turns: SessionTranscriptRow[][],
  beforeEntryId?: string | null,
): SessionTranscriptRow[][] {
  if (!beforeEntryId) return turns;
  if (!projection.knownEntryIds.has(beforeEntryId)) {
    throw new TranscriptCursorError("unknown_cursor");
  }
  if (!projection.pathEntryIds.has(beforeEntryId)) {
    throw new TranscriptCursorError("cursor_not_on_leaf");
  }
  const cursorIndex = turns.findIndex((turn) => turn[0]?.entryId === beforeEntryId);
  if (cursorIndex < 0) {
    throw new TranscriptCursorError("cursor_not_page_boundary");
  }
  return turns.slice(0, cursorIndex);
}

function takeLatestTurns(turns: SessionTranscriptRow[][], limit: number): SessionTranscriptRow[][] {
  const selected: SessionTranscriptRow[][] = [];
  let count = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (selected.length > 0 && count + turn.length > limit) break;
    selected.unshift(turn);
    count += turn.length;
  }
  return selected;
}
