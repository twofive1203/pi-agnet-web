/**
 * Bounded, SDK-free extraction of searchable session browse fields from a JSONL file.
 *
 * Disk JSONL remains authoritative. Used by the rebuildable session index so search
 * can match name + firstMessage without opening every file through SessionManager.
 */

import { closeSync, openSync, readSync, statSync } from "fs";
import { stripVisualEvidenceFromMessage } from "./vision-resolver";

/** Hard cap on bytes scanned per file while building search summaries. */
export const SESSION_SUMMARY_MAX_BYTES = 8 * 1024 * 1024;

/** Match reader truncation used by SessionManager-backed browse paths. */
export const SESSION_FIRST_MESSAGE_MAX_CHARS = 100;

export interface SessionBrowseSummary {
  name?: string;
  firstMessage: string;
  messageCount: number;
}

const DEFAULT_FIRST_MESSAGE = "(no messages)";

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    const text = stripVisualEvidenceFromMessage(content).trim();
    return text ? text.slice(0, SESSION_FIRST_MESSAGE_MAX_CHARS) : null;
  }
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = stripVisualEvidenceFromMessage((block as { text: string }).text || "").trim();
      if (text) return text.slice(0, SESSION_FIRST_MESSAGE_MAX_CHARS);
    }
  }
  return null;
}

/**
 * Scan a session JSONL for browse/search summary fields.
 * - `name` is the latest non-empty `session_info.name`
 * - `firstMessage` is the first user message text (truncated)
 * - `messageCount` counts `type:"message"` entries within the scanned prefix
 *
 * Returns null when the file is unreadable. Individual malformed lines are skipped.
 */
export function readSessionBrowseSummary(filePath: string): SessionBrowseSummary | null {
  let fd: number | null = null;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    const maxBytes = Math.min(st.size, SESSION_SUMMARY_MAX_BYTES);
    fd = openSync(filePath, "r");

    let name: string | undefined;
    let firstMessage = DEFAULT_FIRST_MESSAGE;
    let messageCount = 0;
    let sawFirstUser = false;

    let offset = 0;
    let pending = "";
    const buf = Buffer.alloc(64 * 1024);

    while (offset < maxBytes) {
      const toRead = Math.min(buf.length, maxBytes - offset);
      const bytes = readSync(fd, buf, 0, toRead, offset);
      if (bytes <= 0) break;
      offset += bytes;
      pending += buf.toString("utf8", 0, bytes);

      let nl = pending.indexOf("\n");
      while (nl >= 0) {
        const rawLine = pending.slice(0, nl).replace(/\r$/, "").trim();
        pending = pending.slice(nl + 1);
        nl = pending.indexOf("\n");
        if (!rawLine) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(rawLine);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        const entry = parsed as {
          type?: unknown;
          name?: unknown;
          message?: { role?: unknown; content?: unknown };
        };

        if (entry.type === "session_info" && typeof entry.name === "string") {
          const trimmed = entry.name.trim();
          if (trimmed) name = trimmed;
          continue;
        }

        if (entry.type !== "message") continue;
        messageCount += 1;
        if (sawFirstUser) continue;
        if (entry.message?.role !== "user") continue;
        const text = extractUserText(entry.message.content);
        if (text) {
          firstMessage = text;
          sawFirstUser = true;
        }
      }
    }

    // Final unterminated line within the scanned window.
    const tail = pending.replace(/\r$/, "").trim();
    if (tail) {
      try {
        const parsed = JSON.parse(tail) as {
          type?: unknown;
          name?: unknown;
          message?: { role?: unknown; content?: unknown };
        };
        if (parsed?.type === "session_info" && typeof parsed.name === "string") {
          const trimmed = parsed.name.trim();
          if (trimmed) name = trimmed;
        } else if (parsed?.type === "message") {
          messageCount += 1;
          if (!sawFirstUser && parsed.message?.role === "user") {
            const text = extractUserText(parsed.message.content);
            if (text) firstMessage = text;
          }
        }
      } catch {
        // ignore trailing partial JSON
      }
    }

    return {
      name,
      firstMessage: firstMessage || DEFAULT_FIRST_MESSAGE,
      messageCount,
    };
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
