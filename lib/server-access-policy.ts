/**
 * Policy helpers for server-access Proxy + auth route handlers.
 *
 * Auth-bypass allowlists prefer durable config under the agent data dir
 * (`server-access-policy.json`); env can override for one-shot/container use.
 * Cookie/protocol helpers remain pure and testable without disk I/O.
 */

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
import {
  SERVER_ACCESS_COOKIE_NAME,
  SERVER_ACCESS_SESSION_TTL_MS,
} from "./server-access-auth";

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

export { SERVER_ACCESS_COOKIE_NAME };

export const UNLOCK_PATH = "/unlock";
export const LOGIN_API_PATH = "/api/server-auth/login";
export const LOGOUT_API_PATH = "/api/server-auth/logout";
export const STATUS_API_PATH = "/api/server-auth/status";
/** Public process health probe (identity + aggregate counters; no session/project paths). */
export const HEALTH_API_PATH = "/api/health";

/**
 * Chrome extension installation pairing endpoints.
 * Not unconditionally public: Proxy may skip cookie/same-origin only for proven loopback peers.
 * Route handlers still enforce loopback for extension-owned actions (exchange/connect_token/unpair).
 */
export const BROWSER_PAIR_API_PATH = "/api/browser/pair";
export const BROWSER_UNPAIR_API_PATH = "/api/browser/unpair";
/** Desktop pet attach API prefix (loopback-only; not anonymously public). */
export const DESKTOP_OBSERVER_API_PREFIX = "/api/desktop-observer";
/** Desktop pet control API prefix (loopback-only; not anonymously public). */
export const DESKTOP_CONTROL_API_PREFIX = "/api/desktop-control";

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

export const ALLOW_INSECURE_HTTP_ENV = "PI_WEB_ALLOW_INSECURE_HTTP";

export function isInsecureHttpAllowed(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const v = env[ALLOW_INSECURE_HTTP_ENV];
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

/** Env override: comma/space-separated IPs or CIDRs that skip access-key auth (socket remote only). */
export const AUTH_BYPASS_CIDRS_ENV = "PI_WEB_AUTH_BYPASS_CIDRS";

/** Durable policy file under the agent data dir (not pi-web.json — avoids settings UI rewrite). */
export const SERVER_ACCESS_POLICY_FILENAME = "server-access-policy.json";
export const SERVER_ACCESS_POLICY_VERSION = 1 as const;

export type ServerAccessPolicyFile = {
  version: typeof SERVER_ACCESS_POLICY_VERSION;
  /** Socket client IPs/CIDRs that skip the access key when server auth is on. */
  authBypassCidrs: string[];
};

export type AuthBypassResolution = {
  entries: string[];
  /** Where the effective list came from. */
  source: "env" | "file" | "none";
  path: string;
};

export function normalizeClientIp(address: string | null | undefined): string | null {
  if (!address) return null;
  let value = address.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  if (value === "0:0:0:0:0:0:0:1") value = "::1";
  return value || null;
}

export function isLoopbackClientAddress(address: string | null | undefined): boolean {
  const ip = normalizeClientIp(address);
  if (!ip) return false;
  if (ip === "::1") return true;
  const v4 = parseIpv4ToInt(ip);
  return v4 != null && (v4 >>> 24) === 127;
}

function parseIpv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function expandIpv6(ip: string): number[] | null {
  const bare = ip.trim().toLowerCase();
  if (!bare.includes(":")) return null;
  if (bare.includes(".")) return null; // no embedded v4 forms beyond ::ffff handled upstream
  const sides = bare.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (sides.length === 1) {
    if (missing !== 0) return null;
  } else if (missing < 0) {
    return null;
  }
  const parts = [
    ...head,
    ...(sides.length === 2 ? Array.from({ length: missing }, () => "0") : []),
    ...tail,
  ];
  if (parts.length !== 8) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
    out.push(parseInt(p, 16));
  }
  return out;
}

/**
 * Parse allowlist entries from env. World-open and loopback rules are rejected.
 * A loopback peer may actually be an HTTPS reverse proxy carrying arbitrary clients.
 */
