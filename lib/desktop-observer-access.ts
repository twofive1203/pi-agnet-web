/**
 * Local-only access gate for /api/desktop-observer/**.
 *
 * Compatibility facade over the shared desktop companion loopback / Host /
 * Origin / access-key helpers. Observer tokens stay in an independent hashed
 * store and are never accepted by desktop-control routes.
 *
 * Attach-only desktop pet: direct IPv4 loopback + short-lived hashed observer
 * tokens. Non-loopback peers and non-loopback forwarded identity are always
 * rejected. Server mode is allowed only on proven loopback; when global
 * access-key auth is on, session mint additionally verifies the access key.
 * Root server-access auth never relaxes the loopback gate.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  getAutomationRemoteAddress,
  isLoopbackIp,
  normalizeIp,
} from "./automation-connection-context";
import {
  DESKTOP_PROTOCOL_CAPABILITIES,
  DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION,
  type DesktopProtocolCapability,
} from "./desktop-control-constants";
import {
  DESKTOP_OBSERVER_PRODUCT,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DESKTOP_OBSERVER_TOKEN_TTL_MS,
} from "./desktop-observer-constants";
import {
  assertDesktopCompanionAccessKey,
  assertDesktopCompanionLocalAccess,
  assertDesktopCompanionLoopback,
  assertDesktopCompanionSessionOrigin,
  DesktopLocalAccessError,
  isDesktopCompanionServerMode,
} from "./desktop-local-access";
import { getProcessInstanceId } from "./process-runtime";
import { TASK_OBSERVER_PROTOCOL_VERSION } from "./task-observer-types";

export {
  DESKTOP_OBSERVER_PRODUCT,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DESKTOP_OBSERVER_TOKEN_TTL_MS,
} from "./desktop-observer-constants";

export class DesktopObserverAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 403, code = "security") {
    super(message);
    this.name = "DesktopObserverAccessError";
    this.status = status;
    this.code = code;
  }
}

function wrapLocalError(error: unknown): never {
  if (error instanceof DesktopLocalAccessError) {
    throw new DesktopObserverAccessError(error.message, error.status, error.code);
  }
  throw error;
}

type ObserverTokenEntry = {
  tokenHash: string;
  expiresAt: number;
  instanceId: string;
  boundRemote: string;
};

declare global {
  var __piDesktopObserverTokens: Map<string, ObserverTokenEntry> | undefined;
}

function tokenStore(): Map<string, ObserverTokenEntry> {
  if (!globalThis.__piDesktopObserverTokens) {
    globalThis.__piDesktopObserverTokens = new Map();
  }
  return globalThis.__piDesktopObserverTokens;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** True when this process has global access-key auth enabled. */
export function isDesktopObserverServerMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isDesktopCompanionServerMode(env);
}

/**
 * Prove direct loopback TCP peer + IPv4 loopback Host (127.x).
 * Server mode is allowed; remote peers are still rejected.
 */
