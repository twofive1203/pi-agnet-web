/**
 * Chat file-upload storage boundary.
 *
 * Uploads live under getAgentDir()/uploads/<sessionId>/ and must never escape
 * that tree. Display names stay human-readable; storage names are sanitized
 * and containment-checked before any exclusive create.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const MAX_TOTAL_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
export const UPLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const MAX_UPLOAD_FILENAME_CHARS = 180;

const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export class FileUploadError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 413 | 500 = 400,
  ) {
    super(message);
    this.name = "FileUploadError";
  }
}

export interface PreparedUploadTarget {
  /** Human-facing original basename after stripping path segments. */
  displayName: string;
  /** Final absolute path inside the upload session directory. */
  targetPath: string;
  /** Sanitized basename actually written on disk. */
  storageName: string;
  sessionDir: string;
  uploadRoot: string;
  uploadId: string;
}

interface FileRecord {
  filePath: string;
  dirPath: string;
  size: number;
  mtimeMs: number;
}

function getAgentDirLocal(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".pi", "agent");
}

/** Canonical upload root: <agentDir>/uploads. Honors PI_CODING_AGENT_DIR. */
export function getUploadRoot(agentDir = getAgentDirLocal()): string {
  return join(resolve(agentDir), "uploads");
}

export function ensureUploadRoot(uploadRoot = getUploadRoot()): string {
  if (!existsSync(uploadRoot)) {
    mkdirSync(uploadRoot, { recursive: true });
  }
  return uploadRoot;
}

export function generateUploadSessionId(): string {
  return randomUUID().slice(0, 8);
}

/** True when target resolves strictly inside root (or equals root). */
export function isPathInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}

/**
 * Collapse a multipart File.name into a single safe storage basename.
 * Rejects empty results so callers can fall back to a generated name.
 */
export function sanitizeUploadFilename(originalName: string): string {
  const raw = typeof originalName === "string" ? originalName : "";

  // Drop any directory component the client may have smuggled in.
  let name = raw.replace(/\0/g, "");
  name = name.replace(/\\/g, "/");
  name = basename(name);
  // Windows drive / UNC leftovers after basename on POSIX-style paths.
  name = name.replace(/^[a-zA-Z]:/, "");
  name = name.replace(/^[.]+/, "");
  // Control chars + path separators that basename might leave on odd inputs.
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_");
  name = name.replace(/[\\/]/g, "_");
  // Windows trailing dots/spaces are reserved / unstable.
  name = name.replace(/[. ]+$/g, "");
  name = name.trim();

  if (!name || name === "." || name === "..") {
    return "";
  }

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const stemKey = stem.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(stemKey) || WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) {
    name = `file_${name}`;
  }

  if (name.length > MAX_UPLOAD_FILENAME_CHARS) {
    const keptExt = extname(name).slice(0, 32);
    const maxStem = Math.max(1, MAX_UPLOAD_FILENAME_CHARS - keptExt.length);
    name = `${name.slice(0, maxStem)}${keptExt}`;
    name = name.replace(/[. ]+$/g, "");
  }

  if (!name || name === "." || name === "..") {
    return "";
  }

  return name;
}

export function displayNameFromOriginal(originalName: string): string {
  const sanitized = sanitizeUploadFilename(originalName);
  if (sanitized) return sanitized;
  const fallback = basename(String(originalName || "").replace(/\\/g, "/")).trim();
  if (!fallback || fallback === "." || fallback === "..") return "upload.bin";
  return fallback;
}

function fallbackStorageName(originalName: string): string {
  const ext = extname(sanitizeUploadFilename(originalName) || String(originalName || ""));
  const safeExt = /^\.[A-Za-z0-9._-]{1,32}$/.test(ext) ? ext : "";
  return `upload_${randomUUID().slice(0, 8)}${safeExt}`;
}

/**
 * Resolve a unique target path under sessionDir. Throws if the final path would
 * leave the session directory (defense in depth after sanitization).
 */
export function allocateUploadTarget(
  sessionDir: string,
  originalName: string,
  options?: { existsSync?: (path: string) => boolean },
): { displayName: string; storageName: string; targetPath: string } {
  const exists = options?.existsSync ?? existsSync;
  const displayName = displayNameFromOriginal(originalName);
  let storageName = sanitizeUploadFilename(originalName) || fallbackStorageName(originalName);

  const resolvedSession = resolve(sessionDir);
  let targetPath = resolve(resolvedSession, storageName);
  if (!isPathInsideRoot(resolvedSession, targetPath) || targetPath === resolvedSession) {
    storageName = fallbackStorageName(originalName);
    targetPath = resolve(resolvedSession, storageName);
  }
  if (!isPathInsideRoot(resolvedSession, targetPath) || targetPath === resolvedSession) {
    throw new FileUploadError("Resolved upload path escapes upload session directory", 400);
  }

  if (!exists(targetPath)) {
    return { displayName, storageName, targetPath };
  }

  const ext = extname(storageName);
  const stem = ext ? storageName.slice(0, -ext.length) : storageName;
  for (let counter = 1; counter <= 10_000; counter += 1) {
    const candidateName = `${stem}_${counter}${ext}`;
    const candidatePath = resolve(resolvedSession, candidateName);
    if (!isPathInsideRoot(resolvedSession, candidatePath) || candidatePath === resolvedSession) {
      continue;
    }
    if (!exists(candidatePath)) {
      return { displayName, storageName: candidateName, targetPath: candidatePath };
    }
  }

  throw new FileUploadError("Could not allocate a unique upload filename", 409);
}

