/**
 * Run-authorized known-path reader for Automation sessions.
 * Does not expand ordinary resolveSessionPath() search scope.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { readRunRecord } from "./automation-store";
import { isPathInsideRoot, getAutomationSessionsRoot } from "./automation-paths";
import type { AutomationRunRecord, AutomationSessionRef } from "./automation-types";
import { isTerminalRunStatus } from "./automation-types";

export class AutomationSessionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "not_found", status = 404) {
    super(message);
    this.name = "AutomationSessionError";
    this.code = code;
    this.status = status;
  }
}

function assertRunAuthorizedSessionPath(run: AutomationRunRecord, sessionFile: string, agentDir?: string): void {
  const root = getAutomationSessionsRoot(agentDir);
  if (!isPathInsideRoot(root, sessionFile)) {
    throw new AutomationSessionError("Session path escapes Automation sessions root", "security", 400);
  }
  if (run.session.sessionFile && run.session.sessionFile !== sessionFile) {
    throw new AutomationSessionError("Session path does not match run record", "security", 400);
  }
}

export function getAuthorizedAutomationRun(runId: string, agentDir?: string): AutomationRunRecord {
  const run = readRunRecord(runId, agentDir);
  if (!run) throw new AutomationSessionError("Run not found", "not_found", 404);
  return run;
}

export function readAutomationTranscript(input: {
  runId: string;
  agentDir?: string;
  offset?: number;
  limit?: number;
}): {
  runId: string;
  session: AutomationSessionRef;
  entries: unknown[];
  total: number;
  retentionTombstone?: boolean;
  artifactsUnavailable?: boolean;
} {
  const run = getAuthorizedAutomationRun(input.runId, input.agentDir);

  // Honor separate retention projection before reading files.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readRunRetentionProjection } = require("./automation-store") as typeof import("./automation-store");
    const proj = readRunRetentionProjection(run.id, input.agentDir);
    if (proj?.retentionTombstone) {
      return {
        runId: run.id,
        session: {
          sessionId: null,
          sessionFile: null,
          availability: "unavailable",
          unavailableReason: "retention_tombstone",
          sealed: false,
          seal: null,
        },
        entries: [],
        total: 0,
        retentionTombstone: true,
        artifactsUnavailable: true,
      };
    }
    if (proj?.artifactsPurgedAt || proj?.sessionAvailability === "unavailable") {
      return {
        runId: run.id,
        session: {
          ...run.session,
          sessionFile: null,
          availability: "unavailable",
          unavailableReason:
            (proj.unavailableReason as string | null) ?? "retention_purged_transcript",
        },
        entries: [],
        total: 0,
        artifactsUnavailable: true,
      };
    }
  } catch {
    // ignore
  }

  const sessionFile = run.session.sessionFile;
  if (!sessionFile || run.session.availability === "unavailable" || !existsSync(sessionFile)) {
    return {
      runId: run.id,
      session: run.session,
      entries: [],
      total: 0,
    };
  }
  assertRunAuthorizedSessionPath(run, sessionFile, input.agentDir);
  let all: unknown[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSessionEntries } = require("./session-reader") as typeof import("./session-reader");
    all = getSessionEntries(sessionFile) as unknown[];
  } catch {
    // Fallback minimal parser for smokes without pi SDK export resolution.
    const text = readFileSync(sessionFile, "utf8");
    all = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return l;
        }
      });
  }
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.max(1, Math.min(500, input.limit ?? 200));
  return {
    runId: run.id,
    session: run.session,
    entries: all.slice(offset, offset + limit),
    total: all.length,
  };
}

export function readAutomationRunChanges(input: {
  runId: string;
  agentDir?: string;
}): unknown {
  const run = getAuthorizedAutomationRun(input.runId, input.agentDir);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readRunRetentionProjection } = require("./automation-store") as typeof import("./automation-store");
    const proj = readRunRetentionProjection(run.id, input.agentDir);
    if (proj?.retentionTombstone || proj?.artifactsPurgedAt) {
      return {
        files: [],
        available: false,
        reason: proj.retentionTombstone ? "retention_tombstone" : "retention_purged",
      };
    }
  } catch {
    // ignore
  }
  if (!run.session.sessionId) {
    return { files: [], available: false, reason: "no_session" };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listSessionChangedFiles } = require("./session-file-changes") as typeof import("./session-file-changes");
    const summary = listSessionChangedFiles(run.session.sessionId);
    return {
      available: true,
      ...summary,
    };
  } catch {
    return { files: [], available: false, reason: "sidecar_unavailable" };
  }
}

export function verifySessionSeal(session: AutomationSessionRef): {
  ok: boolean;
  reason?: string;
} {
  if (!session.sealed || !session.seal || !session.sessionFile) {
    return { ok: false, reason: "not_sealed" };
  }
  if (!existsSync(session.sessionFile)) {
    return { ok: false, reason: "missing_file" };
  }
  const buf = readFileSync(session.sessionFile);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== session.seal.sha256 || buf.byteLength !== session.seal.size) {
    return { ok: false, reason: "seal_mismatch" };
  }
  return { ok: true };
}

export function isPromoteEligible(run: AutomationRunRecord): { ok: boolean; reason?: string } {
  if (!isTerminalRunStatus(run.status)) {
    return { ok: false, reason: "not_terminal" };
  }
  if (run.lease) {
    return { ok: false, reason: "active_lease" };
  }
  if (run.session.availability !== "available" || !run.session.sessionFile) {
    return { ok: false, reason: "no_session" };
  }
  if (!run.session.sealed || !run.session.seal) {
    return { ok: false, reason: "unsealed" };
  }
  const seal = verifySessionSeal(run.session);
  if (!seal.ok) return { ok: false, reason: seal.reason };
  return { ok: true };
}

export function computeFileSeal(sessionFile: string): NonNullable<AutomationSessionRef["seal"]> {
  const buf = readFileSync(sessionFile);
  const st = statSync(sessionFile);
  const text = buf.toString("utf8");
  return {
    size: st.size,
    sha256: createHash("sha256").update(buf).digest("hex"),
    entryCount: text.split(/\r?\n/).filter((l) => l.trim()).length,
    sealedAt: new Date().toISOString(),
  };
}