export function assertDesktopObserverLoopback(req: Request): string {
  try {
    return assertDesktopCompanionLoopback(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

/**
 * Full attach gate: proven loopback only.
 * Server mode is allowed on loopback; access-key check happens at session mint.
 * Returns normalized remote address.
 */
export function assertDesktopObserverLocalAccess(req: Request): string {
  try {
    return assertDesktopCompanionLocalAccess(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

/**
 * When server auth is on, verify the desktop-provided access key before minting
 * an observer token. Local mode is a no-op. Uses the login attempt budget so
 * brute-force against the pet attach path shares the same socket-IP limits.
 */
export async function assertDesktopObserverAccessKey(
  req: Request,
  accessKey: unknown,
): Promise<void> {
  try {
    await assertDesktopCompanionAccessKey(req, accessKey);
  } catch (error) {
    wrapLocalError(error);
  }
}

/**
 * Session mint origin policy: exact same-origin when Origin present;
 * missing Origin allowed for Electron main (not browsers with spoofed referer alone).
 */
export function assertDesktopObserverSessionOrigin(req: Request): void {
  try {
    assertDesktopCompanionSessionOrigin(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

export function issueDesktopObserverToken(options: {
  remote: string;
  ttlMs?: number;
  instanceId?: string;
}): { token: string; expiresAt: number; instanceId: string; ttlMs: number } {
  if (!isLoopbackIp(options.remote)) {
    throw new DesktopObserverAccessError("Token mint requires loopback remote", 403, "security");
  }

  const ttlMs = options.ttlMs ?? DESKTOP_OBSERVER_TOKEN_TTL_MS;
  const instanceId = options.instanceId ?? getProcessInstanceId();
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const token = `${id}.${secret}`;
  const expiresAt = Date.now() + ttlMs;
  tokenStore().set(id, {
    tokenHash: hashToken(secret),
    expiresAt,
    instanceId,
    boundRemote: normalizeIp(options.remote) ?? options.remote,
  });
  pruneExpiredTokens();
  return { token, expiresAt, instanceId, ttlMs };
}

export function readDesktopObserverToken(req: Request): string | null {
  const header = req.headers.get(DESKTOP_OBSERVER_TOKEN_HEADER);
  if (!header) return null;
  const trimmed = header.trim();
  return trimmed || null;
}

export function assertDesktopObserverToken(req: Request): {
  instanceId: string;
  expiresAt: number;
} {
  assertDesktopObserverLocalAccess(req);
  const raw = readDesktopObserverToken(req);
  if (!raw || !raw.includes(".")) {
    throw new DesktopObserverAccessError("Missing desktop observer token", 401, "unauthorized");
  }
  const [id, secret] = raw.split(".", 2);
  if (!id || !secret) {
    throw new DesktopObserverAccessError("Invalid desktop observer token", 401, "unauthorized");
  }
  const entry = tokenStore().get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    tokenStore().delete(id);
    throw new DesktopObserverAccessError("Desktop observer token expired", 401, "unauthorized");
  }
  const a = Buffer.from(entry.tokenHash, "hex");
  const b = Buffer.from(hashToken(secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DesktopObserverAccessError("Desktop observer token mismatch", 401, "unauthorized");
  }
  const currentInstance = getProcessInstanceId();
  if (entry.instanceId !== currentInstance) {
    tokenStore().delete(id);
    throw new DesktopObserverAccessError(
      "Desktop observer token bound to a different instance",
      401,
      "instance_mismatch",
    );
  }
  const remote = getAutomationRemoteAddress();
  if (!remote || !isLoopbackIp(remote) || !isLoopbackIp(entry.boundRemote)) {
    throw new DesktopObserverAccessError(
      "Desktop observer token remote binding failed",
      401,
      "unauthorized",
    );
  }
  return { instanceId: entry.instanceId, expiresAt: entry.expiresAt };
}

export function buildDesktopObserverProtocolPayload(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): {
  protocolVersion: typeof TASK_OBSERVER_PROTOCOL_VERSION;
  product: typeof DESKTOP_OBSERVER_PRODUCT;
  mode: "local" | "server";
  instanceId: string;
  /** Loopback attach is supported in both local and server mode. */
  compatible: boolean;
  /** When true, POST /session must include a valid access key. */
  authRequired: boolean;
  reasonCode: string | null;
  /**
   * Additive companion capabilities. Old clients ignore unknown fields;
   * missing capabilities on old servers keep observer attach working.
   */
  capabilities: DesktopProtocolCapability[];
} {
  const serverMode = isDesktopObserverServerMode(env);
  return {
    protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
    product: DESKTOP_OBSERVER_PRODUCT,
    mode: serverMode ? "server" : "local",
    instanceId: getProcessInstanceId(env as NodeJS.ProcessEnv),
    compatible: true,
    authRequired: serverMode,
    reasonCode: null,
    capabilities: [...DESKTOP_PROTOCOL_CAPABILITIES],
  };
}

export function protocolHasQuickSessionCapability(payload: {
  capabilities?: unknown;
}): boolean {
  if (!Array.isArray(payload.capabilities)) return false;
  return payload.capabilities.includes(DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION);
}

function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [id, entry] of tokenStore()) {
    if (entry.expiresAt <= now) tokenStore().delete(id);
  }
}

/** Test helper. */
export function resetDesktopObserverTokensForTests(): void {
  tokenStore().clear();
}
