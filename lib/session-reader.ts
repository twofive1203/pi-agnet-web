import { SessionManager, buildSessionContext as piBuildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve as resolvePath } from "path";
import type {
  SessionEntry,
  SessionInfo,
  SessionContext,
  SessionTreeNode,
  AssistantMessage,
  ProjectSummary,
} from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { stripVisualEvidenceFromMessage } from "./vision-resolver";
import { getGitMetadataForCwd } from "./git-worktree";
import { canonicalizeCwd, expandCwd } from "./cwd";
import {
  archiveSessionArtifacts,
  deleteSessionArtifacts,
  unarchiveSessionArtifacts,
} from "./session-artifacts";
import {
  getSessionIndexEntries,
  getSessionIndexEntriesForCwd,
  indexEntryToCandidate,
  invalidateSessionIndex,
  type SessionIndexEntry,
} from "./session-index";
import {
  readSessionHeaderLine,
  sessionIdFromFilePath,
} from "./session-reader-header";

export { getAgentDir };
export { readSessionHeaderLine, sessionIdFromFilePath } from "./session-reader-header";
export { invalidateSessionIndex } from "./session-index";

export function getSessionsDir(): string {
  return `${getAgentDir()}/sessions`;
}

export interface DeletedSessionFile {
  id: string;
  path: string;
  cwd: string;
}

function cwdKeys(cwd: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (!cwd) return keys;
  for (const candidate of [cwd, expandCwd(cwd), canonicalizeCwd(cwd)]) {
    if (candidate) keys.add(candidate.replace(/[\\/]+$/, ""));
  }
  return keys;
}

function cwdMatchesAny(cwd: string | undefined, targets: Set<string>): boolean {
  for (const key of cwdKeys(cwd)) {
    if (targets.has(key)) return true;
  }
  return false;
}

function isDeletedWorktreeCwd(cwd: string | undefined): boolean {
  const keys = cwdKeys(cwd);
  if (keys.size === 0) return false;
  if ([...keys].some((key) => existsSync(key))) return false;

  return [...keys].some((key) => {
    const parts = key.split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 && parts[parts.length - 2].endsWith(".worktrees");
  });
}

function deleteSessionFile(session: Pick<PiSessionInfo, "id" | "path" | "cwd">): DeletedSessionFile | null {
  try {
    deleteSessionArtifacts(session.path);
  } catch {
    return null;
  }

  invalidateSessionPathCache(session.id);
  invalidateSessionIndex();
  try { rmdirSync(dirname(session.path)); } catch { /* keep non-empty session directories */ }
  return { id: session.id, path: session.path, cwd: session.cwd ?? "" };
}

function pruneDeletedWorktreeSessions(piSessions: PiSessionInfo[]): Set<string> {
  const prunedSessionIds = new Set<string>();
  for (const session of piSessions) {
    if (!isDeletedWorktreeCwd(session.cwd)) continue;
    prunedSessionIds.add(session.id);
    deleteSessionFile(session);
  }
  return prunedSessionIds;
}

export async function deleteSessionsForCwd(cwd: string, aliases: string[] = []): Promise<DeletedSessionFile[]> {
  const targets = new Set<string>();
  for (const candidate of [cwd, ...aliases]) {
    for (const key of cwdKeys(candidate)) targets.add(key);
  }

  const deleted: DeletedSessionFile[] = [];
  const piSessions: PiSessionInfo[] = await SessionManager.listAll();
  for (const session of piSessions) {
    if (!cwdMatchesAny(session.cwd, targets)) continue;
    const deletedSession = deleteSessionFile(session);
    if (deletedSession) deleted.push(deletedSession);
  }
  return deleted;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  let piSessions: PiSessionInfo[] = await SessionManager.listAll();
  const prunedSessionIds = pruneDeletedWorktreeSessions(piSessions);
  if (prunedSessionIds.size > 0) {
    piSessions = piSessions.filter((session) => !prunedSessionIds.has(session.id));
  }
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(s.path, s.id);

  const canonicalCwdBySessionId = new Map<string, string>();
  for (const s of piSessions) {
    if (s.cwd) canonicalCwdBySessionId.set(s.id, canonicalizeCwd(s.cwd));
  }

  const gitByCwd = new Map<string, SessionInfo["git"]>();
  const worktreeByCwd = new Map<string, SessionInfo["worktree"]>();
  await Promise.all([...new Set(canonicalCwdBySessionId.values())].map(async (cwd) => {
    try {
      const metadata = await getGitMetadataForCwd(cwd);
      if (metadata) {
        gitByCwd.set(cwd, metadata);
        if (metadata.isWorktree) {
          worktreeByCwd.set(cwd, {
            isWorktree: true,
            branch: metadata.branch,
            repoRoot: metadata.repoRoot,
            mainWorktreePath: metadata.mainWorktreePath,
            mainWorktreeBranch: metadata.mainWorktreeBranch,
          });
        }
      }
    } catch {
      // Git metadata is best-effort; normal session listing must still work.
    }
  }));

  const cache = getPathCache();
  return piSessions.map((s) => {
    const cwd = canonicalCwdBySessionId.get(s.id) ?? s.cwd;
    // Populate path cache so resolveSessionPath works without a full scan
    cache.set(s.id, s.path);
    return {
      path: s.path,
      id: s.id,
      cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(s.parentSessionPath) : undefined,
      worktree: cwd ? worktreeByCwd.get(cwd) : undefined,
      git: cwd ? gitByCwd.get(cwd) : undefined,
    };
  });
}

