/**
 * Shared Automation service used by HTTP routes and interactive Agent tools.
 */

import {
  AUTOMATION_DEFAULT_APPROVAL_TTL_MS,
  AUTOMATION_DEFAULT_MAX_RUNTIME_MS,
  defaultBudgetPolicy,
  defaultScheduleConfig,
  type AutomationTaskConfig,
  type AutomationTaskRecord,
  type AutomationRunRecord,
  type AutomationBlockedReason,
} from "./automation-types";
import {
  appendAuditEvent,
  appendAuditEventUnlocked,
  createDraftTaskRecord,
  deleteTaskRecordSoft,
  ensureAutomationLayout,
  getTaskRecord,
  listOmissionRecords,
  listRunRecords,
  listTaskRecords,
  makeAutomationTaskId,
  readRunRecord,
  readRunRetentionProjection,
  readAuditProjection,
  readTasksFile,
  upsertTaskRecord,
  withAutomationStoreLock,
  writeRunRetentionProjection,
  AutomationStoreError,
  setGlobalDisabled,
  listAuditProjectionIds,
} from "./automation-store";
import { ensureAutomationDefaultCwd, resolveAutomationTargetCwd } from "./automation-default-cwd";
import {
  previewNextRuns,
  validateMaxRuntimeMs,
  validateScheduleConfig,
  getNextRunAt,
  AutomationScheduleError,
} from "./automation-schedule";
import {
  buildAuthorityConfig,
  buildLivePolicyForTargetCwd,
  discoverLiveCatalogForTargetCwd,
  listModelsForTargetCwd,
  probeCredentialHandlesOk,
  probeModelAvailability,
  staticPreflight,
} from "./automation-tool-policy";
import {
  buildToolSnapshot,
  defaultAutomationCatalog,
  defaultBuiltinCatalog,
  isAlwaysBlockedToolName,
  isReviewedWebToolName,
} from "./automation-resource-catalog";
import {
  buildReviewedWebToolSnapshot,
} from "./automation-reviewed-web-tools";
import {
  buildAuthoritySummary,
  buildAuthoritySummaryModel,
  confirmApprovalChallenge,
  consumeApprovalChallenge,
  consumeUiApprovalContext,
  createApprovalChallenge,
  hashProposedConfig,
  type ApprovalAction,
} from "./automation-approval";
import {
  enqueueManualRun,
  getAutomationSchedulerStatus,
  requestRunCancel,
  startAutomationScheduler,
} from "./automation-scheduler";
import { repairAutomationLock } from "./automation-lock";
import { promoteAutomationRun } from "./automation-promotion";
import {
  isPromoteEligible,
  readAutomationRunChanges,
  readAutomationTranscript,
} from "./automation-session";
import { existsSync, rmSync } from "fs";
import { removePathBestEffort } from "./automation-store";

export class AutomationServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly blockedReason?: string;

  constructor(message: string, options?: { status?: number; code?: string; blockedReason?: string }) {
    super(message);
    this.name = "AutomationServiceError";
    this.status = options?.status ?? 400;
    this.code = options?.code ?? "validation";
    this.blockedReason = options?.blockedReason;
  }
}

function wrap(err: unknown): never {
  if (err instanceof AutomationServiceError) throw err;
  if (err instanceof AutomationStoreError) {
    throw new AutomationServiceError(err.message, {
      status: err.status,
      code: err.code,
      blockedReason: err.blockedReason,
    });
  }
  if (err instanceof AutomationScheduleError) {
    throw new AutomationServiceError(err.message, { status: 400, code: "validation" });
  }
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { message?: string; code?: string; status?: number };
    throw new AutomationServiceError(e.message ?? "Automation error", {
      status: e.status ?? 400,
      code: e.code ?? "validation",
    });
  }
  throw new AutomationServiceError(err instanceof Error ? err.message : String(err));
}

function nowIso(): string {
  return new Date().toISOString();
}

export function projectTask(task: AutomationTaskRecord) {
  const config = task.pendingConfig ?? task.approvedConfig;
  let nextPreview: ReturnType<typeof previewNextRuns> = [];
  try {
    nextPreview = previewNextRuns({
      cron: config.schedule.cron,
      timezone: config.schedule.timezone,
      count: 3,
    });
  } catch {
    nextPreview = [];
  }
  return {
    id: task.id,
    revision: task.revision,
    approvedRevision: task.approvedRevision,
    pendingRevision: task.pendingRevision,
    status: task.status,
    blockedReason: task.blockedReason,
    name: task.name,
    description: task.description,
    nextRunAt: task.nextRunAt,
    lastRunId: task.lastRunId,
    consecutiveFailures: task.consecutiveFailures,
    approvedConfig: task.approvedConfig,
    pendingConfig: task.pendingConfig,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    approvedAt: task.approvedAt,
    archivedAt: task.archivedAt,
    nextPreview,
    authoritySummary: buildAuthoritySummary(task.approvedConfig),
    authoritySummaryStructured: buildAuthoritySummaryModel(task.approvedConfig),
  };
}

export function projectRun(run: AutomationRunRecord, agentDir?: string) {
  // Honor separate retention projection (artifact unavailable/tombstone).
  // Never mutates the immutable terminal run snapshot.
  let session = run.session;
  let retentionTombstone = false;
  let artifactsPurged = false;
  let promoteOk = isPromoteEligible(run).ok;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readRunRetentionProjection } = require("./automation-store") as typeof import("./automation-store");
    const proj = readRunRetentionProjection(run.id, agentDir);
    if (proj) {
      if (proj.retentionTombstone) {
        retentionTombstone = true;
        artifactsPurged = true;
        promoteOk = false;
        session = {
          sessionId: null,
          sessionFile: null,
          availability: "unavailable",
          unavailableReason: "retention_tombstone",
          sealed: false,
          seal: null,
        };
      } else if (proj.artifactsPurgedAt || proj.sessionAvailability === "unavailable") {
        artifactsPurged = true;
        promoteOk = false;
        session = {
          ...run.session,
          sessionFile: null,
          availability: "unavailable",
          unavailableReason:
            (proj.unavailableReason as string | null) ?? "retention_purged_transcript",
          // Preserve seal metadata only as historical; file is gone.
          sealed: Boolean(run.session.sealed),
          seal: run.session.seal,
        };
      }
    }
  } catch {
    // projection optional
  }

  // 365d tombstone minimizes discoverable metadata while preserving audit/legal minimum.
  if (retentionTombstone) {
    return {
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      trigger: run.trigger,
      blockedReason: null,
      occurrence: {
        occurrenceKey: run.occurrence.occurrenceKey,
        scheduledForUtc: run.occurrence.scheduledForUtc,
        timezone: run.occurrence.timezone,
        schedulePolicyVersion: run.occurrence.schedulePolicyVersion,
        cron: null,
        localWallTime: null,
        localOffsetMinutes: null,
      },
      summary: null,
      errorCategory: run.errorCategory,
      errorMessage: null,
      usage: null,
      session,
      requestedModel: null,
      actualModel: null,
      effectiveTools: [] as string[],
      scheduledForUtc: run.occurrence?.scheduledForUtc ?? null,
      createdAt: run.createdAt,
      startedAt: null,
      completedAt: run.completedAt,
      cwd: null,
      terminal: true,
      promoteEligible: false,
      sideEffectsStarted: run.sideEffectsStarted,
      retentionTombstone: true,
      artifactsPurged: true,
    };
  }

  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    trigger: run.trigger,
    blockedReason: run.blockedReason,
    occurrence: run.occurrence,
    summary: run.summary,
    errorCategory: run.errorCategory,
    errorMessage: run.errorMessage,
    usage: run.usage,
    session,
    requestedModel: run.requestedModel,
    actualModel: run.actualModel,
    effectiveTools: run.effectiveTools?.map((t) => t.name) ?? [],
    scheduledForUtc: run.occurrence?.scheduledForUtc ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cwd: run.cwd,
    terminal: run.terminal,
    promoteEligible: promoteOk,
    sideEffectsStarted: run.sideEffectsStarted,
    retentionTombstone: false,
    artifactsPurged,
  };
}

