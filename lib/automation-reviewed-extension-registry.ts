/**
 * Trusted, versioned, non-self-declared reviewed extension registry.
 *
 * Catalog discovery and factory evaluation may execute only for digests that
 * appear here. Extensions cannot self-declare as reviewed via their own
 * package.json or source. Unknown/corrupt registry files fail closed.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAutomationRoot, getAgentDirLocal } from "./automation-paths";

/** Bump only with an intentional trust-source schema migration. */
export const AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION = 1 as const;

export const AUTOMATION_REVIEWED_EXTENSION_REGISTRY_FILENAME =
  "reviewed-extension-registry.v1.json" as const;

export type ReviewedExtensionRegistryEntry = {
  /** Exact package/source closure digest (sha256 hex). Primary trust key. */
  closureDigest: string;
  /** Optional exact verified bundle digest (sha256 hex). When set, must match. */
  bundleSha256?: string;
  /** Operator/product label for diagnostics (never used as trust). */
  label: string;
  /** ISO timestamp when the entry was reviewed. */
  reviewedAt: string;
  /** Registry schema version at review time. */
  registryVersion: typeof AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION;
};

export type ReviewedExtensionRegistryFile = {
  schemaVersion: typeof AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION;
  /**
   * Explicit trust provenance. Must be one of the known non-self sources.
   * Extensions/package manifests must never write this file.
   */
  trustSource: "builtin" | "operator_curated";
  updatedAt: string;
  /** Keyed by lowercase closureDigest. */
  entries: Record<string, ReviewedExtensionRegistryEntry>;
};

/**
 * Built-in product trust source. Empty in v1 — first-party web tools use the
 * separate web registry. Extensions are only trusted via operator-curated
 * versioned registry files or future explicit product reviews landed here.
 */
export const AUTOMATION_BUILTIN_REVIEWED_EXTENSION_REGISTRY: Readonly<ReviewedExtensionRegistryFile> =
  Object.freeze({
    schemaVersion: AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION,
    trustSource: "builtin",
    updatedAt: "1970-01-01T00:00:00.000Z",
    entries: Object.freeze({}) as Record<string, ReviewedExtensionRegistryEntry>,
  });

export function getReviewedExtensionRegistryPath(agentDir = getAgentDirLocal()): string {
  return join(getAutomationRoot(agentDir), AUTOMATION_REVIEWED_EXTENSION_REGISTRY_FILENAME);
}

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function normalizeEntry(
  raw: unknown,
  key: string,
): ReviewedExtensionRegistryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<ReviewedExtensionRegistryEntry>;
  if (!isHexSha256(e.closureDigest)) return null;
  if (e.closureDigest.toLowerCase() !== key.toLowerCase()) return null;
  if (e.bundleSha256 != null && !isHexSha256(e.bundleSha256)) return null;
  if (typeof e.label !== "string" || !e.label.trim()) return null;
  if (typeof e.reviewedAt !== "string" || !e.reviewedAt.trim()) return null;
  if (e.registryVersion !== AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION) return null;
  return {
    closureDigest: e.closureDigest.toLowerCase(),
    bundleSha256: e.bundleSha256?.toLowerCase(),
    label: e.label.trim().slice(0, 200),
    reviewedAt: e.reviewedAt,
    registryVersion: AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION,
  };
}

/**
 * Load the effective reviewed registry (builtin ∪ operator-curated).
 * Fail closed: corrupt/version-mismatched operator files contribute zero entries
 * and never widen trust. Builtin entries always apply.
 */
