/**
 * Rebuildable session/project index for WebUI browsing and workspace search.
 *
 * Disk JSONL files remain the source of truth. This module accelerates project
 * discovery, per-cwd candidate collection, and name/firstMessage search by
 * caching header + browse summaries keyed by path + mtimeMs + size. Cache
 * failures never block browsing or search.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { canonicalizeCwd } from "./cwd";
import { readSessionHeaderLine, sessionIdFromFilePath } from "./session-reader-header";
import { readSessionBrowseSummary } from "./session-search-summary";

/** Local agent-dir resolution to keep this module free of pi SDK import edges. */
function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** v2 adds searchable browse summaries (name / firstMessage / messageCount). */
export const SESSION_INDEX_VERSION = 2 as const;
export const SESSION_INDEX_FILE_NAME = "pi-web-session-index.json";

export interface SessionIndexEntry {
  path: string;
  mtimeMs: number;
  size: number;
  id: string;
  cwd: string;
  parentSessionId?: string;
  created: string;
  /** File mtime ISO — browse ordering key (not message activity). */
  modified: string;
  archived: boolean;
  /** Latest session_info name when present. */
  name?: string;
  /** First user message preview (truncated). */
  firstMessage: string;
  messageCount: number;
}

export interface SessionIndexFile {
  version: typeof SESSION_INDEX_VERSION;
  entries: SessionIndexEntry[];
}

export interface SessionIndexStatFile {
  path: string;
  mtimeMs: number;
  size: number;
  archived: boolean;
  fileName: string;
}

interface SessionIndexRuntime {
  refreshPromise: Promise<SessionIndexEntry[]> | null;
  writeChain: Promise<void>;
  memory: SessionIndexEntry[] | null;
  /** Fingerprints of unreadable/malformed files skipped on the last successful scan. */
  skippedFingerprints: Set<string>;
  /** Test/observability: number of header reads during the last refresh. */
  lastHeaderReads: number;
  /** Cumulative header reads since process start (tests may reset). */
  headerReadCount: number;
}

declare global {
  var __piSessionIndexRuntime: SessionIndexRuntime | undefined;
}

function getRuntime(): SessionIndexRuntime {
  if (!globalThis.__piSessionIndexRuntime) {
    globalThis.__piSessionIndexRuntime = {
      refreshPromise: null,
      writeChain: Promise.resolve(),
      memory: null,
      skippedFingerprints: new Set(),
      lastHeaderReads: 0,
      headerReadCount: 0,
    };
  }
  return globalThis.__piSessionIndexRuntime;
}

export function getSessionIndexPath(agentDir = defaultAgentDir()): string {
  return join(agentDir, SESSION_INDEX_FILE_NAME);
}

export function getSessionsDirForIndex(agentDir = defaultAgentDir()): string {
  return join(agentDir, "sessions");
}

export function getSessionsArchiveDirForIndex(agentDir = defaultAgentDir()): string {
  return join(agentDir, "sessions-archive");
}

/** Test helper: reset in-memory index state without touching disk. */
export function resetSessionIndexRuntimeForTests(): void {
  const runtime = getRuntime();
  runtime.refreshPromise = null;
  runtime.writeChain = Promise.resolve();
  runtime.memory = null;
  runtime.skippedFingerprints = new Set();
  runtime.lastHeaderReads = 0;
  runtime.headerReadCount = 0;
}

export function getSessionIndexHeaderReadCount(): number {
  return getRuntime().headerReadCount;
}

export function getLastSessionIndexHeaderReads(): number {
  return getRuntime().lastHeaderReads;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SessionIndexEntry>;
  return (
    typeof entry.path === "string" &&
    entry.path.length > 0 &&
    isFiniteNumber(entry.mtimeMs) &&
    isFiniteNumber(entry.size) &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.cwd === "string" &&
    entry.cwd.length > 0 &&
    typeof entry.created === "string" &&
    typeof entry.modified === "string" &&
    typeof entry.archived === "boolean" &&
    (entry.parentSessionId === undefined || typeof entry.parentSessionId === "string") &&
    (entry.name === undefined || typeof entry.name === "string") &&
    typeof entry.firstMessage === "string" &&
    isFiniteNumber(entry.messageCount)
  );
}

function readPersistedIndex(indexPath: string): SessionIndexEntry[] | null {
  try {
    if (!existsSync(indexPath)) return null;
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionIndexFile>;
    if (parsed.version !== SESSION_INDEX_VERSION || !Array.isArray(parsed.entries)) {
      return null;
    }
    const entries = parsed.entries.filter(isValidEntry);
    return entries.length === parsed.entries.length ? entries : null;
  } catch {
    return null;
  }
}

