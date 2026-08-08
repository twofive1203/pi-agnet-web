/**
 * Workspace-scoped session search over the rebuildable session index summaries.
 *
 * Matches only `name` and `firstMessage` (not full chat bodies). Disk JSONL stays
 * authoritative via the index fingerprint (path + mtimeMs + size).
 */

import { getGitMetadataForCwd } from "./git-worktree";
import {
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MIN_QUERY_CHARS,
} from "./session-reader-constants";
import {
  getSessionIndexEntriesForCwd,
  type SessionIndexEntry,
} from "./session-index";
import type { SessionInfo } from "./types";

export {
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MIN_QUERY_CHARS,
} from "./session-reader-constants";

export interface SessionSearchOptions {
  cwd: string;
  query: string;
  includeArchived?: boolean;
  limit?: number;
  agentDir?: string;
}

export interface SessionSearchResult {
  sessions: SessionInfo[];
  total: number;
  hasMore: boolean;
  query: string;
  cwd: string;
  limit: number;
}

function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  return Math.min(n, SESSION_SEARCH_MAX_LIMIT);
}

/** Pure matcher used by API + smoke tests. */
export function sessionSummaryMatchesQuery(
  entry: Pick<SessionIndexEntry, "name" | "firstMessage">,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return false;
  const name = (entry.name ?? "").toLowerCase();
  const firstMessage = (entry.firstMessage ?? "").toLowerCase();
  return name.includes(normalizedQuery) || firstMessage.includes(normalizedQuery);
}

function entryToSessionInfo(
  entry: SessionIndexEntry,
  worktree: SessionInfo["worktree"] | undefined,
  git: SessionInfo["git"] | undefined
): SessionInfo {
  return {
    path: entry.path,
    id: entry.id,
    cwd: entry.cwd,
    name: entry.name,
    created: entry.created,
    modified: entry.modified,
    messageCount: entry.messageCount,
    firstMessage: entry.firstMessage || "(no messages)",
    parentSessionId: entry.parentSessionId,
    archived: entry.archived || undefined,
    worktree,
    git,
  };
}

/**
 * Search active (+ optional archived) sessions for one workspace cwd.
 * Results are flat, newest-first by file mtime, hard-capped by limit.
 */
export async function searchSessionsForCwd(
  options: SessionSearchOptions
): Promise<SessionSearchResult> {
  const cwd = options.cwd?.trim() ?? "";
  const query = options.query ?? "";
  const normalized = normalizeQuery(query);
  const limit = clampLimit(options.limit);
  const includeArchived = options.includeArchived !== false;

  if (!cwd || normalized.length < SESSION_SEARCH_MIN_QUERY_CHARS) {
    return {
      sessions: [],
      total: 0,
      hasMore: false,
      query,
      cwd,
      limit,
    };
  }

  const entries = await getSessionIndexEntriesForCwd(cwd, {
    agentDir: options.agentDir,
    // undefined = active + archived; false = active only
    archived: includeArchived ? undefined : false,
  });

  const matched = entries
    .filter((entry) => (includeArchived ? true : !entry.archived))
    .filter((entry) => sessionSummaryMatchesQuery(entry, normalized))
    .sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.path.localeCompare(a.path);
    });

  const total = matched.length;
  const page = matched.slice(0, limit);

  let worktree: SessionInfo["worktree"] | undefined;
  let git: SessionInfo["git"] | undefined;
  if (page.length > 0) {
    try {
      const metadata = await getGitMetadataForCwd(cwd);
      if (metadata) {
        git = metadata;
        if (metadata.isWorktree) {
          worktree = {
            isWorktree: true,
            branch: metadata.branch,
            repoRoot: metadata.repoRoot,
            mainWorktreePath: metadata.mainWorktreePath,
            mainWorktreeBranch: metadata.mainWorktreeBranch,
          };
        }
      }
    } catch {
      // Worktree metadata is best-effort for display only.
    }
  }

  return {
    sessions: page.map((entry) => entryToSessionInfo(entry, worktree, git)),
    total,
    hasMore: total > limit,
    query,
    cwd,
    limit,
  };
}