export function parseAuthBypassEntries(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/[,\s]+/)) {
    const entry = token.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "0.0.0.0/0" || entry === "::/0") continue;
    if (authBypassEntryIncludesLoopback(entry)) continue;
    out.push(entry);
  }
  return out;
}

export function getServerAccessPolicyPath(agentDir = getAgentDir()): string {
  return join(agentDir, SERVER_ACCESS_POLICY_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAuthBypassList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    out.push(...parseAuthBypassEntries(item));
  }
  // De-dupe while preserving order.
  return [...new Set(out)];
}

/**
 * Read durable server-access policy. Missing/invalid file → empty allowlist (fail closed for bypass).
 * Does not throw for corrupt files — bypass simply stays empty and auth remains required.
 */
export function readServerAccessPolicyFile(agentDir = getAgentDir()): ServerAccessPolicyFile {
  const path = getServerAccessPolicyPath(agentDir);
  if (!existsSync(path)) {
    return { version: SERVER_ACCESS_POLICY_VERSION, authBypassCidrs: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(raw) || raw.version !== SERVER_ACCESS_POLICY_VERSION) {
      return { version: SERVER_ACCESS_POLICY_VERSION, authBypassCidrs: [] };
    }
    return {
      version: SERVER_ACCESS_POLICY_VERSION,
      authBypassCidrs: normalizeAuthBypassList(raw.authBypassCidrs),
    };
  } catch {
    return { version: SERVER_ACCESS_POLICY_VERSION, authBypassCidrs: [] };
  }
}

/** Atomic write for durable policy (owner-only when the platform supports modes). */
export function writeServerAccessPolicyFile(
  policy: { authBypassCidrs: string[] },
  agentDir = getAgentDir(),
): ServerAccessPolicyFile {
  const path = getServerAccessPolicyPath(agentDir);
  const next: ServerAccessPolicyFile = {
    version: SERVER_ACCESS_POLICY_VERSION,
    authBypassCidrs: normalizeAuthBypassList(policy.authBypassCidrs),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch {
    if (existsSync(path)) unlinkSync(path);
    renameSync(tmp, path);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on Windows
  }
  return next;
}

/**
 * Resolve effective auth-bypass list.
 * Precedence: non-empty env override → durable policy file → none.
 */
export function resolveAuthBypassEntries(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  agentDir?: string;
}): AuthBypassResolution {
  const env = options?.env ?? process.env;
  const agentDir = options?.agentDir ?? getAgentDir();
  const path = getServerAccessPolicyPath(agentDir);
  const envRaw = env[AUTH_BYPASS_CIDRS_ENV];
  // Only treat env as an override when the variable is present (including empty → no bypass).
  if (typeof envRaw === "string") {
    const entries = parseAuthBypassEntries(envRaw);
    return { entries, source: "env", path };
  }
  const file = readServerAccessPolicyFile(agentDir);
  if (file.authBypassCidrs.length > 0) {
    return { entries: file.authBypassCidrs, source: "file", path };
  }
  return { entries: [], source: "none", path };
}

export function getAuthBypassEntries(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  agentDir?: string,
): string[] {
  return resolveAuthBypassEntries({ env, agentDir }).entries;
}

export function ipMatchesEntry(ip: string, entry: string): boolean {
  const client = normalizeClientIp(ip);
  const rule = entry.trim().toLowerCase();
  if (!client || !rule) return false;

  if (!rule.includes("/")) {
    return client === normalizeClientIp(rule);
  }

  const [netRaw, bitsRaw] = rule.split("/");
  const bits = Number(bitsRaw);
  if (!netRaw || !Number.isInteger(bits) || bits < 0) return false;

  const clientV4 = parseIpv4ToInt(client);
  const netV4 = parseIpv4ToInt(netRaw);
  if (clientV4 != null && netV4 != null) {
    if (bits > 32) return false;
    if (bits === 0) return false; // world-open rejected
    const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
    return (clientV4 & mask) === (netV4 & mask);
  }

  const clientV6 = expandIpv6(client);
  const netV6 = expandIpv6(netRaw);
  if (clientV6 && netV6) {
    if (bits > 128 || bits === 0) return false;
    let remaining = bits;
    for (let i = 0; i < 8; i += 1) {
      const take = Math.min(16, remaining);
      if (take === 0) break;
      const shift = 16 - take;
      const mask = take === 16 ? 0xffff : ((0xffff << shift) & 0xffff);
      if ((clientV6[i]! & mask) !== (netV6[i]! & mask)) return false;
      remaining -= take;
    }
    return true;
  }

  return false;
}