function listJsonlStatFiles(rootDir: string, archived: boolean): SessionIndexStatFile[] {
  if (!existsSync(rootDir)) return [];
  let dirEntries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    dirEntries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionIndexStatFile[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(rootDir, entry.name);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const fileName of files) {
      const filePath = join(dirPath, fileName);
      try {
        const st = statSync(filePath);
        if (!st.isFile()) continue;
        out.push({
          path: filePath,
          mtimeMs: st.mtimeMs,
          size: st.size,
          archived,
          fileName,
        });
      } catch {
        // isolate unreadable files
      }
    }
  }
  return out;
}

function fingerprintKey(path: string, mtimeMs: number, size: number, archived: boolean): string {
  return `${path}\0${mtimeMs}\0${size}\0${archived ? "1" : "0"}`;
}

function entryFromHeader(
  file: SessionIndexStatFile,
  header: { id: string; cwd: string; timestamp?: string; parentSession?: string }
): SessionIndexEntry {
  const created = header.timestamp || new Date(file.mtimeMs).toISOString();
  const modified = new Date(file.mtimeMs).toISOString();
  const parentSessionId = header.parentSession
    ? sessionIdFromFilePath(header.parentSession)
    : undefined;
  // Browse summary is best-effort; header-only fields still index the session.
  const summary = readSessionBrowseSummary(file.path);
  return {
    path: file.path,
    mtimeMs: file.mtimeMs,
    size: file.size,
    id: header.id,
    cwd: canonicalizeCwd(header.cwd),
    parentSessionId,
    created,
    modified,
    archived: file.archived,
    name: summary?.name,
    firstMessage: summary?.firstMessage ?? "(no messages)",
    messageCount: summary?.messageCount ?? 0,
  };
}

function entriesEqual(a: SessionIndexEntry[], b: SessionIndexEntry[]): boolean {
  if (a.length !== b.length) return false;
  const sortKey = (e: SessionIndexEntry) => `${e.archived ? "1" : "0"}\0${e.path}`;
  const left = [...a].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const right = [...b].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  for (let i = 0; i < left.length; i++) {
    const x = left[i];
    const y = right[i];
    if (
      x.path !== y.path ||
      x.mtimeMs !== y.mtimeMs ||
      x.size !== y.size ||
      x.id !== y.id ||
      x.cwd !== y.cwd ||
      x.parentSessionId !== y.parentSessionId ||
      x.created !== y.created ||
      x.modified !== y.modified ||
      x.archived !== y.archived ||
      x.name !== y.name ||
      x.firstMessage !== y.firstMessage ||
      x.messageCount !== y.messageCount
    ) {
      return false;
    }
  }
  return true;
}

function enqueueWrite(indexPath: string, entries: SessionIndexEntry[]): void {
  const runtime = getRuntime();
  runtime.writeChain = runtime.writeChain
    .then(() => {
      try {
        const dir = dirname(indexPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const payload: SessionIndexFile = { version: SESSION_INDEX_VERSION, entries };
        const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, "utf8");
        renameSync(tmpPath, indexPath);
      } catch {
        // Cache write failures must never block browsing.
        try {
          // best-effort temp cleanup if rename failed after write
          const dir = dirname(indexPath);
          // ignore
          void dir;
        } catch {
          // ignore
        }
      }
    })
    .catch(() => {
      // keep chain alive
    });
}

/**
 * Refresh the session index from disk. Concurrent callers share one in-flight build.
 * Returns the latest entry snapshot (active + archived).
 */
