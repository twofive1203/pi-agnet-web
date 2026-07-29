/**
 * Canonical Automation storage paths under getAgentDir()/automations/.
 * IDs are strictly validated before path join to prevent traversal.
 */

import { createHash } from "crypto";
import { join, resolve, sep } from "path";
import { homedir } from "os";
import {
  isValidAutomationRunId,
  isValidAutomationTaskId,
} from "./automation-types";

export const AUTOMATION_DEFAULT_CWD_BASENAME = "pi-automation-cwd";

export function getAgentDirLocal(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export function getAutomationRoot(agentDir = getAgentDirLocal()): string {
  return join(agentDir, "automations");
}

export function getAutomationTasksPath(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "tasks.json");
}

export function getAutomationStoreLockPath(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "store.lock");
}

export function getAutomationSchedulerLockPath(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "scheduler.lock");
}

export function getAutomationSchedulerStatusPath(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "scheduler-status.json");
}

export function getAutomationClaimsDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "claims");
}

export function getAutomationRunsDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "runs");
}

export function getAutomationPromotionsDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "promotions");
}

export function getAutomationAuditDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "audit");
}

export function getAutomationSessionsRoot(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "sessions");
}

export function getAutomationOmissionsDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "omissions");
}

export function getAutomationConfigPath(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "config.json");
}

export function assertSafeAutomationId(kind: "task" | "run" | "claim", id: string): string {
  const ok =
    kind === "task"
      ? isValidAutomationTaskId(id)
      : kind === "run"
        ? isValidAutomationRunId(id)
        : // Claim file ids are always hashed encodings — never raw ISO keys.
          /^[a-z0-9][a-z0-9_.-]{0,200}$/i.test(id) &&
          !id.includes("..") &&
          !id.includes("/") &&
          !id.includes("\\") &&
          !id.includes(":");
  if (!ok) {
    throw new Error(`Invalid automation ${kind} id`);
  }
  return id;
}

/**
 * Encode an occurrence key into a Windows-safe claim filename stem.
 * Original occurrence key (with ISO ':' etc.) is retained inside the claim record;
 * only the filesystem path uses this encoding. Never places ':', path separators,
 * or other reserved characters into the filename.
 */
export function encodeOccurrenceKeyForFilename(occurrenceKey: string): string {
  if (!occurrenceKey || typeof occurrenceKey !== "string") {
    throw new Error("Invalid automation claim id");
  }
  if (occurrenceKey.includes("..") || occurrenceKey.includes("/") || occurrenceKey.includes("\\")) {
    // Occurrence keys are composed of taskId@iso@tz@spv — never path segments.
    // Still hash even if malformed so we never write unsafe names.
  }
  const digest = createHash("sha256").update(occurrenceKey, "utf8").digest("hex").slice(0, 40);
  // Human-readable prefix from the leading task id segment (sanitized).
  const taskPart = (occurrenceKey.split("@")[0] ?? "occ")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 48) || "occ";
  const encoded = `${taskPart}_${digest}`;
  return assertSafeAutomationId("claim", encoded);
}

export function getAutomationClaimPath(occurrenceKey: string, agentDir?: string): string {
  const safe = encodeOccurrenceKeyForFilename(occurrenceKey);
  return join(getAutomationClaimsDir(agentDir), `${safe}.json`);
}

/** Separate retention/tombstone projection — never mutates runs/<id>.json. */
export function getAutomationRetentionDir(agentDir?: string): string {
  return join(getAutomationRoot(agentDir), "retention");
}

export function getAutomationRetentionPath(runId: string, agentDir?: string): string {
  return join(getAutomationRetentionDir(agentDir), `${assertSafeAutomationId("run", runId)}.json`);
}

export function getAutomationRunPath(runId: string, agentDir?: string): string {
  return join(getAutomationRunsDir(agentDir), `${assertSafeAutomationId("run", runId)}.json`);
}

export function getAutomationPromotionPath(runId: string, agentDir?: string): string {
  return join(getAutomationPromotionsDir(agentDir), `${assertSafeAutomationId("run", runId)}.json`);
}

export function getAutomationAuditPath(runId: string, agentDir?: string): string {
  return join(getAutomationAuditDir(agentDir), `${assertSafeAutomationId("run", runId)}.json`);
}

export function getAutomationTaskSessionDir(taskId: string, runId: string, agentDir?: string): string {
  return join(
    getAutomationSessionsRoot(agentDir),
    assertSafeAutomationId("task", taskId),
    assertSafeAutomationId("run", runId),
  );
}

export function getDefaultAutomationCwdCandidate(): string {
  return join(homedir(), AUTOMATION_DEFAULT_CWD_BASENAME);
}

export function isPathInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}
