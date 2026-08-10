import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import path from "path";
import { canonicalizeCwd } from "./cwd";

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piRegisteredAllowedRoots: Set<string> | undefined;
}

function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

function createRootVariants(root: string): string[] {
  const canonical = canonicalizeCwd(root);
  return [...new Set([root, canonical].filter(Boolean))];
}

export function registerAllowedRoot(cwd: string): void {
  if (!globalThis.__piRegisteredAllowedRoots) globalThis.__piRegisteredAllowedRoots = new Set();
  for (const root of createRootVariants(cwd)) {
    try {
      if (statSync(root).isDirectory()) globalThis.__piRegisteredAllowedRoots.add(root);
    } catch {
      // Ignore stale paths. They will not be included in future root sets.
    }
  }
  globalThis.__piAllowedRootsCache = undefined;
}

/**
 * Authorized workspace roots for file/workflow APIs.
 *
 * Prefers the rebuildable session index cwd set (header fingerprint scan) over
 * SessionManager.listAll + per-cwd git metadata. Disk JSONL remains the source
 * of truth via index refresh; registered roots and ~/pi-cwd-* still apply.
 * Authorization semantics are unchanged: a path is allowed iff it sits under
 * one of the discovered roots.
 */
export async function getAllowedRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__piAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const roots = new Set<string>();

  try {
    const { getSessionIndexCwdRoots } = await import("@/lib/session-index");
    const indexRoots = await getSessionIndexCwdRoots({ includeArchived: false });
    for (const cwd of indexRoots) {
      for (const root of createRootVariants(cwd)) roots.add(root);
    }
  } catch {
    // Index acceleration failed — fall back to full active session list.
    try {
      const { listAllSessions } = await import("@/lib/session-reader");
      const sessions = await listAllSessions();
      for (const session of sessions) {
        if (!session.cwd) continue;
        for (const root of createRootVariants(session.cwd)) roots.add(root);
      }
    } catch {
      // Session discovery is best-effort; registered + home roots still apply.
    }
  }

  const home = homedir();
  try {
    for (const name of readdirSync(home)) {
      if (/^pi-cwd-\d{8}$/.test(name)) {
        for (const root of createRootVariants(path.join(home, name))) roots.add(root);
      }
    }
  } catch {
    // Home-directory discovery is best-effort; session roots still work.
  }

  for (const registered of globalThis.__piRegisteredAllowedRoots ?? []) {
    for (const root of createRootVariants(registered)) {
      try {
        if (statSync(root).isDirectory()) roots.add(root);
      } catch {
        // Drop stale registered roots from this cache snapshot.
      }
    }
  }

  globalThis.__piAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isPathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/**
 * Synchronous check against roots registered via registerAllowedRoot only.
 * Useful for smoke tests and hot paths that must not import session-reader.
 */
export function isRegisteredAllowedRoot(target: string): boolean {
  const registered = globalThis.__piRegisteredAllowedRoots;
  if (!registered || registered.size === 0) return false;
  const roots = new Set<string>();
  for (const root of registered) {
    for (const variant of createRootVariants(root)) roots.add(variant);
  }
  return isPathAllowed(canonicalizeCwd(target), roots);
}
