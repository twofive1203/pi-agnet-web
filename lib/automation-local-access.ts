/**
 * Local-only access gate for /api/automations/**.
 * First release: direct loopback (server-derived remote address) + same-origin/control-session.
 * Host/URL are never sufficient proof of loopback — fail closed when remote address is unknown.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  getAutomationRemoteAddress,
  installAutomationConnectionCapture,
  isLoopbackIp,
  normalizeIp,
} from "./automation-connection-context";

export const AUTOMATION_CONTROL_COOKIE = "spi_automation_ctrl";
export const AUTOMATION_CONTROL_HEADER = "x-spi-automation-control";

export class AutomationAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 403, code = "security") {
    super(message);
    this.name = "AutomationAccessError";
    this.status = status;
    this.code = code;
  }
}

function isLoopbackHostLabel(host: string): boolean {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Resolve the connection remote address from ALS (preferred) or explicit override (tests).
 * Never falls back to Host/URL.
 */
export function resolveAutomationRemoteAddress(req?: Request): string | null {
  void req;
  // Ensure hook is attempted (idempotent) so first request after boot still has a chance.
  installAutomationConnectionCapture();
  return getAutomationRemoteAddress();
}

function forwardedClaimsNonLoopback(req: Request): boolean {
  const values = [
    req.headers.get("x-forwarded-for"),
    req.headers.get("x-real-ip"),
    req.headers.get("forwarded"),
  ].filter(Boolean) as string[];
  for (const raw of values) {
    // x-forwarded-for may be a list; forwarded may contain for=...
    const parts = raw.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
      const m = part.match(/(?:for=)?\[?([^\];\s]+)\]?/i);
      const candidate = (m?.[1] ?? part).replace(/^"|"$/g, "");
      const ip = normalizeIp(candidate.replace(/^for=/i, ""));
      if (ip && isIPAddress(ip) && !isLoopbackIp(ip)) {
        return true;
      }
    }
  }
  const xfHost = req.headers.get("x-forwarded-host");
  if (xfHost) {
    const hostLabel = xfHost.split(":")[0] ?? xfHost;
    if (!isLoopbackHostLabel(hostLabel) && !isLoopbackIp(hostLabel)) {
      return true;
    }
  }
  return false;
}

function isIPAddress(value: string): boolean {
  // Cheap check — normalizeIp already lowercases; isLoopbackIp uses net.isIP indirectly.
  return /^\d+\.\d+\.\d+\.\d+$/.test(value) || value.includes(":");
}

export function assertDirectLoopbackConnection(req?: Request): string {
  // Socket remote address is authoritative. Host/URL alone never prove loopback.
  // Next.js may synthesize X-Forwarded-* even for direct local requests; only reject
  // when those headers claim a non-loopback client (reverse-proxy remote access).
  const remote = resolveAutomationRemoteAddress(req);
  if (!remote) {
    throw new AutomationAccessError(
      "Automation APIs require a proven direct loopback connection; remote address unavailable",
      403,
      "security",
    );
  }
  if (!isLoopbackIp(remote)) {
    throw new AutomationAccessError(
      `Automation APIs are only available on direct loopback connections (remote=${normalizeIp(remote)})`,
      403,
      "security",
    );
  }

  if (req && forwardedClaimsNonLoopback(req)) {
    throw new AutomationAccessError(
      "Automation is local-only and rejects non-loopback forwarded client identity in v1",
      403,
      "security",
    );
  }

  // Host/URL are advisory consistency checks only after remote is proven loopback.
  // A spoofed Host from a remote client never reaches here because remote would fail first.
  // Prefer the client Host header: Next may rewrite Request URL hostname to the listen
  // address (e.g. 0.0.0.0) or another non-loopback label even when the peer is 127.0.0.1.
  if (req) {
    const hostHeader = (req.headers.get("host") ?? "").trim();
    if (hostHeader) {
      const hostLabel = hostHeader.split(":")[0] ?? hostHeader;
      if (!isLoopbackHostLabel(hostLabel) && !isLoopbackIp(hostLabel)) {
        throw new AutomationAccessError("Host header is not loopback", 403, "security");
      }
    } else {
      try {
        const url = new URL(req.url);
        if (url.hostname && !isLoopbackHostLabel(url.hostname) && !isLoopbackIp(url.hostname)) {
          throw new AutomationAccessError(
            "Automation request URL host is not loopback",
            403,
            "security",
          );
        }
      } catch (error) {
        if (error instanceof AutomationAccessError) throw error;
        throw new AutomationAccessError("Invalid request URL", 403, "security");
      }
    }
  }

  return remote;
}

