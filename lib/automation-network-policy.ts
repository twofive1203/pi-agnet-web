/**
 * SSRF-safe network policy for Automation web_search/web_fetch.
 * Enforces HTTP(S)-only, DNS + connect IP checks, private/metadata deny,
 * redirect re-validation, streaming response size and time limits.
 */

import { isIP, connect as netConnect, type Socket } from "net";
import { lookup as dnsLookup } from "dns/promises";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";

export class AutomationNetworkError extends Error {
  readonly code = "blocked" as const;
  readonly blockedReason = "policy_violation" as const;

  constructor(message: string) {
    super(message);
    this.name = "AutomationNetworkError";
  }
}

export const AUTOMATION_NET_DEFAULTS = {
  maxRedirects: 3,
  maxResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  allowedProtocols: ["http:", "https:"] as const,
  connectTimeoutMs: 8_000,
};

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "metadata.azure.com",
]);

function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase().replace(/\.$/, "");
  // WHATWG URL on some platforms keeps brackets on IPv6 hostnames (`[fe80::1]`).
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  // Drop zone id if present on scoped literals.
  if (h.includes("%")) {
    h = h.split("%")[0] ?? h;
  }
  return h;
}

/**
 * Expand an IPv6 textual address to eight lowercase hextets.
 * Accepts compressed forms and optional zone id (`%eth0`); rejects garbage.
 */
export function expandIpv6Hextets(ip: string): string[] | null {
  const bare = ip.trim().toLowerCase().split("%")[0] ?? "";
  if (!bare) return null;
  // Node may hand back dotted IPv4-mapped forms such as ::ffff:169.254.1.1
  let normalized = bare;
  const v4Tail = normalized.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const mappedV4 = v4Tail[2]!.split(".").map((p) => Number(p));
    if (
      mappedV4.length !== 4 ||
      mappedV4.some((n) => !Number.isFinite(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const [a, b, c, d] = mappedV4 as [number, number, number, number];
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    normalized = `${v4Tail[1]}${hi}:${lo}`;
  }
  if (normalized.includes(".")) return null;
  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":").filter((p) => p.length > 0) : [];
  const right =
    sides.length === 2 && sides[1] ? sides[1].split(":").filter((p) => p.length > 0) : [];
  let full: string[];
  if (sides.length === 1) {
    if (left.length !== 8) return null;
    full = left;
  } else {
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    full = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
    if (full.length !== 8) return null;
  }
  const out: string[] = [];
  for (const h of full) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
    out.push(h.padStart(4, "0"));
  }
  return out;
}

/** IPv6 link-local is fe80::/10 (first 10 bits = 1111111010 → first hextet fe80–febf). */
export function isIpv6LinkLocal(ip: string): boolean {
  const hextets = expandIpv6Hextets(ip);
  if (!hextets) return false;
  const first = Number.parseInt(hextets[0]!, 16);
  return first >= 0xfe80 && first <= 0xfebf;
}

export function isPrivateOrSpecialIp(ip: string): boolean {
  // Strip zone id for scoped IPv6 before Node isIP classification.
  const bare = ip.includes("%") ? ip.split("%")[0]! : ip;
  const v = isIP(bare);
  if (v === 4) {
    const parts = bare.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
    if (a! >= 224) return true; // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = bare.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const hextets = expandIpv6Hextets(bare);
    if (hextets) {
      const first = Number.parseInt(hextets[0]!, 16);
      if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
      if (first >= 0xfe80 && first <= 0xfebf) return true; // link-local fe80::/10
      if ((first & 0xff00) === 0xff00) return true; // multicast
      // IPv4-mapped (::ffff:x.x.x.x) and IPv4-compatible
      const isV4Mapped =
        hextets.slice(0, 5).every((h) => h === "0000") && hextets[5] === "ffff";
      const isV4Compat =
        hextets.slice(0, 6).every((h) => h === "0000") &&
        !(hextets[6] === "0000" && (hextets[7] === "0000" || hextets[7] === "0001"));
      if (isV4Mapped || isV4Compat) {
        const hi = Number.parseInt(hextets[6]!, 16);
        const lo = Number.parseInt(hextets[7]!, 16);
        const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrSpecialIp(mapped);
      }
      return false;
    }
    // Fail closed helpers when expansion fails.
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (isIpv6LinkLocal(bare)) return true;
    if (lower.startsWith("ff")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateOrSpecialIp(mapped);
    }
    return false;
  }
  return true;
}

