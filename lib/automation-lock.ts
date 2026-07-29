/**
 * Cross-process exclusive locks for Automation store and scheduler leases.
 * Corrupt/empty locks fail closed and require explicit repair.
 * Store lock supports same-async-chain reentrancy via AsyncLocalStorage.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { hostname } from "os";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import type { AutomationLockFile } from "./automation-types";
import { AUTOMATION_SCHEMA_VERSION } from "./automation-types";
import {
  getAutomationRoot,
  getAutomationSchedulerLockPath,
  getAutomationStoreLockPath,
} from "./automation-paths";

const DEFAULT_LOCK_TTL_MS = 30_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 50;

export class AutomationLockError extends Error {
  readonly code: "lock_busy" | "repair_required" | "fencing_rejected" | "not_owner";

  constructor(message: string, code: AutomationLockError["code"] = "lock_busy") {
    super(message);
    this.name = "AutomationLockError";
    this.code = code;
  }
}

export interface LockHandle {
  kind: "store" | "scheduler";
  path: string;
  ownerId: string;
  epoch: number;
  acquiredAt: string;
  release: () => void;
  heartbeat: () => void;
  fencingToken: string;
}

/** Tracks the active store lock handle for reentrant same-chain callers. */
const storeLockAls = new AsyncLocalStorage<LockHandle>();

/** True when the current async chain already holds the store lock. */
export function isHoldingAutomationStoreLock(): boolean {
  return Boolean(storeLockAls.getStore());
}

/** Current store lock handle if the async chain holds it. */
export function getHeldAutomationStoreLock(): LockHandle | undefined {
  return storeLockAls.getStore();
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLock(raw: string): AutomationLockFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== AUTOMATION_SCHEMA_VERSION) return null;
    if (parsed.kind !== "store" && parsed.kind !== "scheduler") return null;
    if (typeof parsed.ownerId !== "string") return null;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.hostname !== "string") return null;
    if (typeof parsed.epoch !== "number" || !Number.isFinite(parsed.epoch)) return null;
    if (typeof parsed.acquiredAt !== "string") return null;
    if (typeof parsed.heartbeatAt !== "string") return null;
    if (typeof parsed.expiresAt !== "string") return null;
    return parsed as unknown as AutomationLockFile;
  } catch {
    return null;
  }
}

function readLockFile(path: string): { lock: AutomationLockFile | null; corrupt: boolean; empty: boolean } {
  if (!existsSync(path)) return { lock: null, corrupt: false, empty: false };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { lock: null, corrupt: true, empty: false };
  }
  if (!raw.trim()) return { lock: null, corrupt: true, empty: true };
  const lock = parseLock(raw);
  if (!lock) return { lock: null, corrupt: true, empty: false };
  return { lock, corrupt: false, empty: false };
}

function isExpired(lock: AutomationLockFile, now = Date.now()): boolean {
  const exp = Date.parse(lock.expiresAt);
  return !Number.isFinite(exp) || exp <= now;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function exclusiveCreate(path: string, body: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function makeOwnerId(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

function epochCounterPath(kind: "store" | "scheduler", agentDir?: string): string {
  return join(getAutomationRoot(agentDir), `${kind}.epoch`);
}

function nextEpoch(kind: "store" | "scheduler", agentDir?: string): number {
  const path = epochCounterPath(kind, agentDir);
  mkdirSync(dirname(path), { recursive: true });
  let current = 0;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) current = Math.floor(n);
    } catch {
      // fail closed by starting from 0 only when unreadable after repair
    }
  }
  const next = current + 1;
  writeFileSync(path, `${next}\n`, "utf8");
  return next;
}

function lockPathFor(kind: "store" | "scheduler", agentDir?: string): string {
  return kind === "store" ? getAutomationStoreLockPath(agentDir) : getAutomationSchedulerLockPath(agentDir);
}

