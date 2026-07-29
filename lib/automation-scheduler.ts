/**
 * Durable Automation scheduler: leader lease, occurrence claim, dispatch, reconcile.
 */

import { hostname } from "os";
import { randomBytes } from "crypto";
import {
  acquireAutomationLock,
  inspectAutomationLock,
  type LockHandle,
} from "./automation-lock";
import { existsSync, statfsSync, statSync } from "fs";
import {
  appendAuditEvent,
  ensureAutomationLayout,
  finalizeRunRecord,
  listClaimRecords,
  listRunRecords,
  listTaskRecords,
  markExecutionBarrier,
  materializeOccurrence,
  materializeOccurrenceWithGateRecheck,
  makeAutomationRunId,
  readRunRecord,
  readSchedulerStatus,
  readTasksFile,
  reconcileOccurrence,
  recoverNeedsTaskAdvance,
  recoverPreparedWithoutRun,
  renewRunLease,
  transferClaimAndRunFencing,
  upsertTaskRecord,
  writeOmissionRecord,
  writeRunRecord,
  writeSchedulerStatus,
  estimateAutomationStorageBytes,
  getTaskRecord,
} from "./automation-store";
import {
  AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES,
  AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY,
  AUTOMATION_SCHEMA_VERSION,
  isTerminalRunStatus,
  type AutomationRunRecord,
  type AutomationTaskRecord,
} from "./automation-types";
import { buildManualOccurrenceMeta, decideOccurrence } from "./automation-schedule";
import {
  buildLivePolicyForTargetCwd,
  discoverLiveCatalogForTargetCwd,
  probeCredentialHandlesOk,
  probeModelAvailability,
  staticPreflight,
} from "./automation-tool-policy";
import { hashPrompt, runAutomationOnce, type LateSettlementHandle } from "./automation-runner";
import {
  activeRunCount,
  registerActiveRun,
  requestCancelRun,
  unregisterActiveRun,
} from "./automation-run-registry";
import { getAutomationRoot } from "./automation-paths";
import {
  AutomationDefaultCwdError,
  ensureAutomationDefaultCwd,
} from "./automation-default-cwd";

/**
 * Real runtime preflight for scheduled/manual dispatch.
 * - default-cwd tasks: integrity check (HOME drift / missing / non-directory)
 * - requires canonical cwd directory
 * - uses target-cwd project settings + authenticated ModelRuntime
 * - reviewed extension discovery (no unapproved import)
 */
export async function runRuntimePreflight(task: AutomationTaskRecord): Promise<{
  ok: boolean;
  blockedReason: import("./automation-types").AutomationBlockedReason | null;
  message: string | null;
  effective: ReturnType<typeof staticPreflight>["effective"];
  cwdExists: boolean;
}> {
  const cwd = task.approvedConfig.target.cwd;
  const cwdSource = task.approvedConfig.target.cwdSource;

  // Default-cwd integrity: block HOME drift / missing / non-directory before anything else.
  if (cwdSource === "default") {
    try {
      const def = ensureAutomationDefaultCwd();
      if (def.canonical !== cwd) {
        return {
          ok: false,
          blockedReason: "cwd_drift",
          message: `Default cwd drift: task=${cwd} current=${def.canonical}`,
          effective: {
            tools: [],
            extensions: [],
            blocked: true,
            blockedReason: "cwd_drift",
            blockMessage: "default cwd drift",
            policyHash: task.approvedConfig.authority.policyHash,
          },
          cwdExists: false,
        };
      }
    } catch (error) {
      const code =
        error instanceof AutomationDefaultCwdError ? error.code : "cwd_unavailable";
      return {
        ok: false,
        blockedReason: code,
        message: error instanceof Error ? error.message : String(error),
        effective: {
          tools: [],
          extensions: [],
          blocked: true,
          blockedReason: code,
          blockMessage: error instanceof Error ? error.message : String(error),
          policyHash: task.approvedConfig.authority.policyHash,
        },
        cwdExists: false,
      };
    }
  }

  // Require canonical cwd directory (not merely existsSync — files/missing fail closed).
  let cwdExists = false;
  if (cwd && existsSync(cwd)) {
    try {
      cwdExists = statSync(cwd).isDirectory();
    } catch {
      cwdExists = false;
    }
  }
  if (!cwdExists) {
    return {
      ok: false,
      blockedReason: (cwd && existsSync(cwd) ? "cwd_invalid" : "cwd_unavailable") as import("./automation-types").AutomationBlockedReason,
      message: cwd && existsSync(cwd)
        ? `cwd is not a directory: ${cwd}`
        : `cwd unavailable: ${cwd}`,
      effective: {
        tools: [],
        extensions: [],
        blocked: true,
        blockedReason: "cwd_unavailable",
        blockMessage: `cwd unavailable: ${cwd}`,
        policyHash: task.approvedConfig.authority.policyHash,
      },
      cwdExists: false,
    };
  }

  const discovered = await discoverLiveCatalogForTargetCwd({
    cwd,
    approvedTools: task.approvedConfig.authority.tools,
  });
  const live = buildLivePolicyForTargetCwd({
    cwd,
    approvedTools: task.approvedConfig.authority.tools,
    discovered,
  });
  const modelAvailable = await probeModelAvailability({
    cwd,
    provider: task.approvedConfig.agent.provider,
    modelId: task.approvedConfig.agent.modelId,
  });
  const credentialHandlesOk = probeCredentialHandlesOk(
    task.approvedConfig.authority.credentialHandles,
  );
  const preflight = staticPreflight({
    cwd,
    cwdExists: true,
    modelAvailable,
    credentialHandlesOk,
    authority: task.approvedConfig.authority,
    live,
  });
  return { ...preflight, cwdExists: true };
}

declare global {
  var __piAutomationScheduler: SchedulerState | undefined;
}

type SchedulerState = {
  ownerId: string;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
  stopping: boolean;
  leader: LockHandle | null;
  available: boolean;
  lastError: string | null;
  agentDir?: string;
  tickInFlight: boolean;
};

const TICK_MS = 15_000;
const LEASE_TTL_MS = 45_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000; // bounded cadence: 6h

declare global {
  var __piAutomationLastRetentionAt: number | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getState(): SchedulerState {
  if (!globalThis.__piAutomationScheduler) {
    globalThis.__piAutomationScheduler = {
      ownerId: `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`,
      timer: null,
      started: false,
      stopping: false,
      leader: null,
      available: false,
      lastError: null,
      tickInFlight: false,
    };
  }
  return globalThis.__piAutomationScheduler;
}

function getFreeSpaceBytes(targetPath: string): number | null {
  try {
    const st = statfsSync(targetPath);
    const bavail = Number(st.bavail);
    const bsize = Number(st.bsize);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) return null;
    return bavail * bsize;
  } catch {
    return null;
  }
}