async function normalizeToolSnapshots(
  tools: Array<{ name: string; origin?: string; sourcePath?: string; description?: string }> | undefined,
  agentDir?: string,
) {
  // Explicit tools:[] must round-trip as no-tools (never fall back to defaults).
  // Always await actual ESM SDK schemas so cold-start drafts freeze exact digests.
  const { defaultBuiltinCatalogAsync, buildToolSnapshot: buildSnap } = await import(
    "./automation-resource-catalog"
  );
  void buildSnap;
  const builtinCatalog = await defaultBuiltinCatalogAsync();
  const resolvedAgentDir = agentDir ?? process.env.PI_CODING_AGENT_DIR;
  const selected =
    tools === undefined || tools === null
      ? builtinCatalog
          .filter((t) => !isAlwaysBlockedToolName(t.name) && !t.risks.localMutation && !t.risks.blocked)
          .map((t) => ({ name: t.name, origin: "builtin" as const }))
      : tools;

  const out = [];
  for (const t of selected) {
    const tool = t as { name: string; origin?: string; sourcePath?: string; description?: string };
    if (isAlwaysBlockedToolName(tool.name)) {
      throw new AutomationServiceError(`Tool not allowed: ${tool.name}`, {
        status: 400,
        code: "validation",
      });
    }
    if (isReviewedWebToolName(tool.name)) {
      out.push(buildReviewedWebToolSnapshot(tool.name as "web_search" | "web_fetch"));
      continue;
    }
    const origin = (tool.origin as "builtin" | "extension" | "custom") || "builtin";
    if (origin === "builtin") {
      const live = builtinCatalog.find((d) => d.name === tool.name);
      if (live) {
        const snap = buildToolSnapshot({
          name: live.name,
          description: tool.description ?? live.description,
          origin: "builtin",
          schema: live.schema,
          risks: live.risks,
        });
        if (snap.risks.blocked) {
          throw new AutomationServiceError(
            `Tool blocked or unsupported: ${tool.name}${snap.risks.blockedReason ? ` (${snap.risks.blockedReason})` : ""}`,
            { status: 400, code: "validation" },
          );
        }
        out.push(snap);
        continue;
      }
      throw new AutomationServiceError(`Tool blocked or unsupported: ${tool.name}`, {
        status: 400,
        code: "validation",
      });
    }

    // Extension/custom: actual registration probe only for trusted reviewed digests
    // via the standalone discovery worker (never in-process factory evaluation).
    let schema: unknown = { name: tool.name };
    let hookInventory: string[] | undefined;
    if (tool.sourcePath) {
      try {
        const {
          tryGetReviewedExtensionTrust,
          discoverReviewedExtensionRegistration,
        } = await import("./automation-extension-discovery");
        const trust = tryGetReviewedExtensionTrust({
          sourcePath: tool.sourcePath,
          agentDir: resolvedAgentDir,
        });
        if (trust.trusted) {
          const discovered = await discoverReviewedExtensionRegistration({
            sourcePath: tool.sourcePath,
            agentDir: resolvedAgentDir,
            liveClosureDigest: trust.closureDigest,
          });
          const reg = discovered.registration;
          hookInventory = reg.hooks;
          const match =
            reg.tools.find((x) => x.name === tool.name) ??
            (reg.tools.length === 1 ? reg.tools[0] : undefined);
          if (match) {
            const {
              classifyExtensionTool,
              buildReviewedActualToolSchema,
            } = await import("./automation-resource-catalog");
            schema = buildReviewedActualToolSchema({
              name: match.name,
              description: match.description ?? tool.description,
              parameters: match.parameters ?? {},
              packageClosure: reg.packageClosure,
              hooks: reg.hooks,
              entry: reg.entryRel,
              bundleSha256: discovered.liveBundleSha256,
              closureDigest: discovered.liveClosureDigest,
            });
            const reviewedRisks = classifyExtensionTool(match.name, tool.sourcePath, {
              reviewedActual: true,
            });
            // Prefer actual registered tool name when the caller used a path-derived alias.
            const toolName =
              match.name && match.name !== tool.name && reg.tools.length === 1
                ? match.name
                : match.name || tool.name;
            const snap = buildToolSnapshot({
              name: toolName,
              description: match.description ?? tool.description,
              origin,
              sourcePath: tool.sourcePath,
              schema,
              hookInventory,
              risks: reviewedRisks,
            });
            // Bind executable digest to the trusted closure digest (authorize ≡ stage ≡ import).
            const bound = {
              ...snap,
              executableDigest: discovered.liveClosureDigest || snap.executableDigest,
            };
            if (bound.risks.blocked) {
              throw new AutomationServiceError(
                `Tool blocked or unsupported: ${toolName}${bound.risks.blockedReason ? ` (${bound.risks.blockedReason})` : ""}`,
                { status: 400, code: "validation" },
              );
            }
            out.push(bound);
            continue;
          }
          schema = {
            name: tool.name,
            discoveredTools: reg.tools.map((x) => x.name),
            packageClosure: reg.packageClosure,
            hooks: reg.hooks,
            catalogMode: "reviewed_empty",
            bundleSha256: discovered.liveBundleSha256,
            closureDigest: discovered.liveClosureDigest,
          };
        } else {
          // Unreviewed: path-bound snapshot only — never execute factory.
          schema = {
            name: tool.name,
            catalogMode: "static_blocked",
            trustReason: trust.reason,
            closureDigest: trust.closureDigest,
          };
        }
      } catch {
        // Fall back to path-bound snapshot (still no factory execution).
      }
    }
    const snap = buildToolSnapshot({
      name: tool.name,
      description: tool.description,
      origin,
      sourcePath: tool.sourcePath,
      schema,
      hookInventory,
    });
    if (snap.risks.blocked) {
      throw new AutomationServiceError(
        `Tool blocked or unsupported: ${tool.name}${snap.risks.blockedReason ? ` (${snap.risks.blockedReason})` : ""}`,
        { status: 400, code: "validation" },
      );
    }
    out.push(snap);
  }
  return out;
}