// ============================================================================
// Browser-oriented project / recent-session readers (bounded, no full scan)
// ============================================================================

export {
  RECENT_SESSIONS_LIMIT,
  ARCHIVED_SESSIONS_LIMIT,
  PARENT_CLOSURE_LIMIT,
} from "./session-reader-constants";
import {
  RECENT_SESSIONS_LIMIT,
  ARCHIVED_SESSIONS_LIMIT,
  PARENT_CLOSURE_LIMIT,
} from "./session-reader-constants";

/** Cursor for mtime-ordered session pages (strictly older than this boundary). */
export interface SessionPageCursor {
  /** ISO mtime of the boundary candidate. */
  before?: string;
  /** Absolute path tie-break when multiple files share the same mtime. */
  beforePath?: string;
}

export interface SessionPageOptions extends SessionPageCursor {
  limit?: number;
  /** Auto-include missing fork parents in the same cwd (default true for active lists). */
  includeParentClosure?: boolean;
}

export interface SessionPageResult {
  sessions: SessionInfo[];
  total: number;
  limit: number;
  hasMore: boolean;
  nextBefore: string | null;
  nextBeforePath: string | null;
}

interface SessionFileCandidate {
  path: string;
  fileName: string;
  /** File mtime ISO — primary sort key for "recent" browsing (not message activity). */
  mtimeIso: string;
  mtimeMs: number;
  /** Filename timestamp prefix when present (create/fork time); secondary sort key. */
  fileNameStamp: string;
}

/**
 * Encode a cwd the same way pi stores sessions under ~/.pi/agent/sessions/.
 * Directory names are lossy and must not be reverse-parsed into a real cwd.
 */
export function encodeSessionDirName(cwd: string): string {
  const resolved = resolvePath(expandCwd(cwd));
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function getSessionDirForCwd(cwd: string): string {
  return join(getSessionsDir(), encodeSessionDirName(cwd));
}

function fileNameTimestamp(fileName: string): string {
  const stamp = fileName.split("_")[0] ?? "";
  return stamp;
}

function listJsonlCandidates(dirPath: string): SessionFileCandidate[] {
  if (!existsSync(dirPath)) return [];
  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    const candidates: SessionFileCandidate[] = [];
    for (const fileName of files) {
      const filePath = join(dirPath, fileName);
      try {
        const st = statSync(filePath);
        if (!st.isFile()) continue;
        candidates.push({
          path: filePath,
          fileName,
          mtimeIso: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs,
          fileNameStamp: fileNameTimestamp(fileName),
        });
      } catch {
        // skip unreadable files
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * Sort candidates for "recent" browsing without reading JSONL content.
 * Primary: filesystem mtime (closer to last write than create time).
 * Secondary: filename timestamp prefix (create/fork time).
 * Tertiary: path for stability.
 *
 * Note: historical `SessionInfo.modified` from SessionManager.listAll uses last
 * message activity time. Browse ordering intentionally uses mtime so the sidebar
 * does not parse every JSONL.
 */
function sortCandidatesRecentFirst(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    const stampCmp = b.fileNameStamp.localeCompare(a.fileNameStamp);
    if (stampCmp !== 0) return stampCmp;
    return b.path.localeCompare(a.path);
  });
}

function firstMessageFromEntries(entries: ReturnType<SessionManager["getEntries"]>): {
  messageCount: number;
  firstMessage: string;
  name?: string;
} {
  let messageCount = 0;
  let firstMessage = "(no messages)";
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") {
      const info = entry as { name?: string };
      name = info.name?.trim() || undefined;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    if (messageCount === 1) {
      const msg = entry as unknown as { message?: { content?: unknown } };
      const content = msg.message?.content;
      if (typeof content === "string") {
        firstMessage = stripVisualEvidenceFromMessage(content).slice(0, 100);
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b: { type: string }) => b.type === "text");
        if (textBlock) firstMessage = stripVisualEvidenceFromMessage((textBlock as { text: string }).text).slice(0, 100);
      }
    }
  }
  return { messageCount, firstMessage: firstMessage || "(no messages)", name };
}