export function assertUrlAllowedForAutomation(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AutomationNetworkError(`Invalid URL: ${rawUrl}`);
  }
  if (!AUTOMATION_NET_DEFAULTS.allowedProtocols.includes(url.protocol as "http:" | "https:")) {
    throw new AutomationNetworkError(`Protocol not allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AutomationNetworkError("URL userinfo is not allowed");
  }
  const host = normalizeHostname(url.hostname);
  if (!host) throw new AutomationNetworkError("URL hostname required");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new AutomationNetworkError(`Hostname blocked: ${host}`);
  }
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new AutomationNetworkError(`Hostname blocked: ${host}`);
  }
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new AutomationNetworkError(`Private/special IP blocked: ${host}`);
    }
  }
  if (/%00/i.test(rawUrl) || host.includes(" ")) {
    throw new AutomationNetworkError("Malformed host");
  }
  return url;
}

export async function resolveAndAssertPublicHostname(hostname: string): Promise<string[]> {
  const host = normalizeHostname(hostname);
  if (isIP(host)) {
    if (isPrivateOrSpecialIp(host)) {
      throw new AutomationNetworkError(`Private/special IP blocked: ${host}`);
    }
    return [host];
  }
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new AutomationNetworkError(
      `DNS lookup failed for ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!records.length) {
    throw new AutomationNetworkError(`DNS returned no addresses for ${host}`);
  }
  const addresses = records.map((r) => r.address);
  for (const address of addresses) {
    if (isPrivateOrSpecialIp(address)) {
      throw new AutomationNetworkError(`Resolved private/special IP blocked: ${address}`);
    }
  }
  return addresses;
}

/**
 * Prove the connect target IP is still public (DNS rebinding / TOCTOU mitigation).
 * Opens a short-lived TCP connection to the first resolved address and verifies peer.
 */
export async function assertConnectIpPublic(
  hostname: string,
  port: number,
  resolvedAddresses: string[],
  timeoutMs = AUTOMATION_NET_DEFAULTS.connectTimeoutMs,
): Promise<string> {
  const candidates = resolvedAddresses.length
    ? resolvedAddresses
    : await resolveAndAssertPublicHostname(hostname);

  let lastError: unknown;
  for (const address of candidates) {
    if (isPrivateOrSpecialIp(address)) {
      throw new AutomationNetworkError(`Connect IP blocked: ${address}`);
    }
    try {
      const peer = await new Promise<string>((resolve, reject) => {
        const socket: Socket = netConnect({ host: address, port, family: isIP(address) === 6 ? 6 : 4 });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new AutomationNetworkError(`Connect timeout to ${address}:${port}`));
        }, timeoutMs);
        socket.once("connect", () => {
          const peerAddr = socket.remoteAddress ?? address;
          clearTimeout(timer);
          socket.destroy();
          if (isPrivateOrSpecialIp(peerAddr)) {
            reject(new AutomationNetworkError(`Connected peer IP blocked: ${peerAddr}`));
            return;
          }
          resolve(peerAddr);
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return peer;
    } catch (error) {
      lastError = error;
    }
  }
  throw new AutomationNetworkError(
    `Connect IP verification failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export type AutomationFetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  bodyText: string;
  bytes: number;
  redirected: boolean;
  connectIp?: string;
};

type RawResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  stream: NodeJS.ReadableStream;
  destroy: () => void;
};

/**
 * Low-level HTTP(S) request pinned to a pre-validated connect IP (no fetch DNS rebinding window).
 */
function requestPinned(
  url: URL,
  connectIp: string,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
    const headers: Record<string, string> = {
      Host: url.host,
      ...(options.headers ?? {}),
    };
    if (options.body != null) {
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        protocol: url.protocol,
        hostname: connectIp,
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers,
        servername: isHttps ? url.hostname : undefined,
        timeout: options.timeoutMs,
        // Reject unauthorized is default; keep it.
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          stream: res,
          destroy: () => {
            try {
              res.destroy();
            } catch {
              // ignore
            }
          },
        });
      },
    );
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new AutomationNetworkError(`Request timed out after ${options.timeoutMs}ms`));
    });
    req.on("error", (error) => {
      reject(
        error instanceof AutomationNetworkError
          ? error
          : new AutomationNetworkError(
              `Network request failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
      );
    });
    if (options.body != null) req.write(options.body);
    req.end();
  });
}

