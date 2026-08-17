/**
 * Bounded, path-free project catalog for desktop quick sessions.
 *
 * Server-only: the public payload never includes cwd, firstMessage, latest
 * session ids, branch text, or Git paths. Submit-time resolution rebuilds the
 * catalog and requires a unique, still-existing canonical cwd.
 */

import { existingCanonicalCwd } from "./cwd";
import {
  buildProjectDisplayNameFromCwd,
  buildProjectKeyFromCwd,
} from "./task-observer-agent";

export const DESKTOP_PROJECT_CATALOG_LIMIT = 100;
export const DESKTOP_PROJECT_CATALOG_MAX_ENCODED_BYTES = 64 * 1024;

export const DESKTOP_PROJECT_RESOLVE_CODES = [
  "project_unknown",
  "project_unavailable",
  "project_collision",
  "project_out_of_catalog",
] as const;

export type DesktopProjectResolveCode = (typeof DESKTOP_PROJECT_RESOLVE_CODES)[number];

export type DesktopProjectCatalogItem = {
  projectRef: string;
  displayName: string;
  /** Present only when another visible item shares displayName. Never a path. */
  disambiguator?: string;
  latestModified: string;
  archived: boolean;
  worktree: boolean;
};

export type DesktopProjectCatalogDiagnostic = {
  code: "project_ref_collision" | "catalog_truncated";
};

export type DesktopProjectCatalog = {
  projects: DesktopProjectCatalogItem[];
  truncated: boolean;
  omitted: number;
  diagnostics: DesktopProjectCatalogDiagnostic[];
};

export type DesktopProjectResolveResult =
  | { ok: true; cwd: string; projectRef: string }
  | { ok: false; code: DesktopProjectResolveCode };

type CatalogSourceRow = {
  cwd: string;
  latestModifiedMs: number;
  archivedOnly: boolean;
  worktree: boolean;
};

export type DesktopProjectCatalogDeps = {
  listActiveSummaries?: () => Promise<
    Array<{
      cwd: string;
      latestModified?: string;
      worktree?: { isWorktree?: boolean } | null;
    }>
  >;
  listArchivedIndexEntries?: () => Promise<
    Array<{
      cwd: string;
      mtimeMs?: number;
      modified?: string;
    }>
  >;
  scanArchivedCwds?: () => Promise<{ cwds: string[]; counts: Record<string, number> }>;
  canonicalizeCwd?: (cwd: string) => string;
  directoryExists?: (cwd: string) => boolean;
  buildProjectKey?: (cwd: string) => string;
  maxItems?: number;
};

type InternalCatalog = {
  public: DesktopProjectCatalog;
  /** Unique resolvable refs whose directory still exists. */
  cwdByRef: Map<string, string>;
  collisionRefs: Set<string>;
  truncatedRefs: Set<string>;
  /** Unique refs present in source facts whose directory is gone. */
  unavailableRefs: Set<string>;
};

const FORBIDDEN_PUBLIC_KEYS = [
  "cwd",
  "path",
  "firstMessage",
  "latestSession",
  "prompt",
  "token",
  "accessKey",
  "branch",
  "repoRoot",
  "mainWorktreePath",
] as const;