export async function refreshSessionIndex(options?: {
  agentDir?: string;
  /** Force rebuild even when memory is warm (still reuses unchanged fingerprints). */
  force?: boolean;
}): Promise<SessionIndexEntry[]> {
  const runtime = getRuntime();
  if (runtime.refreshPromise) return runtime.refreshPromise;

  const agentDir = options?.agentDir ?? defaultAgentDir();
  const indexPath = getSessionIndexPath(agentDir);

  // Build first, assign second, clear via promise.finally so a synchronously
  // completing body cannot lose the in-flight handle before assignment.
  const promise = (async () => {
    try {
      const previous =
        runtime.memory ??
        readPersistedIndex(indexPath) ??
        [];
      const previousByFp = new Map<string, SessionIndexEntry>();
      for (const entry of previous) {
        previousByFp.set(
          fingerprintKey(entry.path, entry.mtimeMs, entry.size, entry.archived),
          entry
        );
      }

      const files = [
        ...listJsonlStatFiles(getSessionsDirForIndex(agentDir), false),
        ...listJsonlStatFiles(getSessionsArchiveDirForIndex(agentDir), true),
      ];

      const next: SessionIndexEntry[] = [];
      const nextSkipped = new Set<string>();
      let headerReads = 0;
      for (const file of files) {
        const fp = fingerprintKey(file.path, file.mtimeMs, file.size, file.archived);
        const reused = previousByFp.get(fp);
        if (reused) {
          next.push(reused);
          continue;
        }
        // Unchanged malformed/unreadable files: skip without re-peeking headers.
        if (runtime.skippedFingerprints.has(fp)) {
          nextSkipped.add(fp);
          continue;
        }
        // Isolate every per-file failure (typed-malformed cwd, I/O, canonicalize throws)
        // so one bad JSONL cannot abort the whole refresh or hide valid entries.
        try {
          headerReads += 1;
          const header = readSessionHeaderLine(file.path);
          if (
            !header ||
            typeof header.id !== "string" ||
            !header.id ||
            typeof header.cwd !== "string" ||
            !header.cwd
          ) {
            nextSkipped.add(fp);
            continue;
          }
          next.push(entryFromHeader(file, header));
        } catch {
          nextSkipped.add(fp);
        }
      }

      runtime.lastHeaderReads = headerReads;
      runtime.headerReadCount += headerReads;
      runtime.memory = next;
      runtime.skippedFingerprints = nextSkipped;

      if (!entriesEqual(previous, next)) {
        enqueueWrite(indexPath, next);
      }

      return next;
    } catch {
      // Full failure: degrade to empty in-memory snapshot; callers still scan via reader fallbacks.
      runtime.lastHeaderReads = 0;
      runtime.memory = runtime.memory ?? [];
      return runtime.memory;
    }
  })();

  runtime.refreshPromise = promise;
  void promise.finally(() => {
    if (runtime.refreshPromise === promise) {
      runtime.refreshPromise = null;
    }
  });
  return promise;
}

/** Drop memory snapshot so the next refresh reloads from disk/index file. */
export function invalidateSessionIndex(): void {
  const runtime = getRuntime();
  runtime.memory = null;
  // Keep skippedFingerprints: unchanged malformed files still match path+mtime+size.
}

export async function getSessionIndexEntries(options?: {
  agentDir?: string;
  archived?: boolean;
}): Promise<SessionIndexEntry[]> {
  const entries = await refreshSessionIndex({ agentDir: options?.agentDir });
  if (options?.archived === true) return entries.filter((e) => e.archived);
  if (options?.archived === false) return entries.filter((e) => !e.archived);
  return entries;
}

function cwdKeySet(cwd: string): Set<string> {
  const keys = new Set<string>();
  if (!cwd) return keys;
  try {
    const canonical = canonicalizeCwd(cwd);
    keys.add(canonical.replace(/[\\/]+$/, ""));
    keys.add(cwd.replace(/[\\/]+$/, ""));
  } catch {
    keys.add(cwd.replace(/[\\/]+$/, ""));
  }
  return keys;
}

export async function getSessionIndexEntriesForCwd(
  cwd: string,
  options?: { agentDir?: string; archived?: boolean }
): Promise<SessionIndexEntry[]> {
  const targets = cwdKeySet(cwd);
  if (targets.size === 0) return [];
  const entries = await getSessionIndexEntries({
    agentDir: options?.agentDir,
    archived: options?.archived,
  });
  return entries.filter((entry) => {
    const keys = cwdKeySet(entry.cwd);
    for (const key of keys) {
      if (targets.has(key)) return true;
    }
    return false;
  });
}

/**
 * Unique workspace roots discovered from the session index.
 * Preferred by allowed-roots over full SessionManager.listAll scans.
 * Disk remains authoritative: refreshSessionIndex rebuilds from JSONL files.
 */
export async function getSessionIndexCwdRoots(options?: {
  agentDir?: string;
  /** Default false — authorized file roots track live workspaces only. */
  includeArchived?: boolean;
}): Promise<string[]> {
  const entries = await getSessionIndexEntries({
    agentDir: options?.agentDir,
    archived: options?.includeArchived ? undefined : false,
  });
  const roots = new Set<string>();
  for (const entry of entries) {
    if (!entry.cwd) continue;
    for (const key of cwdKeySet(entry.cwd)) roots.add(key);
  }
  return [...roots];
}

export function indexEntryToCandidate(entry: SessionIndexEntry): {
  path: string;
  fileName: string;
  mtimeIso: string;
  mtimeMs: number;
  fileNameStamp: string;
} {
  const fileName = basename(entry.path);
  const fileNameStamp = fileName.split("_")[0] ?? "";
  return {
    path: entry.path,
    fileName,
    mtimeIso: entry.modified || new Date(entry.mtimeMs).toISOString(),
    mtimeMs: entry.mtimeMs,
    fileNameStamp,
  };
}

/** Best-effort cleanup of a leftover temp file path (tests). */
export function cleanupSessionIndexTempFiles(agentDir = defaultAgentDir()): void {
  const indexPath = getSessionIndexPath(agentDir);
  const dir = dirname(indexPath);
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${SESSION_INDEX_FILE_NAME}.tmp.`)) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}
