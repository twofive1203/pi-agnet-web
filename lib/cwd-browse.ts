import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { canonicalizeCwd, expandCwd } from "./cwd";

/** Hard cap so a huge directory cannot flood the picker response. */
const MAX_BROWSE_ENTRIES = 500;

export interface CwdBrowseEntry {
  name: string;
  path: string;
}

export interface CwdBrowseResult {
  /** Canonical directory being listed, or "" when showing roots. */
  path: string;
  /** Parent directory path, or null at a filesystem root / roots view. */
  parent: string | null;
  entries: CwdBrowseEntry[];
  truncated: boolean;
  home: string;
  platform: NodeJS.Platform;
  roots: CwdBrowseEntry[];
}

export interface CwdCreateResult {
  name: string;
  path: string;
}

export class CwdBrowseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CwdBrowseError";
    this.status = status;
  }
}

function isFilesystemRoot(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  return path.dirname(resolved) === resolved;
}

function safeCanonical(dirPath: string): string {
  try {
    return canonicalizeCwd(dirPath);
  } catch {
    return path.resolve(expandCwd(dirPath));
  }
}

function normalizeNewDirectoryName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    throw new CwdBrowseError("Folder name is required", 400);
  }
  if (name.length > 255) {
    throw new CwdBrowseError("Folder name must be 255 characters or fewer", 400);
  }
  if (name === "." || name === ".." || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw new CwdBrowseError("Folder name cannot contain path separators or control characters", 400);
  }
  if (process.platform === "win32") {
    if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
      throw new CwdBrowseError("Folder name contains characters that Windows does not allow", 400);
    }
    const stem = name.split(".", 1)[0]?.toUpperCase() ?? "";
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new CwdBrowseError("Folder name is reserved by Windows", 400);
    }
  }
  return name;
}

/**
 * Create one direct child in a directory currently reachable by the server picker.
 * The name is a single path segment and mkdir remains non-recursive so a typo cannot
 * create an unexpected directory chain.
 */
export function createCwdDirectory(rawParent: unknown, rawName: unknown): CwdCreateResult {
  const parentInput = typeof rawParent === "string" ? rawParent.trim() : "";
  if (!parentInput) {
    throw new CwdBrowseError("Parent directory is required", 400);
  }

  const parent = safeCanonical(expandCwd(parentInput));
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    throw new CwdBrowseError(`Parent directory does not exist: ${parentInput}`, 400);
  }
  if (!parentStat.isDirectory()) {
    throw new CwdBrowseError(`Parent path is not a directory: ${parentInput}`, 400);
  }

  const name = normalizeNewDirectoryName(rawName);
  const target = path.join(parent, name);
  try {
    mkdirSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new CwdBrowseError(`Folder already exists: ${name}`, 409);
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new CwdBrowseError(`Cannot create folder in this location: ${name}`, 403);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CwdBrowseError(`Cannot create folder: ${message}`, 500);
  }

  return { name, path: safeCanonical(target) };
}

/**
 * Top-level shortcuts for the directory picker.
 * Windows includes existing drive letters; POSIX always exposes `/` plus Home.
 */
export function listBrowseRoots(): CwdBrowseEntry[] {
  const home = homedir();
  const roots: CwdBrowseEntry[] = [{ name: "Home", path: safeCanonical(home) }];

  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      try {
        if (existsSync(drive)) {
          roots.push({ name: `${letter}:`, path: safeCanonical(drive) });
        }
      } catch {
        // Skip unreadable drive roots.
      }
    }
    return roots;
  }

  roots.push({ name: "/", path: "/" });
  return roots;
}

/**
 * List child directories for the server-side project path picker.
 * Directories only — never returns file contents. Unreadable children are skipped.
 */
export function browseCwdDirectory(rawPath?: string | null): CwdBrowseResult {
  const home = safeCanonical(homedir());
  const roots = listBrowseRoots();
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";

  if (!trimmed) {
    return {
      path: "",
      parent: null,
      entries: roots,
      truncated: false,
      home,
      platform: process.platform,
      roots,
    };
  }

  const expanded = expandCwd(trimmed);
  const canonical = safeCanonical(expanded);

  let stat;
  try {
    stat = statSync(canonical);
  } catch {
    throw new CwdBrowseError(`Directory does not exist: ${trimmed}`, 400);
  }

  if (!stat.isDirectory()) {
    throw new CwdBrowseError(`Path is not a directory: ${trimmed}`, 400);
  }

  let names: string[];
  try {
    names = readdirSync(canonical);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CwdBrowseError(`Cannot read directory: ${message}`, 403);
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const entries: CwdBrowseEntry[] = [];
  let truncated = false;

  for (const name of names) {
    if (name === "." || name === "..") continue;
    const childPath = path.join(canonical, name);
    try {
      if (!statSync(childPath).isDirectory()) continue;
      entries.push({ name, path: safeCanonical(childPath) });
      if (entries.length >= MAX_BROWSE_ENTRIES) {
        truncated = true;
        break;
      }
    } catch {
      // Skip entries that disappear or are unreadable mid-scan.
    }
  }

  const parent = isFilesystemRoot(canonical) ? null : path.dirname(canonical);

  return {
    path: canonical,
    parent,
    entries,
    truncated,
    home,
    platform: process.platform,
    roots,
  };
}
