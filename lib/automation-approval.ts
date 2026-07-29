/**
 * One-time browser approval challenges and in-memory Agent UI approval context.
 * Challenges bind action/task/run/revision/policy hash/canonical cwd and optional
 * proposed-config hash so tool updates confirm the mutation, not existing state.
 *
 * Browser flow (local-only trust boundary — not remote identity auth):
 * 1) create challenge → returns id + normalized authority summary (NO consumable secret)
 * 2) trusted UI renders summary and collects a real AppDialog confirmation
 * 3) confirm challenge → marks confirmed and returns one-time secret
 * 4) mutation consumes challengeId+secret atomically
 *
 * Ordinary localhost requests cannot assert confirmation by create alone; a separate
 * confirm step is required. This is a UX/control-plane gate on a loopback service,
 * not cryptographic end-user identity.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { authoritySummaryLines, buildAuthoritySummaryStructured, type AuthoritySummaryStructured } from "./automation-tool-policy";
export type { AuthoritySummaryStructured };
import type { AutomationAuthorityConfig, AutomationTaskConfig } from "./automation-types";

export type ApprovalAction =
  | "activate"
  | "resume"
  | "run_now"
  | "cancel_run"
  | "promote"
  | "archive"
  | "export"
  | "export_run"
  | "delete_artifacts"
  | "update_sensitive"
  | "repair_scheduler"
  | "set_global_disabled";

/** Structured summary for locale-aware UI confirmation (not challenge binding text). */
export type ApprovalSummaryStructured = ReturnType<typeof buildAuthoritySummaryModel> & {
  action: ApprovalAction | string;
  proposedConfigHash?: string | null;
  runId?: string | null;
  runStatus?: string | null;
};

export type ApprovalChallenge = {
  id: string;
  action: ApprovalAction;
  taskId: string | null;
  runId: string | null;
  revision: string | null;
  policyHash: string | null;
  cwd: string | null;
  /** Hash of proposed config for update_sensitive; null otherwise. */
  proposedConfigHash: string | null;
  /** English machine lines for audit/agent-tool binding. UI must prefer summaryStructured. */
  summary: string[];
  /** Locale-neutral structured authority fields for AppDialog formatting. */
  summaryStructured?: ApprovalSummaryStructured | null;
  expiresAt: number;
  consumed: boolean;
  /** Set only after explicit confirm step (UI AppDialog). */
  confirmedAt: number | null;
  controlSessionId: string;
};

export type UiApprovalProof = {
  id: string;
  action: ApprovalAction;
  taskId?: string;
  runId?: string;
  revision?: string | null;
  policyHash?: string | null;
  cwd?: string | null;
  proposedConfigHash?: string | null;
  summary: string[];
  at: number;
};

declare global {
  var __piAutomationApprovals: Map<string, ApprovalChallenge> | undefined;
  var __piAutomationUiApprovalProofs: Map<string, UiApprovalProof> | undefined;
}

function approvals(): Map<string, ApprovalChallenge> {
  if (!globalThis.__piAutomationApprovals) {
    globalThis.__piAutomationApprovals = new Map();
  }
  return globalThis.__piAutomationApprovals;
}

function uiProofs(): Map<string, UiApprovalProof> {
  if (!globalThis.__piAutomationUiApprovalProofs) {
    globalThis.__piAutomationUiApprovalProofs = new Map();
  }
  return globalThis.__piAutomationUiApprovalProofs;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const secrets = new Map<string, string>();
/** Raw secrets held until confirm delivers them once. */
const pendingSecrets = new Map<string, string>();

export function hashProposedConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config ?? null)).digest("hex");
}

export function buildAuthoritySummaryModel(config: AutomationTaskConfig): {
  name: string;
  cron: string;
  timezone: string;
  cwd: string;
  cwdSource: string;
  provider: string;
  modelId: string;
  thinking: string | null;
  maxRuntimeMin: number;
  promptHash: string;
  authority: AuthoritySummaryStructured;
} {
  return {
    name: config.name,
    cron: config.schedule.cron,
    timezone: config.schedule.timezone,
    cwd: config.target.cwd,
    cwdSource: config.target.cwdSource,
    provider: config.agent.provider,
    modelId: config.agent.modelId,
    thinking: config.agent.thinking ?? null,
    maxRuntimeMin: Math.round(config.agent.maxRuntimeMs / 60000),
    promptHash: createHash("sha256").update(config.agent.prompt).digest("hex").slice(0, 16),
    authority: buildAuthoritySummaryStructured(config.authority),
  };
}

/** Stable English lines for challenge binding / agent tool confirms. */
export function buildAuthoritySummary(config: AutomationTaskConfig): string[] {
  const m = buildAuthoritySummaryModel(config);
  return [
    `Name: ${m.name}`,
    `Schedule: ${m.cron} (${m.timezone})`,
    `Cwd (${m.cwdSource}): ${m.cwd}`,
    `Model: ${m.provider}/${m.modelId}`,
    `Thinking: ${m.thinking ?? "(default)"}`,
    `Max runtime: ${m.maxRuntimeMin} min`,
    `Prompt hash: ${m.promptHash}`,
    `Policy hash: ${m.authority.policyHash}`,
    ...authoritySummaryLines(config.authority),
  ];
}

