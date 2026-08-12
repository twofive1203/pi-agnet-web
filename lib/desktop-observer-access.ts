/**
 * Local-only access gate for /api/desktop-observer/**.
 *
 * Attach-only desktop pet: direct IPv4 loopback + local mode + short-lived
 * hashed observer tokens. Server mode, non-loopback peers, and non-loopback
 * forwarded identity are rejected. Root server-access auth never relaxes these gates.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  assertDirectLoopbackConnection,
  AutomationAccessError,
} from "./automation-local-access";
import {
  getAutomationRemoteAddress,
  isLoopbackIp,
  normalizeIp,
} from "./automation-connection-context";
import {
  DESKTOP_OBSERVER_PRODUCT,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DESKTOP_OBSERVER_TOKEN_TTL_MS,
} from "./desktop-observer-constants";
import { getProcessInstanceId } from "./process-runtime";
import { isServerAccessAuthEnabled } from "./server-access-policy";
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

function isIpv4LoopbackHostLabel(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/:\d+$/, "").toLowerCase();
  // Desktop pet attaches to 127.0.0.1 only (R15) — no localhost DNS.
  if (h === "127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** True when this process is in server mode (desktop observer unsupported in v1). */
export function isDesktopObserverServerMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isServerAccessAuthEnabled(env as NodeJS.ProcessEnv);
}

/**
 * Prove direct loopback TCP peer + IPv4 loopback Host (127.x).
 * Does not check server mode (protocol probe needs that separately).
 */
export function assertDesktopObserverLoopback(req: Request): string {
  let remote: string;
  try {
    remote = assertDirectLoopbackConnection(req);
  } catch (error) {
    if (error instanceof AutomationAccessError) {
      throw new DesktopObserverAccessError(error.message, error.status, error.code);
    }
    throw error;
  }

  // Stricter than Automation: client Host must be IPv4 loopback (not "localhost").
  const hostHeader = (req.headers.get("host") ?? "").trim();
  if (hostHeader) {
    const hostLabel = hostHeader.split(":")[0] ?? hostHeader;
    if (!isIpv4LoopbackHostLabel(hostLabel)) {
      throw new DesktopObserverAccessError(
        "Desktop observer requires Host 127.0.0.1",
        403,
        "security",
      );
    }
  } else {
    try {
      const url = new URL(req.url);
      if (url.hostname && !isIpv4LoopbackHostLabel(url.hostname)) {
        throw new DesktopObserverAccessError(
          "Desktop observer requires URL host 127.0.0.1",
          403,
          "security",
        );
      }
    } catch (error) {
      if (error instanceof DesktopObserverAccessError) throw error;
      throw new DesktopObserverAccessError("Invalid request URL", 403, "security");
    }
  }

  return remote;
}

/**
 * Full attach gate: loopback + local mode (not server mode).
 * Returns normalized remote address.
 */
export function assertDesktopObserverLocalAccess(req: Request): string {
  if (isDesktopObserverServerMode()) {
    throw new DesktopObserverAccessError(
      "Desktop observer is unavailable in server mode",
      403,
      "server_mode",
    );
  }
  return assertDesktopObserverLoopback(req);
}

/**
 * Session mint origin policy: exact same-origin when Origin present;
 * missing Origin allowed for Electron main (not browsers with spoofed referer alone).
 */
export function assertDesktopObserverSessionOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let reqUrl: URL;
  try {
    reqUrl = new URL(req.url);
  } catch {
    throw new DesktopObserverAccessError("Invalid request URL", 403, "security");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new DesktopObserverAccessError("Invalid Origin", 403, "security");
  }
  // Compare host ignoring hostname label style — still require loopback origin.
  if (originUrl.protocol !== reqUrl.protocol) {
    throw new DesktopObserverAccessError("Cross-origin request blocked", 403, "security");
  }
  const originHost = originUrl.hostname;
  if (!isIpv4LoopbackHostLabel(originHost) && !isLoopbackIp(originHost)) {
    throw new DesktopObserverAccessError("Origin is not loopback", 403, "security");
  }
  const reqPort = reqUrl.port || (reqUrl.protocol === "https:" ? "443" : "80");
  const originPort = originUrl.port || (originUrl.protocol === "https:" ? "443" : "80");
  if (reqPort !== originPort) {
    throw new DesktopObserverAccessError("Cross-origin port mismatch", 403, "security");
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
  compatible: boolean;
  reasonCode: string | null;
} {
  const serverMode = isDesktopObserverServerMode(env);
  return {
    protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
    product: DESKTOP_OBSERVER_PRODUCT,
    mode: serverMode ? "server" : "local",
    instanceId: getProcessInstanceId(env as NodeJS.ProcessEnv),
    compatible: !serverMode,
    reasonCode: serverMode ? "server_mode" : null,
  };
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
