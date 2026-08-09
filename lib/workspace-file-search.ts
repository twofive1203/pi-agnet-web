import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store",
]);

const IGNORED_SUFFIXES = [".pyc"];

export const WORKSPACE_FILE_SEARCH_MAX_RESULTS = 24;
export const WORKSPACE_FILE_SEARCH_MAX_ENTRIES = 25_000;
export const WORKSPACE_FILE_SEARCH_DEADLINE_MS = 1_500;

export interface WorkspaceFileSearchMatch {
  name: string;
  fullPath: string;
  relativePath: string;
}

export interface WorkspaceFileSearchResult {
  files: WorkspaceFileSearchMatch[];
  total: number;
  truncated: boolean;
  scannedEntries: number;
}

interface SearchOptions {
  maxResults?: number;
  maxEntries?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error("Workspace file search aborted");
  error.name = "AbortError";
  return error;
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Breadth-first, bounded workspace filename search. Async directory reads avoid
 * monopolizing the Next.js event loop, while entry/time budgets keep large or
 * low-match repositories from turning an autocomplete request into a full scan.
 */
export async function searchWorkspaceFiles(
  cwd: string,
  query: string,
  options: SearchOptions = {},
): Promise<WorkspaceFileSearchResult> {
  const maxResults = Math.max(1, Math.floor(options.maxResults ?? WORKSPACE_FILE_SEARCH_MAX_RESULTS));
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? WORKSPACE_FILE_SEARCH_MAX_ENTRIES));
  const deadlineMs = Math.max(1, Math.floor(options.deadlineMs ?? WORKSPACE_FILE_SEARCH_DEADLINE_MS));
  const lowerQuery = query.trim().toLowerCase();
  const startedAt = Date.now();
  const directories = [cwd];
  const files: WorkspaceFileSearchMatch[] = [];
  let scannedEntries = 0;
  let truncated = false;

  while (directories.length > 0 && files.length < maxResults) {
    checkAborted(options.signal);
    if (scannedEntries >= maxEntries || Date.now() - startedAt >= deadlineMs) {
      truncated = true;
      break;
    }

    const directory = directories.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    checkAborted(options.signal);

    entries.sort((left, right) => {
      if (left.isFile() !== right.isFile()) return left.isFile() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

    for (const entry of entries) {
      checkAborted(options.signal);
      if (scannedEntries >= maxEntries || Date.now() - startedAt >= deadlineMs) {
        truncated = true;
        break;
      }
      scannedEntries += 1;
      if (IGNORED_NAMES.has(entry.name) || IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && (!lowerQuery || entry.name.toLowerCase().includes(lowerQuery))) {
        files.push({
          name: entry.name,
          fullPath,
          relativePath: path.relative(cwd, fullPath),
        });
        if (files.length >= maxResults) {
          truncated = true;
          break;
        }
      } else if (entry.isDirectory()) {
        directories.push(fullPath);
      }
    }
  }

  if (directories.length > 0) truncated = true;
  return { files, total: files.length, truncated, scannedEntries };
}
