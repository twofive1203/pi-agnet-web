/**
 * Process identity, single-instance guardrails, and minimal runtime health snapshot.
 * Chat session wrappers / SSE listeners are process-local — multi-replica is unsupported
 * even with sticky routing until cross-process session coordination exists.
 */

import { hostname as osHostname } from "node:os";
import {
  detectMultiInstanceRisk,
  envFlagEnabled,
  formatRuntimeIdentityLine,
  resolveProcessInstanceId,
} from "../bin/runtime-options.js";

export type MultiInstanceRisk = ReturnType<typeof detectMultiInstanceRisk>;

export type ProcessIdentity = {
  pid: number;
  instanceId: string;
  hostname: string;
  startedAt: string;
  uptimeMs: number;
  mode: "server" | "local";
  bind: { hostname: string; port: string };
  nodeVersion: string;
  platform: NodeJS.Platform;
};

export type SchedulerHealthSummary = {
  role: "leader" | "standby" | "inactive" | "unavailable";
  available: boolean;
  inProcessStarted: boolean;
  activeRuns: number;
  globalDisabled: boolean;
  repairRequired: boolean;
  lastError: string | null;
  ownerId: string | null;
  inProcessOwnerId: string | null;
};

export type ProcessHealthSnapshot = {
  ok: boolean;
  status: "ready";
  pid: number;
  instanceId: string;
  hostname: string;
  startedAt: string;
  uptimeMs: number;
  mode: "server" | "local";
  bind: { hostname: string; port: string };
  nodeVersion: string;
  platform: NodeJS.Platform;
  singleInstance: {
    ok: boolean;
    fatal: boolean;
    allowOverride: boolean;
    reasons: string[];
    signals: string[];
  };
  liveSessions: number;
  sseListeners: number;
  startLocks: number;
  scheduler: SchedulerHealthSummary;
};

declare global {
  var __piProcessRuntime: { instanceId: string; startedAtMs: number } | undefined;
}

function getRuntimeState(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { instanceId: string; startedAtMs: number } {
  if (!globalThis.__piProcessRuntime) {
    globalThis.__piProcessRuntime = {
      instanceId: resolveProcessInstanceId({ env, pid: process.pid }),
      startedAtMs: Date.now(),
    };
  }
  return globalThis.__piProcessRuntime;
}

export function getProcessInstanceId(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const envId = typeof env.PI_WEB_INSTANCE_ID === "string" ? env.PI_WEB_INSTANCE_ID.trim() : "";
  if (envId) return envId;
  return getRuntimeState(env).instanceId;
}

export function getProcessStartedAtMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  return getRuntimeState(env).startedAtMs;
}

export { detectMultiInstanceRisk, formatRuntimeIdentityLine, resolveProcessInstanceId };

