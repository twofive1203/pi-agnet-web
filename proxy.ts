/**
 * Next.js 16 Proxy — instance-level server access gate.
 *
 * When PI_WEB_SERVER_MODE is off, requests pass through with zero state I/O.
 * When on, every non-public path requires a valid opaque session cookie,
 * unless the socket remote address matches PI_WEB_AUTH_BYPASS_CIDRS.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  getAutomationRemoteAddress,
  installAutomationConnectionCapture,
} from "./lib/automation-connection-context";
import {
  validateServerAccessSession,
  ServerAccessError,
} from "./lib/server-access-auth";
import {
  UNLOCK_PATH,
  assertAuthRequestSameOrigin,
  forbiddenJson,
  getAuthBypassEntries,
  isApiPath,
  isBrowserExtensionPairingPath,
  isClientIpAuthBypassed,
  isDesktopControlPath,
  isDesktopObserverPath,
  isLoopbackClientAddress,
  isPublicPath,
  isSecureTransportRequired,
  isServerAccessAuthEnabled,
  isStateChangingMethod,
  noStoreHeaders,
  readSessionTokenFromCookieHeader,
  secureTransportRequiredJson,
  serviceUnavailableJson,
  unauthorizedJson,
} from "./lib/server-access-policy";
import { evaluateDesktopCompanionProxyGate } from "./lib/desktop-local-access";

export const config = {
  // Login is fully self-gated and excluded so Proxy cannot pre-buffer an oversized
  // anonymous request body before the route's 4 KiB streaming limit runs.
  // The end anchor avoids exempting any future subroute under the login path.
  matcher: [
    "/((?!_next/static|_next/image|api/server-auth/login$).*)",
    "/",
  ],
};

function redirectToUnlock(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = UNLOCK_PATH;
  url.search = "";
  const res = NextResponse.redirect(url, 307);
  for (const [k, v] of Object.entries(noStoreHeaders())) {
    res.headers.set(k, String(v));
  }
  return res;
}

function resolveSocketRemoteAddress(): string | null {
  // Prefer the instrumentation-captured socket address. Never trust client XFF.
  try {
    installAutomationConnectionCapture();
  } catch {
    // ignore
  }
  return getAutomationRemoteAddress();
}

export async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  if (!isServerAccessAuthEnabled()) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname || "/";

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Chrome extension installation pairing stays cookie-free and same-origin-free.
  // The extension always talks to http://127.0.0.1 and cannot carry the WebUI access-key
  // cookie or an exact page Origin. Prefer a proven loopback TCP peer; when socket capture is
  // unavailable in this layer, only extension-owned actions (exchange/connect_token/unpair)
  // skip the cookie gate and the route handlers still enforce direct loopback.
  // issue/configure remain fully authenticated so server-mode code issuance is not anonymous.
  if (isBrowserExtensionPairingPath(pathname) && isStateChangingMethod(request.method)) {
    const remote = resolveSocketRemoteAddress();
    if (isLoopbackClientAddress(remote)) {
      return NextResponse.next();
    }
    if (pathname === "/api/browser/unpair" || pathname === "/api/browser/unpair/") {
      return NextResponse.next();
    }
    try {
      const peek = await request.clone().json() as { action?: unknown };
      const action = typeof peek.action === "string" ? peek.action : "";
      if (action === "exchange" || action === "connect_token") {
        return NextResponse.next();
      }
    } catch {
      // Fall through to normal origin/auth gates when the body is not JSON.
    }
  }

  // Desktop pet cannot carry a browser session cookie. Proxy only skips the cookie/HTTPS
  // gate after a transport check; route handlers still mint with Access Key + namespace tokens.
  // Never treat these paths as anonymously public.
  if (isDesktopObserverPath(pathname) || isDesktopControlPath(pathname)) {
    const remote = resolveSocketRemoteAddress();
    const gate = evaluateDesktopCompanionProxyGate(request, remote);
    if (gate.allow) {
      return NextResponse.next();
    }
    if (gate.code === "insecure_http") {
      return new NextResponse(
        JSON.stringify({
          error: "HTTPS required for remote desktop attach",
          code: "insecure_http",
        }),
        {
          status: 403,
          headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
        },
      );
    }
    return forbiddenJson();
  }

  // SameSite cookies still travel between sibling origins on the same site.
  // Require an exact browser-facing origin for every state-changing business request.
  if (isStateChangingMethod(request.method)) {
    try {
      assertAuthRequestSameOrigin(request);
    } catch {
      return forbiddenJson();
    }
  }

  // Optional trusted-client bypass (e.g. exact Tailscale peers / mesh CIDRs).
  // Loopback entries are rejected while parsing because they would also trust a reverse proxy.
  const bypassEntries = getAuthBypassEntries();
  if (bypassEntries.length > 0) {
    const remote = resolveSocketRemoteAddress();
    if (isClientIpAuthBypassed(remote, bypassEntries)) {
      return NextResponse.next();
    }
  }

  if (isSecureTransportRequired(request)) {
    if (isApiPath(pathname)) return secureTransportRequiredJson();
    return redirectToUnlock(request);
  }

  const token = readSessionTokenFromCookieHeader(request.headers.get("cookie"));

  let valid = false;
  try {
    const result = validateServerAccessSession(token);
    valid = result.ok;
  } catch (error) {
    if (error instanceof ServerAccessError) {
      if (isApiPath(pathname)) {
        return serviceUnavailableJson();
      }
      // Pages: still send to unlock; unlock form will surface 503 on login if needed.
      return redirectToUnlock(request);
    }
    if (isApiPath(pathname)) {
      return serviceUnavailableJson();
    }
    return redirectToUnlock(request);
  }

  if (valid) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return unauthorizedJson();
  }

  return redirectToUnlock(request);
}
