/**
 * Instance-level server access authentication domain.
 *
 * Single shared access key + opaque server-side sessions under
 * `<agentDir>/server-access.json`. Plaintext keys/tokens are never persisted.
 * Fail closed on corrupt/missing state in server mode.
 */

import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVER_ACCESS_STATE_FILENAME = "server-access.json";
export const SERVER_ACCESS_COOKIE_NAME = "spi_access_session";
export const SERVER_ACCESS_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SERVER_ACCESS_MAX_SESSIONS = 64;
export const SERVER_ACCESS_KEY_BYTES = 32;
export const SERVER_ACCESS_SCHEMA_VERSION = 1 as const;

/** scrypt params: OWASP-aligned N=2^15, r=8, p=1; maxmem sized for Node 22. */
export const SERVER_ACCESS_SCRYPT = {
  algorithm: "scrypt" as const,
  N: 1 << 15,
  r: 8,
  p: 1,
  keyLen: 32,
  maxmem: 64 * 1024 * 1024,
};

export const SERVER_ACCESS_RATE_LIMIT = {
  clientWindowMs: 60_000,
  clientMaxFailures: 10,
  globalWindowMs: 60_000,
  globalMaxFailures: 60,
  retryAfterSec: 30,
};

export type ServerAccessErrorCode =
  | "not_initialized"
  | "corrupt_state"
  | "invalid_credentials"
  | "rate_limited"
  | "session_invalid"
  | "write_failed"
  | "misconfigured";

