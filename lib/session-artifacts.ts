import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "fs";
import { dirname, extname, join, relative } from "path";

export interface SessionUsageFile {
  path: string;
  kind: "main" | "subagent";
}

function replaceSessionRootSegment(filePath: string, from: "sessions" | "sessions-archive", to: "sessions" | "sessions-archive"): string {
  const pattern = new RegExp(`([\\\\/])${from.replace("-", "\\-")}([\\\\/])`);
  if (!pattern.test(filePath)) {
    throw new Error(`Session path is not under ${from}: ${filePath}`);
  }
  return filePath.replace(pattern, `$1${to}$2`);
}

/** Return the directory used by pi-subagents for artifacts owned by a parent session. */
export function getSessionCompanionDir(sessionPath: string): string {
  const extension = extname(sessionPath);
  return extension.toLowerCase() === ".jsonl"
    ? sessionPath.slice(0, -extension.length)
    : `${sessionPath}.artifacts`;
}

function collectNestedSessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name === "session.jsonl") {
        files.push(entryPath);
      }
    }
  }
  return files;
}

/**
 * List usage-bearing files owned by a top-level session.
 * Archived sessions also check the active companion path for legacy archives
 * created before companion directories moved with their parent JSONL.
 */
export function listSessionUsageFiles(sessionPath: string): SessionUsageFile[] {
  const files: SessionUsageFile[] = [{ path: sessionPath, kind: "main" }];
  const companionDirs = [getSessionCompanionDir(sessionPath)];

  if (/[\\/]sessions-archive[\\/]/.test(sessionPath)) {
    try {
      companionDirs.push(getSessionCompanionDir(replaceSessionRootSegment(sessionPath, "sessions-archive", "sessions")));
    } catch {
      // The primary archived companion remains sufficient for custom layouts.
    }
  }

  const seen = new Set<string>();
  for (const companionDir of companionDirs) {
    for (const nestedPath of collectNestedSessionFiles(companionDir)) {
      // Primary and legacy archive locations can both exist after interrupted
      // manual migrations. Relative artifact identity prevents double billing.
      const key = relative(companionDir, nestedPath).replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ path: nestedPath, kind: "subagent" });
    }
  }
  return files;
}

function moveSessionArtifacts(sourcePath: string, targetPath: string): string {
  mkdirSync(dirname(targetPath), { recursive: true });
  const sourceCompanion = getSessionCompanionDir(sourcePath);
  const targetCompanion = getSessionCompanionDir(targetPath);
  let movedCompanion = false;

  if (existsSync(sourceCompanion) && sourceCompanion !== targetCompanion) {
    if (existsSync(targetCompanion)) {
      throw new Error(`Session companion target already exists: ${targetCompanion}`);
    }
    renameSync(sourceCompanion, targetCompanion);
    movedCompanion = true;
  }

  try {
    renameSync(sourcePath, targetPath);
  } catch (error) {
    if (movedCompanion) {
      try { renameSync(targetCompanion, sourceCompanion); } catch { /* preserve original error */ }
    }
    throw error;
  }
  return targetPath;
}

export function archiveSessionArtifacts(sessionPath: string): string {
  return moveSessionArtifacts(
    sessionPath,
    replaceSessionRootSegment(sessionPath, "sessions", "sessions-archive"),
  );
}

export function unarchiveSessionArtifacts(archivePath: string): string {
  const targetPath = replaceSessionRootSegment(archivePath, "sessions-archive", "sessions");
  const archivedCompanion = getSessionCompanionDir(archivePath);
  const activeCompanion = getSessionCompanionDir(targetPath);

  // Legacy archives left the companion directory in active sessions. In that
  // layout only the parent JSONL needs to move back.
  if (!existsSync(archivedCompanion) && existsSync(activeCompanion)) {
    mkdirSync(dirname(targetPath), { recursive: true });
    renameSync(archivePath, targetPath);
    return targetPath;
  }
  return moveSessionArtifacts(archivePath, targetPath);
}

/** Delete a parent session and its path-derived companion directory. */
export function deleteSessionArtifacts(sessionPath: string): void {
  try {
    unlinkSync(sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  rmSync(getSessionCompanionDir(sessionPath), { recursive: true, force: true });

  if (/[\\/]sessions-archive[\\/]/.test(sessionPath)) {
    try {
      const legacyActivePath = replaceSessionRootSegment(sessionPath, "sessions-archive", "sessions");
      rmSync(getSessionCompanionDir(legacyActivePath), { recursive: true, force: true });
    } catch {
      // Custom archive layouts have no path-derived active fallback to remove.
    }
  }
}