export async function buildTaskConfigFromInput(input: {
  name: string;
  description?: string;
  cron: string;
  timezone: string;
  cwd?: string | null;
  cwdSource?: "project" | "default";
  provider: string;
  modelId: string;
  thinking?: string | null;
  prompt: string;
  maxRuntimeMs?: number;
  tools?: Array<{ name: string; origin?: string; sourcePath?: string; description?: string }>;
  budgets?: Partial<ReturnType<typeof defaultBudgetPolicy>>;
  approvalExpiresAt?: string | null;
  agentDir?: string;
}): Promise<AutomationTaskConfig> {
  if (!input.name?.trim()) throw new AutomationServiceError("name required");
  if (!input.prompt?.trim()) throw new AutomationServiceError("prompt required");
  if (!input.provider?.trim() || !input.modelId?.trim()) {
    throw new AutomationServiceError("provider and modelId required");
  }
  validateScheduleConfig({ cron: input.cron, timezone: input.timezone });
  const maxRuntimeMs = input.maxRuntimeMs ?? AUTOMATION_DEFAULT_MAX_RUNTIME_MS;
  validateMaxRuntimeMs(maxRuntimeMs);
  const target = resolveAutomationTargetCwd({
    cwd: input.cwd,
    cwdSource: input.cwdSource,
    agentDir: input.agentDir,
  });
  const toolSnaps = await normalizeToolSnapshots(input.tools, input.agentDir);
  // Pre-config rejection: never construct authority that silently drops selections.
  for (const t of toolSnaps) {
    if (t.risks.blocked || isAlwaysBlockedToolName(t.name)) {
      throw new AutomationServiceError(
        `Tool blocked or unsupported: ${t.name}${t.risks.blockedReason ? ` (${t.risks.blockedReason})` : ""}`,
        { status: 400, code: "validation" },
      );
    }
  }
  const budgets = { ...defaultBudgetPolicy(), ...(input.budgets ?? {}) };
  let authority: ReturnType<typeof buildAuthorityConfig>;
  try {
    authority = buildAuthorityConfig({
      tools: toolSnaps,
      extensions: toolSnaps
        .filter((t) => t.origin === "extension" && t.sourcePath)
        .map((t) => ({
          sourceIdentity: t.sourceIdentity,
          sourcePath: t.sourcePath!,
          executableDigest: t.executableDigest,
          hookInventory: t.hookInventory ?? [],
          configHash: t.configHash,
        })),
      budgets,
      approvalExpiresAt:
        input.approvalExpiresAt !== undefined
          ? input.approvalExpiresAt
          : new Date(Date.now() + AUTOMATION_DEFAULT_APPROVAL_TTL_MS).toISOString(),
    });
  } catch (error) {
    if (error instanceof AutomationServiceError) throw error;
    throw new AutomationServiceError(error instanceof Error ? error.message : String(error), {
      status: 400,
      code: "validation",
    });
  }
  // Authority tool count must match the requested (post-default) selection — never shrink.
  if (authority.tools.length !== toolSnaps.length) {
    throw new AutomationServiceError(
      `Authority tool set shrunk from ${toolSnaps.length} to ${authority.tools.length}`,
      { status: 400, code: "validation" },
    );
  }
  return {
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    schedule: defaultScheduleConfig(input.cron.trim(), input.timezone.trim()),
    target: { cwd: target.cwd, cwdSource: target.cwdSource },
    agent: {
      provider: input.provider.trim(),
      modelId: input.modelId.trim(),
      thinking: input.thinking ?? null,
      prompt: input.prompt,
      maxRuntimeMs,
    },
    authority,
  };
}

function requireApproval(
  mode: "browser" | "ui" | "none",
  action: ApprovalAction,
  opts: {
    challengeId?: string;
    secret?: string;
    taskId?: string;
    runId?: string;
    revision?: string;
    policyHash?: string;
    cwd?: string;
    proposedConfigHash?: string;
    controlSessionRaw?: string;
    uiProofId?: string;
  },
): void {
  if (mode === "none") {
    throw new AutomationServiceError("Approval required", {
      status: 403,
      code: "approval_required",
    });
  }
  if (mode === "ui") {
    if (
      !consumeUiApprovalContext(action, {
        taskId: opts.taskId,
        runId: opts.runId,
        revision: opts.revision,
        policyHash: opts.policyHash,
        cwd: opts.cwd,
        proposedConfigHash: opts.proposedConfigHash,
        proofId: opts.uiProofId,
      })
    ) {
      throw new AutomationServiceError("Trusted UI confirmation required", {
        status: 403,
        code: "approval_required",
      });
    }
    return;
  }
  if (!opts.challengeId || !opts.secret || !opts.controlSessionRaw) {
    throw new AutomationServiceError("Approval challenge required", {
      status: 403,
      code: "approval_required",
    });
  }
  try {
    consumeApprovalChallenge({
      challengeId: opts.challengeId,
      secret: opts.secret,
      action,
      taskId: opts.taskId,
      runId: opts.runId,
      revision: opts.revision,
      policyHash: opts.policyHash,
      cwd: opts.cwd,
      proposedConfigHash: opts.proposedConfigHash,
      controlSessionRaw: opts.controlSessionRaw,
    });
  } catch (error) {
    wrap(error);
  }
}

/**
 * Audit projections are keyed by run-id filesystem paths. Task/scheduler lifecycle
 * events use a stable synthetic run id that still matches AUTOMATION_RUN_ID_RE.
 */
function auditRunIdFor(input: { runId?: string | null; taskId?: string | null; scope?: string }): string {
  if (input.runId && /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/i.test(input.runId)) {
    return input.runId;
  }
  const scope = (input.scope ?? "task").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 24);
  const task = (input.taskId ?? "system")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = `aud-${scope}-${task || "system"}`;
  return base.slice(0, 80).replace(/[^a-z0-9]+$/i, "") || "aud-system";
}

/**
 * Durable audit transaction for sensitive mutations.
 * Under one store.lock: write prepared audit → mutate → write committed audit.
 * Failure after prepare leaves repair-required evidence; never silent drop.
 */