function toModifiedMs(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function defaultCanonicalize(cwd: string): string {
  return existingCanonicalCwd(cwd) ?? cwd.trim();
}

function defaultDirectoryExists(cwd: string): boolean {
  return existingCanonicalCwd(cwd) != null;
}

async function defaultActiveSummaries() {
  const { listProjectSummaries } = await import("./session-reader");
  return listProjectSummaries();
}

async function defaultArchivedIndexEntries() {
  const { getSessionIndexEntries } = await import("./session-index");
  return getSessionIndexEntries({ archived: true });
}

async function defaultScanArchivedCwds() {
  const { scanArchivedCwds } = await import("./session-reader");
  return scanArchivedCwds();
}

function collectRows(input: {
  active: Array<{ cwd: string; latestModified?: string; worktree?: { isWorktree?: boolean } | null }>;
  archived: Array<{ cwd: string; mtimeMs?: number; modified?: string }>;
  archivedFallback: string[];
  canonicalizeCwd: (cwd: string) => string;
  directoryExists: (cwd: string) => boolean;
}): CatalogSourceRow[] {
  const byCanonical = new Map<string, CatalogSourceRow>();

  const upsert = (rawCwd: string, latestModifiedMs: number, archivedOnly: boolean, worktree: boolean) => {
    const trimmed = rawCwd.trim();
    if (!trimmed) return;
    const canonical = input.canonicalizeCwd(trimmed);
    if (!canonical) return;
    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, {
        cwd: canonical,
        latestModifiedMs,
        archivedOnly,
        worktree,
      });
      return;
    }
    existing.latestModifiedMs = Math.max(existing.latestModifiedMs, latestModifiedMs);
    if (!archivedOnly) existing.archivedOnly = false;
    if (worktree) existing.worktree = true;
  };

  for (const summary of input.active) {
    upsert(
      summary.cwd,
      toModifiedMs(summary.latestModified, 0),
      false,
      summary.worktree?.isWorktree === true,
    );
  }

  for (const entry of input.archived) {
    upsert(entry.cwd, toModifiedMs(entry.mtimeMs ?? entry.modified, 0), true, false);
  }

  for (const cwd of input.archivedFallback) {
    upsert(cwd, 0, true, false);
  }

  return [...byCanonical.values()];
}

function shortRefLabel(projectRef: string): string {
  const digest = projectRef.startsWith("p_") ? projectRef.slice(2) : projectRef;
  return digest.slice(-6);
}

