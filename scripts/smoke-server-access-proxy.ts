/**
 * Policy + synthetic gate smoke for server-access Proxy behavior.
 * Does not boot Next — validates path classification, cookie helpers, protocol trust.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_ACCESS_COOKIE_NAME,
  UNLOCK_PATH,
  assertAuthRequestSameOrigin,
  buildSessionCookie,
  getAuthBypassEntries,
  getServerAccessPolicyPath,
  ipMatchesEntry,
  isApiPath,
  isClientIpAuthBypassed,
  isPublicPath,
  isServerAccessAuthEnabled,
  parseAuthBypassEntries,
  readServerAccessPolicyFile,
  readSessionTokenFromCookieHeader,
  resolveAuthBypassEntries,
  resolveEffectiveProtocol,
  shouldWarnPlainHttp,
  writeServerAccessPolicyFile,
} from "../lib/server-access-policy";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function walkApiRoutes(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkApiRoutes(full, acc);
    else if (name === "route.ts" || name === "route.js") acc.push(full);
  }
  return acc;
}

function routeFileToPath(file: string): string {
  const rel = relative(join(ROOT, "app"), file).replace(/\\/g, "/");
  // app/api/foo/bar/route.ts -> /api/foo/bar
  const withoutFile = rel.replace(/\/route\.(ts|js)$/, "");
  // dynamic segments [id] -> _id_ for inventory only
  return `/${withoutFile}`.replace(/\[([^\]]+)\]/g, "_$1_");
}

function testPublicPaths(): void {
  assert(isPublicPath("/unlock"), "unlock public");
  assert(isPublicPath("/unlock/"), "unlock slash");
  assert(isPublicPath("/api/server-auth/login"), "login public");
  assert(isPublicPath("/api/server-auth/logout"), "logout public");
  assert(isPublicPath("/api/server-auth/status"), "status public");
  assert(isPublicPath("/favicon.ico"), "favicon public");
  assert(isPublicPath("/snail-pi-logo.svg"), "logo public");
  assert(isPublicPath("/_next/static/css/app.css"), "static public");
  assert(!isPublicPath("/"), "home not public");
  assert(!isPublicPath("/file"), "file page not public");
  assert(!isPublicPath("/api/home"), "home api not public");
  assert(!isPublicPath("/api/sessions"), "sessions not public");
  assert(!isPublicPath("/api/models"), "models not public");
  assert(!isPublicPath("/api/agent/events"), "agent sse not public");
  console.log("OK public-paths");
}

function testApiInventoryProtected(): void {
  const apiRoot = join(ROOT, "app", "api");
  const routes = walkApiRoutes(apiRoot).map(routeFileToPath);
  assert(routes.length > 20, `expected many API routes, got ${routes.length}`);
  const publicApis = new Set([
    "/api/server-auth/login",
    "/api/server-auth/logout",
    "/api/server-auth/status",
  ]);
  for (const p of routes) {
    // Normalize dynamic inventory paths back to check isPublicPath on templates
    // isPublicPath only exact-matches login/logout; dynamic paths must not be public.
    if (publicApis.has(p)) {
      assert(isPublicPath(p), `${p} should be public`);
      continue;
    }
    // Replace inventory placeholders with sample values for classification
    const sample = p.replace(/_([A-Za-z0-9]+)_/g, "x");
    assert(isApiPath(sample), `${sample} is api`);
    assert(!isPublicPath(sample), `${sample} must require auth`);
  }
  console.log(`OK api-inventory-protected count=${routes.length}`);
}

function testCookieHelpers(): void {
  const token = "abc.def_ghi-jkl";
  const cookie = buildSessionCookie(token, { secure: false, maxAgeSec: 100 });
  assert(cookie.includes(`${SERVER_ACCESS_COOKIE_NAME}=`), "cookie name");
  assert(cookie.includes("HttpOnly"), "httpOnly");
  assert(cookie.includes("SameSite=Strict"), "sameSite");
  assert(cookie.includes("Path=/"), "path");
  assert(!cookie.includes("Secure"), "no secure on http");
  assert(cookie.includes("Max-Age=100"), "max-age");

  const header = `${cookie}; other=1`;
  assert(readSessionTokenFromCookieHeader(header) === token, "read token");

  const secure = buildSessionCookie(token, { secure: true });
  assert(secure.includes("Secure"), "secure flag");

  const cleared = buildSessionCookie("", { clear: true, secure: false });
  assert(cleared.includes("Max-Age=0"), "cleared max-age");
  console.log("OK cookie-helpers");
}

function testProtocolTrust(): void {
  const httpReq = new Request("http://127.0.0.1:62666/unlock");
  assert(resolveEffectiveProtocol(httpReq, {}) === "http", "plain http");
  assert(shouldWarnPlainHttp(httpReq, {}) === true, "warn http");

  const httpsReq = new Request("https://example.com/unlock");
  assert(resolveEffectiveProtocol(httpsReq, {}) === "https", "direct https");
  assert(shouldWarnPlainHttp(httpsReq, {}) === false, "no warn https");

  // Forged forwarded proto ignored without trust.
  const forged = new Request("http://10.0.0.5:62666/", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert(
    resolveEffectiveProtocol(forged, { PI_WEB_HOSTNAME: "0.0.0.0" }) === "http",
    "forged proto ignored without trust",
  );

  // Trust + loopback backend honors forwarded proto.
  const trusted = new Request("http://127.0.0.1:62666/", {
    headers: { "x-forwarded-proto": "https" },
  });
  assert(
    resolveEffectiveProtocol(trusted, {
      PI_WEB_TRUST_PROXY: "1",
      PI_WEB_HOSTNAME: "127.0.0.1",
    }) === "https",
    "trusted proxy https",
  );
  assert(
    shouldWarnPlainHttp(trusted, {
      PI_WEB_TRUST_PROXY: "1",
      PI_WEB_HOSTNAME: "127.0.0.1",
    }) === false,
    "no http warn behind trusted https proxy",
  );

  // Trust without loopback bind ignores header.
  assert(
    resolveEffectiveProtocol(forged, {
      PI_WEB_TRUST_PROXY: "1",
      PI_WEB_HOSTNAME: "0.0.0.0",
    }) === "http",
    "trust proxy requires loopback bind",
  );
  console.log("OK protocol-trust");
}

function testSameOrigin(): void {
  const ok = new Request("http://localhost:62666/api/server-auth/login", {
    method: "POST",
    headers: { origin: "http://localhost:62666", host: "localhost:62666" },
  });
  assertAuthRequestSameOrigin(ok);

  // Next may rewrite URL host to localhost while client used 127.0.0.1 — Host wins.
  const rewritten = new Request("http://localhost:62666/api/server-auth/login", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:62666", host: "127.0.0.1:62666" },
  });
  assertAuthRequestSameOrigin(rewritten);

  let blocked = false;
  try {
    assertAuthRequestSameOrigin(
      new Request("http://localhost:62666/api/server-auth/login", {
        method: "POST",
        headers: { origin: "http://evil.example", host: "localhost:62666" },
      }),
    );
  } catch {
    blocked = true;
  }
  assert(blocked, "cross origin blocked");

  let missing = false;
  try {
    assertAuthRequestSameOrigin(
      new Request("http://localhost:62666/api/server-auth/login", {
        method: "POST",
        headers: { host: "localhost:62666" },
      }),
    );
  } catch {
    missing = true;
  }
  assert(missing, "missing origin blocked");
  console.log("OK same-origin");
}

function testAuthFlag(): void {
  assert(!isServerAccessAuthEnabled({}), "default off");
  assert(isServerAccessAuthEnabled({ PI_WEB_SERVER_MODE: "1" }), "on=1");
  assert(isServerAccessAuthEnabled({ PI_WEB_SERVER_MODE: "true" }), "on=true");
  assert(!isServerAccessAuthEnabled({ PI_WEB_SERVER_MODE: "0" }), "off=0");
  assert(UNLOCK_PATH === "/unlock", "unlock path");
  console.log("OK auth-flag");
}

function testAuthBypassCidrs(): void {
  assert(ipMatchesEntry("100.64.1.2", "100.64.1.2"), "exact ip");
  assert(ipMatchesEntry("100.64.1.2", "100.64.0.0/10"), "tailscale cgnat");
  assert(!ipMatchesEntry("192.168.1.5", "100.64.0.0/10"), "lan not in tailscale");
  assert(ipMatchesEntry("10.0.0.5", "10.0.0.0/8"), "class a");
  assert(!ipMatchesEntry("11.0.0.5", "10.0.0.0/8"), "outside class a");
  assert(ipMatchesEntry("::1", "::1"), "ipv6 exact");
  assert(ipMatchesEntry("2001:db8::1", "2001:db8::/32"), "ipv6 cidr");

  const parsed = parseAuthBypassEntries("100.64.0.0/10, 100.1.2.3 0.0.0.0/0 ::/0");
  assert(parsed.includes("100.64.0.0/10"), "keeps tailscale");
  assert(parsed.includes("100.1.2.3"), "keeps host");
  assert(!parsed.includes("0.0.0.0/0"), "rejects world v4");
  assert(!parsed.includes("::/0"), "rejects world v6");

  assert(
    isClientIpAuthBypassed("100.99.0.1", ["100.64.0.0/10"]),
    "bypass match",
  );
  assert(
    !isClientIpAuthBypassed("8.8.8.8", ["100.64.0.0/10"]),
    "bypass miss",
  );
  assert(!isClientIpAuthBypassed(null, ["100.64.0.0/10"]), "null remote no bypass");
  assert(
    !isClientIpAuthBypassed("100.64.1.1", []),
    "empty allowlist never bypasses",
  );
  // Forged XFF must not be consulted by this helper — only the IP argument matters.
  assert(
    !isClientIpAuthBypassed("192.168.0.8", getAuthBypassEntries({
      PI_WEB_AUTH_BYPASS_CIDRS: "100.64.0.0/10",
    })),
    "lan still gated when only tailscale listed",
  );

  const dir = mkdtempSync(join(tmpdir(), "spi-auth-policy-"));
  try {
    assert(
      resolveAuthBypassEntries({ env: {}, agentDir: dir }).source === "none",
      "empty dir → none",
    );
    writeServerAccessPolicyFile({ authBypassCidrs: ["100.64.0.0/10", "10.0.0.5"] }, dir);
    const path = getServerAccessPolicyPath(dir);
    assert(path.endsWith("server-access-policy.json"), "policy filename");
    const file = readServerAccessPolicyFile(dir);
    assert(file.authBypassCidrs.includes("100.64.0.0/10"), "file stores cidr");
    const fromFile = resolveAuthBypassEntries({ env: {}, agentDir: dir });
    assert(fromFile.source === "file", "source=file");
    assert(fromFile.entries.includes("10.0.0.5"), "file entries loaded");

    // Env present overrides file (even when empty → no bypass).
    const envOverride = resolveAuthBypassEntries({
      env: { PI_WEB_AUTH_BYPASS_CIDRS: "100.1.2.3" },
      agentDir: dir,
    });
    assert(envOverride.source === "env", "env overrides file");
    assert(envOverride.entries.includes("100.1.2.3"), "env entries win");
    assert(!envOverride.entries.includes("10.0.0.5"), "file entries not merged when env set");

    const envEmpty = resolveAuthBypassEntries({
      env: { PI_WEB_AUTH_BYPASS_CIDRS: "" },
      agentDir: dir,
    });
    assert(envEmpty.source === "env" && envEmpty.entries.length === 0, "empty env disables bypass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("OK auth-bypass-cidrs");
}

function main(): void {
  testPublicPaths();
  testApiInventoryProtected();
  testCookieHelpers();
  testProtocolTrust();
  testSameOrigin();
  testAuthFlag();
  testAuthBypassCidrs();
  console.log("server-access-proxy smoke checks passed");
}

main();