/**
 * Create a challenge. Does NOT return a consumable secret.
 * Callers must confirmApprovalChallenge after presenting summary to a human.
 */
export function createApprovalChallenge(input: {
  action: ApprovalAction;
  taskId?: string | null;
  runId?: string | null;
  revision?: string | null;
  policyHash?: string | null;
  cwd?: string | null;
  proposedConfigHash?: string | null;
  summary: string[];
  summaryStructured?: ApprovalSummaryStructured | null;
  controlSessionRaw: string;
  ttlMs?: number;
  /**
   * Test-only: when true, also return secret and auto-confirm (legacy smokes).
   * Production UI/API must leave this false.
   */
  deliverSecretImmediately?: boolean;
}): {
  challengeId: string;
  expiresAt: number;
  summary: string[];
  summaryStructured?: ApprovalSummaryStructured | null;
  /** Only present when deliverSecretImmediately is true (tests). */
  secret?: string;
  requiresConfirmation: boolean;
} {
  const id = randomBytes(12).toString("hex");
  const secret = randomBytes(18).toString("base64url");
  const controlSessionId = createHash("sha256").update(input.controlSessionRaw).digest("hex").slice(0, 24);
  const expiresAt = Date.now() + (input.ttlMs ?? 5 * 60 * 1000);
  const immediately = Boolean(input.deliverSecretImmediately);
  approvals().set(id, {
    id,
    action: input.action,
    taskId: input.taskId ?? null,
    runId: input.runId ?? null,
    revision: input.revision ?? null,
    policyHash: input.policyHash ?? null,
    cwd: input.cwd ?? null,
    proposedConfigHash: input.proposedConfigHash ?? null,
    summary: input.summary,
    summaryStructured: input.summaryStructured ?? null,
    expiresAt,
    consumed: false,
    confirmedAt: immediately ? Date.now() : null,
    controlSessionId,
  });
  secrets.set(id, hashSecret(secret));
  if (immediately) {
    return {
      challengeId: id,
      secret,
      expiresAt,
      summary: input.summary,
      summaryStructured: input.summaryStructured ?? null,
      requiresConfirmation: false,
    };
  }
  pendingSecrets.set(id, secret);
  return {
    challengeId: id,
    expiresAt,
    summary: input.summary,
    summaryStructured: input.summaryStructured ?? null,
    requiresConfirmation: true,
  };
}

/**
 * Explicit confirmation step. Rejects body flags like confirmed:true without this call.
 * Ordinary create+mutate without confirm fails closed at consume.
 */
export function confirmApprovalChallenge(input: {
  challengeId: string;
  controlSessionRaw: string;
  /**
   * Must be the literal server-side confirm path. Body `confirmed: true` from clients
   * is ignored — presence of this call is the confirmation signal, and only after UI dialog.
   */
}): {
  challengeId: string;
  secret: string;
  summary: string[];
  summaryStructured?: ApprovalSummaryStructured | null;
  expiresAt: number;
} {
  const challenge = approvals().get(input.challengeId);
  if (!challenge) {
    throw Object.assign(new Error("Approval challenge not found"), {
      code: "approval_required",
      status: 403,
    });
  }
  if (challenge.consumed) {
    throw Object.assign(new Error("Approval challenge already used"), {
      code: "approval_replayed",
      status: 403,
    });
  }
  if (challenge.expiresAt <= Date.now()) {
    throw Object.assign(new Error("Approval challenge expired"), {
      code: "approval_expired",
      status: 403,
    });
  }
  const controlSessionId = createHash("sha256").update(input.controlSessionRaw).digest("hex").slice(0, 24);
  if (challenge.controlSessionId !== controlSessionId) {
    throw Object.assign(new Error("Approval control session mismatch"), {
      code: "security",
      status: 403,
    });
  }
  const secret = pendingSecrets.get(input.challengeId);
  if (!secret) {
    // Already confirmed once — do not re-deliver secret.
    throw Object.assign(new Error("Approval secret already delivered or missing"), {
      code: "approval_replayed",
      status: 403,
    });
  }
  challenge.confirmedAt = Date.now();
  pendingSecrets.delete(input.challengeId);
  return {
    challengeId: challenge.id,
    secret,
    summary: challenge.summary,
    summaryStructured: challenge.summaryStructured ?? null,
    expiresAt: challenge.expiresAt,
  };
}

