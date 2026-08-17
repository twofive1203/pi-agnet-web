/**
 * Shared loopback / Host / Origin / access-key gate for desktop companion
 * namespaces (observer + control). Token stores stay separate — this module
 * never mints or verifies observer or control tokens.
 *
 * Root server-access auth never relaxes the loopback gate. Non-loopback peers
 * and non-loopback forwarded identity are always rejected.
 */

import {
  assertDirectLoopbackConnection,
  AutomationAccessError,
} from "./automation-local-access";
import { getAutomationRemoteAddress, isLoopbackIp } from "./automation-connection-context";
import {
  assertAccessKeyValid,
  consumeLoginAttempt,
  recordLoginSuccess,
  ServerAccessError,
} from "./server-access-auth";
import {
  clientKeyFromRequest,
  isServerAccessAuthEnabled,
  MAX_ACCESS_KEY_LENGTH,
} from "./server-access-policy";

export class DesktopLocalAccessError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 403, code = "security") {
    super(message);
    this.name = "DesktopLocalAccessError";
    this.status = status;
    this.code = code;
  }
}

export function isIpv4LoopbackHostLabel(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/:\d+$/, "").toLowerCase();
  // Desktop pet attaches to 127.0.0.1 only (R15) — no localhost DNS.
  if (h === "127.0.0.1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** True when this process has global access-key auth enabled. */
export function isDesktopCompanionServerMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isServerAccessAuthEnabled(env as NodeJS.ProcessEnv);
}

/**
 * Prove direct loopback TCP peer + IPv4 loopback Host (127.x).
 * Server mode is allowed; remote peers are still rejected.
 */
export function assertDesktopCompanionLoopback(req: Request): string {
  let remote: string;
  try {
    remote = assertDirectLoopbackConnection(req);
  } catch (error) {
    if (error instanceof AutomationAccessError) {
      throw new DesktopLocalAccessError(error.message, error.status, error.code);
    }
    throw error;
  }

  // Stricter than Automation: client Host must be IPv4 loopback (not "localhost").
  const hostHeader = (req.headers.get("host") ?? "").trim();
  if (hostHeader) {
    const hostLabel = hostHeader.split(":")[0] ?? hostHeader;
    if (!isIpv4LoopbackHostLabel(hostLabel)) {
      throw new DesktopLocalAccessError(
        "Desktop companion requires Host 127.0.0.1",
        403,
        "security",
      );
    }
  } else {
    try {
      const url = new URL(req.url);
      if (url.hostname && !isIpv4LoopbackHostLabel(url.hostname)) {
        throw new DesktopLocalAccessError(
          "Desktop companion requires URL host 127.0.0.1",
          403,
          "security",
        );
      }
    } catch (error) {
      if (error instanceof DesktopLocalAccessError) throw error;
      throw new DesktopLocalAccessError("Invalid request URL", 403, "security");
    }
  }

  return remote;
}

/**
 * Full attach gate: proven loopback only.
 * Server mode is allowed on loopback; access-key check happens at session mint.
 * Returns normalized remote address.
 */
export function assertDesktopCompanionLocalAccess(req: Request): string {
  return assertDesktopCompanionLoopback(req);
}

/**
 * When server auth is on, verify the desktop-provided access key before minting
 * a companion token. Local mode is a no-op. Uses the login attempt budget so
 * brute-force against observer and control mint paths share the same socket-IP
 * limits.
 */
export async function assertDesktopCompanionAccessKey(
  req: Request,
  accessKey: unknown,
): Promise<void> {
  if (!isDesktopCompanionServerMode()) return;

  const remote = getAutomationRemoteAddress();
  const clientKey = clientKeyFromRequest(req, remote);
  const rate = consumeLoginAttempt(clientKey);
  if (!rate.allowed) {
    throw new DesktopLocalAccessError(
      "Too many attempts. Try again later.",
      429,
      "rate_limited",
    );
  }

  const key = typeof accessKey === "string" ? accessKey : "";
  if (!key) {
    throw new DesktopLocalAccessError("Access key required", 401, "auth_required");
  }
  if (key.length > MAX_ACCESS_KEY_LENGTH) {
    throw new DesktopLocalAccessError("Invalid access key", 401, "auth_invalid");
  }

  try {
    await assertAccessKeyValid(key);
    recordLoginSuccess(clientKey);
  } catch (error) {
    if (error instanceof ServerAccessError) {
      if (error.code === "invalid_credentials") {
        throw new DesktopLocalAccessError("Invalid access key", 401, "auth_invalid");
      }
      if (error.code === "rate_limited") {
        throw new DesktopLocalAccessError(
          "Too many attempts. Try again later.",
          429,
          "rate_limited",
        );
      }
      throw new DesktopLocalAccessError(
        "Authentication unavailable",
        503,
        "auth_unavailable",
      );
    }
    throw error;
  }
}

/**
 * Session mint origin policy: exact same-origin when Origin present;
 * missing Origin allowed for Electron main (not browsers with spoofed referer alone).
 */
export function assertDesktopCompanionSessionOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  let reqUrl: URL;
  try {
    reqUrl = new URL(req.url);
  } catch {
    throw new DesktopLocalAccessError("Invalid request URL", 403, "security");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new DesktopLocalAccessError("Invalid Origin", 403, "security");
  }
  // Compare host ignoring hostname label style — still require loopback origin.
  if (originUrl.protocol !== reqUrl.protocol) {
    throw new DesktopLocalAccessError("Cross-origin request blocked", 403, "security");
  }
  const originHost = originUrl.hostname;
  if (!isIpv4LoopbackHostLabel(originHost) && !isLoopbackIp(originHost)) {
    throw new DesktopLocalAccessError("Origin is not loopback", 403, "security");
  }
  const reqPort = reqUrl.port || (reqUrl.protocol === "https:" ? "443" : "80");
  const originPort = originUrl.port || (originUrl.protocol === "https:" ? "443" : "80");
  if (reqPort !== originPort) {
    throw new DesktopLocalAccessError("Cross-origin port mismatch", 403, "security");
  }
}