async function commitMutationWithAudit<T>(input: {
  agentDir?: string;
  runId: string;
  taskId: string;
  kind: string;
  actor: string;
  message: string;
  data?: Record<string, unknown>;
  mutate: () => Promise<T> | T;
}): Promise<T> {
  const runId = auditRunIdFor({ runId: input.runId, taskId: input.taskId, scope: input.kind });
  const transactionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
  return withAutomationStoreLock(async () => {
    appendAuditEventUnlocked({
      runId,
      taskId: input.taskId,
      kind: `prepared:${input.kind}`,
      actor: input.actor,
      message: input.message,
      data: { ...input.data, logicalRunId: input.runId, transactionId },
      agentDir: input.agentDir,
    });
    try {
      const result = await input.mutate();
      try {
        appendAuditEventUnlocked({
          runId,
          taskId: input.taskId,
          kind: input.kind,
          actor: input.actor,
          message: `committed:${input.message}`,
          data: { ...input.data, logicalRunId: input.runId, transactionId },
          agentDir: input.agentDir,
        });
      } catch (auditErr) {
        try {
          appendAuditEventUnlocked({
            runId,
            taskId: input.taskId,
            kind: "repair_required",
            actor: "system",
            message: `Audit commit failed after mutation: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            agentDir: input.agentDir,
          });
        } catch {
          throw new AutomationServiceError(
            `Mutation committed but audit failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            { status: 500, code: "repair_required" },
          );
        }
        throw new AutomationServiceError(
          `Mutation committed but audit commit failed (repair_required recorded)`,
          { status: 500, code: "repair_required" },
        );
      }
      return result;
    } catch (err) {
      if (err instanceof AutomationServiceError && err.code === "repair_required") throw err;
      try {
        appendAuditEventUnlocked({
          runId,
          taskId: input.taskId,
          kind: "repair_required",
          actor: "system",
          message: `Mutation failed after audit prepare (${input.kind}): ${err instanceof Error ? err.message : String(err)}`,
          agentDir: input.agentDir,
        });
      } catch {
        // best-effort
      }
      throw err;
    }
  }, { agentDir: input.agentDir });
}

export const automationService = {
  ensure(agentDir?: string) {
    ensureAutomationLayout(agentDir);
    return readTasksFile(agentDir);
  },

  listTasks(agentDir?: string) {
    return listTaskRecords(agentDir)
      .filter((t) => t.status !== "archived")
      .map(projectTask);
  },

  getTask(taskId: string, agentDir?: string) {
    const task = getTaskRecord(taskId, agentDir);
    if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
    return projectTask(task);
  },

  async createDraft(
    input: Parameters<typeof buildTaskConfigFromInput>[0] & { createdBySessionId?: string | null },
    agentDir?: string,
  ) {
    try {
      const config = await buildTaskConfigFromInput({ ...input, agentDir });
      const task = createDraftTaskRecord({
        id: makeAutomationTaskId(config.name),
        config,
        createdBySessionId: input.createdBySessionId,
      });
      const saved = await commitMutationWithAudit({
        agentDir,
        runId: `task:${task.id}`,
        taskId: task.id,
        kind: "task_create",
        actor: "service",
        message: "create draft",
        data: { name: task.name },
        mutate: () => upsertTaskRecord(task, { agentDir }),
      });
      return projectTask(saved);
    } catch (error) {
      wrap(error);
    }
  },

  async updateTask(
    taskId: string,
    patch: Partial<Parameters<typeof buildTaskConfigFromInput>[0]> & {
      expectedRevision: string;
      sensitive?: boolean;
    },
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
      if (task.status === "archived") {
        throw new AutomationServiceError("Task archived", { status: 409, code: "archived" });
      }
      if (task.revision !== patch.expectedRevision) {
        throw new AutomationServiceError("Revision conflict", {
          status: 409,
          code: "revision_conflict",
        });
      }

      const base = task.pendingConfig ?? task.approvedConfig;
      // Preserve tools when omitted so a harmless description update on explicit no-tools
      // cannot expand authority. Include budgets + approvalExpiresAt for parity.
      const preservedTools =
        patch.tools !== undefined
          ? patch.tools
          : base.authority.tools.map((t) => ({
              name: t.name,
              origin: t.origin,
              sourcePath: t.sourcePath,
              description: t.description,
            }));
      const nextConfig = await buildTaskConfigFromInput({
        name: patch.name ?? base.name,
        description: patch.description ?? base.description,
        cron: patch.cron ?? base.schedule.cron,
        timezone: patch.timezone ?? base.schedule.timezone,
        cwd: patch.cwd ?? base.target.cwd,
        cwdSource: patch.cwdSource ?? base.target.cwdSource,
        provider: patch.provider ?? base.agent.provider,
        modelId: patch.modelId ?? base.agent.modelId,
        thinking: patch.thinking !== undefined ? patch.thinking : base.agent.thinking,
        prompt: patch.prompt ?? base.agent.prompt,
        maxRuntimeMs: patch.maxRuntimeMs ?? base.agent.maxRuntimeMs,
        tools: preservedTools,
        budgets: patch.budgets
          ? { ...base.authority.budgets, ...patch.budgets }
          : base.authority.budgets,
        approvalExpiresAt:
          patch.approvalExpiresAt !== undefined
            ? patch.approvalExpiresAt
            : base.authority.approvalExpiresAt,
        agentDir,
      });

      const sensitive =
        patch.sensitive ||
        task.status === "active" ||
        nextConfig.schedule.cron !== base.schedule.cron ||
        nextConfig.target.cwd !== base.target.cwd ||
        nextConfig.agent.prompt !== base.agent.prompt ||
        nextConfig.authority.policyHash !== base.authority.policyHash;

      const proposedHash = hashProposedConfig(nextConfig);

      if (sensitive && task.status === "active") {
        // Pending revision path — approval must bind the *proposed* mutation, not existing state.
        requireApproval(approval.mode, "update_sensitive", {
          challengeId: approval.challengeId,
          secret: approval.secret,
          controlSessionRaw: approval.controlSessionRaw,
          taskId,
          revision: task.revision,
          policyHash: nextConfig.authority.policyHash,
          cwd: nextConfig.target.cwd,
          proposedConfigHash: proposedHash,
        });
        const updated = await commitMutationWithAudit({
          agentDir,
          runId: `task:${taskId}`,
          taskId,
          kind: "task_update_pending",
          actor: approval.mode,
          message: "sensitive update → pending revision",
          data: { proposedConfigHash: proposedHash },
          mutate: () =>
            upsertTaskRecord(
              {
                ...task,
                name: nextConfig.name,
                description: nextConfig.description,
                pendingConfig: nextConfig,
                pendingRevision: `pending-${Date.now().toString(36)}`,
              },
              { agentDir, expectedTaskRevision: task.revision },
            ),
        });
        return projectTask(updated);
      }

      if (sensitive) {
        requireApproval(approval.mode, "update_sensitive", {
          challengeId: approval.challengeId,
          secret: approval.secret,
          controlSessionRaw: approval.controlSessionRaw,
          taskId,
          revision: task.revision,
          policyHash: nextConfig.authority.policyHash,
          cwd: nextConfig.target.cwd,
          proposedConfigHash: proposedHash,
        });
      }

      const updated = await commitMutationWithAudit({
        agentDir,
        runId: `task:${taskId}`,
        taskId,
        kind: "task_update",
        actor: approval.mode === "none" ? "service" : approval.mode,
        message: sensitive ? "sensitive update" : "update",
        data: { sensitive: Boolean(sensitive) },
        mutate: () =>
          upsertTaskRecord(
            {
              ...task,
              name: nextConfig.name,
              description: nextConfig.description,
              approvedConfig: nextConfig,
              pendingConfig: null,
              pendingRevision: null,
            },
            { agentDir, expectedTaskRevision: task.revision },
          ),
      });
      return projectTask(updated);
    } catch (error) {
      wrap(error);
    }
  },

  async activate(
    taskId: string,
    expectedRevision: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
      if (task.status === "archived") {
        throw new AutomationServiceError("Task archived", { status: 409, code: "archived" });
      }
      if (task.revision !== expectedRevision) {
        throw new AutomationServiceError("Revision conflict", {
          status: 409,
          code: "revision_conflict",
        });
      }
      const config = task.pendingConfig ?? task.approvedConfig;
      // Resume uses its own approval action so challenge/action binding cannot be confused with activate.
      const approvalAction =
        task.status === "paused" || task.status === "blocked" ? "resume" : "activate";
      requireApproval(approval.mode, approvalAction, {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        taskId,
        revision: task.revision,
        policyHash: config.authority.policyHash,
        cwd: config.target.cwd,
      });

      // Approval expiry / consecutive-failure / budget gates before becoming active.
      if (config.authority.approvalExpiresAt) {
        const exp = Date.parse(config.authority.approvalExpiresAt);
        if (Number.isFinite(exp) && exp <= Date.now()) {
          throw new AutomationServiceError("Approval expired", {
            status: 403,
            code: "approval_expired",
            blockedReason: "approval_expired",
          });
        }
      }
      // Persistent pause after consecutive failures: human-approved resume clears the counter.
      const clearFailuresOnResume =
        approvalAction === "resume" &&
        task.consecutiveFailures >=
          (config.authority.budgets?.consecutiveFailureThreshold ?? 3);

      // Live policy check at activation against real target-cwd resources (not synthesized snapshots).
      // Must await actual ESM SDK schemas + executable digests before freezing/intersecting.
      const discovered = await discoverLiveCatalogForTargetCwd({
        cwd: config.target.cwd,
        approvedTools: config.authority.tools,
      });
      const live = buildLivePolicyForTargetCwd({
        cwd: config.target.cwd,
        approvedTools: config.authority.tools,
        discovered,
      });
      const modelAvailable = await probeModelAvailability({
        cwd: config.target.cwd,
        provider: config.agent.provider,
        modelId: config.agent.modelId,
      });
      const credentialHandlesOk = probeCredentialHandlesOk(config.authority.credentialHandles);
      const preflight = staticPreflight({
        cwd: config.target.cwd,
        cwdExists: existsSync(config.target.cwd),
        modelAvailable,
        credentialHandlesOk,
        authority: config.authority,
        live,
      });
      if (!preflight.ok) {
        // prepared → mutation → committed audit for activation-preflight block
        await commitMutationWithAudit({
          agentDir,
          runId: `task:${taskId}`,
          taskId,
          kind: "task_activate_preflight_blocked",
          actor: approval.mode,
          message: preflight.message ?? "activation preflight blocked",
          data: { blockedReason: preflight.blockedReason },
          mutate: () =>
            upsertTaskRecord(
              {
                ...task,
                status: "blocked",
                blockedReason: (preflight.blockedReason ?? "policy_violation") as AutomationBlockedReason,
                approvedConfig: config,
                pendingConfig: null,
                pendingRevision: null,
              },
              { agentDir, expectedTaskRevision: task.revision },
            ),
        });
        throw new AutomationServiceError(preflight.message ?? "Blocked", {
          status: 409,
          code: "blocked",
          blockedReason: preflight.blockedReason ?? undefined,
        });
      }

      const nextRunAt = getNextRunAt({
        cron: config.schedule.cron,
        timezone: config.schedule.timezone,
      });

      const updated = await commitMutationWithAudit({
        agentDir,
        runId: `task:${taskId}`,
        taskId,
        kind: approvalAction === "resume" ? "task_resume" : "task_activate",
        actor: approval.mode,
        message: approvalAction === "resume" ? "resume" : "activate",
        data: { nextRunAt },
        mutate: () =>
          upsertTaskRecord(
            {
              ...task,
              status: "active",
              blockedReason: null,
              approvedConfig: config,
              pendingConfig: null,
              pendingRevision: null,
              approvedRevision: `approved-${Date.now().toString(36)}`,
              approvedAt: nowIso(),
              nextRunAt,
              // Human-approved resume after consecutive-failure pause clears the streak.
              consecutiveFailures:
                clearFailuresOnResume || approvalAction === "resume" ? 0 : task.consecutiveFailures,
            },
            { agentDir, expectedTaskRevision: task.revision },
          ),
      });
      void startAutomationScheduler({ agentDir });
      return projectTask(updated);
    } catch (error) {
      wrap(error);
    }
  },

  async pause(taskId: string, expectedRevision: string, agentDir?: string) {
    try {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
      if (task.revision !== expectedRevision) {
        throw new AutomationServiceError("Revision conflict", {
          status: 409,
          code: "revision_conflict",
        });
      }
      if (task.status !== "active") {
        throw new AutomationServiceError("Only active tasks can be paused", { code: "validation" });
      }
      const updated = await commitMutationWithAudit({
        agentDir,
        runId: `task:${taskId}`,
        taskId,
        kind: "task_pause",
        actor: "service",
        message: "pause",
        mutate: () =>
          upsertTaskRecord(
            { ...task, status: "paused" },
            { agentDir, expectedTaskRevision: expectedRevision },
          ),
      });
      return projectTask(updated);
    } catch (error) {
      wrap(error);
    }
  },

  async archive(
    taskId: string,
    expectedRevision: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
      requireApproval(approval.mode, "archive", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        taskId,
        revision: expectedRevision,
        policyHash: task.approvedConfig.authority.policyHash,
        cwd: task.approvedConfig.target.cwd,
      });
      const updated = await commitMutationWithAudit({
        agentDir,
        runId: `task:${taskId}`,
        taskId,
        kind: "task_archive",
        actor: approval.mode,
        message: "archive",
        mutate: () => deleteTaskRecordSoft(taskId, expectedRevision, agentDir),
      });
      return projectTask(updated);
    } catch (error) {
      wrap(error);
    }
  },

  async runNow(
    taskId: string,
    expectedRevision: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) throw new AutomationServiceError("Task not found", { status: 404, code: "not_found" });
      if (task.revision !== expectedRevision) {
        throw new AutomationServiceError("Revision conflict", {
          status: 409,
          code: "revision_conflict",
        });
      }
      if (task.status === "archived") {
        throw new AutomationServiceError("Task archived", { status: 409, code: "archived" });
      }
      requireApproval(approval.mode, "run_now", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        taskId,
        revision: expectedRevision,
        policyHash: task.approvedConfig.authority.policyHash,
        cwd: task.approvedConfig.target.cwd,
      });
      if (task.status !== "active" && task.status !== "paused") {
        // allow run-now on draft only after activate; keep draft safe
        if (task.status === "draft") {
          throw new AutomationServiceError("Activate task before run-now", {
            status: 409,
            code: "validation",
          });
        }
      }
      void startAutomationScheduler({ agentDir });
      const run = await commitMutationWithAudit({
        agentDir,
        runId: `task:${taskId}:run-now`,
        taskId,
        kind: "run_now",
        actor: approval.mode,
        message: "run_now",
        mutate: async () => enqueueManualRun({ taskId, agentDir }),
      });
      // Also chain audit under the concrete run id for run-scoped readers.
      try {
        await appendAuditEvent({
          runId: run.id,
          taskId,
          kind: "manual_enqueue",
          actor: approval.mode,
          message: "run_now",
          agentDir,
        });
      } catch (auditErr) {
        try {
          await appendAuditEvent({
            runId: run.id,
            taskId,
            kind: "repair_required",
            actor: "system",
            message: `Audit failure after run_now: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            agentDir,
          });
        } catch {
          throw new AutomationServiceError(
            `run_now succeeded but audit failed and repair journal could not be written: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
            { status: 500, code: "repair_required" },
          );
        }
      }
      return projectRun(run, agentDir);
    } catch (error) {
      wrap(error);
    }
  },

  listRuns(taskId?: string, agentDir?: string, offset = 0, limit = 50) {
    // Full scan for accurate totals — never truncate the universe to newest 10k.
    const all = listRunRecords({ taskId, agentDir }).map((r) => projectRun(r, agentDir));
    const off = Math.max(0, offset);
    const lim = Math.max(1, Math.min(200, limit));
    return {
      runs: all.slice(off, off + lim),
      total: all.length,
      offset: off,
      limit: lim,
    };
  },


  /**
   * Dedicated inbox/summary: one merged, time-ordered run + omission stream
   * with a single offset/limit/total cursor (no dual-cursor page skew).
   */
  getInbox(
    agentDir?: string,
    options?: {
      limit?: number;
      offset?: number;
      /** @deprecated Prefer merged limit/offset. */
      runLimit?: number;
      omissionLimit?: number;
      runOffset?: number;
      omissionOffset?: number;
    },
  ) {
    const limit = Math.max(1, Math.min(500, options?.limit ?? options?.runLimit ?? 50));
    const offset = Math.max(0, options?.offset ?? options?.runOffset ?? 0);
    const allRuns = listRunRecords({ agentDir }).map((r) => projectRun(r, agentDir));
    const { omissions: allOmissions } = listOmissionRecords({ agentDir, limit: 100_000, offset: 0 });
    type Merged =
      | { type: "run"; sortAt: string; run: ReturnType<typeof projectRun> }
      | {
          type: "omission";
          sortAt: string;
          omission: {
            id: string;
            taskId: string;
            kind: string;
            timezone?: string;
            firstLocal?: string;
            lastLocal?: string;
            firstUtc?: string;
            lastUtc?: string;
            count?: number;
            reason?: string;
            createdAt?: string;
          };
        };
    const merged: Merged[] = [];
    for (const run of allRuns) {
      if (!["succeeded", "blocked", "failed", "ambiguous"].includes(String(run.status))) continue;
      merged.push({
        type: "run",
        sortAt: String(run.completedAt || run.createdAt || ""),
        run,
      });
    }
    for (const o of allOmissions) {
      merged.push({
        type: "omission",
        sortAt: String(o.createdAt || o.lastUtc || o.firstUtc || ""),
        omission: {
          id: o.id,
          taskId: o.taskId,
          kind: o.kind,
          timezone: o.timezone ?? undefined,
          firstLocal: o.firstLocal ?? undefined,
          lastLocal: o.lastLocal ?? undefined,
          firstUtc: o.firstUtc ?? undefined,
          lastUtc: o.lastUtc ?? undefined,
          count: o.count ?? undefined,
          reason: o.reason ?? undefined,
          createdAt: o.createdAt ?? undefined,
        },
      });
    }
    merged.sort((a, b) => b.sortAt.localeCompare(a.sortAt));
    const total = merged.length;
    const page = merged.slice(offset, offset + limit);
    const runs = page.filter((x): x is Extract<Merged, { type: "run" }> => x.type === "run").map((x) => x.run);
    const omissions = page
      .filter((x): x is Extract<Merged, { type: "omission" }> => x.type === "omission")
      .map((x) => x.omission);
    return {
      items: page,
      total,
      offset,
      limit,
      runs,
      runsTotal: total,
      runsOffset: offset,
      runsLimit: limit,
      omissions,
      omissionsTotal: total,
      omissionsOffset: offset,
      omissionsLimit: limit,
    };
  },

  getRun(runId: string, agentDir?: string) {
    const run = readRunRecord(runId, agentDir);
    if (!run) throw new AutomationServiceError("Run not found", { status: 404, code: "not_found" });
    return projectRun(run, agentDir);
  },

  async cancelRun(
    runId: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const run = readRunRecord(runId, agentDir);
      if (!run) throw new AutomationServiceError("Run not found", { status: 404, code: "not_found" });
      const task = getTaskRecord(run.taskId, agentDir);
      requireApproval(approval.mode, "cancel_run", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        runId,
        taskId: run.taskId,
        cwd: run.cwd,
        policyHash: task?.approvedConfig.authority.policyHash,
        revision: task?.revision,
      });
      const updated = await commitMutationWithAudit({
        agentDir,
        runId,
        taskId: run.taskId,
        kind: "run_cancel",
        actor: approval.mode,
        message: "cancel_run",
        mutate: () => requestRunCancel(runId, agentDir),
      });
      return projectRun(updated, agentDir);
    } catch (error) {
      wrap(error);
    }
  },

  getRunSession(runId: string, agentDir?: string, offset?: number, limit?: number) {
    const transcript = readAutomationTranscript({ runId, agentDir, offset, limit });
    // Parity with UI: paginated transcript AND changes projection together.
    const changes = readAutomationRunChanges({ runId, agentDir });
    return { ...transcript, changes };
  },

  getRunChanges(runId: string, agentDir?: string) {
    return readAutomationRunChanges({ runId, agentDir });
  },

  async promoteRun(
    runId: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const run = readRunRecord(runId, agentDir);
      if (!run) throw new AutomationServiceError("Run not found", { status: 404, code: "not_found" });
      const task = getTaskRecord(run.taskId, agentDir);
      requireApproval(approval.mode, "promote", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        runId,
        taskId: run.taskId,
        cwd: run.cwd,
        policyHash: task?.approvedConfig.authority.policyHash,
        revision: task?.revision,
      });
      const promo = await commitMutationWithAudit({
        agentDir,
        runId,
        taskId: run.taskId,
        kind: "run_promote",
        actor: approval.mode,
        message: "promote",
        mutate: () => promoteAutomationRun({ runId, agentDir }),
      });
      return promo;
    } catch (error) {
      wrap(error);
    }
  },

  async deleteRunArtifacts(
    runId: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      const run = readRunRecord(runId, agentDir);
      if (!run) throw new AutomationServiceError("Run not found", { status: 404, code: "not_found" });
      if (!run.terminal) {
        throw new AutomationServiceError("Cannot delete artifacts of non-terminal run", {
          code: "validation",
        });
      }
      if (!run.session.sealed && run.session.availability === "available") {
        throw new AutomationServiceError("Cannot delete unsealed session", { code: "validation" });
      }
      const task = getTaskRecord(run.taskId, agentDir);
      requireApproval(approval.mode, "delete_artifacts", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        runId,
        taskId: run.taskId,
        cwd: run.cwd,
        policyHash: task?.approvedConfig.authority.policyHash,
        revision: task?.revision,
      });
      await commitMutationWithAudit({
        agentDir,
        runId,
        taskId: run.taskId,
        kind: "artifacts_deleted",
        actor: approval.mode,
        message: "artifacts deleted; tombstone retained",
        mutate: () => {
          if (run.session.sessionFile) {
            removePathBestEffort(run.session.sessionFile);
          }
          // Explicit delete MUST update the separate retention projection.
          // Never suppress projection failure or claim committed while readers still say available.
          // Never mutates the immutable terminal run snapshot.
          writeRunRetentionProjection(
            {
              ...run,
              session: {
                ...run.session,
                sessionFile: null,
                availability: "unavailable",
                unavailableReason: "artifacts_deleted",
              },
              artifactsPurgedAt: new Date().toISOString(),
            } as never,
            agentDir,
          );
          // Postcondition: projection must report purged/unavailable.
          const proj = readRunRetentionProjection(runId, agentDir);
          if (!proj || proj.sessionAvailability === "available") {
            throw new AutomationServiceError(
              "Artifact deletion retention projection failed postcondition (still available)",
              { status: 500, code: "repair_required" },
            );
          }
          return { ok: true as const, runId };
        },
      });
      return { ok: true, runId };
    } catch (error) {
      wrap(error);
    }
  },

  schedulerStatus(agentDir?: string) {
    return getAutomationSchedulerStatus(agentDir);
  },

  async repairSchedulerLock(
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    try {
      requireApproval(approval.mode, "repair_scheduler", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
      });
      const result = await commitMutationWithAudit({
        agentDir,
        runId: "scheduler:repair",
        taskId: "scheduler",
        kind: "scheduler_repair",
        actor: approval.mode,
        message: "repair_scheduler_lock",
        mutate: () => repairAutomationLock("scheduler", agentDir),
      });
      void startAutomationScheduler({ agentDir });
      return result;
    } catch (error) {
      wrap(error);
    }
  },

  async createBrowserApproval(input: {
    action: ApprovalAction;
    taskId?: string;
    runId?: string;
    revision?: string;
    proposedConfig?: unknown;
    controlSessionRaw: string;
    agentDir?: string;
  }) {
    let summary = [`Action: ${input.action}`];
    let summaryStructured: ReturnType<typeof buildAuthoritySummaryModel> & {
      action: string;
      proposedConfigHash?: string | null;
      runId?: string | null;
      runStatus?: string | null;
    } = { action: input.action } as never;
    let policyHash: string | undefined;
    let cwd: string | undefined;
    let proposedConfigHash: string | undefined;
    let taskId = input.taskId;
    let revision = input.revision;

    if (input.proposedConfig) {
      proposedConfigHash = hashProposedConfig(input.proposedConfig);
      summary.push(`Proposed config hash: ${proposedConfigHash.slice(0, 16)}`);
    }

    if (input.taskId) {
      const task = getTaskRecord(input.taskId, input.agentDir);
      if (task) {
        // For update_sensitive, rebuild the same full config updateTask will require.
        let config = task.pendingConfig ?? task.approvedConfig;
        if (input.action === "update_sensitive" && input.proposedConfig && typeof input.proposedConfig === "object") {
          const patch = input.proposedConfig as Partial<Parameters<typeof buildTaskConfigFromInput>[0]>;
          const base = task.pendingConfig ?? task.approvedConfig;
          config = await buildTaskConfigFromInput({
            name: patch.name ?? base.name,
            description: patch.description ?? base.description,
            cron: patch.cron ?? base.schedule.cron,
            timezone: patch.timezone ?? base.schedule.timezone,
            cwd: patch.cwd ?? base.target.cwd,
            cwdSource: patch.cwdSource ?? base.target.cwdSource,
            provider: patch.provider ?? base.agent.provider,
            modelId: patch.modelId ?? base.agent.modelId,
            thinking: patch.thinking !== undefined ? patch.thinking : base.agent.thinking,
            prompt: patch.prompt ?? base.agent.prompt,
            maxRuntimeMs: patch.maxRuntimeMs ?? base.agent.maxRuntimeMs,
            tools: patch.tools ?? base.authority.tools.map((t) => ({
              name: t.name,
              origin: t.origin,
              sourcePath: t.sourcePath,
            })),
            budgets: patch.budgets
              ? { ...base.authority.budgets, ...patch.budgets }
              : base.authority.budgets,
            approvalExpiresAt:
              patch.approvalExpiresAt !== undefined
                ? patch.approvalExpiresAt
                : base.authority.approvalExpiresAt,
            agentDir: input.agentDir,
          });
          proposedConfigHash = hashProposedConfig(config);
          summary = [
            `Action: update_sensitive (proposed mutation)`,
            ...buildAuthoritySummary(config),
            `Proposed config hash: ${proposedConfigHash.slice(0, 16)}`,
          ];
        } else {
          summary = [`Action: ${input.action}`, ...buildAuthoritySummary(config)];
        }
        summaryStructured = {
          action: input.action,
          ...buildAuthoritySummaryModel(config),
          proposedConfigHash: proposedConfigHash ?? null,
        };
        policyHash = config.authority.policyHash;
        cwd = config.target.cwd;
        revision = revision ?? task.revision;
      }
    }
    if (input.runId) {
      const run = readRunRecord(input.runId, input.agentDir);
      if (run) {
        summary.push(`Run: ${run.id}`, `Status: ${run.status}`, `Cwd: ${run.cwd}`);
        cwd = run.cwd;
        taskId = taskId ?? run.taskId;
        // Export/cancel/delete/promote bind the same policyHash/revision/cwd as create.
        const task = getTaskRecord(run.taskId, input.agentDir);
        if (!policyHash) {
          policyHash = task?.approvedConfig.authority.policyHash;
        }
        if (!revision) {
          revision = task?.revision;
        }
        if (task) {
          summary.push(...buildAuthoritySummary(task.approvedConfig).slice(0, 8));
          summaryStructured = {
            action: input.action,
            ...buildAuthoritySummaryModel(task.approvedConfig),
            proposedConfigHash: proposedConfigHash ?? null,
            runId: run.id,
            runStatus: run.status,
          };
        } else {
          summaryStructured = {
            ...summaryStructured,
            action: input.action,
            runId: run.id,
            runStatus: run.status,
            cwd: run.cwd,
          };
        }
      }
    }
    // Normalize export alias.
    const action = input.action === "export" ? "export_run" : input.action;
    summaryStructured = { ...summaryStructured, action };
    return createApprovalChallenge({
      action,
      taskId,
      runId: input.runId,
      revision,
      policyHash,
      cwd,
      proposedConfigHash,
      summary,
      summaryStructured,
      controlSessionRaw: input.controlSessionRaw,
    });
  },

  /** Second step after AppDialog: deliver one-time secret only after explicit confirm. */
  confirmBrowserApproval(input: { challengeId: string; controlSessionRaw: string }) {
    return confirmApprovalChallenge({
      challengeId: input.challengeId,
      controlSessionRaw: input.controlSessionRaw,
    });
  },

  /** Export a sealed run transcript (approval-bound). Marks export-in-flight for retention. */
  async exportRun(
    runId: string,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ): Promise<{ runId: string; content: Buffer; filename: string }> {
    try {
      const run = readRunRecord(runId, agentDir);
      if (!run) throw new AutomationServiceError("Run not found", { status: 404, code: "not_found" });
      const task = getTaskRecord(run.taskId, agentDir);
      requireApproval(approval.mode, "export_run", {
        challengeId: approval.challengeId,
        secret: approval.secret,
        controlSessionRaw: approval.controlSessionRaw,
        runId,
        taskId: run.taskId,
        cwd: run.cwd,
        policyHash: task?.approvedConfig.authority.policyHash,
        revision: task?.revision,
      });
      // Cross-process owner+exportId lease — only this exporter removes its own entry.
      const {
        acquireExportLease,
        releaseExportLease,
      } = await import("./automation-retention");
      const lease = await acquireExportLease(runId, agentDir);
      try {
        const content = await commitMutationWithAudit({
          agentDir,
          runId,
          taskId: run.taskId,
          kind: "export_run",
          actor: approval.mode,
          message: "run exported",
          data: { exportId: lease.exportId, ownerId: lease.ownerId },
          mutate: async () => {
            const session = readAutomationTranscript({ runId, agentDir });
            const file = session.session.sessionFile;
            if (!file || !existsSync(file)) {
              throw new AutomationServiceError("No session file", { status: 404, code: "not_found" });
            }
            const { readFileSync: readFs } = await import("fs");
            return readFs(file);
          },
        });
        return { runId, content, filename: `automation-${runId}.jsonl` };
      } finally {
        await releaseExportLease(runId, agentDir, {
          ownerId: lease.ownerId,
          exportId: lease.exportId,
        });
      }
    } catch (error) {
      wrap(error);
    }
  },

  async setDisabled(
    disabled: boolean,
    approval: {
      mode: "browser" | "ui" | "none";
      challengeId?: string;
      secret?: string;
      controlSessionRaw?: string;
    },
    agentDir?: string,
  ) {
    requireApproval(approval.mode, "set_global_disabled", {
      challengeId: approval.challengeId,
      secret: approval.secret,
      controlSessionRaw: approval.controlSessionRaw,
    });
    await commitMutationWithAudit({
      agentDir,
      runId: "scheduler:global-disable",
      taskId: "scheduler",
      kind: "global_disable",
      actor: approval.mode,
      message: disabled ? "global_disable_on" : "global_disable_off",
      data: { disabled },
      mutate: () => setGlobalDisabled(disabled, agentDir),
    });
    return this.schedulerStatus(agentDir);
  },

  catalog() {
    // Kick async SDK schema load; return best-available catalog (cached actual when warm).
    void import("./automation-resource-catalog").then((m) => m.loadActualBuiltinToolSchemasAsync());
    return defaultAutomationCatalog().map((t) => ({
      name: t.name,
      description: t.description,
      origin: t.origin,
      blocked: t.risks.blocked,
      risks: t.risks,
      sourceIdentity: t.sourceIdentity,
    }));
  },

  async catalogAsync() {
    const { defaultAutomationCatalogAsync } = await import("./automation-resource-catalog");
    const cat = await defaultAutomationCatalogAsync();
    return cat.map((t) => ({
      name: t.name,
      description: t.description,
      origin: t.origin,
      blocked: t.risks.blocked,
      risks: t.risks,
      sourceIdentity: t.sourceIdentity,
    }));
  },

  /** Target-cwd live tool catalog (no unapproved extension import). */
  async catalogForCwd(cwd: string, approvedTools?: AutomationTaskConfig["authority"]["tools"]) {
    const { existsSync } = await import("fs");
    if (!cwd?.trim() || !existsSync(cwd)) {
      // Nonexistent/unauthorized cwd: fail closed with empty catalog (never full static).
      return [];
    }
    const discovered = await discoverLiveCatalogForTargetCwd({ cwd, approvedTools });
    const live = buildLivePolicyForTargetCwd({ cwd, approvedTools, discovered });
    return live.tools.map((t) => {
      const schema = (t as { schema?: unknown }).schema;
      const schemaObj =
        schema && typeof schema === "object" ? (schema as Record<string, unknown>) : null;
      const hookInventory =
        (t as { hookInventory?: string[] }).hookInventory ??
        (Array.isArray(schemaObj?.hooks) ? (schemaObj!.hooks as string[]) : undefined);
      const packageClosure = Array.isArray(schemaObj?.packageClosure)
        ? (schemaObj!.packageClosure as string[])
        : undefined;
      const executableDigest = (t as { executableDigest?: string }).executableDigest;
      const schemaHash = (t as { schemaHash?: string }).schemaHash;
      const configHash = (t as { configHash?: string }).configHash;
      return {
        name: t.name,
        description: t.description,
        origin: t.origin,
        blocked: t.risks.blocked,
        risks: t.risks,
        sourceIdentity: t.sourceIdentity,
        sourcePath: t.sourcePath,
        // Actual registration surface for reviewed extensions (and builtin schema identity).
        schema,
        hookInventory,
        packageClosure,
        executableDigest,
        schemaHash,
        configHash,
      };
    });
  },

  async modelsForCwd(cwd: string) {
    const { existsSync } = await import("fs");
    if (!cwd?.trim() || !existsSync(cwd)) return [];
    return listModelsForTargetCwd({ cwd });
  },

  /** Resolve stable default cwd canonical path for UI target requests. */
  resolveDefaultCwdCanonical(agentDir?: string): string | null {
    try {
      return ensureAutomationDefaultCwd(agentDir).canonical;
    } catch {
      return null;
    }
  },

  catalogLegacy() {
    return defaultBuiltinCatalog().map((t) => ({
      name: t.name,
      description: t.description,
      origin: t.origin,
      risks: t.risks,
      blocked: t.risks.blocked,
    }));
  },

  /** Live next-run preview helper for editor. */
  previewSchedule(input: { cron: string; timezone: string; count?: number }) {
    validateScheduleConfig({ cron: input.cron, timezone: input.timezone });
    return previewNextRuns({
      cron: input.cron,
      timezone: input.timezone,
      count: input.count ?? 5,
    });
  },

  /**
   * Startup/tick reconciliation of prepared-but-uncommitted audit transactions.
   * Commits when postcondition proves the mutation landed; otherwise marks repair_required.
   */
  async reconcilePreparedAudits(agentDir?: string): Promise<{
    scanned: number;
    committed: number;
    repairRequired: number;
  }> {
    return reconcilePreparedAuditTransactions(agentDir);
  },
};