function buildSessionInfoFromFile(
  filePath: string,
  options?: { expectedCwdTargets?: Set<string>; includeGit?: boolean }
): SessionInfo | null {
  try {
    const sm = SessionManager.open(filePath);
    const header = sm.getHeader();
    if (!header?.id) return null;
    if (options?.expectedCwdTargets && !cwdMatchesAny(header.cwd, options.expectedCwdTargets)) {
      return null;
    }

    const sessionCwd = header.cwd ? canonicalizeCwd(header.cwd) : "";
    const entries = sm.getEntries();
    const { messageCount, firstMessage, name } = firstMessageFromEntries(entries);

    let modified = header.timestamp ?? new Date().toISOString();
    try {
      modified = statSync(filePath).mtime.toISOString();
    } catch {
      // use header timestamp
    }

    const cache = getPathCache();
    cache.set(header.id, filePath);

    return {
      path: filePath,
      id: header.id,
      cwd: sessionCwd,
      name: name ?? sm.getSessionName(),
      created: header.timestamp ?? modified,
      modified,
      messageCount,
      firstMessage,
      parentSessionId: header.parentSession
        ? sessionIdFromFilePath(header.parentSession)
        : undefined,
    };
  } catch {
    return null;
  }
}

async function loadGitMapsForCwds(cwds: string[]): Promise<{
  gitByCwd: Map<string, SessionInfo["git"]>;
  worktreeByCwd: Map<string, SessionInfo["worktree"]>;
}> {
  const gitByCwd = new Map<string, SessionInfo["git"]>();
  const worktreeByCwd = new Map<string, SessionInfo["worktree"]>();
  await Promise.all([...new Set(cwds.filter(Boolean))].map(async (cwd) => {
    try {
      const metadata = await getGitMetadataForCwd(cwd);
      if (metadata) {
        gitByCwd.set(cwd, metadata);
        if (metadata.isWorktree) {
          worktreeByCwd.set(cwd, {
            isWorktree: true,
            branch: metadata.branch,
            repoRoot: metadata.repoRoot,
            mainWorktreePath: metadata.mainWorktreePath,
            mainWorktreeBranch: metadata.mainWorktreeBranch,
          });
        }
      }
    } catch {
      // best-effort
    }
  }));
  return { gitByCwd, worktreeByCwd };
}

/**
 * Discover projects by scanning first-level session directories without parsing every JSONL.
 *
 * Pi directory encoding is lossy on Windows (`/`, `\\`, and `:` all become `-`), so one
 * encoded directory may contain sessions from multiple real cwds. Always group by the
 * session header cwd, never treat the directory name as a single project.
 */
function candidateFromIndexEntry(entry: SessionIndexEntry): SessionFileCandidate {
  const c = indexEntryToCandidate(entry);
  return {
    path: c.path,
    fileName: c.fileName,
    mtimeIso: c.mtimeIso,
    mtimeMs: c.mtimeMs,
    fileNameStamp: c.fileNameStamp,
  };
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  // Prefer rebuildable index (path+mtime+size fingerprint) so unchanged JSONL headers
  // are not re-read on every projects request. Disk remains the source of truth.
  type CwdBucket = {
    cwd: string;
    candidates: SessionFileCandidate[];
  };

  const byCwd = new Map<string, CwdBucket>();
  let usedIndex = false;

  try {
    const activeEntries = await getSessionIndexEntries({ archived: false });
    usedIndex = true;
    for (const entry of activeEntries) {
      const cwd = entry.cwd;
      if (!cwd) continue;
      if (isDeletedWorktreeCwd(cwd)) {
        deleteSessionFile({ id: entry.id, path: entry.path, cwd });
        invalidateSessionIndex();
        continue;
      }
      const bucket = byCwd.get(cwd) ?? { cwd, candidates: [] };
      bucket.candidates.push(candidateFromIndexEntry(entry));
      byCwd.set(cwd, bucket);
    }
  } catch {
    usedIndex = false;
  }

  // Fallback only when index refresh itself failed.
  if (!usedIndex) {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) return [];
    let dirEntries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      dirEntries = readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(sessionsDir, String(entry.name));
      const candidates = listJsonlCandidates(dirPath);
      for (const candidate of candidates) {
        const header = readSessionHeaderLine(candidate.path);
        if (!header?.cwd) continue;
        const cwd = canonicalizeCwd(header.cwd);
        if (isDeletedWorktreeCwd(cwd)) {
          deleteSessionFile({
            id: sessionIdFromFilePath(candidate.path) ?? header.id,
            path: candidate.path,
            cwd,
          });
          continue;
        }
        const bucket = byCwd.get(cwd) ?? { cwd, candidates: [] };
        bucket.candidates.push(candidate);
        byCwd.set(cwd, bucket);
      }
    }
  }

  const { gitByCwd, worktreeByCwd } = await loadGitMapsForCwds([...byCwd.keys()]);

  const summaries: ProjectSummary[] = [];
  for (const bucket of byCwd.values()) {
    const ordered = sortCandidatesRecentFirst(bucket.candidates);
    const targets = cwdKeys(bucket.cwd);

    // Newest *valid readable* candidate wins for latestSession / latestModified.
    // A newer malformed file must not blank out an older valid session.
    let latestSession: ProjectSummary["latestSession"];
    let latestModified = ordered[0]?.mtimeIso ?? new Date(0).toISOString();
    for (const candidate of ordered) {
      const info = buildSessionInfoFromFile(candidate.path, { expectedCwdTargets: targets });
      if (!info) continue;
      latestSession = {
        id: info.id,
        name: info.name,
        firstMessage: info.firstMessage,
        modified: info.modified,
        created: info.created,
        messageCount: info.messageCount,
      };
      latestModified = candidate.mtimeIso || info.modified;
      break;
    }

    summaries.push({
      cwd: bucket.cwd,
      sessionCount: bucket.candidates.length,
      latestModified,
      latestSession,
      git: gitByCwd.get(bucket.cwd),
      worktree: worktreeByCwd.get(bucket.cwd),
    });
  }

  summaries.sort((a, b) => b.latestModified.localeCompare(a.latestModified));
  return summaries;
}