export function inspectAutomationLock(
  kind: "store" | "scheduler",
  agentDir?: string,
): {
  path: string;
  exists: boolean;
  lock: AutomationLockFile | null;
  corrupt: boolean;
  empty: boolean;
  expired: boolean;
  ageMs: number | null;
} {
  const path = lockPathFor(kind, agentDir);
  const { lock, corrupt, empty } = readLockFile(path);
  const ageMs = lock ? Date.now() - Date.parse(lock.heartbeatAt) : null;
  return {
    path,
    exists: existsSync(path),
    lock,
    corrupt,
    empty,
    expired: lock ? isExpired(lock) : false,
    ageMs: Number.isFinite(ageMs as number) ? ageMs : null,
  };
}

export async function acquireAutomationLock(options: {
  kind: "store" | "scheduler";
  agentDir?: string;
  ownerId?: string;
  ttlMs?: number;
  timeoutMs?: number;
  allowStaleTakeover?: boolean;
}): Promise<LockHandle> {
  const kind = options.kind;
  const path = lockPathFor(kind, options.agentDir);
  const ownerId = options.ownerId ?? makeOwnerId();
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const allowStaleTakeover = options.allowStaleTakeover !== false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const inspect = inspectAutomationLock(kind, options.agentDir);
    if (inspect.corrupt || inspect.empty) {
      throw new AutomationLockError(
        `${kind} lock is corrupt or empty and requires repair: ${path}`,
        "repair_required",
      );
    }

    if (!inspect.lock) {
      const epoch = nextEpoch(kind, options.agentDir);
      const acquiredAt = nowIso();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const lock: AutomationLockFile = {
        schemaVersion: AUTOMATION_SCHEMA_VERSION,
        kind,
        ownerId,
        pid: process.pid,
        hostname: hostname(),
        epoch,
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt,
      };
      if (exclusiveCreate(path, `${JSON.stringify(lock, null, 2)}\n`)) {
        return createHandle(kind, path, ownerId, epoch, acquiredAt, ttlMs);
      }
    } else if (
      inspect.lock.ownerId === ownerId &&
      inspect.lock.pid === process.pid &&
      inspect.lock.hostname === hostname()
    ) {
      const heartbeatAt = nowIso();
      const refreshed: AutomationLockFile = {
        ...inspect.lock,
        heartbeatAt,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      writeJsonAtomic(path, refreshed);
      return createHandle(kind, path, ownerId, inspect.lock.epoch, inspect.lock.acquiredAt, ttlMs);
    } else if (allowStaleTakeover && isExpired(inspect.lock)) {
      // Cross-process safe takeover protocol:
      // 1) Atomically rename the stale lock aside (only one contender wins).
      // 2) exclusiveCreate the new lock at the canonical path.
      // 3) Verify ownership. Never unlink-then-create and never blind overwrite.
      const stale = inspect.lock;
      const tombstone = `${path}.stale-${stale.epoch}-${randomBytes(6).toString("hex")}`;
      try {
        const current = readLockFile(path);
        if (
          !current.lock ||
          current.corrupt ||
          current.lock.ownerId !== stale.ownerId ||
          current.lock.epoch !== stale.epoch ||
          !isExpired(current.lock)
        ) {
          await sleep(DEFAULT_POLL_MS);
          continue;
        }
        try {
          renameSync(path, tombstone);
        } catch {
          // Lost the rename race to another contender.
          await sleep(DEFAULT_POLL_MS);
          continue;
        }

        const epoch = nextEpoch(kind, options.agentDir);
        const acquiredAt = nowIso();
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        const replacement: AutomationLockFile = {
          schemaVersion: AUTOMATION_SCHEMA_VERSION,
          kind,
          ownerId,
          pid: process.pid,
          hostname: hostname(),
          epoch,
          acquiredAt,
          heartbeatAt: acquiredAt,
          expiresAt,
          previousOwnerId: stale.ownerId,
          previousEpoch: stale.epoch,
        };
        if (exclusiveCreate(path, `${JSON.stringify(replacement, null, 2)}\n`)) {
          try {
            unlinkSync(tombstone);
          } catch {
            // leave tombstone for operator inspection
          }
          return createHandle(kind, path, ownerId, epoch, acquiredAt, ttlMs);
        }
        // Another writer filled the path after our rename — do not clobber.
      } catch {
        // contended / filesystem race — retry
      }
      await sleep(DEFAULT_POLL_MS);
      continue;
    }

    await sleep(DEFAULT_POLL_MS);
  }

  throw new AutomationLockError(`Timed out acquiring ${kind} lock`, "lock_busy");
}