export function evaluateSingleInstanceGuard(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MultiInstanceRisk {
  return detectMultiInstanceRisk(env);
}

/**
 * Refuse unsupported multi-instance markers unless emergency override is set.
 * Returns the evaluation for logging; throws when fatal.
 */
export function assertSingleInstanceOrThrow(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): MultiInstanceRisk {
  const risk = detectMultiInstanceRisk(env);
  if (risk.fatal) {
    const detail = risk.reasons.join("; ") || "multi-instance markers present";
    throw new Error(
      `Unsupported multi-instance/cluster environment: ${detail}. ` +
        "Use single-process fork (ecosystem.config.cjs). " +
        "Set PI_WEB_ALLOW_MULTI_INSTANCE=1 only as an emergency override (still unsupported).",
    );
  }
  return risk;
}

export function getProcessIdentity(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ProcessIdentity {
  const state = getRuntimeState(env);
  const serverMode = envFlagEnabled(env.PI_WEB_SERVER_MODE);
  const bindHost =
    (typeof env.PI_WEB_HOSTNAME === "string" && env.PI_WEB_HOSTNAME.trim()) ||
    "127.0.0.1";
  const bindPort = (typeof env.PORT === "string" && env.PORT.trim()) || "62666";
  return {
    pid: process.pid,
    instanceId: getProcessInstanceId(env),
    hostname: osHostname(),
    startedAt: new Date(state.startedAtMs).toISOString(),
    uptimeMs: Math.max(0, Date.now() - state.startedAtMs),
    mode: serverMode ? "server" : "local",
    bind: { hostname: bindHost, port: bindPort },
    nodeVersion: process.version,
    platform: process.platform,
  };
}

function summarizeScheduler(raw: {
  available?: boolean;
  inProcessStarted?: boolean;
  inProcessOwnerId?: string | null;
  ownerId?: string | null;
  activeRuns?: number;
  globalDisabled?: boolean;
  repairRequired?: boolean;
  lastError?: string | null;
}): SchedulerHealthSummary {
  const available = Boolean(raw.available);
  const inProcessStarted = Boolean(raw.inProcessStarted);
  const ownerId = raw.ownerId ?? null;
  const inProcessOwnerId = raw.inProcessOwnerId ?? null;
  let role: SchedulerHealthSummary["role"] = "inactive";
  if (!inProcessStarted && !available) {
    role = "inactive";
  } else if (
    inProcessStarted &&
    available &&
    ownerId &&
    inProcessOwnerId &&
    ownerId === inProcessOwnerId
  ) {
    role = "leader";
  } else if (inProcessStarted) {
    role = "standby";
  } else {
    role = "unavailable";
  }
  return {
    role,
    available,
    inProcessStarted,
    activeRuns: Number.isFinite(raw.activeRuns) ? Number(raw.activeRuns) : 0,
    globalDisabled: Boolean(raw.globalDisabled),
    repairRequired: Boolean(raw.repairRequired),
    lastError: raw.lastError ?? null,
    ownerId,
    inProcessOwnerId,
  };
}

/**
 * Minimal ops snapshot: identity + aggregate live session/SSE counts + scheduler role.
 * Never includes session ids, cwds, paths, or secrets.
 */
export async function buildProcessHealthSnapshot(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<ProcessHealthSnapshot> {
  const identity = getProcessIdentity(env);
  const singleInstance = detectMultiInstanceRisk(env);

  let liveSessions = 0;
  let sseListeners = 0;
  let startLocks = 0;
  try {
    const { getRpcRuntimeStats } = await import("./rpc-manager");
    const stats = getRpcRuntimeStats();
    liveSessions = stats.liveSessions;
    sseListeners = stats.sseListeners;
    startLocks = stats.startLocks;
  } catch {
    // Registry may be unavailable during early boot; report zeros.
  }

  let scheduler: SchedulerHealthSummary = {
    role: "unavailable",
    available: false,
    inProcessStarted: false,
    activeRuns: 0,
    globalDisabled: false,
    repairRequired: false,
    lastError: null,
    ownerId: null,
    inProcessOwnerId: null,
  };
  try {
    const { getAutomationSchedulerStatus } = await import("./automation-scheduler");
    scheduler = summarizeScheduler(getAutomationSchedulerStatus());
  } catch (error) {
    scheduler = {
      ...scheduler,
      role: "unavailable",
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: singleInstance.ok || singleInstance.allowOverride,
    status: "ready",
    pid: identity.pid,
    instanceId: identity.instanceId,
    hostname: identity.hostname,
    startedAt: identity.startedAt,
    uptimeMs: identity.uptimeMs,
    mode: identity.mode,
    bind: identity.bind,
    nodeVersion: identity.nodeVersion,
    platform: identity.platform,
    singleInstance: {
      ok: singleInstance.ok,
      fatal: singleInstance.fatal,
      allowOverride: singleInstance.allowOverride,
      reasons: singleInstance.reasons,
      signals: singleInstance.signals,
    },
    liveSessions,
    sseListeners,
    startLocks,
    scheduler,
  };
}

/** Boot log line used by instrumentation after Node runtime registration. */
export function logProcessRuntimeIdentity(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  singleInstanceOk = true,
): void {
  const identity = getProcessIdentity(env);
  console.log(
    formatRuntimeIdentityLine({
      pid: identity.pid,
      instanceId: identity.instanceId,
      serverMode: identity.mode === "server",
      hostname: identity.bind.hostname,
      port: identity.bind.port,
      singleInstanceOk,
    }),
  );
}