export function loadReviewedExtensionRegistry(agentDir?: string): ReviewedExtensionRegistryFile {
  const builtin = AUTOMATION_BUILTIN_REVIEWED_EXTENSION_REGISTRY;
  const path = getReviewedExtensionRegistryPath(agentDir);
  if (!existsSync(path)) {
    return {
      schemaVersion: builtin.schemaVersion,
      trustSource: "builtin",
      updatedAt: builtin.updatedAt,
      entries: { ...builtin.entries },
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReviewedExtensionRegistryFile>;
    if (parsed.schemaVersion !== AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION) {
      // Fail closed: ignore entire operator file on version mismatch.
      return {
        schemaVersion: builtin.schemaVersion,
        trustSource: "builtin",
        updatedAt: builtin.updatedAt,
        entries: { ...builtin.entries },
      };
    }
    if (parsed.trustSource !== "operator_curated" && parsed.trustSource !== "builtin") {
      return {
        schemaVersion: builtin.schemaVersion,
        trustSource: "builtin",
        updatedAt: builtin.updatedAt,
        entries: { ...builtin.entries },
      };
    }
    const entries: Record<string, ReviewedExtensionRegistryEntry> = {
      ...builtin.entries,
    };
    const rawEntries = parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
    for (const [key, value] of Object.entries(rawEntries)) {
      const normalized = normalizeEntry(value, key);
      if (normalized) {
        entries[normalized.closureDigest] = normalized;
      }
      // Invalid entries are skipped (fail closed for that digest only).
    }
    return {
      schemaVersion: AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION,
      trustSource: parsed.trustSource === "operator_curated" ? "operator_curated" : "builtin",
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt
          ? parsed.updatedAt
          : new Date().toISOString(),
      entries,
    };
  } catch {
    // Corrupt file → builtin only.
    return {
      schemaVersion: builtin.schemaVersion,
      trustSource: "builtin",
      updatedAt: builtin.updatedAt,
      entries: { ...builtin.entries },
    };
  }
}

export function getReviewedExtensionEntry(
  closureDigest: string,
  agentDir?: string,
): ReviewedExtensionRegistryEntry | null {
  if (!isHexSha256(closureDigest)) return null;
  const reg = loadReviewedExtensionRegistry(agentDir);
  return reg.entries[closureDigest.toLowerCase()] ?? null;
}

export function isReviewedExtensionDigest(closureDigest: string, agentDir?: string): boolean {
  return getReviewedExtensionEntry(closureDigest, agentDir) != null;
}

/**
 * Operator/test helper: atomically write a curated registry file.
 * Never called from extension code paths. Tests and explicit ops only.
 */
export function writeOperatorReviewedExtensionRegistry(
  entries: ReviewedExtensionRegistryEntry[],
  agentDir?: string,
): string {
  const path = getReviewedExtensionRegistryPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const map: Record<string, ReviewedExtensionRegistryEntry> = {};
  for (const e of entries) {
    if (!isHexSha256(e.closureDigest)) {
      throw new Error(`invalid closureDigest: ${String(e.closureDigest).slice(0, 20)}`);
    }
    if (e.registryVersion !== AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION) {
      throw new Error("registryVersion mismatch");
    }
    if (e.bundleSha256 != null && !isHexSha256(e.bundleSha256)) {
      throw new Error(`invalid bundleSha256 for ${e.closureDigest.slice(0, 12)}`);
    }
    const dig = e.closureDigest.toLowerCase();
    map[dig] = {
      closureDigest: dig,
      bundleSha256: e.bundleSha256?.toLowerCase(),
      label: e.label.trim().slice(0, 200) || dig.slice(0, 12),
      reviewedAt: e.reviewedAt || new Date().toISOString(),
      registryVersion: AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION,
    };
  }
  const body: ReviewedExtensionRegistryFile = {
    schemaVersion: AUTOMATION_REVIEWED_EXTENSION_REGISTRY_VERSION,
    trustSource: "operator_curated",
    updatedAt: new Date().toISOString(),
    entries: map,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}

/**
 * Assert live digests still match a reviewed registry entry before any factory work.
 * Throws on missing entry or digest drift (fail closed, before import/factory).
 */
export function assertReviewedExtensionDigestsMatch(input: {
  liveClosureDigest: string;
  liveBundleSha256?: string;
  agentDir?: string;
}): ReviewedExtensionRegistryEntry {
  const entry = getReviewedExtensionEntry(input.liveClosureDigest, input.agentDir);
  if (!entry) {
    throw new Error(
      `extension closure digest not in trusted reviewed registry: ${input.liveClosureDigest.slice(0, 12)}`,
    );
  }
  if (entry.closureDigest !== input.liveClosureDigest.toLowerCase()) {
    throw new Error(
      `reviewed extension closure digest drift before factory: registry=${entry.closureDigest.slice(0, 12)} live=${input.liveClosureDigest.slice(0, 12)}`,
    );
  }
  if (
    entry.bundleSha256 &&
    input.liveBundleSha256 &&
    entry.bundleSha256 !== input.liveBundleSha256.toLowerCase()
  ) {
    throw new Error(
      `reviewed extension bundle digest drift before factory: registry=${entry.bundleSha256.slice(0, 12)} live=${input.liveBundleSha256.slice(0, 12)}`,
    );
  }
  return entry;
}
