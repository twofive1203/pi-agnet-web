/**
 * Loopback gate for cwd native folder picker.
 * Reuses the Automation connection-capture ALS so socket remoteAddress is authoritative.
 * Host/URL alone never prove same-machine access.
 */

import {
  getAutomationRemoteAddress,
  installAutomationConnectionCapture,
  isLoopbackIp,
  normalizeIp,
} from "./automation-connection-context";

export type CwdLocalAccessDenial =
  | "remote_address_unavailable"
  | "not_loopback"
  | "forwarded_non_loopback"
  | "host_not_loopback";

export class CwdLocalAccessError extends Error {
  readonly status = 403;
  readonly code: CwdLocalAccessDenial;

  constructor(message: string, code: CwdLocalAccessDenial) {
    super(message);
    this.name = "CwdLocalAccessError";
    this.code = code;
  }
}

function isLoopbackHostLabel(host: string): boolean {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function isIPAddress(value: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value) || value.includes(":");
}

function forwardedClaimsNonLoopback(req: Request): boolean {
  const values = [
    req.headers.get("x-forwarded-for"),
    req.headers.get("x-real-ip"),
    req.headers.get("forwarded"),
  ].filter(Boolean) as string[];

  for (const raw of values) {
    const parts = raw.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      const match = part.match(/(?:for=)?\[?([^\];\s]+)\]?/i);
      const candidate = (match?.[1] ?? part).replace(/^"|"$/g, "");
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

export function resolveCwdRemoteAddress(req?: Request): string | null {
  void req;
  installAutomationConnectionCapture();
  return getAutomationRemoteAddress();
}

/**
 * Best-effort same-machine probe for capability responses (never throws).
 * True only when the TCP peer is loopback and proxies do not claim a remote client.
 */
export function probeCwdLocalAccess(req?: Request): {
  localAccess: boolean;
  remoteAddress: string | null;
  reason?: CwdLocalAccessDenial;
} {
  try {
    const remoteAddress = assertCwdLocalAccess(req);
    return { localAccess: true, remoteAddress };
  } catch (error) {
    if (error instanceof CwdLocalAccessError) {
      return {
        localAccess: false,
        remoteAddress: resolveCwdRemoteAddress(req),
        reason: error.code,
      };
    }
    return {
      localAccess: false,
      remoteAddress: resolveCwdRemoteAddress(req),
      reason: "remote_address_unavailable",
    };
  }
}

/**
 * Require a proven direct loopback connection before opening a host OS folder dialog.
 * Fail closed when the socket remote address is unknown.
 */
export function assertCwdLocalAccess(req?: Request): string {
  const remote = resolveCwdRemoteAddress(req);
  if (!remote) {
    throw new CwdLocalAccessError(
      "Native folder picker requires a proven direct loopback connection",
      "remote_address_unavailable",
    );
  }
  if (!isLoopbackIp(remote)) {
    throw new CwdLocalAccessError(
      `Native folder picker is only available on direct loopback connections (remote=${normalizeIp(remote)})`,
      "not_loopback",
    );
  }

  if (req && forwardedClaimsNonLoopback(req)) {
    throw new CwdLocalAccessError(
      "Native folder picker rejects non-loopback forwarded client identity",
      "forwarded_non_loopback",
    );
  }

  if (req) {
    try {
      const url = new URL(req.url);
      if (url.hostname && !isLoopbackHostLabel(url.hostname) && !isLoopbackIp(url.hostname)) {
        throw new CwdLocalAccessError(
          "Native folder picker request URL host is not loopback",
          "host_not_loopback",
        );
      }
    } catch (error) {
      if (error instanceof CwdLocalAccessError) throw error;
      throw new CwdLocalAccessError(
        "Native folder picker rejected invalid request URL",
        "host_not_loopback",
      );
    }

    const host = req.headers.get("host") ?? "";
    if (host) {
      const hostLabel = host.split(":")[0] ?? host;
      if (!isLoopbackHostLabel(hostLabel) && !isLoopbackIp(hostLabel)) {
        throw new CwdLocalAccessError(
          "Native folder picker Host header is not loopback",
          "host_not_loopback",
        );
      }
    }
  }

  return remote;
}