/**
 * Reconcile audit chains that end on prepared:* without a matching committed kind.
 * Safe to call from scheduler startup/tick under store lock.
 */
export async function reconcilePreparedAuditTransactions(agentDir?: string): Promise<{
  scanned: number;
  committed: number;
  repairRequired: number;
}> {
  ensureAutomationLayout(agentDir);
  const ids = listAuditProjectionIds(agentDir);
  let committed = 0;
  let repairRequired = 0;
  await withAutomationStoreLock(async () => {
    for (const runId of ids) {
      const proj = readAuditProjection(runId, agentDir);
      if (!proj?.events?.length) continue;
      const events = proj.events;
      // Match every prepared:* event by transaction id (not merely last kind).
      for (const event of events) {
        if (!event.kind.startsWith("prepared:")) continue;
        const kind = event.kind.slice("prepared:".length);
        const txnId =
          event.data && typeof event.data === "object"
            ? String((event.data as { transactionId?: string }).transactionId ?? "")
            : "";
        const hasMatch = events.some((e) => {
          if (e.seq === event.seq) return false;
          const eTxn =
            e.data && typeof e.data === "object"
              ? String((e.data as { transactionId?: string }).transactionId ?? "")
              : "";
          if (txnId) {
            return (
              eTxn === txnId &&
              (e.kind === kind || e.kind === "repair_required")
            );
          }
          // Legacy events without transactionId: only the trailing prepared may reconcile by kind.
          return e.seq > event.seq && (e.kind === kind || e.kind === "repair_required");
        });
        if (hasMatch) continue;
        // Only reconcile open prepared events (no later event for this txn).
        const proven = proveAuditMutationPostcondition({
          runId,
          taskId: proj.taskId,
          kind,
          data: event.data as Record<string, unknown> | undefined,
          agentDir,
        });
        if (proven) {
          appendAuditEventUnlocked({
            runId,
            taskId: proj.taskId,
            kind,
            actor: "reconcile",
            message: `committed:reconciled after crash (${kind})`,
            data: { ...(event.data as object), reconciled: true, transactionId: txnId || undefined },
            agentDir,
          });
          committed += 1;
        } else {
          appendAuditEventUnlocked({
            runId,
            taskId: proj.taskId,
            kind: "repair_required",
            actor: "reconcile",
            message: `Prepared audit without proven mutation: ${kind}`,
            data: { preparedKind: kind, transactionId: txnId || undefined, ...(event.data as object) },
            agentDir,
          });
          repairRequired += 1;
        }
      }
    }
  }, { agentDir });
  return { scanned: ids.length, committed, repairRequired };
}

