/**
 * Pure policy helpers for server-access Proxy + auth route handlers.
 * No filesystem I/O — safe to unit-test with synthetic Request objects.
 */

import {
  SERVER_ACCESS_COOKIE_NAME,
  SERVER_ACCESS_SESSION_TTL_MS,
} from "./server-access-auth";

export { SERVER_ACCESS_COOKIE_NAME };

export const UNLOCK_PATH = "/unlock";
export const LOGIN_API_PATH = "/api/server-auth/login";
export const LOGOUT_API_PATH = "/api/server-auth/logout";
export const STATUS_API_PATH = "/api/server-auth/status";

/** Max access-key length accepted by login. */
export const MAX_ACCESS_KEY_LENGTH = 512;
/** Max JSON body bytes for login. */
export const MAX_LOGIN_BODY_BYTES = 4096;

export function isServerAccessAuthEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const v = env.PI_WEB_SERVER_MODE;
  if (v == null) return false;
  const normalized = String(v).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isTrustProxyEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const v = env.PI_WEB_TRUST_PROXY;
  if (v == null) return false;
  const normalized = String(v).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = hostname.trim().toLowerCase();
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    return a === 127;
  }
  return false;
}

/**
 * Effective external protocol for Secure cookie + HTTP warnings.
 * Default: trust only the request URL protocol.
 * With PI_WEB_TRUST_PROXY=1 and loopback backend bind, honor X-Forwarded-Proto.
 */
export function resolveEffectiveProtocol(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): "http" | "https" {
  const url = new URL(req.url);
  if (url.protocol === "https:") return "https";

  if (!isTrustProxyEnabled(env)) return "http";

  const bindHost = (env.PI_WEB_HOSTNAME ?? "").trim() || "127.0.0.1";
  if (!isLoopbackHostname(bindHost)) return "http";

  const xf = req.headers.get("x-forwarded-proto");
  if (!xf) return "http";
  // Take left-most hop and normalize.
  const first = xf.split(",")[0]?.trim().toLowerCase();
  if (first === "https") return "https";
  return "http";
}

export function shouldWarnPlainHttp(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return resolveEffectiveProtocol(req, env) !== "https";
}

/**
 * Public paths allowed without a session when auth is on.
 * Keep this minimal — never include business APIs or project pages.
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname === UNLOCK_PATH || pathname.startsWith(`${UNLOCK_PATH}/`)) return true;
  if (
    pathname === LOGIN_API_PATH
    || pathname === LOGOUT_API_PATH
    || pathname === STATUS_API_PATH
  ) {
    return true;
  }

  // Static assets required to render the unlock page.
  if (pathname === "/favicon.ico") return true;
  if (pathname === "/snail-pi-logo.svg") return true;
  if (pathname.startsWith("/_next/static/")) return true;
  if (pathname.startsWith("/_next/image")) return true;

  return false;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Read the opaque session token from Cookie header.
 */
export function readSessionTokenFromCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    if (name !== SERVER_ACCESS_COOKIE_NAME) continue;
    const raw = part.slice(idx + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function buildSessionCookie(token: string, options: {
  maxAgeSec?: number;
  secure: boolean;
  clear?: boolean;
}): string {
  const maxAge = options.clear
    ? 0
    : (options.maxAgeSec ?? Math.floor(SERVER_ACCESS_SESSION_TTL_MS / 1000));
  const value = options.clear ? "" : encodeURIComponent(token);
  const parts = [
    `${SERVER_ACCESS_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  if (options.clear) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  return parts.join("; ");
}

/**
 * Resolve the host the browser thinks it talked to.
 * Prefer the Host header — Next may rewrite Request URL hostname to `localhost`
 * even when the client connected via `127.0.0.1`.
 */
function requestAuthority(req: Request): { protocol: string; host: string } {
  const url = new URL(req.url);
  let host = (req.headers.get("host") ?? "").trim() || url.host;
  // Forwarded host only when explicitly trusted (same gate as Secure cookie).
  if (
    isTrustProxyEnabled()
    && isLoopbackHostname((process.env.PI_WEB_HOSTNAME ?? "").trim() || "127.0.0.1")
  ) {
    const xfHost = (req.headers.get("x-forwarded-host") ?? "").split(",")[0]?.trim();
    if (xfHost) host = xfHost;
  }
  const protocol = `${resolveEffectiveProtocol(req)}:`;
  return { protocol, host };
}

function authoritiesMatch(
  candidate: URL,
  authority: { protocol: string; host: string },
): boolean {
  if (candidate.host !== authority.host) return false;
  // Allow http/https protocol match only when equal; do not allow cross-scheme.
  return candidate.protocol === authority.protocol;
}

/**
 * Same-origin check for state-changing auth requests.
 * Requires Origin or Referer to match the request Host (not a rewritten URL host).
 */
export function assertAuthRequestSameOrigin(req: Request): void {
  const authority = requestAuthority(req);
  const origin = req.headers.get("origin");
  if (origin) {
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      throw new Error("invalid_origin");
    }
    if (!authoritiesMatch(o, authority)) {
      throw new Error("cross_origin");
    }
    return;
  }
  const referer = req.headers.get("referer");
  if (referer) {
    let r: URL;
    try {
      r = new URL(referer);
    } catch {
      throw new Error("invalid_referer");
    }
    if (!authoritiesMatch(r, authority)) {
      throw new Error("cross_origin");
    }
    return;
  }
  // Browsers always send Origin on POST from forms/fetch. Reject missing.
  throw new Error("missing_origin");
}

export function clientKeyFromRequest(req: Request): string {
  // Default: do not trust forwarded IP. Use a coarse host bucket only.
  try {
    const url = new URL(req.url);
    return `host:${url.host}`;
  } catch {
    return "host:unknown";
  }
}

export function noStoreHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    ...extra,
  };
}

export function unauthorizedJson(message = "Authentication required"): Response {
  return new Response(JSON.stringify({ error: message, code: "unauthorized" }), {
    status: 401,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export function serviceUnavailableJson(message = "Server access authentication unavailable"): Response {
  return new Response(JSON.stringify({ error: message, code: "auth_unavailable" }), {
    status: 503,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}