async function readStreamLimited(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  timeoutMs: number,
  destroy: () => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      destroy();
      reject(new AutomationNetworkError(`Response body timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err?: Error, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(buf ?? Buffer.alloc(0));
    };

    stream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        destroy();
        finish(new AutomationNetworkError(`Response exceeds ${maxBytes} bytes (streaming limit)`));
        return;
      }
      chunks.push(buf);
    });
    stream.on("end", () => finish(undefined, Buffer.concat(chunks, total)));
    stream.on("error", (error) =>
      finish(
        error instanceof AutomationNetworkError
          ? error
          : new AutomationNetworkError(
              `Stream error: ${error instanceof Error ? error.message : String(error)}`,
            ),
      ),
    );
  });
}

/**
 * Policy-enforced fetch for Automation-reviewed network tools.
 * Not a general-purpose HTTP client.
 */
export async function automationSafeFetch(
  rawUrl: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxRedirects?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
    /** Test double — when set, skips pin/connect path and uses this fetch (still validates URL/DNS). */
    fetchImpl?: typeof fetch;
  },
): Promise<AutomationFetchResult> {
  const maxRedirects = options?.maxRedirects ?? AUTOMATION_NET_DEFAULTS.maxRedirects;
  const maxResponseBytes = options?.maxResponseBytes ?? AUTOMATION_NET_DEFAULTS.maxResponseBytes;
  const timeoutMs = options?.timeoutMs ?? AUTOMATION_NET_DEFAULTS.timeoutMs;

  let current = assertUrlAllowedForAutomation(rawUrl);
  let addresses = await resolveAndAssertPublicHostname(current.hostname);
  let redirected = false;
  let lastConnectIp: string | undefined;

  for (let i = 0; i <= maxRedirects; i += 1) {
    const port = current.port
      ? Number(current.port)
      : current.protocol === "https:"
        ? 443
        : 80;

    // Re-resolve each hop (redirect) and verify connect IP before body download.
    addresses = await resolveAndAssertPublicHostname(current.hostname);
    if (!options?.fetchImpl) {
      lastConnectIp = await assertConnectIpPublic(current.hostname, port, addresses);
    }

    if (options?.fetchImpl) {
      // Test path with injected fetch — still manual redirect + size limit.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetchImpl(current.toString(), {
          method: options?.method ?? "GET",
          headers: options?.headers,
          body: options?.body,
          redirect: "manual",
          signal: controller.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new AutomationNetworkError("Redirect without Location");
          const next = new URL(location, current);
          assertUrlAllowedForAutomation(next.toString());
          await resolveAndAssertPublicHostname(next.hostname);
          current = next;
          redirected = true;
          continue;
        }
        // Stream-ish size limit: read in chunks via arrayBuffer but reject oversized content-length first.
        const cl = response.headers.get("content-length");
        if (cl && Number(cl) > maxResponseBytes) {
          throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
        }
        const reader = response.body?.getReader?.();
        if (reader) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > maxResponseBytes) {
                try {
                  await reader.cancel();
                } catch {
                  // ignore
                }
                throw new AutomationNetworkError(
                  `Response exceeds ${maxResponseBytes} bytes (streaming limit)`,
                );
              }
              chunks.push(value);
            }
          }
          const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
          const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
          return {
            url: rawUrl,
            finalUrl: current.toString(),
            status: response.status,
            contentType: response.headers.get("content-type"),
            bodyText,
            bytes: buf.byteLength,
            redirected,
            connectIp: lastConnectIp,
          };
        }
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.byteLength > maxResponseBytes) {
          throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
        }
        return {
          url: rawUrl,
          finalUrl: current.toString(),
          status: response.status,
          contentType: response.headers.get("content-type"),
          bodyText: new TextDecoder("utf-8", { fatal: false }).decode(buf),
          bytes: buf.byteLength,
          redirected,
          connectIp: lastConnectIp,
        };
      } catch (error) {
        if (error instanceof AutomationNetworkError) throw error;
        if ((error as Error)?.name === "AbortError") {
          throw new AutomationNetworkError(`Request timed out after ${timeoutMs}ms`);
        }
        throw new AutomationNetworkError(
          `Network request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    const raw = await requestPinned(current, lastConnectIp!, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
      timeoutMs,
    });

    if ([301, 302, 303, 307, 308].includes(raw.status)) {
      raw.destroy();
      const locationHeader = raw.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
      if (!location) throw new AutomationNetworkError("Redirect without Location");
      const next = new URL(location, current);
      assertUrlAllowedForAutomation(next.toString());
      current = next;
      redirected = true;
      continue;
    }

    const contentTypeHeader = raw.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0] ?? null
      : contentTypeHeader ?? null;
    const clHeader = raw.headers["content-length"];
    const cl = Array.isArray(clHeader) ? clHeader[0] : clHeader;
    if (cl && Number(cl) > maxResponseBytes) {
      raw.destroy();
      throw new AutomationNetworkError(`Response exceeds ${maxResponseBytes} bytes`);
    }

    const buf = await readStreamLimited(raw.stream, maxResponseBytes, timeoutMs, raw.destroy);
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return {
      url: rawUrl,
      finalUrl: current.toString(),
      status: raw.status,
      contentType,
      bodyText,
      bytes: buf.byteLength,
      redirected,
      connectIp: lastConnectIp,
    };
  }
  throw new AutomationNetworkError(`Too many redirects (>${maxRedirects})`);
}

/** Pure checks used by smoke tests without network I/O. */
export function evaluateUrlForTests(rawUrl: string): { ok: boolean; reason?: string } {
  try {
    assertUrlAllowedForAutomation(rawUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
