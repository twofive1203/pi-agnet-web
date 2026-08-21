/**
 * Shared network / Host / Origin / access-key gate for desktop companion
 * namespaces (observer + control). Token stores stay separate — this module
 * never mints or verifies observer or control tokens.
 *
 * Local attach remains proven IPv4 loopback. Remote attach is server-mode only,
 * HTTPS by default, and never trusts X-Forwarded-For. Root cookie auth never
 * substitutes for Access Key mint + namespace tokens.
 */

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
  assertAccessKeyValid,
  consumeLoginAttempt,
  recordLoginSuccess,
  ServerAccessError,
} from "./server-access-auth";
import {
  clientKeyFromRequest,
  isLoopbackClientAddress,
  isSecureTransportRequired,
  isServerAccessAuthEnabled,
  isTrustProxyEnabled,
  MAX_ACCESS_KEY_LENGTH,
  resolveEffectiveProtocol,
} from "./server-access-policy";

export type DesktopCompanionAttachKind =
  | "local_loopback"
  | "remote_direct"
  | "remote_proxy";

export type DesktopCompanionIdentity = {
  kind: DesktopCompanionAttachKind;
  remote: string;
  bindKey: string;
  host: string;
  effectiveOrigin: string;
};

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

function requestHost(req: Request): string {
  return (req.headers.get("host") ?? "").trim();
}

function hostLabel(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end > 0) return host.slice(1, end);
  }
  return host.split(":")[0] ?? host;
}

export function evaluateDesktopCompanionProxyGate(
  req: Request,
  remote: string | null | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { allow: true } | { allow: false; status: number; code: string } {
  if (!remote) return { allow: false, status: 403, code: "security" };
  const loopbackPeer = isLoopbackClientAddress(remote);
  const host = requestHost(req);
  const loopbackHost = host ? isIpv4LoopbackHostLabel(hostLabel(host)) : false;

  if (loopbackPeer && (loopbackHost || !host)) {
    return { allow: true };
  }
  if (!isServerAccessAuthEnabled(env)) {
    return { allow: false, status: 403, code: "security" };
  }
  if (isSecureTransportRequired(req, env)) {
    return { allow: false, status: 403, code: "insecure_http" };
  }
  if (loopbackPeer && isTrustProxyEnabled(env)) {
    return { allow: true };
  }
  if (!loopbackPeer) {
    return { allow: true };
  }
  return { allow: false, status: 403, code: "security" };
}

export function classifyDesktopCompanionIdentity(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DesktopCompanionIdentity {
  const remoteRaw = getAutomationRemoteAddress();
  if (!remoteRaw) {
    throw new DesktopLocalAccessError("Missing remote address", 403, "security");
  }
  const remote = normalizeIp(remoteRaw) ?? remoteRaw;
  const host = requestHost(req);
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new DesktopLocalAccessError("Invalid request URL", 403, "security");
  }
  const loopbackPeer = isLoopbackIp(remote);
  const loopbackHost = host
    ? isIpv4LoopbackHostLabel(hostLabel(host))
    : isIpv4LoopbackHostLabel(url.hostname);

  if (loopbackPeer && loopbackHost) {
    return {
      kind: "local_loopback",
      remote,
      bindKey: `local:${remote}`,
      host: host || url.host,
      effectiveOrigin: url.origin,
    };
  }

  if (!isDesktopCompanionServerMode(env)) {
    throw new DesktopLocalAccessError(
      "Desktop companion requires Host 127.0.0.1",
      403,
      "security",
    );
  }

  if (isSecureTransportRequired(req, env)) {
    throw new DesktopLocalAccessError(
      "HTTPS required for remote desktop attach",
      403,
      "insecure_http",
    );
  }

  if (loopbackPeer && isTrustProxyEnabled(env) && host && !loopbackHost) {
    const proto = resolveEffectiveProtocol(req, env);
    const effectiveOrigin = `${proto}://${host}`;
    return {
      kind: "remote_proxy",
      remote,
      bindKey: `proxy:${effectiveOrigin}`,
      host,
      effectiveOrigin,
    };
  }

  if (!loopbackPeer) {
    return {
      kind: "remote_direct",
      remote,
      bindKey: `direct:${remote}`,
      host: host || url.host,
      effectiveOrigin: url.origin,
    };
  }

  throw new DesktopLocalAccessError(
    "Desktop companion remote attach rejected",
    403,
    "security",
  );
}

/**
 * Network attach gate: local loopback or server-mode remote with valid transport.
 */
export function assertDesktopCompanionNetworkAccess(req: Request): DesktopCompanionIdentity {
  return classifyDesktopCompanionIdentity(req);
}

/**
 * Full attach gate: local loopback or authorized remote.
 * Access-key check happens at session mint.
 * Returns normalized remote address for mint binding.
 */
export function assertDesktopCompanionLocalAccess(req: Request): string {
  return assertDesktopCompanionNetworkAccess(req).remote;
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
  identity?: DesktopCompanionIdentity,
): Promise<void> {
  const ident = identity ?? classifyDesktopCompanionIdentity(req);
  const serverMode = isDesktopCompanionServerMode();
  if (ident.kind === "local_loopback" && !serverMode) return;
  // Remote mint always requires the instance access key; auth-bypass CIDRs never skip it.

  const remote = ident.remote;
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
export function assertDesktopCompanionSessionOrigin(
  req: Request,
  identity?: DesktopCompanionIdentity,
): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const ident = identity ?? classifyDesktopCompanionIdentity(req);
  let expected: URL;
  try {
    expected = new URL(ident.effectiveOrigin);
  } catch {
    throw new DesktopLocalAccessError("Invalid request URL", 403, "security");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new DesktopLocalAccessError("Invalid Origin", 403, "security");
  }
  if (originUrl.protocol !== expected.protocol) {
    throw new DesktopLocalAccessError("Cross-origin request blocked", 403, "security");
  }
  if (ident.kind === "local_loopback") {
    const originHost = originUrl.hostname;
    if (!isIpv4LoopbackHostLabel(originHost) && !isLoopbackIp(originHost)) {
      throw new DesktopLocalAccessError("Origin is not loopback", 403, "security");
    }
  } else if (originUrl.hostname.toLowerCase() !== expected.hostname.toLowerCase()) {
    throw new DesktopLocalAccessError("Cross-origin request blocked", 403, "security");
  }
  const expectedPort = expected.port || (expected.protocol === "https:" ? "443" : "80");
  const originPort = originUrl.port || (originUrl.protocol === "https:" ? "443" : "80");
  if (expectedPort !== originPort) {
    throw new DesktopLocalAccessError("Cross-origin port mismatch", 403, "security");
  }
}