export function consumeApprovalChallenge(input: {
  challengeId: string;
  secret: string;
  action: ApprovalAction;
  taskId?: string | null;
  runId?: string | null;
  revision?: string | null;
  policyHash?: string | null;
  cwd?: string | null;
  proposedConfigHash?: string | null;
  controlSessionRaw: string;
}): void {
  const challenge = approvals().get(input.challengeId);
  if (!challenge) {
    throw Object.assign(new Error("Approval challenge not found"), {
      code: "approval_required",
      status: 403,
    });
  }
  if (challenge.consumed) {
    throw Object.assign(new Error("Approval challenge already used"), {
      code: "approval_replayed",
      status: 403,
    });
  }
  if (!challenge.confirmedAt) {
    throw Object.assign(new Error("Approval challenge not confirmed by trusted UI"), {
      code: "approval_required",
      status: 403,
    });
  }
  if (challenge.expiresAt <= Date.now()) {
    throw Object.assign(new Error("Approval challenge expired"), {
      code: "approval_expired",
      status: 403,
    });
  }
  // export and export_run are aliases for the same authority.
  const actionMatches =
    challenge.action === input.action ||
    (challenge.action === "export" && input.action === "export_run") ||
    (challenge.action === "export_run" && input.action === "export");
  if (!actionMatches) {
    throw Object.assign(new Error("Approval action mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  if ((challenge.taskId ?? null) !== (input.taskId ?? null)) {
    throw Object.assign(new Error("Approval task mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  if ((challenge.runId ?? null) !== (input.runId ?? null)) {
    throw Object.assign(new Error("Approval run mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  if ((challenge.revision ?? null) !== (input.revision ?? null)) {
    throw Object.assign(new Error("Approval revision mismatch"), {
      code: "revision_conflict",
      status: 409,
    });
  }
  if ((challenge.policyHash ?? null) !== (input.policyHash ?? null)) {
    throw Object.assign(new Error("Approval policy hash mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  if ((challenge.cwd ?? null) !== (input.cwd ?? null)) {
    throw Object.assign(new Error("Approval cwd mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  if ((challenge.proposedConfigHash ?? null) !== (input.proposedConfigHash ?? null)) {
    throw Object.assign(new Error("Approval proposed config mismatch"), {
      code: "approval_required",
      status: 403,
    });
  }
  const controlSessionId = createHash("sha256").update(input.controlSessionRaw).digest("hex").slice(0, 24);
  if (challenge.controlSessionId !== controlSessionId) {
    throw Object.assign(new Error("Approval control session mismatch"), {
      code: "security",
      status: 403,
    });
  }
  const expected = secrets.get(input.challengeId);
  if (!expected) {
    throw Object.assign(new Error("Approval secret missing"), {
      code: "approval_required",
      status: 403,
    });
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hashSecret(input.secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("Approval secret invalid"), {
      code: "approval_required",
      status: 403,
    });
  }
  challenge.consumed = true;
  secrets.delete(input.challengeId);
  pendingSecrets.delete(input.challengeId);
}

/**
 * Multi-slot in-memory UI approval proofs from trusted ctx.ui.confirm.
 * Not a single global slot — concurrent tool calls cannot clobber each other.
 */
export function setUiApprovalContext(ctx: {
  action: ApprovalAction;
  taskId?: string;
  runId?: string;
  revision?: string | null;
  policyHash?: string | null;
  cwd?: string | null;
  proposedConfigHash?: string | null;
  summary?: string[];
} | null): string | null {
  if (!ctx) return null;
  const id = randomBytes(8).toString("hex");
  uiProofs().set(id, {
    id,
    action: ctx.action,
    taskId: ctx.taskId,
    runId: ctx.runId,
    revision: ctx.revision,
    policyHash: ctx.policyHash,
    cwd: ctx.cwd,
    proposedConfigHash: ctx.proposedConfigHash,
    summary: ctx.summary ?? [],
    at: Date.now(),
  });
  return id;
}

export function consumeUiApprovalContext(
  action: ApprovalAction,
  opts?: {
    taskId?: string;
    runId?: string;
    revision?: string | null;
    policyHash?: string | null;
    cwd?: string | null;
    proposedConfigHash?: string | null;
    proofId?: string;
  },
): boolean {
  const now = Date.now();
  // Drop expired proofs.
  for (const [id, proof] of uiProofs()) {
    if (now - proof.at > 60_000) uiProofs().delete(id);
  }

  const matches = (proof: UiApprovalProof): boolean => {
    if (proof.action !== action) return false;
    if ((proof.taskId ?? undefined) !== (opts?.taskId ?? undefined)) return false;
    if ((proof.runId ?? undefined) !== (opts?.runId ?? undefined)) return false;
    if ((proof.revision ?? null) !== (opts?.revision ?? null)) return false;
    if ((proof.policyHash ?? null) !== (opts?.policyHash ?? null)) return false;
    if ((proof.cwd ?? null) !== (opts?.cwd ?? null)) return false;
    if ((proof.proposedConfigHash ?? null) !== (opts?.proposedConfigHash ?? null)) return false;
    return true;
  };

  if (opts?.proofId) {
    const proof = uiProofs().get(opts.proofId);
    if (!proof || !matches(proof)) return false;
    uiProofs().delete(opts.proofId);
    return true;
  }

  for (const [id, proof] of uiProofs()) {
    if (matches(proof)) {
      uiProofs().delete(id);
      return true;
    }
  }
  return false;
}

export function peekApprovalChallenge(id: string): ApprovalChallenge | null {
  return approvals().get(id) ?? null;
}

export type { AutomationAuthorityConfig };