export class ServerAccessError extends Error {
  readonly code: ServerAccessErrorCode;
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(
    code: ServerAccessErrorCode,
    message: string,
    status = 401,
    retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ServerAccessError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export type ServerAccessSessionRecord = {
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
};

export type ServerAccessState = {
  version: typeof SERVER_ACCESS_SCHEMA_VERSION;
  algorithm: "scrypt";
  scrypt: {
    N: number;
    r: number;
    p: number;
    keyLen: number;
    maxmem: number;
  };
  salt: string;
  verifier: string;
  credentialGeneration: number;
  sessions: ServerAccessSessionRecord[];
  updatedAt: number;
};

export type ServerAccessInitResult = {
  state: ServerAccessState;
  /** Present only on first init or rotation — show once, never persist. */
  accessKeyOnce?: string;
  created: boolean;
  rotated: boolean;
};

type RateBucket = {
  count: number;
  windowStart: number;
};

type MutableClock = { now: () => number };

const defaultClock: MutableClock = { now: () => Date.now() };
let clock: MutableClock = defaultClock;

/** Test-only clock injection. */
export function __setServerAccessClockForTests(nowFn: (() => number) | null): void {
  clock = nowFn ? { now: nowFn } : defaultClock;
}

function nowMs(): number {
  return clock.now();
}

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export function getServerAccessStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, SERVER_ACCESS_STATE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomAccessKey(): string {
  return randomBytes(SERVER_ACCESS_KEY_BYTES).toString("base64url");
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) {
      // Consume comparable work without throwing on length mismatch.
      const dummy = Buffer.alloc(32);
      timingSafeEqual(dummy, dummy);
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function deriveVerifier(
  accessKey: string,
  saltB64: string,
  params: ServerAccessState["scrypt"],
): string {
  const salt = Buffer.from(saltB64, "base64");
  const derived = scryptSync(accessKey, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  return derived.toString("base64");
}

function safeEqualBase64(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "base64");
    const bb = Buffer.from(b, "base64");
    if (ba.length === 0 || ba.length !== bb.length) {
      const dummy = Buffer.alloc(32);
      timingSafeEqual(dummy, dummy);
      return false;
    }
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function pruneSessions(sessions: ServerAccessSessionRecord[], now: number): ServerAccessSessionRecord[] {
  const live = sessions.filter((s) => s.expiresAt > now);
  if (live.length <= SERVER_ACCESS_MAX_SESSIONS) return live;
  // Evict earliest-expiring first when over the hard cap.
  return [...live]
    .sort((a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt)
    .slice(live.length - SERVER_ACCESS_MAX_SESSIONS);
}

function parseState(raw: unknown): ServerAccessState {
  if (!isRecord(raw)) {
    throw new ServerAccessError("corrupt_state", "server-access state is not an object", 503);
  }
  if (raw.version !== SERVER_ACCESS_SCHEMA_VERSION) {
    throw new ServerAccessError("corrupt_state", "unsupported server-access schema version", 503);
  }
  if (raw.algorithm !== "scrypt") {
    throw new ServerAccessError("corrupt_state", "unsupported server-access algorithm", 503);
  }
  if (!isRecord(raw.scrypt)) {
    throw new ServerAccessError("corrupt_state", "missing scrypt parameters", 503);
  }
  const scrypt = {
    N: Number(raw.scrypt.N),
    r: Number(raw.scrypt.r),
    p: Number(raw.scrypt.p),
    keyLen: Number(raw.scrypt.keyLen),
    maxmem: Number(raw.scrypt.maxmem),
  };
  if (
    !Number.isInteger(scrypt.N) ||
    scrypt.N < 2 ||
    !Number.isInteger(scrypt.r) ||
    scrypt.r < 1 ||
    !Number.isInteger(scrypt.p) ||
    scrypt.p < 1 ||
    !Number.isInteger(scrypt.keyLen) ||
    scrypt.keyLen < 16 ||
    !Number.isInteger(scrypt.maxmem) ||
    scrypt.maxmem < 1024
  ) {
    throw new ServerAccessError("corrupt_state", "invalid scrypt parameters", 503);
  }
  if (typeof raw.salt !== "string" || raw.salt.length < 8) {
    throw new ServerAccessError("corrupt_state", "missing salt", 503);
  }
  if (typeof raw.verifier !== "string" || raw.verifier.length < 8) {
    throw new ServerAccessError("corrupt_state", "missing verifier", 503);
  }
  if (
    typeof raw.credentialGeneration !== "number" ||
    !Number.isInteger(raw.credentialGeneration) ||
    raw.credentialGeneration < 1
  ) {
    throw new ServerAccessError("corrupt_state", "invalid credential generation", 503);
  }
  if (!Array.isArray(raw.sessions)) {
    throw new ServerAccessError("corrupt_state", "sessions must be an array", 503);
  }
  const sessions: ServerAccessSessionRecord[] = [];
  for (const item of raw.sessions) {
    if (!isRecord(item)) continue;
    if (typeof item.tokenHash !== "string" || !/^[0-9a-f]{64}$/i.test(item.tokenHash)) continue;
    if (typeof item.expiresAt !== "number" || !Number.isFinite(item.expiresAt)) continue;
    if (typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) continue;
    sessions.push({
      tokenHash: item.tokenHash.toLowerCase(),
      expiresAt: item.expiresAt,
      createdAt: item.createdAt,
    });
  }
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;

  return {
    version: SERVER_ACCESS_SCHEMA_VERSION,
    algorithm: "scrypt",
    scrypt,
    salt: raw.salt,
    verifier: raw.verifier,
    credentialGeneration: raw.credentialGeneration,
    sessions,
    updatedAt,
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(tmpPath, path);
    } catch {
      // Windows may refuse rename-over-existing.
      if (existsSync(path)) unlinkSync(path);
      renameSync(tmpPath, path);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
  } catch (error) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw new ServerAccessError(
      "write_failed",
      error instanceof Error ? error.message : "failed to write server-access state",
      503,
    );
  }
}

/** Serialize mutations within one process. */
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function readServerAccessState(agentDir = getAgentDir()): ServerAccessState {
  const path = getServerAccessStatePath(agentDir);
  if (!existsSync(path)) {
    throw new ServerAccessError("not_initialized", "server-access state is missing", 503);
  }
  let rawText: string;
  try {
    rawText = readFileSync(path, "utf8");
  } catch (error) {
    throw new ServerAccessError(
      "corrupt_state",
      error instanceof Error ? error.message : "failed to read server-access state",
      503,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new ServerAccessError("corrupt_state", "server-access state is not valid JSON", 503);
  }
  const state = parseState(parsed);
  const pruned = pruneSessions(state.sessions, nowMs());
  if (pruned.length !== state.sessions.length) {
    // Lazy cleanup of expired sessions — best effort, non-blocking for readers.
    const next = { ...state, sessions: pruned, updatedAt: nowMs() };
    try {
      atomicWriteJson(path, next);
      return next;
    } catch {
      return { ...state, sessions: pruned };
    }
  }
  return state;
}

function buildFreshState(accessKey: string, generation = 1): ServerAccessState {
  const salt = randomBytes(16).toString("base64");
  const scrypt = { ...SERVER_ACCESS_SCRYPT };
  const verifier = deriveVerifier(accessKey, salt, scrypt);
  return {
    version: SERVER_ACCESS_SCHEMA_VERSION,
    algorithm: "scrypt",
    scrypt: {
      N: scrypt.N,
      r: scrypt.r,
      p: scrypt.p,
      keyLen: scrypt.keyLen,
      maxmem: scrypt.maxmem,
    },
    salt,
    verifier,
    credentialGeneration: generation,
    sessions: [],
    updatedAt: nowMs(),
  };
}

/**
 * Ensure auth state exists. On first create returns the one-time plaintext key.
 * Does not rotate an existing healthy state.
 */
export async function ensureServerAccessInitialized(
  agentDir = getAgentDir(),
): Promise<ServerAccessInitResult> {
  return enqueueWrite(() => {
    const path = getServerAccessStatePath(agentDir);
    if (existsSync(path)) {
      const state = readServerAccessState(agentDir);
      return { state, created: false, rotated: false };
    }
    const accessKey = randomAccessKey();
    const state = buildFreshState(accessKey, 1);
    atomicWriteJson(path, state);
    return { state, accessKeyOnce: accessKey, created: true, rotated: false };
  });
}

/**
 * Rotate access key and wipe all sessions. Always returns a one-time plaintext key.
 * Rebuilds state even when the previous file is corrupt (explicit recovery path).
 */
export async function rotateServerAccessKey(
  agentDir = getAgentDir(),
): Promise<ServerAccessInitResult> {
  return enqueueWrite(() => {
    const path = getServerAccessStatePath(agentDir);
    let generation = 1;
    if (existsSync(path)) {
      try {
        const prev = readServerAccessState(agentDir);
        generation = prev.credentialGeneration + 1;
      } catch {
        generation = 1;
      }
    }
    const accessKey = randomAccessKey();
    const state = buildFreshState(accessKey, generation);
    atomicWriteJson(path, state);
    return { state, accessKeyOnce: accessKey, created: !existsSync(path), rotated: true };
  });
}

export function verifyAccessKey(
  accessKey: string,
  agentDir = getAgentDir(),
): boolean {
  if (typeof accessKey !== "string" || accessKey.length === 0 || accessKey.length > 512) {
    return false;
  }
  const state = readServerAccessState(agentDir);
  const candidate = deriveVerifier(accessKey, state.salt, state.scrypt);
  return safeEqualBase64(candidate, state.verifier);
}

export type CreateSessionResult = {
  token: string;
  expiresAt: number;
  maxAgeSec: number;
};

export async function createServerAccessSession(
  accessKey: string,
  agentDir = getAgentDir(),
): Promise<CreateSessionResult> {
  return enqueueWrite(() => {
    if (typeof accessKey !== "string" || accessKey.length === 0 || accessKey.length > 512) {
      throw new ServerAccessError("invalid_credentials", "Invalid access key", 401);
    }
    const state = readServerAccessState(agentDir);
    const candidate = deriveVerifier(accessKey, state.salt, state.scrypt);
    if (!safeEqualBase64(candidate, state.verifier)) {
      throw new ServerAccessError("invalid_credentials", "Invalid access key", 401);
    }
    const now = nowMs();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(token);
    const expiresAt = now + SERVER_ACCESS_SESSION_TTL_MS;
    const sessions = pruneSessions(
      [...state.sessions, { tokenHash, expiresAt, createdAt: now }],
      now,
    );
    const next: ServerAccessState = {
      ...state,
      sessions,
      updatedAt: now,
    };
    atomicWriteJson(getServerAccessStatePath(agentDir), next);
    return {
      token,
      expiresAt,
      maxAgeSec: Math.floor(SERVER_ACCESS_SESSION_TTL_MS / 1000),
    };
  });
}

export function validateServerAccessSession(
  token: string | null | undefined,
  agentDir = getAgentDir(),
): { ok: true; expiresAt: number } | { ok: false } {
  if (typeof token !== "string" || token.length < 16 || token.length > 256) {
    return { ok: false };
  }
  let state: ServerAccessState;
  try {
    state = readServerAccessState(agentDir);
  } catch (error) {
    // Propagate corrupt/missing state so Proxy can fail closed with 503.
    if (error instanceof ServerAccessError) throw error;
    return { ok: false };
  }
  const tokenHash = hashSessionToken(token);
  const now = nowMs();
  for (const session of state.sessions) {
    if (session.expiresAt <= now) continue;
    if (safeEqualHex(session.tokenHash, tokenHash)) {
      return { ok: true, expiresAt: session.expiresAt };
    }
  }
  return { ok: false };
}

export async function revokeServerAccessSession(
  token: string | null | undefined,
  agentDir = getAgentDir(),
): Promise<void> {
  return enqueueWrite(() => {
    if (typeof token !== "string" || token.length < 16) return;
    let state: ServerAccessState;
    try {
      state = readServerAccessState(agentDir);
    } catch {
      return;
    }
    const tokenHash = hashSessionToken(token);
    const now = nowMs();
    const sessions = pruneSessions(
      state.sessions.filter((s) => !safeEqualHex(s.tokenHash, tokenHash)),
      now,
    );
    if (sessions.length === state.sessions.length) return;
    atomicWriteJson(getServerAccessStatePath(agentDir), {
      ...state,
      sessions,
      updatedAt: now,
    });
  });
}

/* ─── In-process login rate limiting ─── */

declare global {
  var __piServerAccessRateLimit:
    | {
        clients: Map<string, RateBucket>;
        global: RateBucket;
      }
    | undefined;
}

function rateStore(): {
  clients: Map<string, RateBucket>;
  global: RateBucket;
} {
  if (!globalThis.__piServerAccessRateLimit) {
    globalThis.__piServerAccessRateLimit = {
      clients: new Map(),
      global: { count: 0, windowStart: nowMs() },
    };
  }
  return globalThis.__piServerAccessRateLimit;
}

function touchBucket(bucket: RateBucket, windowMs: number, now: number): RateBucket {
  if (now - bucket.windowStart >= windowMs) {
    return { count: 0, windowStart: now };
  }
  return bucket;
}

/** Bound map growth under abuse. */
function trimClientBuckets(clients: Map<string, RateBucket>, now: number): void {
  if (clients.size < 512) return;
  for (const [key, bucket] of clients) {
    if (now - bucket.windowStart >= SERVER_ACCESS_RATE_LIMIT.clientWindowMs * 2) {
      clients.delete(key);
    }
  }
  if (clients.size > 1024) {
    // Drop oldest half arbitrarily.
    let i = 0;
    for (const key of clients.keys()) {
      clients.delete(key);
      i += 1;
      if (i >= 512) break;
    }
  }
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

export function checkLoginRateLimit(clientKey: string): RateLimitDecision {
  const store = rateStore();
  const now = nowMs();
  const key = clientKey.trim() || "unknown";
  trimClientBuckets(store.clients, now);

  store.global = touchBucket(store.global, SERVER_ACCESS_RATE_LIMIT.globalWindowMs, now);
  const client = touchBucket(
    store.clients.get(key) ?? { count: 0, windowStart: now },
    SERVER_ACCESS_RATE_LIMIT.clientWindowMs,
    now,
  );
  store.clients.set(key, client);

  if (store.global.count >= SERVER_ACCESS_RATE_LIMIT.globalMaxFailures) {
    return { allowed: false, retryAfterSec: SERVER_ACCESS_RATE_LIMIT.retryAfterSec };
  }
  if (client.count >= SERVER_ACCESS_RATE_LIMIT.clientMaxFailures) {
    return { allowed: false, retryAfterSec: SERVER_ACCESS_RATE_LIMIT.retryAfterSec };
  }
  return { allowed: true };
}

export function recordLoginFailure(clientKey: string): void {
  const store = rateStore();
  const now = nowMs();
  const key = clientKey.trim() || "unknown";
  store.global = touchBucket(store.global, SERVER_ACCESS_RATE_LIMIT.globalWindowMs, now);
  store.global.count += 1;
  const client = touchBucket(
    store.clients.get(key) ?? { count: 0, windowStart: now },
    SERVER_ACCESS_RATE_LIMIT.clientWindowMs,
    now,
  );
  client.count += 1;
  store.clients.set(key, client);
}

export function recordLoginSuccess(clientKey: string): void {
  // Successful login clears the client bucket but not the global one
  // (plan: success does not bypass global limits).
  const store = rateStore();
  const key = clientKey.trim() || "unknown";
  store.clients.delete(key);
}

/** Test-only reset. */
export function __resetServerAccessRateLimitForTests(): void {
  globalThis.__piServerAccessRateLimit = undefined;
}

/**
 * Boot helper used by instrumentation.
 * When rotate=true, always rotates. Otherwise ensures state exists.
 * Returns one-time key only for create/rotate.
 */
export async function bootstrapServerAccessAuth(options?: {
  agentDir?: string;
  rotate?: boolean;
}): Promise<ServerAccessInitResult> {
  const agentDir = options?.agentDir ?? getAgentDir();
  if (options?.rotate) {
    return rotateServerAccessKey(agentDir);
  }
  return ensureServerAccessInitialized(agentDir);
}

export function isServerAccessStatePresent(agentDir = getAgentDir()): boolean {
  return existsSync(getServerAccessStatePath(agentDir));
}
