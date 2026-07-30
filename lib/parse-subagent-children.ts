import { open, stat } from "node:fs/promises";
import { normalizeToolCalls } from "./normalize";
import { parsePersistedSubagentRuns, type SubagentRun } from "./subagent-runs";
import type { AgentMessage } from "./types";

export const MAX_SUBAGENT_DETAIL_DEPTH = 3;
export const MAX_SUBAGENT_DETAIL_CHILDREN = 16;
export const MAX_SUBAGENT_DETAIL_OUTPUT_CHARS = 32_000;
const MAX_SUBAGENT_DETAIL_BYTES = 1024 * 1024;
const MAX_SUBAGENT_DETAIL_ENTRIES = 2_000;
const HEAD_BYTES = 768 * 1024;

export interface SubagentDetailResult {
  fingerprint: string;
  depth: number;
  output: string | null;
  outputTruncated: boolean;
  children: SubagentRun[];
  childrenTruncated: boolean;
  fileTruncated: boolean;
}

export function createSubagentDetailFingerprint(size: number, mtimeMs: number): string {
  return `v1:${size}:${Math.floor(mtimeMs)}`;
}

interface DetailLimits {
  maxBytes?: number;
  maxEntries?: number;
  maxChildren?: number;
  maxOutputChars?: number;
}

function messageText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((block) => typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
      ? block.text
      : "")
    .join("");
}

function completeLines(text: string, trimStart: boolean, trimEnd: boolean): string[] {
  let value = text;
  if (trimStart) {
    const firstNewline = value.indexOf("\n");
    value = firstNewline >= 0 ? value.slice(firstNewline + 1) : "";
  }
  if (trimEnd) {
    const lastNewline = value.lastIndexOf("\n");
    value = lastNewline >= 0 ? value.slice(0, lastNewline) : "";
  }
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

async function readBoundedLines(sessionFile: string, size: number, maxBytes: number): Promise<{
  headLines: string[];
  tailLines: string[];
  truncated: boolean;
}> {
  const handle = await open(sessionFile, "r");
  try {
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return {
        headLines: completeLines(buffer.toString("utf8"), false, false),
        tailLines: [],
        truncated: false,
      };
    }

    const headLength = Math.min(HEAD_BYTES, maxBytes, size);
    const tailLength = Math.min(maxBytes - headLength, size - headLength);
    const head = Buffer.alloc(headLength);
    const tail = Buffer.alloc(Math.max(0, tailLength));
    await handle.read(head, 0, headLength, 0);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, size - tailLength);
    return {
      headLines: completeLines(head.toString("utf8"), false, true),
      tailLines: completeLines(tail.toString("utf8"), true, false),
      truncated: true,
    };
  } finally {
    await handle.close();
  }
}

/** Read one subagent session with strict I/O, entry, child, and output bounds. */
export async function parseSubagentDetail(
  sessionFile: string,
  depth: number,
  limits: DetailLimits = {},
): Promise<SubagentDetailResult> {
  const maxBytes = limits.maxBytes ?? MAX_SUBAGENT_DETAIL_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_SUBAGENT_DETAIL_ENTRIES;
  const maxChildren = limits.maxChildren ?? MAX_SUBAGENT_DETAIL_CHILDREN;
  const maxOutputChars = limits.maxOutputChars ?? MAX_SUBAGENT_DETAIL_OUTPUT_CHARS;
  const before = await stat(sessionFile);
  const { headLines, tailLines, truncated: bytesTruncated } = await readBoundedLines(sessionFile, before.size, maxBytes);
  const allLineCount = headLines.length + tailLines.length;
  const headBudget = tailLines.length > 0 ? Math.ceil(maxEntries / 2) : maxEntries;
  const tailBudget = Math.max(0, maxEntries - Math.min(headLines.length, headBudget));
  const lines = [
    ...headLines.slice(0, headBudget),
    ...(tailBudget > 0 ? tailLines.slice(-tailBudget) : []),
  ];

  const messages: AgentMessage[] = [];
  const entriesTruncated = allLineCount > lines.length;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: AgentMessage };
      if (entry.type === "message" && entry.message) {
        messages.push(normalizeToolCalls(entry.message));
      }
    } catch {
      // Ignore malformed or chunk-boundary JSONL records and retain valid history.
    }
  }

  const allChildren = parsePersistedSubagentRuns(messages).map((run) => ({
    ...run,
    depth,
    parentId: undefined,
  }));
  const children = maxChildren > 0 ? allChildren.slice(-maxChildren) : [];
  const latestOutput = [...messages].reverse().map(messageText).find(Boolean) ?? "";
  const outputTruncated = latestOutput.length > maxOutputChars || bytesTruncated || entriesTruncated;
  const output = latestOutput
    ? latestOutput.slice(-maxOutputChars)
    : null;
  return {
    // Fingerprint the exact size/mtime snapshot used for the read. If the file
    // appends concurrently, the next conditional request sees a newer stat.
    fingerprint: createSubagentDetailFingerprint(before.size, before.mtimeMs),
    depth,
    output,
    outputTruncated,
    children,
    childrenTruncated: allChildren.length > maxChildren || bytesTruncated || entriesTruncated,
    fileTruncated: bytesTruncated || entriesTruncated,
  };
}
