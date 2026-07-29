/**
 * Retention scanner for Automation transcripts/metadata.
 * Scan outside lock; claim deletions inside lock.
 * Preserve active/unsealed/promotion/export in-flight sources.
 * Defaults: 90-day artifacts/transcripts/changes, 365-day terminal metadata/audit.
 *
 * After writing an integrity/tombstone projection at 365d, DELETE the full
 * authoritative runs/<id>.json (do not rewrite/mutate it). APIs list tombstone only.
 *
 * Export-in-flight protection uses owner+exportId cross-process lease files with
 * ref-counts so retention cannot purge while ANY active lease exists. Only the
 * owning exporter may remove its own lease entry.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "fs";
import { join } from "path";
import { hostname } from "os";
import { randomBytes } from "crypto";
import {
  AUTOMATION_METADATA_RETENTION_MS,
  AUTOMATION_TRANSCRIPT_RETENTION_MS,
} from "./automation-types";
import {
  getAutomationAuditDir,
  getAutomationClaimPath,
  getAutomationRetentionDir,
  getAutomationRoot,
  getAutomationRunPath,
  getAutomationRunsDir,
  getAutomationSessionsRoot,
} from "./automation-paths";
import {
  listRunRecords,
  readPromotionRecord,
  readRunRecord,
  readRunRetentionProjection,
  withAutomationStoreLock,
  removePathBestEffort,
  writeRunRetentionProjection,
  terminalRunSnapshotExists,
} from "./automation-store";

export type RetentionReport = {
  scannedRuns: number;
  deletedTranscripts: number;
  deletedChanges: number;
  deletedClaims: number;
  deletedMetadata: number;
  tombstonesWritten: number;
  skipped: number;
  errors: string[];
  /** Confirms runs/<id>.json was never rewritten by retention (deleted only after tombstone). */
  terminalSnapshotsPreserved: number;
};

const EXPORT_LEASE_TTL_MS = 30 * 60_000;

export type ExportLeaseEntry = {
  exportId: string;
  ownerId: string;
  ownerPid: number;
  hostname: string;
  acquiredAt: string;
  expiresAt: string;
};

export type ExportLeaseFile = {
  runId: string;
  leases: ExportLeaseEntry[];
};

function exportLeasesDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "export-leases");
}

function exportLeasePath(runId: string, agentDir?: string): string {
  return join(exportLeasesDir(agentDir), `${runId}.json`);
}

function readExportLeaseFile(runId: string, agentDir?: string): ExportLeaseFile | null {
  const path = exportLeasePath(runId, agentDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ExportLeaseFile> & {
      // Legacy single-lease shape
      ownerPid?: number;
      hostname?: string;
      acquiredAt?: string;
      expiresAt?: string;
      exportId?: string;
      ownerId?: string;
    };
    if (Array.isArray(raw.leases)) {
      return { runId, leases: raw.leases as ExportLeaseEntry[] };
    }
    // Migrate legacy single-owner file into multi-lease shape.
    if (raw.expiresAt || raw.ownerPid) {
      return {
        runId,
        leases: [
          {
            exportId: raw.exportId ?? "legacy",
            ownerId: raw.ownerId ?? `legacy-pid-${raw.ownerPid ?? 0}`,
            ownerPid: raw.ownerPid ?? 0,
            hostname: raw.hostname ?? hostname(),
            acquiredAt: raw.acquiredAt ?? new Date().toISOString(),
            expiresAt: raw.expiresAt ?? new Date(Date.now() + EXPORT_LEASE_TTL_MS).toISOString(),
          },
        ],
      };
    }
    return { runId, leases: [] };
  } catch {
    // Fail closed: treat corrupt as a single permanent lease.
    return {
      runId,
      leases: [
        {
          exportId: "corrupt",
          ownerId: "corrupt",
          ownerPid: 0,
          hostname: hostname(),
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + EXPORT_LEASE_TTL_MS).toISOString(),
        },
      ],
    };
  }
}

function writeExportLeaseFileAtomic(file: ExportLeaseFile, agentDir?: string): void {
  mkdirSync(exportLeasesDir(agentDir), { recursive: true });
  const path = exportLeasePath(file.runId, agentDir);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows replace fallback
    try {
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmp, path);
    } catch {
      try {
        writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
        unlinkSync(tmp);
      } catch {
        // ignore
      }
    }
  }
}

