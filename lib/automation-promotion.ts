/**
 * Idempotent promote of sealed Automation sessions into ordinary project sessions.
 * Never mutates terminal run snapshots; uses independent promotion projection.
 * Validates Pi session v3 header, coherent entry id/parent sequence, and
 * source seal / post-copy SHA-256 before rewriting destination identity.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import {
  readPromotionRecord,
  readRunRecord,
  writePromotionRecord,
  withAutomationStoreLock,
} from "./automation-store";
import { isPromoteEligible, verifySessionSeal } from "./automation-session";
import { AUTOMATION_SCHEMA_VERSION, type AutomationPromotionRecord } from "./automation-types";
import { getAgentDirLocal } from "./automation-paths";
import { join as pathJoin } from "path";

export class AutomationPromotionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "validation", status = 400) {
    super(message);
    this.name = "AutomationPromotionError";
    this.code = code;
    this.status = status;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function encodeSessionDirName(cwd: string): string {
  return (
    createHash("sha256").update(cwd).digest("hex").slice(0, 16) +
    "_" +
    Buffer.from(cwd).toString("base64url").slice(0, 48)
  );
}

function makeDestinationSessionFile(
  cwd: string,
  preferredSessionId?: string | null,
): { sessionId: string; sessionFile: string } {
  let dir: string;
  try {
    // Prefer project helper when pi SDK is resolvable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSessionDirForCwd } = require("./session-reader") as typeof import("./session-reader");
    dir = getSessionDirForCwd(cwd);
  } catch {
    dir = pathJoin(getAgentDirLocal(), "sessions", encodeSessionDirName(cwd));
  }
  mkdirSync(dir, { recursive: true });
  // Prefer source session id so filename/header can agree after identity rewrite.
  const sessionId =
    preferredSessionId && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(preferredSessionId)
      ? preferredSessionId
      : randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionFile = join(dir, `${stamp}_${sessionId}.jsonl`);
  return { sessionId, sessionFile };
}

function refreshSessionIndexBestEffort(sessionId?: string | null, sessionFile?: string | null): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reader = require("./session-reader") as typeof import("./session-reader") & {
      invalidateSessionIndex?: () => void;
      invalidateSessionPathCache?: (id: string) => void;
    };
    reader.invalidateSessionIndex?.();
    if (sessionId && sessionFile) {
      reader.invalidateSessionPathCache?.(sessionId);
    }
  } catch {
    // optional
  }
}

export function validateJsonlStructure(buf: Buffer): {
  ok: boolean;
  reason?: string;
  entryCount: number;
  sha256: string;
  headerId?: string;
} {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const text = buf.toString("utf8");
  if (text.includes("\u0000")) {
    return { ok: false, reason: "binary_null_bytes", entryCount: 0, sha256 };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) {
    return { ok: false, reason: "empty_jsonl", entryCount: 0, sha256 };
  }

  let headerId: string | undefined;
  const entryIds = new Set<string>();
  let previousEntryId: string | null = null;
  let rootCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, reason: `invalid_json_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `non_object_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    const rec = parsed as Record<string, unknown>;

    if (i === 0) {
      // Required Pi session v3 header.
      if (rec.type !== "session") {
        return { ok: false, reason: "missing_session_header", entryCount: lines.length, sha256 };
      }
      if (typeof rec.id !== "string" || !rec.id) {
        return { ok: false, reason: "header_missing_id", entryCount: lines.length, sha256 };
      }
      if (typeof rec.cwd !== "string" || !rec.cwd) {
        return { ok: false, reason: "header_missing_cwd", entryCount: lines.length, sha256 };
      }
      const version = typeof rec.version === "number" ? rec.version : null;
      if (version == null || version < 3) {
        return { ok: false, reason: "header_requires_session_v3", entryCount: lines.length, sha256 };
      }
      headerId = rec.id;
      continue;
    }

    // Non-header entries must be typed session tree nodes with id/parentId.
    // Lone {"role":"assistant"} records are rejected.
    if (typeof rec.type !== "string" || !rec.type) {
      return { ok: false, reason: `missing_type_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    if (typeof rec.id !== "string" || !rec.id) {
      return { ok: false, reason: `missing_entry_id_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    if (!("parentId" in rec)) {
      return { ok: false, reason: `missing_parent_id_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    const parentId = rec.parentId;
    if (parentId !== null && typeof parentId !== "string") {
      return { ok: false, reason: `invalid_parent_id_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    if (entryIds.has(rec.id)) {
      return { ok: false, reason: `duplicate_entry_id_line_${i + 1}`, entryCount: lines.length, sha256 };
    }
    if (parentId === null) {
      // Single-root coherent Pi entry graph: exactly one content root after header.
      rootCount += 1;
      if (rootCount > 1) {
        return { ok: false, reason: "multiple_roots", entryCount: lines.length, sha256 };
      }
    } else if (!entryIds.has(parentId) && parentId !== previousEntryId) {
      // parent must refer to an earlier entry id (tree coherence).
      if (!entryIds.has(parentId)) {
        return { ok: false, reason: `parent_before_child_line_${i + 1}`, entryCount: lines.length, sha256 };
      }
    }
    entryIds.add(rec.id);
    previousEntryId = rec.id;
  }

  if (!headerId) {
    return { ok: false, reason: "no_session_header", entryCount: lines.length, sha256 };
  }
  return { ok: true, entryCount: lines.length, sha256, headerId };
}

/**
 * Rewrite header id/cwd/version so destination filename and header id agree,
 * while preserving a coherent entry tree. Returns rewritten buffer.
 */