/** Prepare a fresh upload session directory and a contained target path. */
export function prepareUploadTarget(
  originalName: string,
  options?: {
    uploadRoot?: string;
    uploadId?: string;
    existsSync?: (path: string) => boolean;
  },
): PreparedUploadTarget {
  const uploadRoot = ensureUploadRoot(options?.uploadRoot ?? getUploadRoot());
  const uploadId = options?.uploadId ?? generateUploadSessionId();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uploadId)) {
    throw new FileUploadError("Invalid upload session id", 400);
  }

  const sessionDir = resolve(uploadRoot, uploadId);
  if (!isPathInsideRoot(uploadRoot, sessionDir) || sessionDir === resolve(uploadRoot)) {
    throw new FileUploadError("Invalid upload session directory", 400);
  }
  mkdirSync(sessionDir, { recursive: true });

  const allocated = allocateUploadTarget(sessionDir, originalName, {
    existsSync: options?.existsSync,
  });

  if (!isPathInsideRoot(sessionDir, allocated.targetPath)) {
    throw new FileUploadError("Resolved upload path escapes upload session directory", 400);
  }

  return {
    displayName: allocated.displayName,
    storageName: allocated.storageName,
    targetPath: allocated.targetPath,
    sessionDir,
    uploadRoot: resolve(uploadRoot),
    uploadId,
  };
}

/**
 * Create the target file exclusively and write bytes.
 * Retries with a new counter suffix on EEXIST races.
 */
export function writeUploadFileExclusive(
  sessionDir: string,
  originalName: string,
  buffer: Buffer,
  options?: { maxAttempts?: number },
): { displayName: string; storageName: string; targetPath: string; size: number } {
  const maxAttempts = options?.maxAttempts ?? 16;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const allocated = allocateUploadTarget(sessionDir, originalName);
    try {
      const fd = openSync(allocated.targetPath, "wx");
      try {
        writeSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        closeSync(fd);
      }
      return {
        displayName: allocated.displayName,
        storageName: allocated.storageName,
        targetPath: allocated.targetPath,
        size: buffer.length,
      };
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new FileUploadError("Could not create upload file exclusively", 409);
}

function deleteEmptyDir(dirPath: string): void {
  try {
    const remaining = readdirSync(dirPath);
    if (remaining.length === 0) {
      rmdirSync(dirPath);
    }
  } catch {
    // ignore races
  }
}

/**
 * Lazy cleanup under the upload root only:
 * 1) delete files older than retention
 * 2) if still over total budget, delete oldest files
 *
 * Never follows directory names outside the root; only one session-dir level.
 */
export function lazyCleanupUploads(
  uploadRoot = getUploadRoot(),
  options?: {
    nowMs?: number;
    retentionMs?: number;
    maxTotalBytes?: number;
  },
): void {
  if (!existsSync(uploadRoot)) return;

  const now = options?.nowMs ?? Date.now();
  const retentionMs = options?.retentionMs ?? UPLOAD_RETENTION_MS;
  const maxTotalBytes = options?.maxTotalBytes ?? MAX_TOTAL_UPLOAD_BYTES;
  const resolvedRoot = resolve(uploadRoot);

  const allFiles: FileRecord[] = [];
  let totalSize = 0;

  for (const dirEntry of readdirSync(resolvedRoot)) {
    const dirPath = resolve(resolvedRoot, dirEntry);
    if (!isPathInsideRoot(resolvedRoot, dirPath) || dirPath === resolvedRoot) {
      continue;
    }
    let dirStat;
    try {
      dirStat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    for (const fileEntry of readdirSync(dirPath)) {
      const filePath = resolve(dirPath, fileEntry);
      if (!isPathInsideRoot(dirPath, filePath) || filePath === dirPath) {
        continue;
      }
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        totalSize += stat.size;
        allFiles.push({ filePath, dirPath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // race — file vanished
      }
    }
  }

  let freed = 0;
  const kept: FileRecord[] = [];
  for (const rec of allFiles) {
    if (now - rec.mtimeMs > retentionMs) {
      try {
        unlinkSync(rec.filePath);
        freed += rec.size;
        deleteEmptyDir(rec.dirPath);
      } catch {
        // ignore
      }
    } else {
      kept.push(rec);
    }
  }

  if (totalSize - freed > maxTotalBytes) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let over = totalSize - freed - maxTotalBytes;
    for (const rec of kept) {
      if (over <= 0) break;
      try {
        unlinkSync(rec.filePath);
        over -= rec.size;
        deleteEmptyDir(rec.dirPath);
      } catch {
        // ignore
      }
    }
  }
}