function buildInternalCatalog(
  rows: CatalogSourceRow[],
  deps: {
    buildProjectKey: (cwd: string) => string;
    directoryExists: (cwd: string) => boolean;
    maxItems: number;
  },
): InternalCatalog {
  const byRef = new Map<string, CatalogSourceRow[]>();
  for (const row of rows) {
    const projectRef = deps.buildProjectKey(row.cwd);
    const bucket = byRef.get(projectRef) ?? [];
    bucket.push(row);
    byRef.set(projectRef, bucket);
  }

  const diagnostics: DesktopProjectCatalogDiagnostic[] = [];
  const collisionRefs = new Set<string>();
  const unavailableRefs = new Set<string>();
  const unique: Array<CatalogSourceRow & { projectRef: string }> = [];

  for (const [projectRef, bucket] of byRef) {
    const distinctCwds = [...new Set(bucket.map((item) => item.cwd))];
    if (distinctCwds.length !== 1) {
      collisionRefs.add(projectRef);
      continue;
    }
    const merged = bucket.reduce((acc, item) => ({
      cwd: item.cwd,
      latestModifiedMs: Math.max(acc.latestModifiedMs, item.latestModifiedMs),
      archivedOnly: acc.archivedOnly && item.archivedOnly,
      worktree: acc.worktree || item.worktree,
      projectRef,
    }));
    if (!deps.directoryExists(merged.cwd)) {
      unavailableRefs.add(projectRef);
      continue;
    }
    unique.push({ ...merged, projectRef });
  }

  if (collisionRefs.size > 0) {
    diagnostics.push({ code: "project_ref_collision" });
  }

  unique.sort((a, b) => {
    if (b.latestModifiedMs !== a.latestModifiedMs) return b.latestModifiedMs - a.latestModifiedMs;
    return a.projectRef.localeCompare(b.projectRef);
  });

  const kept = unique.slice(0, deps.maxItems);
  const truncatedRows = unique.slice(deps.maxItems);
  const truncatedRefs = new Set(truncatedRows.map((row) => row.projectRef));
  const truncated = truncatedRows.length > 0;
  if (truncated) diagnostics.push({ code: "catalog_truncated" });

  const nameCounts = new Map<string, number>();
  for (const row of kept) {
    const name = buildProjectDisplayNameFromCwd(row.cwd);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const projects: DesktopProjectCatalogItem[] = kept.map((row) => {
    const displayName = buildProjectDisplayNameFromCwd(row.cwd);
    const item: DesktopProjectCatalogItem = {
      projectRef: row.projectRef,
      displayName,
      latestModified: toIso(row.latestModifiedMs),
      archived: row.archivedOnly,
      worktree: row.worktree,
    };
    if ((nameCounts.get(displayName) ?? 0) > 1) {
      item.disambiguator = shortRefLabel(row.projectRef);
    }
    return item;
  });

  const cwdByRef = new Map(kept.map((row) => [row.projectRef, row.cwd]));
  const catalog: DesktopProjectCatalog = {
    projects,
    truncated,
    omitted: truncatedRows.length,
    diagnostics,
  };
  assertDesktopProjectCatalogSafe(catalog);

  return { public: catalog, cwdByRef, collisionRefs, truncatedRefs, unavailableRefs };
}

async function loadInternalCatalog(deps: DesktopProjectCatalogDeps = {}): Promise<InternalCatalog> {
  const canonicalize = deps.canonicalizeCwd ?? defaultCanonicalize;
  const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
  const buildProjectKey = deps.buildProjectKey ?? buildProjectKeyFromCwd;
  const maxItems = deps.maxItems ?? DESKTOP_PROJECT_CATALOG_LIMIT;

  const active = await (deps.listActiveSummaries ?? defaultActiveSummaries)();

  let archived: Array<{ cwd: string; mtimeMs?: number; modified?: string }> = [];
  let archivedFallback: string[] = [];
  if (deps.listArchivedIndexEntries) {
    archived = await deps.listArchivedIndexEntries();
  } else {
    try {
      archived = await defaultArchivedIndexEntries();
    } catch {
      const fallback = await (deps.scanArchivedCwds ?? defaultScanArchivedCwds)();
      archivedFallback = fallback.cwds;
    }
  }
  const rows = collectRows({
    active,
    archived,
    archivedFallback,
    canonicalizeCwd: canonicalize,
    directoryExists,
  });

  return buildInternalCatalog(rows, { buildProjectKey, directoryExists, maxItems });
}

export async function buildDesktopProjectCatalog(
  deps: DesktopProjectCatalogDeps = {},
): Promise<DesktopProjectCatalog> {
  const catalog = await loadInternalCatalog(deps);
  return catalog.public;
}

export async function resolveDesktopProjectRef(
  projectRef: unknown,
  deps: DesktopProjectCatalogDeps = {},
): Promise<DesktopProjectResolveResult> {
  if (typeof projectRef !== "string" || !projectRef.trim()) {
    return { ok: false, code: "project_unknown" };
  }
  const ref = projectRef.trim();
  if (!/^p_[a-f0-9]{16}$/.test(ref)) {
    return { ok: false, code: "project_unknown" };
  }

  const catalog = await loadInternalCatalog(deps);
  if (catalog.collisionRefs.has(ref)) {
    return { ok: false, code: "project_collision" };
  }
  if (catalog.unavailableRefs.has(ref)) {
    return { ok: false, code: "project_unavailable" };
  }
  if (catalog.truncatedRefs.has(ref)) {
    return { ok: false, code: "project_out_of_catalog" };
  }
  const cwd = catalog.cwdByRef.get(ref);
  if (!cwd) return { ok: false, code: "project_unknown" };

  const directoryExists = deps.directoryExists ?? defaultDirectoryExists;
  if (!directoryExists(cwd)) {
    return { ok: false, code: "project_unavailable" };
  }
  return { ok: true, cwd, projectRef: ref };
}

export function assertDesktopProjectCatalogSafe(value: unknown): void {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN_PUBLIC_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(json)) {
      throw new Error(`desktop project catalog leaked key: ${key}`);
    }
  }
  if (json.includes("firstMessage") || json.includes("latestSession")) {
    throw new Error("desktop project catalog leaked session content");
  }
  if (json.length > DESKTOP_PROJECT_CATALOG_MAX_ENCODED_BYTES) {
    throw new Error("desktop project catalog exceeds encoded budget");
  }
}
