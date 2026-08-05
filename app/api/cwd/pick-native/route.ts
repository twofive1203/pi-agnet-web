import { NextResponse } from "next/server";
import {
  assertCwdLocalAccess,
  CwdLocalAccessError,
  probeCwdLocalAccess,
} from "@/lib/cwd-local-access";
import {
  getNativePickCapabilities,
  pickDirectoryNative,
} from "@/lib/cwd-native-pick";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/cwd/pick-native
 * Capability probe for the add-project flow: loopback local-access + host OS picker support.
 * Does not open a dialog.
 */
export async function GET(req: Request) {
  const local = probeCwdLocalAccess(req);
  const caps = getNativePickCapabilities();
  return NextResponse.json({
    localAccess: local.localAccess,
    localAccessReason: local.reason ?? null,
    platform: caps.platform,
    nodePlatform: caps.nodePlatform,
    nativePickerSupported: caps.nativePickerSupported,
    backend: caps.backend,
    hasDisplayHint: caps.hasDisplayHint,
    /** Prefer native dialog only when both local and supported. */
    preferNative: local.localAccess && caps.nativePickerSupported,
  });
}

/**
 * POST /api/cwd/pick-native  body: { initialPath?: string }
 * Opens a host-OS folder chooser on the WebUI server machine (loopback only).
 * On success returns `{ path }`; cancelled/unavailable responses use structured codes
 * so the UI can fall back to the web directory browser.
 */
export async function POST(req: Request) {
  try {
    assertCwdLocalAccess(req);
  } catch (error) {
    if (error instanceof CwdLocalAccessError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          preferNative: false,
        },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: String(error), code: "unavailable" }, { status: 500 });
  }

  try {
    const body = await req.json().catch(() => ({})) as { initialPath?: unknown };
    const initialPath = typeof body.initialPath === "string" ? body.initialPath : null;

    const result = await pickDirectoryNative({ initialPath });
    if (result.ok) {
      return NextResponse.json({ path: result.path, code: "ok" });
    }

    const status =
      result.code === "busy"
        ? 409
        : result.code === "timeout"
          ? 504
          : result.code === "cancelled"
            ? 200
            : 503;

    return NextResponse.json(
      {
        error: result.error,
        code: result.code,
        cancelled: result.code === "cancelled",
      },
      { status },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        code: "unavailable",
      },
      { status: 500 },
    );
  }
}