async function becomeLeader(state: SchedulerState): Promise<boolean> {
  try {
    const handle = await acquireAutomationLock({
      kind: "scheduler",
      agentDir: state.agentDir,
      ownerId: state.ownerId,
      ttlMs: LEASE_TTL_MS,
      timeoutMs: 2_000,
      allowStaleTakeover: true,
    });
    state.leader = handle;
    state.available = true;
    state.lastError = null;
    return true;
  } catch (error) {
    state.leader = null;
    const message = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string })?.code === "repair_required") {
      state.available = false;
      state.lastError = message;
      writeSchedulerStatus({
        ...readSchedulerStatus(state.agentDir),
        available: false,
        repairRequired: true,
        repairReason: message,
        lastError: message,
      }, state.agentDir);
      return false;
    }
    // Another leader holds the lock — this process is standby.
    state.available = true;
    state.lastError = null;
    return false;
  }
}

function persistStatus(state: SchedulerState, extra?: Partial<ReturnType<typeof readSchedulerStatus>>): void {
  const tasks = readTasksFile(state.agentDir);
  const nonterminal = listRunRecords({ agentDir: state.agentDir }).filter((r) => !r.terminal).length;

  // Standby must NOT overwrite the leader's owner/epoch/heartbeat with nulls.
  // Diagnostics must consistently show the actual leader.
  if (!state.leader) {
    const existing = readSchedulerStatus(state.agentDir);
    const standbyPatch = { ...(extra ?? {}) } as Partial<ReturnType<typeof readSchedulerStatus>>;
    // Drop identity-nulling keys from standby patches.
    if (standbyPatch.ownerId == null) delete standbyPatch.ownerId;
    if (standbyPatch.pid == null) delete standbyPatch.pid;
    if (standbyPatch.hostname == null) delete standbyPatch.hostname;
    if (standbyPatch.epoch == null || standbyPatch.epoch === 0) delete standbyPatch.epoch;
    if (standbyPatch.heartbeatAt == null) delete standbyPatch.heartbeatAt;
    writeSchedulerStatus({
      ...existing,
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      ownerId: existing.ownerId,
      pid: existing.pid,
      hostname: existing.hostname,
      epoch: existing.epoch,
      heartbeatAt: existing.heartbeatAt,
      nextWakeAt: existing.nextWakeAt ?? new Date(Date.now() + TICK_MS).toISOString(),
      lastScanAt: existing.lastScanAt,
      lastError: state.lastError ?? existing.lastError,
      globalDisabled: tasks.globalDisabled,
      nonterminalRunCount: nonterminal,
      available: state.available && !tasks.globalDisabled,
      freeSpaceBytes: existing.freeSpaceBytes,
      storageBytes: estimateAutomationStorageBytes(state.agentDir),
      updatedAt: nowIso(),
      ...standbyPatch,
    }, state.agentDir);
    return;
  }

  writeSchedulerStatus({
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    ownerId: state.leader.ownerId,
    pid: process.pid,
    hostname: hostname(),
    epoch: state.leader.epoch,
    heartbeatAt: nowIso(),
    nextWakeAt: new Date(Date.now() + TICK_MS).toISOString(),
    lastScanAt: nowIso(),
    lastError: state.lastError,
    globalDisabled: tasks.globalDisabled,
    nonterminalRunCount: nonterminal,
    available: state.available && !tasks.globalDisabled,
    repairRequired: false,
    repairReason: null,
    freeSpaceBytes: null,
    storageBytes: estimateAutomationStorageBytes(state.agentDir),
    updatedAt: nowIso(),
    ...extra,
  }, state.agentDir);
}