function pruneExpiredLeases(file: ExportLeaseFile, now: number): ExportLeaseFile {
  return {
    ...file,
    leases: file.leases.filter((l) => {
      const exp = Date.parse(l.expiresAt);
      if (!Number.isFinite(exp)) return true; // fail closed
      return exp >= now;
    }),
  };
}

/**
 * Cross-process export lease under store.lock.
 * Multiple concurrent exporters each hold ownerId+exportId entries (ref-count).
 * Retention MUST honor these files so another process cannot purge mid-export.
 * Returns the exportId the caller must later release.
 */
export async function acquireExportLease(
  runId: string,
  agentDir?: string,
  options?: { ownerId?: string; exportId?: string },
): Promise<{ exportId: string; ownerId: string }> {
  const ownerId = options?.ownerId ?? `pid-${process.pid}-${hostname()}`;
  const exportId = options?.exportId ?? `exp-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  await withAutomationStoreLock(async () => {
    const now = Date.now();
    const existing = readExportLeaseFile(runId, agentDir) ?? { runId, leases: [] };
    const pruned = pruneExpiredLeases(existing, now);
    pruned.leases.push({
      exportId,
      ownerId,
      ownerPid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + EXPORT_LEASE_TTL_MS).toISOString(),
    });
    writeExportLeaseFileAtomic(pruned, agentDir);
  }, { agentDir });
  return { exportId, ownerId };
}

/**
 * Release ONLY the caller's own lease entry. Never removes another owner's lease.
 */
export async function releaseExportLease(
  runId: string,
  agentDir?: string,
  options?: { ownerId?: string; exportId?: string },
): Promise<void> {
  await withAutomationStoreLock(async () => {
    const existing = readExportLeaseFile(runId, agentDir);
    if (!existing) return;
    const now = Date.now();
    const pruned = pruneExpiredLeases(existing, now);
    const next: ExportLeaseFile = {
      runId,
      leases: pruned.leases.filter((l) => {
        if (options?.exportId && options?.ownerId) {
          // Only the matching owner+exportId may be removed.
          return !(l.exportId === options.exportId && l.ownerId === options.ownerId);
        }
        if (options?.exportId) {
          // exportId alone is insufficient without owner — refuse to remove others' leases.
          // Only remove if this process owns it.
          return !(l.exportId === options.exportId && l.ownerPid === process.pid);
        }
        // Legacy: release only leases owned by this pid.
        return l.ownerPid !== process.pid;
      }),
    };
    if (!next.leases.length) {
      const path = exportLeasePath(runId, agentDir);
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
      }
      return;
    }
    writeExportLeaseFileAtomic(next, agentDir);
  }, { agentDir });
}

/** Sync check usable inside an already-held store lock. */
export function isExportLeaseActive(runId: string, agentDir?: string, now = Date.now()): boolean {
  const file = readExportLeaseFile(runId, agentDir);
  if (!file) return false;
  const pruned = pruneExpiredLeases(file, now);
  if (pruned.leases.length !== file.leases.length) {
    // Best-effort rewrite of pruned set.
    try {
      if (!pruned.leases.length) {
        const path = exportLeasePath(runId, agentDir);
        if (existsSync(path)) unlinkSync(path);
      } else {
        writeExportLeaseFileAtomic(pruned, agentDir);
      }
    } catch {
      // ignore
    }
  }
  return pruned.leases.length > 0;
}

/** Count active leases (ref-count) for tests/diagnostics. */
export function countExportLeases(runId: string, agentDir?: string, now = Date.now()): number {
  const file = readExportLeaseFile(runId, agentDir);
  if (!file) return 0;
  return pruneExpiredLeases(file, now).leases.length;
}

// Back-compat aliases used by existing callers/tests.
export function markExportInFlight(runId: string, agentDir?: string): void {
  try {
    const now = Date.now();
    const existing = readExportLeaseFile(runId, agentDir) ?? { runId, leases: [] };
    const pruned = pruneExpiredLeases(existing, now);
    pruned.leases.push({
      exportId: `sync-${process.pid}-${now}`,
      ownerId: `pid-${process.pid}`,
      ownerPid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + EXPORT_LEASE_TTL_MS).toISOString(),
    });
    writeExportLeaseFileAtomic(pruned, agentDir);
  } catch {
    // ignore
  }
}

export function clearExportInFlight(runId: string, agentDir?: string): void {
  try {
    const existing = readExportLeaseFile(runId, agentDir);
    if (!existing) return;
    const next = {
      runId,
      leases: existing.leases.filter((l) => l.ownerPid !== process.pid),
    };
    if (!next.leases.length) {
      const path = exportLeasePath(runId, agentDir);
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    writeExportLeaseFileAtomic(next, agentDir);
  } catch {
    // ignore
  }
}

export function isExportInFlight(runId: string, agentDir?: string): boolean {
  return isExportLeaseActive(runId, agentDir);
}

function deleteSessionChangesBestEffort(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearSessionChangedFiles } = require("./session-file-changes") as {
      clearSessionChangedFiles?: (sessionId: string) => void;
    };
    if (typeof clearSessionChangedFiles === "function") {
      clearSessionChangedFiles(sessionId);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAgentDirLocal } = require("./automation-paths") as typeof import("./automation-paths");
    const candidate = join(getAgentDirLocal(), "session-file-changes", `${sessionId}.json`);
    if (existsSync(candidate)) {
      unlinkSync(candidate);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * List ALL terminal run ids for retention (no newest-10k truncation).
 * Prefer direct directory pagination over listRunRecords(limit).
 */
export function listAllTerminalRunIdsForRetention(agentDir?: string): string[] {
  const ids = new Set<string>();
  const runsDir = getAutomationRunsDir(agentDir);
  if (existsSync(runsDir)) {
    // Paginate directory entries — never slice to newest 10k.
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith(".json")) continue;
      ids.add(name.replace(/\.json$/i, ""));
    }
  }
  // Also include retention projections that still need work (tombstone missing).
  const retDir = getAutomationRetentionDir(agentDir);
  if (existsSync(retDir)) {
    for (const name of readdirSync(retDir)) {
      if (!name.endsWith(".json")) continue;
      ids.add(name.replace(/\.json$/i, ""));
    }
  }
  return [...ids];
}

export async function runAutomationRetention(options?: {
  agentDir?: string;
  now?: number;
  transcriptRetentionMs?: number;
  metadataRetentionMs?: number;
}): Promise<RetentionReport> {
  const now = options?.now ?? Date.now();
  const transcriptMs = options?.transcriptRetentionMs ?? AUTOMATION_TRANSCRIPT_RETENTION_MS;
  const metadataMs = options?.metadataRetentionMs ?? AUTOMATION_METADATA_RETENTION_MS;
  const report: RetentionReport = {
    scannedRuns: 0,
    deletedTranscripts: 0,
    deletedChanges: 0,
    deletedClaims: 0,
    deletedMetadata: 0,
    tombstonesWritten: 0,
    skipped: 0,
    errors: [],
    terminalSnapshotsPreserved: 0,
  };

  // Full scan — never limit to newest 10k.
  const allIds = listAllTerminalRunIdsForRetention(options?.agentDir);
  report.scannedRuns = allIds.length;

  const transcriptCandidates: string[] = [];
  const metadataCandidates: string[] = [];

  for (const runId of allIds) {
    const run = readRunRecord(runId, options?.agentDir);
    // Fall back to projection-only ids.
    if (!run) {
      const proj = readRunRetentionProjection(runId, options?.agentDir);
      if (proj?.retentionTombstone) {
        report.skipped += 1;
        continue;
      }
      // Orphan projection without run — eligible for metadata cleanup if aged.
      report.skipped += 1;
      continue;
    }
    if (!run.terminal || !run.completedAt) {
      report.skipped += 1;
      continue;
    }
    if (!run.session.sealed && run.session.availability === "available") {
      report.skipped += 1;
      continue;
    }
    if (isExportLeaseActive(run.id, options?.agentDir, now)) {
      report.skipped += 1;
      continue;
    }
    const promo = readPromotionRecord(run.id, options?.agentDir);
    if (promo && promo.status === "staging") {
      report.skipped += 1;
      continue;
    }
    const completed = Date.parse(run.completedAt);
    if (!Number.isFinite(completed)) {
      report.skipped += 1;
      continue;
    }
    const existingProj = readRunRetentionProjection(run.id, options?.agentDir);
    if (now - completed >= transcriptMs) {
      if (!existingProj?.artifactsPurgedAt) {
        transcriptCandidates.push(run.id);
      }
    }
    if (now - completed >= metadataMs) {
      if (!existingProj?.retentionTombstone) {
        metadataCandidates.push(run.id);
      }
    }
  }

  await withAutomationStoreLock(async () => {
    for (const runId of transcriptCandidates) {
      try {
        if (isExportLeaseActive(runId, options?.agentDir, now)) {
          report.skipped += 1;
          continue;
        }
        const run = readRunRecord(runId, options?.agentDir);
        if (!run || !run.terminal) {
          report.skipped += 1;
          continue;
        }
        const promo = readPromotionRecord(runId, options?.agentDir);
        if (promo && promo.status === "staging") {
          report.skipped += 1;
          continue;
        }
        const snapshotExisted = terminalRunSnapshotExists(runId, options?.agentDir);

        if (run.session.sessionFile && existsSync(run.session.sessionFile)) {
          removePathBestEffort(run.session.sessionFile);
          report.deletedTranscripts += 1;
        }
        if (deleteSessionChangesBestEffort(run.session.sessionId)) {
          report.deletedChanges += 1;
        }

        // External projection only — never rewrite runs/<id>.json here.
        writeRunRetentionProjection(
          {
            ...run,
            session: {
              ...run.session,
              sessionFile: null,
              availability: "unavailable",
              unavailableReason: "retention_purged_transcript",
              sealed: run.session.sealed,
              seal: run.session.seal,
            },
            artifactsPurgedAt: new Date(now).toISOString(),
          } as never,
          options?.agentDir,
        );

        if (snapshotExisted && terminalRunSnapshotExists(runId, options?.agentDir)) {
          report.terminalSnapshotsPreserved += 1;
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    for (const runId of metadataCandidates) {
      try {
        if (isExportLeaseActive(runId, options?.agentDir, now)) {
          report.skipped += 1;
          continue;
        }
        const run = readRunRecord(runId, options?.agentDir);
        if (!run || !run.terminal || !run.completedAt) continue;
        const completed = Date.parse(run.completedAt);
        if (!Number.isFinite(completed) || now - completed < metadataMs) continue;

        const promo = readPromotionRecord(runId, options?.agentDir);
        if (promo && promo.status === "staging") {
          report.skipped += 1;
          continue;
        }

        const snapshotExisted = terminalRunSnapshotExists(runId, options?.agentDir);
        const snapshotPath = getAutomationRunPath(runId, options?.agentDir);

        try {
          const claimPath = getAutomationClaimPath(run.occurrence.occurrenceKey, options?.agentDir);
          if (existsSync(claimPath)) {
            unlinkSync(claimPath);
            report.deletedClaims += 1;
          }
        } catch (error) {
          report.errors.push(String(error));
        }

        const auditPath = join(getAutomationAuditDir(options?.agentDir), `${runId}.json`);
        if (existsSync(auditPath)) {
          try {
            const st = statSync(auditPath);
            if (now - st.mtimeMs >= metadataMs) {
              unlinkSync(auditPath);
              report.deletedMetadata += 1;
            }
          } catch (error) {
            report.errors.push(String(error));
          }
        }

        // 1) Write integrity/tombstone projection FIRST.
        writeRunRetentionProjection(
          {
            ...run,
            session: {
              sessionId: null,
              sessionFile: null,
              availability: "unavailable",
              unavailableReason: "retention_tombstone",
              sealed: false,
              seal: null,
            },
            terminal: true,
            retentionTombstone: true,
            artifactsPurgedAt: new Date(now).toISOString(),
          } as never,
          options?.agentDir,
        );
        report.tombstonesWritten += 1;

        // 2) DELETE the full authoritative run metadata file (do not rewrite/mutate it).
        if (snapshotExisted && existsSync(snapshotPath)) {
          try {
            unlinkSync(snapshotPath);
            report.deletedMetadata += 1;
          } catch (error) {
            report.errors.push(
              `Failed to delete run metadata ${runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        if (snapshotExisted && !terminalRunSnapshotExists(runId, options?.agentDir)) {
          report.terminalSnapshotsPreserved += 1;
        }
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }, { agentDir: options?.agentDir });

  void getAutomationRunsDir;
  void getAutomationSessionsRoot;
  void getAutomationRetentionDir;
  void listRunRecords;
  void readdirSync;

  return report;
}