function findSessionDirsForCwd(cwd: string): string[] {
  const targets = cwdKeys(cwd);
  const dirs = new Set<string>();

  for (const key of targets) {
    const encoded = getSessionDirForCwd(key);
    if (existsSync(encoded)) dirs.add(encoded);
  }

  // Always header-scan first-level dirs: encoding is lossy on Windows, so sessions for
  // this cwd may live in a colliding encoded folder that is not encode(cwd). Only reading
  // a few newest files is insufficient when foreign-cwd sessions dominate mtime order.
  const sessionsDir = getSessionsDir();
  if (existsSync(sessionsDir)) {
    try {
      for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dirPath = join(sessionsDir, entry.name);
        if (dirs.has(dirPath)) continue;
        const candidates = listJsonlCandidates(dirPath);
        if (candidates.length === 0) continue;
        for (const candidate of candidates) {
          const header = readSessionHeaderLine(candidate.path);
          if (header && cwdMatchesAny(header.cwd, targets)) {
            dirs.add(dirPath);
            break;
          }
        }
      }
    } catch {
      // ignore unreadable session roots
    }
  }

  return [...dirs];
}

function parseBeforeMs(before?: string): number | null {
  if (!before) return null;
  const ms = Date.parse(before);
  return Number.isFinite(ms) ? ms : null;
}

/** True when candidate is strictly older than the (beforeMs, beforePath) cursor. */
function isStrictlyBeforeCursor(
  candidate: SessionFileCandidate,
  beforeMs: number | null,
  beforePath?: string
): boolean {
  if (beforeMs == null) return true;
  if (candidate.mtimeMs < beforeMs) return true;
  if (candidate.mtimeMs > beforeMs) return false;
  // Same mtime: path descending order means "older" pages continue after the boundary path.
  if (!beforePath) return false;
  return candidate.path.localeCompare(beforePath) < 0;
}

function clampPageLimit(limit: number | undefined, fallback: number): number {
  const raw = limit == null ? fallback : limit;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(100, Math.floor(raw)));
}

async function collectMatchingCandidatesForCwd(cwd: string): Promise<{
  matching: SessionFileCandidate[];
  targets: Set<string>;
}> {
  const targets = cwdKeys(cwd);
  if (targets.size === 0) return { matching: [], targets };

  // Index path: entries already grouped by real header cwd (Windows collision safe).
  // A successful refresh is authoritative even when this cwd has zero matches.
  try {
    const indexed = await getSessionIndexEntriesForCwd(cwd, { archived: false });
    const matching = sortCandidatesRecentFirst(indexed.map(candidateFromIndexEntry));
    return { matching, targets };
  } catch {
    // fall through to direct scan
  }

  const dirs = findSessionDirsForCwd(cwd);
  const allCandidates: SessionFileCandidate[] = [];
  for (const dir of dirs) {
    allCandidates.push(...listJsonlCandidates(dir));
  }

  const ordered = sortCandidatesRecentFirst(allCandidates);
  const matching: SessionFileCandidate[] = [];
  for (const candidate of ordered) {
    const header = readSessionHeaderLine(candidate.path);
    if (header && cwdMatchesAny(header.cwd, targets)) matching.push(candidate);
  }
  return { matching, targets };
}

function pageSliceFromMatching(
  matching: SessionFileCandidate[],
  safeLimit: number,
  before?: string,
  beforePath?: string
): {
  pageCandidates: SessionFileCandidate[];
  total: number;
  hasMore: boolean;
  nextBefore: string | null;
  nextBeforePath: string | null;
} {
  const beforeMs = parseBeforeMs(before);
  const window = beforeMs == null && !beforePath
    ? matching
    : matching.filter((c) => isStrictlyBeforeCursor(c, beforeMs, beforePath));

  const pageCandidates = window.slice(0, safeLimit);
  const last = pageCandidates[pageCandidates.length - 1];
  const hasMore = window.length > pageCandidates.length;

  return {
    pageCandidates,
    total: matching.length,
    hasMore,
    nextBefore: hasMore && last ? last.mtimeIso : null,
    nextBeforePath: hasMore && last ? last.path : null,
  };
}

