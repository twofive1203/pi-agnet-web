import { NextResponse } from "next/server";
import { getBrowserBindingManager } from "@/lib/browser-binding-manager";
import { ensureBrowserBridgeStarted } from "@/lib/browser-bridge";
import { readBrowserBridgeState, verifyInstallationSecret } from "@/lib/browser-pairing";
import { BrowserControlError } from "@/lib/browser-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserControlError("INVALID_FRAME", "sessionId is required");
  }
  const sessionId = value.trim();
  if (sessionId.startsWith("new-")) {
    throw new BrowserControlError("INVALID_FRAME", "Wait for the real session id before browser binding");
  }
  return sessionId;
}

/** List bindings or create a pending bind request. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = requireSessionId(url.searchParams.get("sessionId"));
    const manager = getBrowserBindingManager();
    return NextResponse.json({
      bindings: manager.listBindings(sessionId),
      status: manager.getPublicStatus(sessionId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BrowserControlError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as {
      action?: unknown;
      sessionId?: unknown;
      sessionLabel?: unknown;
      bindingId?: unknown;
      pendingRequestId?: unknown;
      clientId?: unknown;
      installationSecret?: unknown;
      tabId?: unknown;
      documentId?: unknown;
      origin?: unknown;
      title?: unknown;
      url?: unknown;
    };

    const action = typeof body.action === "string" ? body.action : "request";
    const manager = getBrowserBindingManager();
    const state = readBrowserBridgeState();
    if (state.enabled) await ensureBrowserBridgeStarted(state.port);

    if (action === "request") {
      const sessionId = requireSessionId(body.sessionId);
      await manager.ensureReady();
      const pending = manager.createPendingBindingRequest({
        sessionId,
        sessionLabel: typeof body.sessionLabel === "string" ? body.sessionLabel : undefined,
      });
      return NextResponse.json({ success: true, pending });
    }

    if (action === "accept") {
      // Acceptance must go over the authenticated extension WebSocket channel.
      // HTTP accept is intentionally rejected so clientId/tabId cannot be forged.
      return NextResponse.json(
        {
          error: "Binding acceptance must use the authenticated extension bridge channel",
          code: "AUTH_FAILED",
        },
        { status: 403 },
      );
    }

    if (action === "set_primary") {
      const sessionId = requireSessionId(body.sessionId);
      if (typeof body.bindingId !== "string") {
        return NextResponse.json({ error: "bindingId is required" }, { status: 400 });
      }
      const bindings = manager.setPrimary(sessionId, body.bindingId);
      return NextResponse.json({ success: true, bindings });
    }

    if (action === "revoke") {
      const sessionId = requireSessionId(body.sessionId);
      const bindings = manager.revoke(
        sessionId,
        typeof body.bindingId === "string" ? body.bindingId : undefined,
      );
      return NextResponse.json({ success: true, bindings });
    }

    if (action === "enable_debug") {
      const sessionId = requireSessionId(body.sessionId);
      if (typeof body.bindingId !== "string") {
        return NextResponse.json({ error: "bindingId is required" }, { status: 400 });
      }
      const binding = await manager.enableDebug(sessionId, body.bindingId);
      return NextResponse.json({ success: true, binding });
    }

    if (action === "disable_debug") {
      const sessionId = requireSessionId(body.sessionId);
      if (typeof body.bindingId !== "string") {
        return NextResponse.json({ error: "bindingId is required" }, { status: 400 });
      }
      const binding = await manager.disableDebug(sessionId, body.bindingId);
      return NextResponse.json({ success: true, binding });
    }

    if (action === "pending") {
      // Pending metadata for extension badge only when installation credentials are proven.
      const clientId = typeof body.clientId === "string" ? body.clientId : "";
      const installationSecret = typeof body.installationSecret === "string" ? body.installationSecret : "";
      if (!clientId || !installationSecret || !verifyInstallationSecret(clientId, installationSecret)) {
        return NextResponse.json(
          { error: "Installation credentials required", code: "AUTH_FAILED" },
          { status: 401 },
        );
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      const pendings = sessionId
        ? manager.listOpenPendingRequests().filter((p) => p.sessionId === sessionId)
        : manager.listOpenPendingRequests();
      return NextResponse.json({
        pendings,
        // Unambiguous single pending only; multi-session clients must choose pendingRequestId.
        pending: pendings.length === 1 ? pendings[0] : null,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BrowserControlError ? 400 : 500;
    const code = error instanceof BrowserControlError ? error.code : undefined;
    return NextResponse.json({ error: message, code }, { status });
  }
}