export function rewriteSessionForPromotion(input: {
  sourceBuf: Buffer;
  destinationSessionId: string;
  cwd: string;
}): Buffer {
  const lines = input.sourceBuf
    .toString("utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (!lines.length) {
    throw new AutomationPromotionError("Empty source session", "repair_required", 500);
  }
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  header.type = "session";
  header.version = 3;
  header.id = input.destinationSessionId;
  header.cwd = input.cwd;
  if (typeof header.timestamp !== "string") {
    header.timestamp = nowIso();
  }
  lines[0] = JSON.stringify(header);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export async function promoteAutomationRun(input: {
  runId: string;
  agentDir?: string;
}): Promise<AutomationPromotionRecord> {
  const existing = readPromotionRecord(input.runId, input.agentDir);
  if (existing?.status === "committed" && existing.destinationSessionFile) {
    return existing;
  }

  return withAutomationStoreLock(async () => {
    const again = readPromotionRecord(input.runId, input.agentDir);
    if (again?.status === "committed" && again.destinationSessionFile) {
      return again;
    }

    const run = readRunRecord(input.runId, input.agentDir);
    if (!run) {
      throw new AutomationPromotionError("Run not found", "not_found", 404);
    }
    const eligibility = isPromoteEligible(run);
    if (!eligibility.ok) {
      throw new AutomationPromotionError(
        `Run is not eligible for promote: ${eligibility.reason}`,
        eligibility.reason === "no_session" ? "validation" : "blocked",
        409,
      );
    }

    const source = run.session.sessionFile!;
    const sealCheck = verifySessionSeal(run.session);
    if (!sealCheck.ok) {
      throw new AutomationPromotionError(`Session seal invalid: ${sealCheck.reason}`, "repair_required", 409);
    }

    try {
      const { sessionId, sessionFile } = again?.destinationSessionFile
        ? {
            sessionId: again.destinationSessionId ?? run.session.sessionId ?? randomUUID(),
            sessionFile: again.destinationSessionFile,
          }
        : makeDestinationSessionFile(run.cwd, run.session.sessionId);

      const stagingDir = join(dirname(sessionFile), `.promote-staging-${input.runId}`);
      mkdirSync(stagingDir, { recursive: true });
      const stagingFile = join(stagingDir, "session.jsonl");

      const projection: AutomationPromotionRecord = {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        runId: run.id,
        taskId: run.taskId,
        status: "staging",
        sourceSessionFile: source,
        destinationSessionFile: sessionFile,
        destinationSessionId: sessionId,
        destinationCwd: run.cwd,
        sourceSeal: run.session.seal!,
        createdAt: again?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
        committedAt: null,
        error: null,
      };
      writePromotionRecord(projection, input.agentDir);

      // Source must remain sealed after runner disposal — re-verify immediately before copy.
      const reseal = verifySessionSeal(run.session);
      if (!reseal.ok) {
        throw new AutomationPromotionError(`Source seal broken before copy: ${reseal.reason}`, "repair_required", 409);
      }

      copyFileSync(source, stagingFile);

      const staged = readFileSync(stagingFile);
      if (staged.byteLength !== run.session.seal!.size) {
        throw new AutomationPromotionError("Staged session size mismatch", "repair_required", 500);
      }

      // Compare source seal SHA-256 against the untouched post-copy bytes first.
      const postCopySha = createHash("sha256").update(staged).digest("hex");
      if (postCopySha !== run.session.seal!.sha256) {
        throw new AutomationPromotionError("Post-copy SHA-256 mismatch vs source seal", "repair_required", 500);
      }

      const structure = validateJsonlStructure(staged);
      if (!structure.ok) {
        throw new AutomationPromotionError(
          `Staged JSONL invalid: ${structure.reason}`,
          "repair_required",
          500,
        );
      }
      if (
        run.session.seal!.entryCount > 0 &&
        structure.entryCount !== run.session.seal!.entryCount
      ) {
        throw new AutomationPromotionError(
          `Staged entry count mismatch: ${structure.entryCount} != ${run.session.seal!.entryCount}`,
          "repair_required",
          500,
        );
      }

      // Rewrite destination so filename id and header id agree (normal session contract).
      const rewritten = rewriteSessionForPromotion({
        sourceBuf: staged,
        destinationSessionId: sessionId,
        cwd: run.cwd,
      });
      const rewrittenCheck = validateJsonlStructure(rewritten);
      if (!rewrittenCheck.ok || rewrittenCheck.headerId !== sessionId) {
        throw new AutomationPromotionError(
          `Rewritten destination invalid: ${rewrittenCheck.reason ?? "header_id_mismatch"}`,
          "repair_required",
          500,
        );
      }
      writeFileSync(stagingFile, rewritten);

      if (!existsSync(sessionFile)) {
        renameSync(stagingFile, sessionFile);
      }

      if (!existsSync(sessionFile)) {
        throw new AutomationPromotionError("Destination missing after rename", "repair_required", 500);
      }
      const destBuf = readFileSync(sessionFile);
      const destCheck = validateJsonlStructure(destBuf);
      if (!destCheck.ok || destCheck.headerId !== sessionId) {
        throw new AutomationPromotionError(
          `Destination header/filename disagree: ${destCheck.reason ?? destCheck.headerId}`,
          "repair_required",
          500,
        );
      }

      const committed: AutomationPromotionRecord = {
        ...projection,
        status: "committed",
        updatedAt: nowIso(),
        committedAt: nowIso(),
      };
      writePromotionRecord(committed, input.agentDir);
      refreshSessionIndexBestEffort(sessionId, sessionFile);
      return committed;
    } catch (error) {
      const failedRun = readRunRecord(input.runId, input.agentDir);
      const failed: AutomationPromotionRecord = {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        runId: input.runId,
        taskId: failedRun?.taskId ?? "unknown",
        status: "failed",
        sourceSessionFile: failedRun?.session.sessionFile ?? "",
        destinationSessionFile: null,
        destinationSessionId: null,
        destinationCwd: failedRun?.cwd ?? null,
        sourceSeal: failedRun?.session.seal ?? {
          size: 0,
          sha256: "",
          entryCount: 0,
          sealedAt: nowIso(),
        },
        createdAt: nowIso(),
        updatedAt: nowIso(),
        committedAt: null,
        error: error instanceof Error ? error.message : String(error),
      };
      writePromotionRecord(failed, input.agentDir);
      throw error;
    }
  }, { agentDir: input.agentDir });
}

/** Recover interrupted promotions to at most one destination. */
export async function recoverPromotion(runId: string, agentDir?: string): Promise<AutomationPromotionRecord | null> {
  const record = readPromotionRecord(runId, agentDir);
  if (!record) return null;
  if (record.status === "committed") return record;
  if (record.status === "staging" && record.destinationSessionFile && existsSync(record.destinationSessionFile)) {
    try {
      const dest = readFileSync(record.destinationSessionFile);
      const check = validateJsonlStructure(dest);
      if (check.ok && check.headerId === record.destinationSessionId) {
        const committed: AutomationPromotionRecord = {
          ...record,
          status: "committed",
          committedAt: nowIso(),
          updatedAt: nowIso(),
          error: null,
        };
        writePromotionRecord(committed, agentDir);
        refreshSessionIndexBestEffort(record.destinationSessionId, record.destinationSessionFile);
        return committed;
      }
    } catch {
      // fall through
    }
  }
  return record;
}

// Keep randomBytes referenced for future staging uniqueness helpers.
void randomBytes;