/**
 * When a page includes fork children whose parents live outside the page window,
 * pull in up to PARENT_CLOSURE_LIMIT missing ancestors from the same cwd so the
 * sidebar tree does not flatten them into false roots.
 */
function closeParentSessions(
  pageSessions: SessionInfo[],
  matching: SessionFileCandidate[],
  targets: Set<string>,
  options?: { archived?: boolean }
): SessionInfo[] {
  if (pageSessions.length === 0) return pageSessions;

  const byId = new Map(pageSessions.map((s) => [s.id, s]));
  const pathById = new Map<string, string>();
  for (const candidate of matching) {
    const id = sessionIdFromFilePath(candidate.path);
    if (id) pathById.set(id, candidate.path);
  }

  const missing: string[] = [];
  const seenMissing = new Set<string>();
  for (const session of pageSessions) {
    const parentId = session.parentSessionId;
    const visited = new Set<string>();
    while (parentId && !byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      if (!seenMissing.has(parentId)) {
        seenMissing.add(parentId);
        missing.push(parentId);
      }
      // Only walk one hop via known page edges unless we load the parent;
      // deeper chains are resolved after each loaded parent below.
      break;
    }
  }

  let added = 0;
  for (let i = 0; i < missing.length && added < PARENT_CLOSURE_LIMIT; i++) {
    const parentId = missing[i];
    if (byId.has(parentId)) continue;
    const filePath = pathById.get(parentId) ?? findSessionFileById(parentId);
    if (!filePath) continue;
    if (options?.archived && !isArchivedSessionPath(filePath)) continue;
    if (!options?.archived && isArchivedSessionPath(filePath)) continue;

    const info = buildSessionInfoFromFile(filePath, { expectedCwdTargets: targets });
    if (!info) continue;
    if (options?.archived) info.archived = true;
    byId.set(info.id, info);
    added += 1;

    // Queue next missing ancestor if still outside the loaded set.
    if (
      info.parentSessionId &&
      !byId.has(info.parentSessionId) &&
      !seenMissing.has(info.parentSessionId) &&
      added < PARENT_CLOSURE_LIMIT
    ) {
      seenMissing.add(info.parentSessionId);
      missing.push(info.parentSessionId);
    }
  }

  return [...byId.values()];
}

/**
 * List recent active sessions for one project cwd with optional mtime cursor pagination.
 *
 * Only fully parses up to `limit` matching JSONL files for the page (default 10),
 * plus a bounded parent-closure set for fork tree stability.
 *
 * Because encoded directories can collide on Windows, candidates are filtered by header cwd
 * with header-only reads first. Full JSONL open/parse is applied only to the page's
 * header-matching candidates (never limit+N retries after malformed bodies).
 *
 * `total` is the header-matched candidate count (not necessarily successfully parsed).
 * Browse order is file mtime, then filename stamp, then path.
 */
export async function listRecentSessionsForCwd(
  cwd: string,
  limitOrOptions: number | SessionPageOptions = RECENT_SESSIONS_LIMIT
): Promise<SessionPageResult> {
  const options: SessionPageOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions ?? {};
  const safeLimit = clampPageLimit(options.limit, RECENT_SESSIONS_LIMIT);
  const includeParentClosure = options.includeParentClosure !== false;

  const empty: SessionPageResult = {
    sessions: [],
    total: 0,
    limit: safeLimit,
    hasMore: false,
    nextBefore: null,
    nextBeforePath: null,
  };

  const { matching, targets } = await collectMatchingCandidatesForCwd(cwd);
  if (targets.size === 0) return empty;

  const page = pageSliceFromMatching(matching, safeLimit, options.before, options.beforePath);

  // Bound full parses strictly to the page's pre-filtered candidates (no backfill).
  const sessions: SessionInfo[] = [];
  for (const candidate of page.pageCandidates) {
    const info = buildSessionInfoFromFile(candidate.path, { expectedCwdTargets: targets });
    if (!info) continue;
    // Skip deleted worktree leftovers if any remain (only files proven for this cwd).
    if (isDeletedWorktreeCwd(info.cwd)) {
      deleteSessionFile({ id: info.id, path: info.path, cwd: info.cwd });
      invalidateSessionIndex();
      continue;
    }
    sessions.push(info);
  }

  const withParents = includeParentClosure
    ? closeParentSessions(sessions, matching, targets)
    : sessions;

  const { gitByCwd, worktreeByCwd } = await loadGitMapsForCwds(
    [...new Set(withParents.map((s) => s.cwd).filter(Boolean))]
  );

  for (const session of withParents) {
    session.git = gitByCwd.get(session.cwd);
    session.worktree = worktreeByCwd.get(session.cwd);
  }

  // Keep response ordered by browse recency (mtime), already selected that way.
  withParents.sort((a, b) => {
    const cmp = b.modified.localeCompare(a.modified);
    if (cmp !== 0) return cmp;
    return b.path.localeCompare(a.path);
  });

  return {
    sessions: withParents,
    total: page.total,
    limit: safeLimit,
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
    nextBeforePath: page.nextBeforePath,
  };
}

