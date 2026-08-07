/**
 * Next.js 16 Proxy — instance-level server access gate.
 *
 * When PI_WEB_SERVER_MODE is off, requests pass through with zero state I/O.
 * When on, every non-public path requires a valid opaque session cookie.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  validateServerAccessSession,
  ServerAccessError,
} from "./lib/server-access-auth";
import {
  UNLOCK_PATH,
  isApiPath,
  isPublicPath,
  isServerAccessAuthEnabled,
  noStoreHeaders,
  readSessionTokenFromCookieHeader,
  serviceUnavailableJson,
  unauthorizedJson,
} from "./lib/server-access-policy";

export const config = {
  // Run on all paths except Next internals that are already allowlisted in isPublicPath.
  // Matcher is a static constant as required by Next.js.
  matcher: [
    "/((?!_next/static|_next/image).*)",
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

export async function proxy(request: NextRequest): Promise<NextResponse | Response> {
  if (!isServerAccessAuthEnabled()) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname || "/";

  if (isPublicPath(pathname)) {
    return NextResponse.next();
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
