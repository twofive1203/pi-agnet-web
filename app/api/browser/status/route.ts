import { NextResponse } from "next/server";
import { getBrowserBindingManager } from "@/lib/browser-binding-manager";
import { ensureBrowserBridgeStarted, getBrowserBridge } from "@/lib/browser-bridge";
import { listInstallations, readBrowserBridgeState } from "@/lib/browser-pairing";
import { BrowserControlError } from "@/lib/browser-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    const state = readBrowserBridgeState();
    if (state.enabled) {
      try {
        await ensureBrowserBridgeStarted(state.port);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json({
          featureEnabled: state.enabled,
          bridge: { ...getBrowserBridge().getStatus(), startError: message },
          installations: listInstallations(),
          session: sessionId ? getBrowserBindingManager().getPublicStatus(sessionId) : null,
        });
      }
    }
    const manager = getBrowserBindingManager();
    const pendings = manager.listOpenPendingRequests();
    return NextResponse.json({
      featureEnabled: state.enabled,
      bridge: getBrowserBridge().getStatus(),
      installations: listInstallations(),
      session: sessionId ? manager.getPublicStatus(sessionId) : null,
      /** @deprecated use pendings — single global pending is ambiguous across sessions */
      pendingGlobal: pendings.length === 1 ? pendings[0] : null,
      pendings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BrowserControlError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