/**
 * Locate a session file by id via directory/filename scan without parsing every JSONL.
 * Filename format: `<timestamp>_<session-id>.jsonl`.
 * Matches the extracted session id exactly (not a substring of another id).
 */
export function findSessionFileById(sessionId: string, rootDir?: string): string | null {
  if (!sessionId) return null;
  const roots = rootDir
    ? [rootDir]
    : [getSessionsDir(), getSessionsArchiveDir()].filter((dir) => existsSync(dir));

  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(root, String(entry.name));
      try {
        const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          if (sessionIdFromFilePath(file) === sessionId) {
            return join(dirPath, file);
          }
        }
      } catch {
        // skip unreadable dirs
      }
    }
  }
  return null;
}

// ============================================================================
// Session path cache: sessionId → absolute file path
// Stored in globalThis for hot-reload safety
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  getPathCache().set(sessionId, filePath);
}

export function invalidateSessionPathCache(sessionId: string): void {
  getPathCache().delete(sessionId);
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const labelsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type === "label") {
      const l = entry as { type: "label"; targetId: string; label?: string };
      if (l.label) labelsById.set(l.targetId, l.label);
      else labelsById.delete(l.targetId);
    }
  }

  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (!entry.parentId) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

export function buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  // Build entryIds: parallel array to messages[], mapping each message back to its entry id.
  // Needed for fork and navigate_tree calls from the UI.
  let targetLeaf: SessionEntry | undefined;
  if (leafId === null) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }
  if (leafId) targetLeaf = byId.get(leafId);
  if (!targetLeaf) targetLeaf = entries[entries.length - 1];
  if (!targetLeaf) {
    return { messages: [], entryIds: [], thinkingLevel: piCtx.thinkingLevel, model: piCtx.model };
  }

  // Walk path from target leaf to root
  const path: SessionEntry[] = [];
  let cur: SessionEntry | undefined = targetLeaf;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }

  // Find the last compaction on path (mirrors pi's buildSessionContext logic)
  let compactionId: string | undefined;
  let firstKeptEntryId: string | undefined;
  for (const e of path) {
    if (e.type === "compaction") {
      compactionId = e.id;
      firstKeptEntryId = (e as { firstKeptEntryId: string }).firstKeptEntryId;
    }
  }

  const entryIds: string[] = [];
  if (compactionId) {
    // The first message in piCtx.messages is the synthetic compaction summary — map to compaction entry id
    entryIds.push(compactionId);
    const compactionIdx = path.findIndex((e) => e.id === compactionId);
    const firstKeptIdx = firstKeptEntryId
      ? path.findIndex((e, i) => i < compactionIdx && e.id === firstKeptEntryId)
      : -1;
    const startIdx = firstKeptIdx >= 0 ? firstKeptIdx : compactionIdx;
    for (let i = startIdx; i < compactionIdx; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      if (path[i].type === "message") entryIds.push(path[i].id);
    }
  } else {
    for (const e of path) {
      if (e.type === "message") entryIds.push(e.id);
    }
  }

  // pi injects compaction summary as {role:"compactionSummary", summary, tokensBefore}.
  // Convert to {role:"user"} so MessageView can render it the same as before.
  const messages = (piCtx.messages as AssistantMessage[]).map((msg) => {
    const raw = msg as unknown as Record<string, unknown>;
    if (raw.role === "compactionSummary") {
      return {
        role: "user" as const,
        content: `*The conversation history before this point was compacted into the following summary:*\n\n${raw.summary ?? ""}`,
        timestamp: raw.timestamp as number | undefined,
      };
    }
    const normalized = normalizeToolCalls(msg);
    if (normalized.role !== "user") return normalized;
    const content = typeof normalized.content === "string"
      ? stripVisualEvidenceFromMessage(normalized.content)
      : normalized.content.map((block) => block.type === "text"
        ? { ...block, text: stripVisualEvidenceFromMessage(block.text) }
        : block);
    return { ...normalized, content };
  });

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

export function getLeafId(entries: SessionEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries[entries.length - 1].id;
}

// ============================================================================
// Archive helpers: move sessions between sessions/ and sessions-archive/
// ============================================================================

export function getSessionsArchiveDir(): string {
  return `${getAgentDir()}/sessions-archive`;
}