function authBypassEntryIncludesLoopback(entry: string): boolean {
  const rule = entry.trim().toLowerCase();
  if (!rule.includes("/")) return isLoopbackClientAddress(rule);

  const [netRaw] = rule.split("/");
  const netV4 = netRaw ? parseIpv4ToInt(netRaw) : null;
  if (netV4 != null && (netV4 >>> 24) === 127) return true;
  return ipMatchesEntry("127.0.0.1", rule) || ipMatchesEntry("::1", rule);
}

/**
 * True when the socket remote address is on the configured allowlist.
 * Never consult Host / X-Forwarded-For here — callers must pass socket-derived IP only.
 */
export function isClientIpAuthBypassed(
  remoteAddress: string | null | undefined,
  entries: string[] = getAuthBypassEntries(),
): boolean {
  const ip = normalizeClientIp(remoteAddress);
  if (!ip || entries.length === 0) return false;
  for (const entry of entries) {
    if (ipMatchesEntry(ip, entry)) return true;
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

export function isSecureTransportRequired(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return !isInsecureHttpAllowed(env) && resolveEffectiveProtocol(req, env) !== "https";
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
    || pathname === HEALTH_API_PATH
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

/**
 * Paths used by the unpacked Chrome extension against http://127.0.0.1.
 * Never treat these as globally public: server mode may listen on non-loopback interfaces.
 */
export function isBrowserExtensionPairingPath(pathname: string): boolean {
  return (
    pathname === BROWSER_PAIR_API_PATH
    || pathname === `${BROWSER_PAIR_API_PATH}/`
    || pathname === BROWSER_UNPAIR_API_PATH
    || pathname === `${BROWSER_UNPAIR_API_PATH}/`
  );
}

/**
 * Desktop pet observer routes. Never globally public: Proxy may skip the
 * browser session cookie only for a proven loopback TCP peer; handlers still
 * enforce Host 127.0.0.1 + loopback remote, and session mint verifies the
 * access key when server auth is on.
 */
export function isDesktopObserverPath(pathname: string): boolean {
  return (
    pathname === DESKTOP_OBSERVER_API_PREFIX
    || pathname.startsWith(`${DESKTOP_OBSERVER_API_PREFIX}/`)
  );
}

/**
 * Desktop pet control routes. Never globally public and never a browser-cookie
 * substitute: Proxy may skip the cookie/HTTPS gate only for a proven loopback
 * TCP peer; handlers still enforce Host 127.0.0.1 + loopback remote + scoped
 * control token, and session mint verifies the access key when server auth is on.
 */
export function isDesktopControlPath(pathname: string): boolean {
  return (
    pathname === DESKTOP_CONTROL_API_PREFIX
    || pathname.startsWith(`${DESKTOP_CONTROL_API_PREFIX}/`)
  );
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function isStateChangingMethod(method: string | null | undefined): boolean {
  const normalized = (method ?? "GET").trim().toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
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

export function clientKeyFromRequest(
  req: Request,
  socketRemoteAddress?: string | null,
): string {
  // Never trust forwarded IP headers. The socket address is captured by the Node server hook.
  const clientIp = normalizeClientIp(socketRemoteAddress);
  if (clientIp) return `ip:${clientIp}`;
  void req;
  // A shared fail-closed bucket is safer than a spoofable Host-derived identity.
  return "ip:unknown";
}

export function noStoreHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    ...extra,
  };
}

function securityErrorJson(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export function unauthorizedJson(message = "Authentication required"): Response {
  return securityErrorJson(401, "unauthorized", message);
}

export function forbiddenJson(message = "Request origin is not allowed"): Response {
  return securityErrorJson(403, "forbidden", message);
}

export function secureTransportRequiredJson(
  message = "HTTPS is required for server access authentication",
): Response {
  return securityErrorJson(426, "secure_transport_required", message);
}

export function serviceUnavailableJson(message = "Server access authentication unavailable"): Response {
  return securityErrorJson(503, "auth_unavailable", message);
}
