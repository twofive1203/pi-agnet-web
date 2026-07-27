/**
 * Bounded session JSONL header peek helpers shared by session-reader and session-index.
 * Kept free of heavier reader imports to avoid circular dependencies.
 */

import { closeSync, openSync, readSync } from "fs";
import { basename } from "path";
import type { SessionHeader } from "./types";

/** Extract session id from a pi session file path or basename. */
export function sessionIdFromFilePath(filePath: string): string | undefined {
  const base = basename(filePath);
  const match =
    base.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i) ??
    base.match(/_(.+)\.jsonl$/i);
  return match?.[1];
}

/**
 * Read only the first JSONL header line of a session file (bounded prefix read).
 * Returns null for missing/unreadable/malformed files or non-session headers.
 */
export function readSessionHeaderLine(filePath: string): SessionHeader | null {
  try {
    // Read a small prefix so project discovery does not load entire multi-MB JSONL files.
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(8 * 1024);
      const bytes = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.toString("utf8", 0, bytes);
      const nl = text.search(/\r?\n/);
      const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
      if (!firstLine) return null;
      const header = JSON.parse(firstLine) as SessionHeader;
      // Require a string id + cwd so typed-malformed headers never escape as "valid".
      if (
        header?.type !== "session" ||
        typeof header.id !== "string" ||
        !header.id ||
        typeof header.cwd !== "string" ||
        !header.cwd
      ) {
        return null;
      }
      return header;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}