/** Separator-safe archived path check for Windows (`\\`) and POSIX (`/`). */
export function isArchivedSessionPath(filePath: string): boolean {
  return /(?:^|[/\\])sessions-archive(?:[/\\]|$)/.test(filePath);
}

/**
 * Move a session file from sessions/ to sessions-archive/.
 * Returns the new archive path.
 */
export function archiveSessionFile(sessionPath: string): string {
  const target = archiveSessionArtifacts(sessionPath);
  // Update parentSession refs in sibling files
  updateParentSessionRefs(dirname(sessionPath), sessionPath, target);
  invalidateSessionIndex();
  return target;
}

/**
 * Move a session file from sessions-archive/ back to sessions/.
 * Returns the new active path.
 */
export function unarchiveSessionFile(archivePath: string): string {
  const target = unarchiveSessionArtifacts(archivePath);
  // Update parentSession refs in sibling files
  updateParentSessionRefs(dirname(archivePath), archivePath, target);
  invalidateSessionIndex();
  return target;
}

/**
 * Scan sibling files in a directory and update their parentSession header
 * if it points to oldPath → point to newPath instead.
 */
function updateParentSessionRefs(dirPath: string, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  try {
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = join(dirPath, file);
      if (filePath === oldPath || filePath === newPath) continue;
      try {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (header.type === "session" && header.parentSession === oldPath) {
          header.parentSession = newPath;
          lines[0] = JSON.stringify(header);
          writeFileSync(filePath, lines.join("\n"));
        }
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // skip if dir unreadable
  }
}

/**
 * Scan the archive directory and return which cwds have archived sessions.
 *
 * Windows session directory encoding is lossy, so one archive folder may hold
 * multiple real cwds. Group every archive JSONL by its canonical header cwd
 * (same strategy as active project summaries). Malformed files are isolated and
 * do not contribute counts; colliding cwds are never merged by directory name.
 */
export async function scanArchivedCwds(): Promise<{ cwds: string[]; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};

  try {
    const archivedEntries = await getSessionIndexEntries({ archived: true });
    for (const entry of archivedEntries) {
      if (!entry.cwd) continue;
      counts[entry.cwd] = (counts[entry.cwd] ?? 0) + 1;
    }
    return { cwds: Object.keys(counts), counts };
  } catch {
    // fall through
  }

  const archiveDir = getSessionsArchiveDir();
  if (!existsSync(archiveDir)) return { cwds: [], counts };

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return { cwds: [], counts };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(archiveDir, entry.name);
    let jsonlFiles: string[];
    try {
      jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of jsonlFiles) {
      const header = readSessionHeaderLine(join(dirPath, file));
      if (!header?.cwd) continue; // isolate malformed / header-less files
      const cwd = canonicalizeCwd(header.cwd);
      counts[cwd] = (counts[cwd] ?? 0) + 1;
    }
  }

  return { cwds: Object.keys(counts), counts };
}

async function collectArchivedMatchingCandidates(cwd?: string): Promise<{
  matching: SessionFileCandidate[];
  targets: Set<string> | null;
}> {
  const targets = cwd ? cwdKeys(cwd) : null;

  try {
    const indexed = cwd
      ? await getSessionIndexEntriesForCwd(cwd, { archived: true })
      : await getSessionIndexEntries({ archived: true });
    return {
      matching: sortCandidatesRecentFirst(indexed.map(candidateFromIndexEntry)),
      targets,
    };
  } catch {
    // fall through to direct scan
  }

  const archiveDir = getSessionsArchiveDir();
  if (!existsSync(archiveDir)) return { matching: [], targets };

  const allCandidates: SessionFileCandidate[] = [];

  let dirs: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirs = readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return { matching: [], targets };
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(archiveDir, dir.name);
    allCandidates.push(...listJsonlCandidates(dirPath));
  }

  const ordered = sortCandidatesRecentFirst(allCandidates);
  if (!targets) {
    // Full archive list: keep files with any valid session header.
    const matching: SessionFileCandidate[] = [];
    for (const candidate of ordered) {
      const header = readSessionHeaderLine(candidate.path);
      if (header?.id) matching.push(candidate);
    }
    return { matching, targets };
  }

  const matching: SessionFileCandidate[] = [];
  for (const candidate of ordered) {
    const header = readSessionHeaderLine(candidate.path);
    if (header && cwdMatchesAny(header.cwd, targets)) matching.push(candidate);
  }
  return { matching, targets };
}

function buildArchivedSessionInfo(
  filePath: string,
  options?: { expectedCwdTargets?: Set<string> | null }
): SessionInfo | null {
  const info = buildSessionInfoFromFile(filePath, {
    expectedCwdTargets: options?.expectedCwdTargets ?? undefined,
  });
  if (!info) return null;
  info.archived = true;
  return info;
}

