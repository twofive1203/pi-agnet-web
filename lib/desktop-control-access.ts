/**
 * Local-only access gate for /api/desktop-control/**.
 *
 * Independent hashed control tokens with limited scopes. Observer tokens are
 * never accepted here, and control tokens are never accepted by observer
 * routes. Tokens stay in process memory, bound to instance + loopback remote.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  getAutomationRemoteAddress,
  isLoopbackIp,
  normalizeIp,
} from "./automation-connection-context";
import {
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DESKTOP_CONTROL_SCOPES,
  DESKTOP_CONTROL_TOKEN_HEADER,
  DESKTOP_CONTROL_TOKEN_TTL_MS,
  type DesktopControlScope,
} from "./desktop-control-constants";
import {
  assertDesktopCompanionAccessKey,
  assertDesktopCompanionLocalAccess,
  assertDesktopCompanionLoopback,
  assertDesktopCompanionSessionOrigin,
  DesktopLocalAccessError,
  isDesktopCompanionServerMode,
} from "./desktop-local-access";
import { getProcessInstanceId } from "./process-runtime";

export {
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DESKTOP_CONTROL_SCOPES,
  DESKTOP_CONTROL_TOKEN_HEADER,
  DESKTOP_CONTROL_TOKEN_TTL_MS,
  type DesktopControlScope,
} from "./desktop-control-constants";

export class DesktopControlAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 403, code = "security") {
    super(message);
    this.name = "DesktopControlAccessError";
    this.status = status;
    this.code = code;
  }
}

function wrapLocalError(error: unknown): never {
  if (error instanceof DesktopLocalAccessError) {
    throw new DesktopControlAccessError(error.message, error.status, error.code);
  }
  throw error;
}

type ControlTokenEntry = {
  tokenHash: string;
  expiresAt: number;
  instanceId: string;
  boundRemote: string;
  scopes: readonly DesktopControlScope[];
};

declare global {
  var __piDesktopControlTokens: Map<string, ControlTokenEntry> | undefined;
}

function tokenStore(): Map<string, ControlTokenEntry> {
  if (!globalThis.__piDesktopControlTokens) {
    globalThis.__piDesktopControlTokens = new Map();
  }
  return globalThis.__piDesktopControlTokens;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isDesktopControlServerMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isDesktopCompanionServerMode(env);
}

export function assertDesktopControlLoopback(req: Request): string {
  try {
    return assertDesktopCompanionLoopback(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

export function assertDesktopControlLocalAccess(req: Request): string {
  try {
    return assertDesktopCompanionLocalAccess(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

export async function assertDesktopControlAccessKey(
  req: Request,
  accessKey: unknown,
): Promise<void> {
  try {
    await assertDesktopCompanionAccessKey(req, accessKey);
  } catch (error) {
    wrapLocalError(error);
  }
}

export function assertDesktopControlSessionOrigin(req: Request): void {
  try {
    assertDesktopCompanionSessionOrigin(req);
  } catch (error) {
    wrapLocalError(error);
  }
}

function normalizeScopes(
  scopes: readonly DesktopControlScope[] | undefined,
): DesktopControlScope[] {
  const requested = scopes?.length ? scopes : [DESKTOP_CONTROL_SCOPE_QUICK_SESSION];
  const allowed = new Set<DesktopControlScope>(DESKTOP_CONTROL_SCOPES);
  const next: DesktopControlScope[] = [];
  for (const scope of requested) {
    if (!allowed.has(scope)) {
      throw new DesktopControlAccessError("Unknown desktop control scope", 400, "bad_request");
    }
    if (!next.includes(scope)) next.push(scope);
  }
  if (next.length === 0) {
    throw new DesktopControlAccessError("Desktop control scope required", 400, "bad_request");
  }
  return next;
}

export function issueDesktopControlToken(options: {
  remote: string;
  ttlMs?: number;
  instanceId?: string;
  scopes?: readonly DesktopControlScope[];
}): {
  token: string;
  expiresAt: number;
  instanceId: string;
  ttlMs: number;
  scopes: DesktopControlScope[];
} {
  if (!isLoopbackIp(options.remote)) {
    throw new DesktopControlAccessError("Token mint requires loopback remote", 403, "security");
  }

  const ttlMs = options.ttlMs ?? DESKTOP_CONTROL_TOKEN_TTL_MS;
  const instanceId = options.instanceId ?? getProcessInstanceId();
  const scopes = normalizeScopes(options.scopes);
  const id = randomBytes(8).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const token = `${id}.${secret}`;
  const expiresAt = Date.now() + ttlMs;
  tokenStore().set(id, {
    tokenHash: hashToken(secret),
    expiresAt,
    instanceId,
    boundRemote: normalizeIp(options.remote) ?? options.remote,
    scopes,
  });
  pruneExpiredTokens();
  return { token, expiresAt, instanceId, ttlMs, scopes };
}

export function readDesktopControlToken(req: Request): string | null {
  const header = req.headers.get(DESKTOP_CONTROL_TOKEN_HEADER);
  if (!header) return null;
  const trimmed = header.trim();
  return trimmed || null;
}

export function assertDesktopControlToken(
  req: Request,
  requiredScope: DesktopControlScope = DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
): {
  instanceId: string;
  expiresAt: number;
  scopes: DesktopControlScope[];
} {
  assertDesktopControlLocalAccess(req);
  const raw = readDesktopControlToken(req);
  if (!raw || !raw.includes(".")) {
    throw new DesktopControlAccessError("Missing desktop control token", 401, "unauthorized");
  }
  const [id, secret] = raw.split(".", 2);
  if (!id || !secret) {
    throw new DesktopControlAccessError("Invalid desktop control token", 401, "unauthorized");
  }
  const entry = tokenStore().get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    tokenStore().delete(id);
    throw new DesktopControlAccessError("Desktop control token expired", 401, "unauthorized");
  }
  const a = Buffer.from(entry.tokenHash, "hex");
  const b = Buffer.from(hashToken(secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new DesktopControlAccessError("Desktop control token mismatch", 401, "unauthorized");
  }
  const currentInstance = getProcessInstanceId();
  if (entry.instanceId !== currentInstance) {
    tokenStore().delete(id);
    throw new DesktopControlAccessError(
      "Desktop control token bound to a different instance",
      401,
      "instance_mismatch",
    );
  }
  const remote = getAutomationRemoteAddress();
  if (!remote || !isLoopbackIp(remote) || !isLoopbackIp(entry.boundRemote)) {
    throw new DesktopControlAccessError(
      "Desktop control token remote binding failed",
      401,
      "unauthorized",
    );
  }
  if (!entry.scopes.includes(requiredScope)) {
    throw new DesktopControlAccessError(
      "Desktop control token missing required scope",
      403,
      "forbidden",
    );
  }
  return {
    instanceId: entry.instanceId,
    expiresAt: entry.expiresAt,
    scopes: [...entry.scopes],
  };
}

function pruneExpiredTokens(): void {
  const now = Date.now();
  for (const [id, entry] of tokenStore()) {
    if (entry.expiresAt <= now) tokenStore().delete(id);
  }
}

/** Test helper. */
export function resetDesktopControlTokensForTests(): void {
  tokenStore().clear();
}