function createHandle(
  kind: "store" | "scheduler",
  path: string,
  ownerId: string,
  epoch: number,
  acquiredAt: string,
  ttlMs: number,
): LockHandle {
  let released = false;
  const fencingToken = `${kind}:${epoch}:${ownerId}`;

  const heartbeat = () => {
    if (released) return;
    const { lock, corrupt } = readLockFile(path);
    if (corrupt || !lock) throw new AutomationLockError("Lock missing during heartbeat", "repair_required");
    if (lock.ownerId !== ownerId || lock.epoch !== epoch) {
      throw new AutomationLockError("Lost lock ownership", "fencing_rejected");
    }
    const next: AutomationLockFile = {
      ...lock,
      heartbeatAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    writeJsonAtomic(path, next);
  };

  const release = () => {
    if (released) return;
    released = true;
    const { lock } = readLockFile(path);
    if (!lock) return;
    if (lock.ownerId !== ownerId || lock.epoch !== epoch) return;
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  };

  return { kind, path, ownerId, epoch, acquiredAt, release, heartbeat, fencingToken };
}

export async function withAutomationStoreLock<T>(
  fn: (handle: LockHandle) => Promise<T> | T,
  options?: {
    agentDir?: string;
    ownerId?: string;
    ttlMs?: number;
    timeoutMs?: number;
  },
): Promise<T> {
  // Reentrancy-safe: callers already holding the store lock (same async chain)
  // reuse the handle without nested acquire/release.
  const held = storeLockAls.getStore();
  if (held) {
    held.heartbeat();
    return await fn(held);
  }
  const handle = await acquireAutomationLock({
    kind: "store",
    agentDir: options?.agentDir,
    ownerId: options?.ownerId,
    ttlMs: options?.ttlMs,
    timeoutMs: options?.timeoutMs,
  });
  try {
    return await storeLockAls.run(handle, async () => await fn(handle));
  } finally {
    handle.release();
  }
}

export function repairAutomationLock(kind: "store" | "scheduler", agentDir?: string): {
  repaired: boolean;
  path: string;
  reason: string;
} {
  const path = lockPathFor(kind, agentDir);
  const inspect = inspectAutomationLock(kind, agentDir);
  if (!inspect.exists) {
    return { repaired: false, path, reason: "lock_missing" };
  }
  if (inspect.corrupt || inspect.empty || inspect.expired) {
    try {
      // Quarantine rather than silent delete of unknown content when possible.
      if (existsSync(path)) {
        const quarantine = `${path}.corrupt.${Date.now()}`;
        try {
          renameSync(path, quarantine);
        } catch {
          unlinkSync(path);
        }
      }
      return {
        repaired: true,
        path,
        reason: inspect.corrupt || inspect.empty ? "corrupt_removed" : "stale_removed",
      };
    } catch (error) {
      throw new AutomationLockError(
        `Failed to repair ${kind} lock: ${error instanceof Error ? error.message : String(error)}`,
        "repair_required",
      );
    }
  }
  // Non-expired foreign lock must not be removed by repair without force.
  return { repaired: false, path, reason: "lock_held" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertFencing(handle: LockHandle, expectedEpoch: number, expectedOwner: string): void {
  if (handle.epoch !== expectedEpoch || handle.ownerId !== expectedOwner) {
    throw new AutomationLockError("Fencing token mismatch", "fencing_rejected");
  }
  if (!existsSync(handle.path)) {
    throw new AutomationLockError("Lock file missing", "fencing_rejected");
  }
  try {
    statSync(handle.path);
  } catch {
    throw new AutomationLockError("Lock file unreadable", "fencing_rejected");
  }
  const { lock, corrupt } = readLockFile(handle.path);
  if (corrupt || !lock) throw new AutomationLockError("Lock corrupt", "repair_required");
  if (lock.ownerId !== handle.ownerId || lock.epoch !== handle.epoch) {
    throw new AutomationLockError("Lock ownership lost", "fencing_rejected");
  }
}