/**
 * List archived sessions, optionally filtered to one cwd.
 * Full parse of every matching archive file — used by Usage and bulk consumers.
 */
async function listArchivedSessions(cwd?: string): Promise<SessionInfo[]> {
  const { matching, targets } = await collectArchivedMatchingCandidates(cwd);
  const sessions: SessionInfo[] = [];
  for (const candidate of matching) {
    const info = buildArchivedSessionInfo(candidate.path, { expectedCwdTargets: targets });
    if (info) sessions.push(info);
  }
  return sessions.sort((a, b) => {
    const cmp = b.modified.localeCompare(a.modified);
    if (cmp !== 0) return cmp;
    return b.path.localeCompare(a.path);
  });
}

export async function listAllArchivedSessions(): Promise<SessionInfo[]> {
  return listArchivedSessions();
}

/**
 * List archived sessions for one project cwd with optional mtime cursor pagination.
 * Without page options (or when called for compatibility), returns the full cwd list.
 */
export async function listArchivedSessionsForCwd(cwd: string): Promise<SessionInfo[]>;
export async function listArchivedSessionsForCwd(
  cwd: string,
  limitOrOptions: number | SessionPageOptions
): Promise<SessionPageResult>;
export async function listArchivedSessionsForCwd(
  cwd: string,
  limitOrOptions?: number | SessionPageOptions
): Promise<SessionInfo[] | SessionPageResult> {
  // Backward-compatible: no second arg → full list for this cwd.
  if (limitOrOptions == null) {
    return listArchivedSessions(cwd);
  }

  const options: SessionPageOptions =
    typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const safeLimit = clampPageLimit(options.limit, ARCHIVED_SESSIONS_LIMIT);
  const includeParentClosure = options.includeParentClosure === true;

  const empty: SessionPageResult = {
    sessions: [],
    total: 0,
    limit: safeLimit,
    hasMore: false,
    nextBefore: null,
    nextBeforePath: null,
  };

  const { matching, targets } = await collectArchivedMatchingCandidates(cwd);
  if (!targets || targets.size === 0) return empty;

  const page = pageSliceFromMatching(matching, safeLimit, options.before, options.beforePath);
  const sessions: SessionInfo[] = [];
  for (const candidate of page.pageCandidates) {
    const info = buildArchivedSessionInfo(candidate.path, { expectedCwdTargets: targets });
    if (info) sessions.push(info);
  }

  const withParents = includeParentClosure
    ? closeParentSessions(sessions, matching, targets, { archived: true })
    : sessions;

  withParents.sort((a, b) => {
    const cmp = b.modified.localeCompare(a.modified);
    if (cmp !== 0) return cmp;
    return b.path.localeCompare(a.path);
  });

  return {
    sessions: withParents,
    total: page.total,
    limit: safeLimit,
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
    nextBeforePath: page.nextBeforePath,
  };
}

/**
 * Find an archived session by scanning the sessions-archive/ directory tree.
 */
export function resolveArchivedSessionPath(sessionId: string): string | null {
  const archiveDir = getSessionsArchiveDir();
  if (!existsSync(archiveDir)) return null;

  const cache = getPathCache();
  // Check cache first
  const cached = cache.get(sessionId);
  if (cached && isArchivedSessionPath(cached)) return cached;

  // Scan archive dirs for the session file (exact id match from filename).
  const entries = readdirSync(archiveDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(archiveDir, entry.name);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      if (sessionIdFromFilePath(file) === sessionId) {
        const fullPath = join(dirPath, file);
        cache.set(sessionId, fullPath);
        return fullPath;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extend resolveSessionPath to also check the archive directory
// ---------------------------------------------------------------------------
export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    // Drop stale cache entries that no longer have a valid matching session header.
    const header = readSessionHeaderLine(cached);
    if (header?.id === sessionId) return cached;
    invalidateSessionPathCache(sessionId);
  }

  // Lightweight filename scan (no full JSONL parse / listAllSessions).
  // Exact filename id match is required; malformed/mismatched headers fail closed.
  const found = findSessionFileById(sessionId);
  if (found) {
    const header = readSessionHeaderLine(found);
    if (header?.id === sessionId) {
      getPathCache().set(sessionId, found);
      return found;
    }
    // Exact id path exists but content is invalid — do not fall through to weaker matches.
    return null;
  }

  // Legacy fallback: full active scan may populate cache for unusual layouts.
  await listAllSessions();
  const cachedAfter = getPathCache().get(sessionId);
  if (cachedAfter) {
    const header = readSessionHeaderLine(cachedAfter);
    if (header?.id === sessionId) return cachedAfter;
    invalidateSessionPathCache(sessionId);
  }

  const archived = resolveArchivedSessionPath(sessionId);
  if (!archived) return null;
  const header = readSessionHeaderLine(archived);
  if (header?.id === sessionId) return archived;
  invalidateSessionPathCache(sessionId);
  return null;
}