function proveAuditMutationPostcondition(input: {
  runId: string;
  taskId: string;
  kind: string;
  data?: Record<string, unknown>;
  agentDir?: string;
}): boolean {
  const { kind, runId, taskId, agentDir } = input;
  try {
    if (kind === "artifacts_deleted") {
      const proj = readRunRetentionProjection(runId, agentDir);
      return Boolean(
        proj &&
          (proj.artifactsPurgedAt ||
            proj.sessionAvailability === "unavailable" ||
            proj.unavailableReason === "artifacts_deleted"),
      );
    }
    if (kind === "preflight_blocked") {
      const run = readRunRecord(runId, agentDir);
      return Boolean(run && run.terminal === true && run.status === "blocked");
    }
    if (kind === "run_late_settlement" || kind === "late_settlement") {
      const run = readRunRecord(runId, agentDir);
      return Boolean(run && run.terminal === true);
    }
    if (kind.startsWith("run_")) {
      const run = readRunRecord(runId, agentDir);
      if (!run) return false;
      const status = kind.slice("run_".length);
      return run.terminal === true && run.status === status;
    }
    if (
      kind === "task_activate" ||
      kind === "task_resume" ||
      kind === "task_activate_preflight_blocked" ||
      kind === "task_create" ||
      kind === "task_pause" ||
      kind === "task_archive"
    ) {
      const task = getTaskRecord(taskId, agentDir);
      if (!task) return false;
      if (kind === "task_activate" || kind === "task_resume") return task.status === "active";
      if (kind === "task_activate_preflight_blocked") return task.status === "blocked";
      if (kind === "task_pause") return task.status === "paused";
      if (kind === "task_archive") return task.status === "archived";
      if (kind === "task_create") return true;
    }
    // task_update cannot be proven from durable state alone (repeated same-kind ops);
    // leave open prepared events for repair_required so operators can inspect.
    if (kind === "global_disable") {
      return true; // config file presence is enough; status reader converges
    }
    if (kind === "scheduler_repair") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// re-export staticPreflight for tests
export { staticPreflight };
void rmSync;