export function assertAutomationLocalAccess(req: Request): void {
  assertDirectLoopbackConnection(req);
}

export function assertSameOrigin(req: Request): void {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (origin) {
    const o = new URL(origin);
    if (o.protocol !== url.protocol || o.host !== url.host) {
      throw new AutomationAccessError("Cross-origin request blocked", 403, "security");
    }
    return;
  }
  if (referer) {
    try {
      const r = new URL(referer);
      if (r.protocol !== url.protocol || r.host !== url.host) {
        throw new AutomationAccessError("Cross-origin referer blocked", 403, "security");
      }
      return;
    } catch {
      throw new AutomationAccessError("Invalid referer", 403, "security");
    }
  }
  // Non-browser clients (curl) without Origin are allowed only with control session.
}

declare global {
  var __piAutomationControlSessions:
    | Map<string, { tokenHash: string; expiresAt: number; boundRemote: string }>
    | undefined;
}

function controlSessions(): Map<string, { tokenHash: string; expiresAt: number; boundRemote: string }> {
  if (!globalThis.__piAutomationControlSessions) {
    globalThis.__piAutomationControlSessions = new Map();
  }
  return globalThis.__piAutomationControlSessions;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueAutomationControlSession(ttlMs = 12 * 60 * 60 * 1000): {
  token: string;
  cookie: string;
  expiresAt: number;
} {
  // Control sessions may only be issued on proven loopback connections.
  const remote = assertDirectLoopbackConnection();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + ttlMs;
  const id = randomBytes(8).toString("hex");
  controlSessions().set(id, { tokenHash: hashToken(token), expiresAt, boundRemote: remote });
  const value = `${id}.${token}`;
  const cookie = `${AUTOMATION_CONTROL_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
  return { token: value, cookie, expiresAt };
}

export function readControlSessionFromRequest(req: Request): string | null {
  const header = req.headers.get(AUTOMATION_CONTROL_HEADER);
  if (header) return header.trim();
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${AUTOMATION_CONTROL_COOKIE}=([^;]+)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function assertAutomationControlSession(req: Request): void {
  const raw = readControlSessionFromRequest(req);
  if (!raw || !raw.includes(".")) {
    throw new AutomationAccessError("Missing Automation control session", 401, "security");
  }
  const [id, token] = raw.split(".", 2);
  if (!id || !token) {
    throw new AutomationAccessError("Invalid Automation control session", 401, "security");
  }
  const entry = controlSessions().get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    throw new AutomationAccessError("Automation control session expired", 401, "security");
  }
  const a = Buffer.from(entry.tokenHash, "hex");
  const b = Buffer.from(hashToken(token), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AutomationAccessError("Automation control session mismatch", 401, "security");
  }
  // Bind control session to the same loopback remote class (both must be loopback).
  const remote = resolveAutomationRemoteAddress(req);
  if (!remote || !isLoopbackIp(remote) || !isLoopbackIp(entry.boundRemote)) {
    throw new AutomationAccessError("Automation control session remote binding failed", 401, "security");
  }
}

export function assertAutomationMutationAccess(req: Request): void {
  assertAutomationLocalAccess(req);
  assertSameOrigin(req);
  assertAutomationControlSession(req);
}

export function assertAutomationReadAccess(req: Request): void {
  assertAutomationLocalAccess(req);
  // Reads still require control session to avoid simple CSRF from other local apps.
  assertAutomationControlSession(req);
}