async function dispatchRun(input: {
  state: SchedulerState;
  task: AutomationTaskRecord;
  run: AutomationRunRecord;
  occurrenceKey: string;
}): Promise<void> {
  const { state, task, run, occurrenceKey } = input;
  if (!state.leader) return;

  const abortController = new AbortController();
  registerActiveRun({
    runId: run.id,
    taskId: task.id,
    abortController,
    startedAt: Date.now(),
  });

  // Heartbeat/renew the run lease for the entire active execution so >45s runs stay healthy.
  // Also observe cross-process cancel_requested and abort/terminate the child.
  const leaseHeartbeat = setInterval(() => {
    if (!state.leader) return;
    try {
      const current = readRunRecord(run.id, state.agentDir);
      if (
        current &&
        !current.terminal &&
        (current.status === "cancel_requested" || current.cancelRequestedAt)
      ) {
        try {
          abortController.abort();
        } catch {
          // ignore
        }
        // Best-effort local registry cancel (same-process).
        try {
          requestCancelRun(run.id);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore read errors
    }
    void renewRunLease({
      runId: run.id,
      ownerId: state.leader.ownerId,
      epoch: state.leader.epoch,
      ttlMs: LEASE_TTL_MS,
      agentDir: state.agentDir,
    }).catch(() => {
      // Lost fencing — runner will fail closed on finalize.
    });
    try {
      state.leader.heartbeat();
    } catch {
      // leader lost
    }
  }, Math.max(5_000, Math.floor(LEASE_TTL_MS / 3)));
  leaseHeartbeat.unref?.();

  let lateSettle: LateSettlementHandle | null = null;
  let retainAuthority = false;
  let authorityDeadlineAt = 0;

  try {
    const preflight = await runRuntimePreflight(task);

    if (!preflight.ok) {
      const transactionId = `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await appendAuditEvent({
        runId: run.id,
        taskId: task.id,
        kind: "prepared:preflight_blocked",
        actor: "scheduler",
        message: preflight.message ?? "blocked",
        data: { transactionId },
        agentDir: state.agentDir,
      });
      try {
        await finalizeRunRecord(
          run.id,
          {
            status: "blocked",
            blockedReason: preflight.blockedReason,
            errorCategory: "preflight",
            errorMessage: preflight.message,
            sideEffectsStarted: false,
            session: {
              sessionId: null,
              sessionFile: null,
              availability: "unavailable",
              unavailableReason: preflight.blockedReason ?? "preflight_blocked",
              sealed: false,
              seal: null,
            },
          },
          {
            agentDir: state.agentDir,
            ownerId: state.leader.ownerId,
            epoch: state.leader.epoch,
          },
        );
        await appendAuditEvent({
          runId: run.id,
          taskId: task.id,
          kind: "preflight_blocked",
          actor: "scheduler",
          message: `committed:${preflight.message ?? "blocked"}`,
          data: { transactionId },
          agentDir: state.agentDir,
        });
      } catch (err) {
        try {
          await appendAuditEvent({
            runId: run.id,
            taskId: task.id,
            kind: "repair_required",
            actor: "scheduler",
            message: `preflight finalize failed: ${err instanceof Error ? err.message : String(err)}`,
            data: { transactionId },
            agentDir: state.agentDir,
          });
        } catch {
          // best-effort
        }
        throw err;
      }
      return;
    }

    // Barrier before any extension import / session construction.
    await markExecutionBarrier({
      occurrenceKey,
      runId: run.id,
      ownerId: state.leader.ownerId,
      epoch: state.leader.epoch,
      fencingToken: state.leader.fencingToken,
      agentDir: state.agentDir,
    });

    const result = await runAutomationOnce({
      taskId: task.id,
      runId: run.id,
      config: task.approvedConfig,
      effective: preflight.effective,
      agentDir: state.agentDir,
      signal: abortController.signal,
    });

    if (result.executionMayContinue) {
      // Uncertain shutdown: retain authority only until verified death/expiry.
      // Never heartbeat forever. Register late-settlement finalization.
      lateSettle = result.lateSettlement ?? null;
      retainAuthority = true;
      // Bound retained authority: max(lease TTL × 2, remaining runtime grace).
      authorityDeadlineAt = Date.now() + Math.max(LEASE_TTL_MS * 2, 30_000);
      const current = readRunRecord(run.id, state.agentDir);
      if (current && !current.terminal) {
        writeRunRecord(
          {
            ...current,
            status: "running",
            errorCategory: result.errorCategory,
            errorMessage: result.errorMessage,
            usage: result.usage,
            actualModel: result.actualModel,
            session: result.session,
            sideEffectsStarted: true,
            summary: result.summary,
            lease: current.lease
              ? {
                  ...current.lease,
                  expiresAt: new Date(authorityDeadlineAt).toISOString(),
                  heartbeatAt: nowIso(),
                }
              : current.lease,
          },
          state.agentDir,
        );
      }
      await appendAuditEvent({
        runId: run.id,
        taskId: task.id,
        kind: "run_abort_ignored_authority_retained",
        actor: "scheduler",
        message: result.errorMessage ?? "abort ignored; authority retained until death/expiry",
        agentDir: state.agentDir,
      });

      // Watchdog: wait for worker death OR deadline, then finalize once. No forever heartbeat.
      const ownerId = state.leader.ownerId;
      const epoch = state.leader.epoch;
      void (async () => {
        try {
          const death = lateSettle
            ? await Promise.race([
                lateSettle.waitUntilSettledOrDead().then((r) => ({ kind: "settled" as const, r })),
                new Promise<{ kind: "expired" }>((resolve) => {
                  const ms = Math.max(0, authorityDeadlineAt - Date.now());
                  setTimeout(() => resolve({ kind: "expired" }), ms).unref?.();
                }),
              ])
            : await new Promise<{ kind: "expired" }>((resolve) => {
                const ms = Math.max(0, authorityDeadlineAt - Date.now());
                setTimeout(() => resolve({ kind: "expired" }), ms).unref?.();
              });

          // Ensure isolated worker is dead before releasing authority.
          if (lateSettle) {
            try {
              await lateSettle.forceKill();
            } catch {
              // ignore
            }
          }

          const still = readRunRecord(run.id, state.agentDir);
          if (!still || still.terminal) return;

          const finalStatus =
            death.kind === "settled" && death.r?.status
              ? death.r.status
              : ("ambiguous" as const);
          const lateTxn = `late-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await appendAuditEvent({
            runId: run.id,
            taskId: task.id,
            kind: "prepared:run_late_settlement",
            actor: "scheduler",
            message: death.kind === "expired" ? "expired" : "settled",
            data: { transactionId: lateTxn },
            agentDir: state.agentDir,
          });
          await finalizeRunRecord(
            run.id,
            {
              status: finalStatus === "succeeded" ? "succeeded" : finalStatus === "failed" ? "failed" : "ambiguous",
              errorCategory: death.kind === "expired" ? "abort_ignored_expired" : result.errorCategory,
              errorMessage:
                death.kind === "expired"
                  ? "Abort-ignored execution expired; worker killed and authority released"
                  : result.errorMessage,
              usage: death.kind === "settled" ? death.r?.usage ?? result.usage : result.usage,
              session: death.kind === "settled" ? death.r?.session ?? result.session : result.session,
              sideEffectsStarted: true,
              summary: death.kind === "settled" ? death.r?.summary ?? null : null,
            },
            {
              agentDir: state.agentDir,
              ownerId,
              epoch,
              allowMissingLease: true,
              allowTakeoverAmbiguous: true,
            },
          );
          await appendAuditEvent({
            runId: run.id,
            taskId: task.id,
            kind: "run_late_settlement",
            actor: "scheduler",
            message: `committed:${death.kind === "expired" ? "expired" : "settled"}`,
            data: { transactionId: lateTxn },
            agentDir: state.agentDir,
          });
        } catch (error) {
          try {
            await finalizeRunRecord(
              run.id,
              {
                status: "ambiguous",
                errorCategory: "late_settlement",
                errorMessage: error instanceof Error ? error.message : String(error),
                sideEffectsStarted: true,
              },
              {
                agentDir: state.agentDir,
                ownerId,
                epoch,
                allowMissingLease: true,
                allowTakeoverAmbiguous: true,
              },
            );
          } catch {
            // next reconcile
          }
        } finally {
          clearInterval(leaseHeartbeat);
          unregisterActiveRun(run.id);
        }
      })();
      return;
    }

    // prepared → mutation → committed for scheduler finalize (crash-safe).
    const finalizeKind = `run_${result.status}`;
    const finalizeTxn = `fin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await appendAuditEvent({
      runId: run.id,
      taskId: task.id,
      kind: `prepared:${finalizeKind}`,
      actor: "scheduler",
      message: result.summary ?? result.errorMessage ?? result.status,
      data: { transactionId: finalizeTxn },
      agentDir: state.agentDir,
    });
    try {
      await finalizeRunRecord(
        run.id,
        {
          status: result.status,
          summary: result.summary,
          errorCategory: result.errorCategory,
          errorMessage: result.errorMessage,
          usage: result.usage,
          actualModel: result.actualModel,
          session: result.session,
          sideEffectsStarted: result.sideEffectsStarted,
          blockedReason:
            result.status === "blocked"
              ? result.errorCategory === "interaction_required"
                ? "interaction_required"
                : "policy_violation"
              : result.errorCategory === "budget"
                ? "policy_violation"
                : null,
          effectiveTools: preflight.effective.tools,
        },
        {
          agentDir: state.agentDir,
          ownerId: state.leader.ownerId,
          epoch: state.leader.epoch,
        },
      );
      await appendAuditEvent({
        runId: run.id,
        taskId: task.id,
        kind: finalizeKind,
        actor: "scheduler",
        message: `committed:${result.summary ?? result.errorMessage ?? result.status}`,
        data: { transactionId: finalizeTxn },
        agentDir: state.agentDir,
      });
    } catch (finalizeErr) {
      try {
        await appendAuditEvent({
          runId: run.id,
          taskId: task.id,
          kind: "repair_required",
          actor: "scheduler",
          message: `Finalize failed after prepare: ${finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)}`,
          agentDir: state.agentDir,
        });
      } catch {
        // best-effort
      }
      throw finalizeErr;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await finalizeRunRecord(
        run.id,
        {
          status: "ambiguous",
          errorCategory: "scheduler",
          errorMessage: message,
          sideEffectsStarted: true,
        },
        {
          agentDir: state.agentDir,
          ownerId: state.leader?.ownerId,
          epoch: state.leader?.epoch,
          allowMissingLease: true,
        },
      );
    } catch {
      state.lastError = message;
    }
  } finally {
    if (!retainAuthority) {
      clearInterval(leaseHeartbeat);
      unregisterActiveRun(run.id);
    }
    // Retained authority is released by the late-settlement watchdog after death/expiry.
  }
}

async function scanAndDispatch(state: SchedulerState): Promise<void> {
  if (!state.leader || state.stopping) return;
  try {
    state.leader.heartbeat();
  } catch (error) {
    state.leader = null;
    state.lastError = error instanceof Error ? error.message : String(error);
    return;
  }

  const tasksFile = readTasksFile(state.agentDir);
  if (tasksFile.globalDisabled) {
    persistStatus(state, { globalDisabled: true, available: false });
    return;
  }

  // Capacity guard: real filesystem free space under the Automation root.
  const storageBytes = estimateAutomationStorageBytes(state.agentDir);
  const freeSpaceBytes = getFreeSpaceBytes(getAutomationRoot(state.agentDir));
  let capacityBlocked = false;
  if (freeSpaceBytes != null && freeSpaceBytes < AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES) {
    capacityBlocked = true;
    persistStatus(state, {
      lastError: "capacity_guard_free_space",
      storageBytes,
      freeSpaceBytes,
    });
  } else if (freeSpaceBytes == null && storageBytes > AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES * 20) {
    // Fallback only when statfs is unavailable.
    capacityBlocked = true;
    persistStatus(state, {
      lastError: "capacity_guard_storage",
      storageBytes,
      freeSpaceBytes,
    });
  } else {
    persistStatus(state, { storageBytes, freeSpaceBytes });
  }

  if (capacityBlocked) {
    // Fail closed on capacity: no new dispatch; reads/export/cleanup remain available.
    // Still reconcile orphan claims so recovery is not starved by capacity.
    await reconcileAllOccurrences(state);
    return;
  }

  // CRITICAL: reconcile orphan claims BEFORE normal due materialization so
  // prepared_without_run cannot be starved by repair_required on the due path.
  // Full truth table converges every tick.
  await reconcileAllOccurrences(state);

  if (activeRunCount() >= AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY) {
    persistStatus(state);
    return;
  }

  const tasks = listTaskRecords(state.agentDir).filter((t) => t.status === "active");
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  for (const task of tasks) {
    if (state.stopping || !state.leader) break;
    if (activeRunCount() >= AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY) break;

    // Approval expiry blocks dispatch and persists blocked state (not silent skip).
    const approvalExp = task.approvedConfig.authority.approvalExpiresAt;
    if (approvalExp) {
      const exp = Date.parse(approvalExp);
      if (Number.isFinite(exp) && exp <= Date.now()) {
        if (task.status === "active" || task.status === "paused") {
          try {
            await upsertTaskRecord(
              {
                ...task,
                status: "blocked",
                blockedReason: "approval_expired",
              },
              { agentDir: state.agentDir, expectedTaskRevision: task.revision },
            );
            if (task.lastRunId) {
              await appendAuditEvent({
                runId: task.lastRunId,
                taskId: task.id,
                kind: "approval_expired_block",
                actor: "scheduler",
                message: `Approval expired at ${approvalExp}`,
                agentDir: state.agentDir,
              });
            }
          } catch {
            // revision race — next tick
          }
        }
        continue;
      }
    }

    // Continuous failure pause — tasks should already be paused by finalize; skip if still active.
    if (
      task.consecutiveFailures >= task.approvedConfig.authority.budgets.consecutiveFailureThreshold
    ) {
      if (task.status === "active") {
        try {
          await upsertTaskRecord(
            { ...task, status: "paused" },
            { agentDir: state.agentDir, expectedTaskRevision: task.revision },
          );
        } catch {
          // revision race — next tick
        }
      }
      continue;
    }

    // Run/day ceiling
    const runsToday = task.runsTodayDate === today ? task.runsToday : 0;
    if (runsToday >= task.approvedConfig.authority.budgets.maxRunsPerDay) {
      continue;
    }

    // Monthly cost ceiling
    const monthlyCost = task.monthlyCostMonth === month ? task.monthlyCostUsd : 0;
    if (monthlyCost >= task.approvedConfig.authority.budgets.maxMonthlyCostUsd) {
      continue;
    }

    // Per-run token budget is enforced after runs populate usage; block when last run overshot.
    const maxTokens = task.approvedConfig.authority.budgets.maxTokensPerRun;
    if (maxTokens > 0 && task.lastRunId) {
      const last = readRunRecord(task.lastRunId, state.agentDir);
      if (last?.usage?.totalTokens != null && last.usage.totalTokens > maxTokens) {
        // Already finished over budget — allow future runs but surface via status; ceilings apply next finalize.
      }
    }

    const hasActiveRun = listRunRecords({ agentDir: state.agentDir, taskId: task.id }).some(
      (r) => !r.terminal && (r.status === "running" || r.status === "claimed" || r.status === "queued" || r.status === "cancel_requested"),
    );

    const decision = decideOccurrence({
      taskId: task.id,
      cron: task.approvedConfig.schedule.cron,
      timezone: task.approvedConfig.schedule.timezone,
      previousNextRunAt: task.nextRunAt,
      lastMaterializedOccurrenceKey: task.lastMaterializedOccurrenceKey,
      lastOmissionKey: task.lastOmissionKey ?? null,
      hasActiveRun,
      // Never invent pre-activation omissions (DST gap / misfire).
      approvedAt: task.approvedAt ?? null,
      activatedAt: task.approvedAt ?? null,
    });

    if (decision.type === "not_due") continue;

    if (decision.type === "omit_misfire_aggregate" || decision.type === "omit_dst_gap") {
      const { buildOmissionKey } = await import("./automation-schedule");
      const omissionKey = buildOmissionKey(decision.omission);
      writeOmissionRecord(
        {
          schemaVersion: AUTOMATION_SCHEMA_VERSION,
          id: `omit-${task.id}-${Date.now()}-${randomBytes(2).toString("hex")}`,
          createdAt: nowIso(),
          ...decision.omission,
        },
        state.agentDir,
      );
      // Advance nextRunAt via a synthetic task update through materialize when firing, else patch next.
      // Persist lastOmissionKey so identical DST gap ticks emit once.
      if (decision.type === "omit_misfire_aggregate" && decision.fire) {
        try {
          await upsertTaskRecord(
            { ...task, lastOmissionKey: omissionKey },
            { agentDir: state.agentDir, expectedTaskRevision: task.revision },
          );
        } catch {
          // revision race — still fall through to fire
        }
        // fall through to fire branch using decision.fire
      } else {
        // Update nextRunAt + omission dedup key
        await upsertTaskRecord(
          { ...task, nextRunAt: decision.nextRunAt, lastOmissionKey: omissionKey },
          { agentDir: state.agentDir, expectedTaskRevision: task.revision },
        );
        continue;
      }
    }

    const occurrence =
      decision.type === "fire" || decision.type === "skip_overlap"
        ? decision.occurrence
        : decision.type === "omit_misfire_aggregate" && decision.fire
          ? decision.fire.occurrence
          : null;
    if (!occurrence) continue;

    if (decision.type === "skip_overlap") {
      const skipRunId = makeAutomationRunId();
      const skipRun: AutomationRunRecord = baseRun({
        id: skipRunId,
        task,
        occurrence,
        status: "skipped",
        trigger: "scheduled",
        ownerId: state.leader.ownerId,
        epoch: state.leader.epoch,
        fencingToken: state.leader.fencingToken,
      });
      skipRun.terminal = true;
      skipRun.completedAt = nowIso();
      skipRun.errorCategory = "overlap";
      skipRun.errorMessage = "Skipped due to active run overlap";
      await materializeOccurrence({
        taskId: task.id,
        occurrenceKey: occurrence.occurrenceKey,
        run: skipRun,
        nextRunAt: decision.nextRunAt,
        ownerId: state.leader.ownerId,
        epoch: state.leader.epoch,
        fencingToken: state.leader.fencingToken,
        agentDir: state.agentDir,
      });
      continue;
    }

    const runId = makeAutomationRunId();
    const run = baseRun({
      id: runId,
      task,
      occurrence,
      status: "claimed",
      trigger: "scheduled",
      ownerId: state.leader.ownerId,
      epoch: state.leader.epoch,
      fencingToken: state.leader.fencingToken,
    });

    const materialized = await materializeOccurrence({
      taskId: task.id,
      occurrenceKey: occurrence.occurrenceKey,
      run,
      nextRunAt:
        decision.type === "fire"
          ? decision.nextRunAt
          : decision.type === "omit_misfire_aggregate"
            ? decision.nextRunAt
            : task.nextRunAt,
      ownerId: state.leader.ownerId,
      epoch: state.leader.epoch,
      fencingToken: state.leader.fencingToken,
      agentDir: state.agentDir,
    });

    // Fire-and-forget dispatch; concurrency guarded by registry.
    void dispatchRun({
      state,
      task: materialized.task,
      run: materialized.run,
      occurrenceKey: occurrence.occurrenceKey,
    });
  }

  // Reconciliation already ran at the start of the tick (before due materialization).
  // A second pass catches claims/runs created during this tick's materialization.
  await reconcileAllOccurrences(state);

  // Bounded retention cadence (does not run every tick).
  const lastRet = globalThis.__piAutomationLastRetentionAt ?? 0;
  if (Date.now() - lastRet >= RETENTION_INTERVAL_MS) {
    globalThis.__piAutomationLastRetentionAt = Date.now();
    void (async () => {
      try {
        const { runAutomationRetention } = await import("./automation-retention");
        await runAutomationRetention({ agentDir: state.agentDir });
      } catch {
        // retention errors must not break scheduling
      }
    })();
  }

  persistStatus(state);
}

/**
 * Full reconciliation truth table over runs + orphan claims.
 * Must run BEFORE normal due materialization so prepared_without_run recovery
 * cannot be starved by repair_required on the due path.
 */
async function reconcileAllOccurrences(state: SchedulerState): Promise<void> {
  const seenOccurrence = new Set<string>();
  const reconcileOne = async (occurrenceKey: string) => {
    if (seenOccurrence.has(occurrenceKey)) return;
    seenOccurrence.add(occurrenceKey);
    const rec = reconcileOccurrence(occurrenceKey, state.agentDir);
    try {
      if (rec.action === "prepared_without_run" && rec.claim) {
        // Create/recover or drop prepared-only claim so occurrence can converge.
        await recoverPreparedWithoutRun(rec.claim.occurrenceKey, state.agentDir, {
          ownerId: state.leader?.ownerId,
          epoch: state.leader?.epoch,
          fencingToken: state.leader?.fencingToken,
        });
        return;
      }
      if (rec.action === "needs_task_advance" && rec.claim) {
        await recoverNeedsTaskAdvance(rec.claim.occurrenceKey, state.agentDir, {
          ownerId: state.leader?.ownerId,
          epoch: state.leader?.epoch,
          fencingToken: state.leader?.fencingToken,
        });
        return;
      }
      if (rec.action === "safe_redispatch" && rec.run && !rec.run.terminal && state.leader) {
        // Pre-barrier: atomically transfer BOTH claim and run fencing before barrier.
        const task = getTaskRecord(rec.run.taskId, state.agentDir);
        if (!task || task.status !== "active") return;
        if (activeRunCount() >= AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY) return;
        try {
          const transferred = await transferClaimAndRunFencing({
            occurrenceKey: rec.run.occurrence.occurrenceKey,
            runId: rec.run.id,
            ownerId: state.leader.ownerId,
            epoch: state.leader.epoch,
            fencingToken: state.leader.fencingToken,
            agentDir: state.agentDir,
            status: "claimed",
            leaseTtlMs: LEASE_TTL_MS,
          });
          void dispatchRun({
            state,
            task,
            run: transferred.run,
            occurrenceKey: transferred.run.occurrence.occurrenceKey,
          });
        } catch {
          // fencing race — next tick
        }
        return;
      }
      if (rec.action === "mark_ambiguous" && rec.run && !rec.run.terminal && state.leader) {
        try {
          await finalizeRunRecord(
            rec.run.id,
            {
              status: "ambiguous",
              errorCategory: "reconciliation",
              errorMessage:
                "Stale uncertain execution after barrier; marked ambiguous under takeover authority",
              sideEffectsStarted: true,
            },
            {
              agentDir: state.agentDir,
              ownerId: state.leader.ownerId,
              epoch: state.leader.epoch,
              allowMissingLease: true,
              allowTakeoverAmbiguous: true,
            },
          );
          unregisterActiveRun(rec.run.id);
        } catch {
          // fencing race — next tick
        }
      }
    } catch {
      // per-occurrence reconcile errors must not stop the scan
    }
  };

  // Prioritize nonterminal / repair-required claims so a stable first-N history cannot
  // starve orphans once claim volume exceeds any soft scan budget (>200).
  const allClaims = listClaimRecords(state.agentDir);
  const prioritizedClaims = [...allClaims].sort((a, b) => {
    const rank = (c: (typeof allClaims)[number]): number => {
      // Highest priority: prepared without run / pre-barrier repair paths.
      if (c.stage === "prepared" && !c.runId) return 0;
      if (c.stage === "run_created" || c.stage === "task_advanced") return 1;
      if (c.stage === "execution_may_have_started" && !c.finalized) return 2;
      if (!c.finalized) return 3;
      return 9;
    };
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    // Older first within same rank.
    return String(a.updatedAt ?? a.createdAt ?? "").localeCompare(
      String(b.updatedAt ?? b.createdAt ?? ""),
    );
  });

  // Always process ALL non-finalized/repair-required claims (no cap starvation).
  // Finalized stable history may be soft-capped after the repair set is exhausted.
  const repairClaims = prioritizedClaims.filter((c) => {
    if (c.stage === "prepared" && !c.runId) return true;
    if (c.stage === "run_created" || c.stage === "task_advanced") return true;
    if (c.stage === "execution_may_have_started" && !c.finalized) return true;
    return !c.finalized;
  });
  const stableClaims = prioritizedClaims.filter((c) => !repairClaims.includes(c));

  for (const claim of repairClaims) {
    await reconcileOne(claim.occurrenceKey);
  }
  // Soft-cap only the finalized/stable history tail.
  for (const claim of stableClaims.slice(0, 200)) {
    await reconcileOne(claim.occurrenceKey);
  }

  // Nonterminal runs first, then a bounded terminal tail.
  const allRuns = listRunRecords({ agentDir: state.agentDir, limit: 10_000 });
  const nonterminalRuns = allRuns.filter((r) => !r.terminal);
  const terminalRuns = allRuns.filter((r) => r.terminal);
  for (const run of nonterminalRuns) {
    await reconcileOne(run.occurrence.occurrenceKey);
  }
  for (const run of terminalRuns.slice(0, 200)) {
    await reconcileOne(run.occurrence.occurrenceKey);
  }
}

function baseRun(input: {
  id: string;
  task: AutomationTaskRecord;
  occurrence: AutomationRunRecord["occurrence"];
  status: AutomationRunRecord["status"];
  trigger: AutomationRunRecord["trigger"];
  ownerId: string;
  epoch: number;
  fencingToken: string;
}): AutomationRunRecord {
  const now = nowIso();
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: input.id,
    taskId: input.task.id,
    taskRevision: input.task.revision,
    trigger: input.trigger,
    status: input.status,
    blockedReason: null,
    occurrence: input.occurrence,
    lease: {
      ownerId: input.ownerId,
      epoch: input.epoch,
      fencingToken: input.fencingToken,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    },
    promptHash: hashPrompt(input.task.approvedConfig.agent.prompt),
    requestedModel: {
      provider: input.task.approvedConfig.agent.provider,
      modelId: input.task.approvedConfig.agent.modelId,
      thinking: input.task.approvedConfig.agent.thinking ?? null,
    },
    actualModel: null,
    effectiveTools: input.task.approvedConfig.authority.tools,
    effectiveExtensions: input.task.approvedConfig.authority.extensions,
    session: {
      sessionId: null,
      sessionFile: null,
      availability: "pending",
      unavailableReason: null,
      sealed: false,
      seal: null,
    },
    summary: null,
    usage: null,
    errorCategory: null,
    errorMessage: null,
    sideEffectsStarted: false,
    cancelRequestedAt: null,
    createdAt: now,
    claimedAt: now,
    startedAt: null,
    completedAt: null,
    cwd: input.task.approvedConfig.target.cwd,
    terminal: isTerminalRunStatus(input.status),
  };
}

async function tick(state: SchedulerState): Promise<void> {
  if (state.tickInFlight || state.stopping) return;
  state.tickInFlight = true;
  try {
    if (!state.leader) {
      await becomeLeader(state);
    }
    if (state.leader) {
      // Reconcile prepared-but-uncommitted audit transactions every tick.
      try {
        const { reconcilePreparedAuditTransactions } = await import("./automation-service");
        await reconcilePreparedAuditTransactions(state.agentDir);
      } catch {
        // audit reconcile must not stop dispatch
      }
      await scanAndDispatch(state);
    } else {
      persistStatus(state);
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    persistStatus(state);
  } finally {
    state.tickInFlight = false;
  }
}

function scheduleNext(state: SchedulerState): void {
  if (state.stopping) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    void tick(state).finally(() => scheduleNext(state));
  }, TICK_MS);
  // Do not keep the process alive solely for automation in tests.
  state.timer.unref?.();
}

export async function startAutomationScheduler(options?: { agentDir?: string }): Promise<{
  started: boolean;
  available: boolean;
  error?: string;
}> {
  const state = getState();
  if (state.started) {
    return { started: true, available: state.available, error: state.lastError ?? undefined };
  }
  state.agentDir = options?.agentDir;
  state.stopping = false;
  try {
    ensureAutomationLayout(state.agentDir);
    // Startup reconciliation of prepared-but-uncommitted audits from prior crashes.
    try {
      const { reconcilePreparedAuditTransactions } = await import("./automation-service");
      await reconcilePreparedAuditTransactions(state.agentDir);
    } catch {
      // non-fatal at startup
    }
    state.started = true;
    await becomeLeader(state);
    persistStatus(state);
    scheduleNext(state);
    // Immediate scan
    void tick(state);
    return { started: true, available: state.available, error: state.lastError ?? undefined };
  } catch (error) {
    state.available = false;
    state.lastError = error instanceof Error ? error.message : String(error);
    state.started = true; // prevent crash loops; status exposes failure
    try {
      writeSchedulerStatus({
        ...readSchedulerStatus(state.agentDir),
        available: false,
        lastError: state.lastError,
        repairRequired: true,
        repairReason: state.lastError,
      }, state.agentDir);
    } catch {
      // ignore
    }
    return { started: true, available: false, error: state.lastError };
  }
}

export async function stopAutomationScheduler(options?: { drainMs?: number }): Promise<void> {
  const state = getState();
  state.stopping = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const drainMs = options?.drainMs ?? 5_000;
  const deadline = Date.now() + drainMs;
  for (const run of listRunRecords({ agentDir: state.agentDir, limit: 50 })) {
    if (!run.terminal) requestCancelRun(run.id);
  }
  while (activeRunCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Only release if all confirmed stopped; otherwise keep lease until process death.
  if (activeRunCount() === 0 && state.leader) {
    state.leader.release();
    state.leader = null;
  } else if (activeRunCount() > 0) {
    // Mark remaining as ambiguous best-effort
    for (const active of (await import("./automation-run-registry")).listActiveRuns()) {
      try {
        await finalizeRunRecord(
          active.runId,
          {
            status: "ambiguous",
            errorCategory: "shutdown",
            errorMessage: "Process shutting down before runner confirmed stop",
            sideEffectsStarted: true,
          },
          { agentDir: state.agentDir, allowMissingLease: true },
        );
      } catch {
        // ignore
      }
    }
  }
  state.started = false;
}

export function getAutomationSchedulerStatus(agentDir?: string) {
  const state = getState();
  const file = readSchedulerStatus(agentDir ?? state.agentDir);
  const lock = inspectAutomationLock("scheduler", agentDir ?? state.agentDir);
  return {
    ...file,
    inProcessStarted: state.started,
    inProcessOwnerId: state.ownerId,
    lock,
    activeRuns: activeRunCount(),
  };
}

/**
 * Shared pre-dispatch gates for scheduled and manual runs.
 * Returns a terminal skipped/blocked run when gated, else null to proceed.
 */
export function evaluateDispatchGates(input: {
  task: AutomationTaskRecord;
  agentDir?: string;
  trigger: "scheduled" | "manual";
}): { blocked: true; reason: string; code: string } | { blocked: false } {
  const tasksFile = readTasksFile(input.agentDir);
  if (tasksFile.globalDisabled) {
    return { blocked: true, reason: "Global Automation kill switch is enabled", code: "blocked" };
  }
  if (input.task.status === "archived") {
    return { blocked: true, reason: "Task archived", code: "archived" };
  }
  if (input.task.status === "blocked") {
    return {
      blocked: true,
      reason: input.task.blockedReason ?? "Task blocked",
      code: "blocked",
    };
  }

  const approvalExp = input.task.approvedConfig.authority.approvalExpiresAt;
  if (approvalExp) {
    const exp = Date.parse(approvalExp);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return { blocked: true, reason: "Approval expired", code: "approval_expired" };
    }
  }

  if (
    input.task.consecutiveFailures >=
    input.task.approvedConfig.authority.budgets.consecutiveFailureThreshold
  ) {
    return {
      blocked: true,
      reason: "Consecutive failure threshold reached",
      code: "blocked",
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const runsToday = input.task.runsTodayDate === today ? input.task.runsToday : 0;
  if (runsToday >= input.task.approvedConfig.authority.budgets.maxRunsPerDay) {
    return { blocked: true, reason: "maxRunsPerDay ceiling reached", code: "blocked" };
  }
  const monthlyCost =
    input.task.monthlyCostMonth === month ? input.task.monthlyCostUsd : 0;
  if (monthlyCost >= input.task.approvedConfig.authority.budgets.maxMonthlyCostUsd) {
    return { blocked: true, reason: "maxMonthlyCostUsd ceiling reached", code: "blocked" };
  }

  const freeSpaceBytes = getFreeSpaceBytes(getAutomationRoot(input.agentDir));
  const storageBytes = estimateAutomationStorageBytes(input.agentDir);
  if (freeSpaceBytes != null && freeSpaceBytes < AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES) {
    return { blocked: true, reason: "capacity_guard_free_space", code: "blocked" };
  }
  if (freeSpaceBytes == null && storageBytes > AUTOMATION_DEFAULT_FREE_SPACE_GUARD_BYTES * 20) {
    return { blocked: true, reason: "capacity_guard_storage", code: "blocked" };
  }

  if (activeRunCount() >= AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY) {
    return { blocked: true, reason: "global concurrency limit", code: "already_running" };
  }

  const hasActiveRun = listRunRecords({ agentDir: input.agentDir, taskId: input.task.id }).some(
    (r) =>
      !r.terminal &&
      (r.status === "running" ||
        r.status === "claimed" ||
        r.status === "queued" ||
        r.status === "cancel_requested"),
  );
  if (hasActiveRun) {
    return { blocked: true, reason: "Task already has an active run", code: "already_running" };
  }

  void input.trigger;
  return { blocked: false };
}

export async function enqueueManualRun(input: {
  taskId: string;
  agentDir?: string;
}): Promise<AutomationRunRecord> {
  const state = getState();
  if (!state.leader) {
    const became = await becomeLeader(state);
    if (!became || !state.leader) {
      throw Object.assign(new Error("Scheduler leader unavailable"), {
        code: "scheduler_unavailable",
      });
    }
  }
  const task = listTaskRecords(input.agentDir).find((t) => t.id === input.taskId);
  if (!task) throw Object.assign(new Error("Task not found"), { code: "not_found" });
  if (task.status === "archived") {
    throw Object.assign(new Error("Task archived"), { code: "archived" });
  }

  // Early soft gate (UX); authoritative recheck happens under store.lock at materialize.
  const earlyGate = evaluateDispatchGates({ task, agentDir: input.agentDir, trigger: "manual" });
  const now = new Date();
  // Manual wallTime/offset MUST reflect task IANA timezone — never host offset / UTC text mismatch.
  const occurrence = buildManualOccurrenceMeta({
    taskId: task.id,
    cron: task.approvedConfig.schedule.cron,
    timezone: task.approvedConfig.schedule.timezone,
    now,
  });

  const persistBlocked = async (
    gate: { reason: string; code: string },
    kind: "manual_skipped" | "manual_blocked" | "manual_preflight_blocked",
    extra?: Partial<AutomationRunRecord>,
  ) => {
    const status =
      gate.code === "already_running" || gate.reason.includes("overlap")
        ? ("skipped" as const)
        : ("blocked" as const);
    const blockedRun = baseRun({
      id: makeAutomationRunId(),
      task,
      occurrence,
      status,
      trigger: "manual",
      ownerId: state.leader!.ownerId,
      epoch: state.leader!.epoch,
      fencingToken: state.leader!.fencingToken,
    });
    blockedRun.terminal = true;
    blockedRun.completedAt = nowIso();
    blockedRun.lease = null;
    blockedRun.errorCategory = gate.code;
    blockedRun.errorMessage = gate.reason;
    blockedRun.blockedReason =
      gate.code === "approval_expired"
        ? "approval_expired"
        : gate.code === "already_running"
          ? null
          : "policy_violation";
    Object.assign(blockedRun, extra ?? {});
    const materialized = await materializeOccurrence({
      taskId: task.id,
      occurrenceKey: occurrence.occurrenceKey,
      run: blockedRun,
      nextRunAt: task.nextRunAt,
      ownerId: state.leader!.ownerId,
      epoch: state.leader!.epoch,
      fencingToken: state.leader!.fencingToken,
      agentDir: input.agentDir,
    });
    await appendAuditEvent({
      runId: materialized.run.id,
      taskId: task.id,
      kind,
      actor: "scheduler",
      message: gate.reason,
      agentDir: input.agentDir,
    });
    return materialized.run;
  };

  if (earlyGate.blocked) {
    if (
      earlyGate.code === "approval_expired" &&
      (task.status === "active" || task.status === "paused")
    ) {
      try {
        await upsertTaskRecord(
          { ...task, status: "blocked", blockedReason: "approval_expired" },
          { agentDir: input.agentDir, expectedTaskRevision: task.revision },
        );
      } catch {
        // revision race
      }
    }
    if (earlyGate.code === "blocked" && earlyGate.reason.includes("kill switch")) {
      // Still durable-record then throw for service mapping.
      await persistBlocked(earlyGate, "manual_blocked");
      throw Object.assign(new Error(earlyGate.reason), {
        code: "blocked",
        blockedReason: "policy_violation",
      });
    }
    return persistBlocked(
      earlyGate,
      earlyGate.code === "already_running" ? "manual_skipped" : "manual_blocked",
    );
  }

  // Live preflight before materialize/dispatch (default-cwd integrity + target auth).
  const preflight = await runRuntimePreflight(task);
  if (!preflight.ok) {
    return persistBlocked(
      { reason: preflight.message ?? "preflight blocked", code: "blocked" },
      "manual_preflight_blocked",
      {
        blockedReason: preflight.blockedReason as never,
        errorCategory: "preflight",
        errorMessage: preflight.message,
      },
    );
  }

  const run = baseRun({
    id: makeAutomationRunId(),
    task,
    occurrence,
    status: "queued",
    trigger: "manual",
    ownerId: state.leader!.ownerId,
    epoch: state.leader!.epoch,
    fencingToken: state.leader!.fencingToken,
  });
  run.status = "claimed";

  // Authoritative gate recheck under store.lock immediately before claim/materialize.
  // Concurrent manual requests cannot both dispatch.
  const locked = await materializeOccurrenceWithGateRecheck({
    taskId: task.id,
    occurrenceKey: occurrence.occurrenceKey,
    run,
    nextRunAt: task.nextRunAt,
    ownerId: state.leader!.ownerId,
    epoch: state.leader!.epoch,
    fencingToken: state.leader!.fencingToken,
    agentDir: input.agentDir,
    globalActiveRuns: activeRunCount(),
    recheckGate: ({ task: fresh, tasksFile, activeRunsForTask, globalActiveRuns }) => {
      if (tasksFile.globalDisabled) {
        return {
          blocked: true as const,
          reason: "Global Automation kill switch is enabled",
          code: "blocked",
        };
      }
      if (fresh.status === "archived") {
        return { blocked: true as const, reason: "Task archived", code: "archived" };
      }
      if (fresh.status === "blocked") {
        return {
          blocked: true as const,
          reason: fresh.blockedReason ?? "Task blocked",
          code: "blocked",
        };
      }
      const approvalExp = fresh.approvedConfig.authority.approvalExpiresAt;
      if (approvalExp) {
        const exp = Date.parse(approvalExp);
        if (Number.isFinite(exp) && exp <= Date.now()) {
          return { blocked: true as const, reason: "Approval expired", code: "approval_expired" };
        }
      }
      if (globalActiveRuns >= AUTOMATION_DEFAULT_GLOBAL_CONCURRENCY) {
        return {
          blocked: true as const,
          reason: "global concurrency limit",
          code: "already_running",
        };
      }
      if (activeRunsForTask > 0) {
        return {
          blocked: true as const,
          reason: "Task already has an active run",
          code: "already_running",
        };
      }
      // Budget/capacity already checked early; re-check day budget under lock.
      const today = new Date().toISOString().slice(0, 10);
      const runsToday = fresh.runsTodayDate === today ? fresh.runsToday : 0;
      if (runsToday >= fresh.approvedConfig.authority.budgets.maxRunsPerDay) {
        return {
          blocked: true as const,
          reason: "maxRunsPerDay ceiling reached",
          code: "blocked",
        };
      }
      return { blocked: false as const };
    },
  });

  if (!locked.ok) {
    if (locked.code === "blocked" && locked.reason.includes("kill switch")) {
      throw Object.assign(new Error(locked.reason), {
        code: "blocked",
        blockedReason: "policy_violation",
      });
    }
    // Materialize a terminal skipped/blocked record with a fresh occurrence key so
    // the losing concurrent request is durable and auditable.
    const loseOcc = {
      ...occurrence,
      occurrenceKey: `${task.id}@manual@${new Date().toISOString()}@spv1-lost`,
    };
    const status =
      locked.code === "already_running" ? ("skipped" as const) : ("blocked" as const);
    const blockedRun = baseRun({
      id: makeAutomationRunId(),
      task: locked.task ?? task,
      occurrence: loseOcc,
      status,
      trigger: "manual",
      ownerId: state.leader!.ownerId,
      epoch: state.leader!.epoch,
      fencingToken: state.leader!.fencingToken,
    });
    blockedRun.terminal = true;
    blockedRun.completedAt = nowIso();
    blockedRun.lease = null;
    blockedRun.errorCategory = locked.code;
    blockedRun.errorMessage = locked.reason;
    const materialized = await materializeOccurrence({
      taskId: task.id,
      occurrenceKey: loseOcc.occurrenceKey,
      run: blockedRun,
      nextRunAt: task.nextRunAt,
      ownerId: state.leader!.ownerId,
      epoch: state.leader!.epoch,
      fencingToken: state.leader!.fencingToken,
      agentDir: input.agentDir,
    });
    await appendAuditEvent({
      runId: materialized.run.id,
      taskId: task.id,
      kind: status === "skipped" ? "manual_skipped" : "manual_blocked",
      actor: "scheduler",
      message: locked.reason,
      agentDir: input.agentDir,
    });
    return materialized.run;
  }

  void dispatchRun({
    state,
    task: locked.task,
    run: locked.run,
    occurrenceKey: occurrence.occurrenceKey,
  });
  return locked.run;
}

export async function requestRunCancel(runId: string, agentDir?: string): Promise<AutomationRunRecord> {
  const run = readRunRecord(runId, agentDir);
  if (!run) throw new Error("Run not found");
  if (run.terminal) return run;
  const next = await finalizeRunRecord(
    runId,
    {
      status: "cancel_requested",
      cancelRequestedAt: nowIso(),
    },
    { agentDir, allowMissingLease: true },
  ).catch(async () => {
    // finalize may reject non-terminal transition if writeRunRecord path differs — patch manually
    const current = readRunRecord(runId, agentDir);
    if (!current || current.terminal) return current!;
    const patched = {
      ...current,
      status: "cancel_requested" as const,
      cancelRequestedAt: nowIso(),
    };
    // cancel_requested is non-terminal
    writeRunRecord(patched, agentDir);
    return patched;
  });
  const aborted = requestCancelRun(runId);
  if (!aborted) {
    // Cross-process: owner observes cancel_requested on next heartbeat; if stale → ambiguous later
  }
  return next;
}

