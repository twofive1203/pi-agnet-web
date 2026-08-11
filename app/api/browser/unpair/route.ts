import { NextResponse } from "next/server";
import { getBrowserBindingManager } from "@/lib/browser-binding-manager";
import { listInstallations, unpairAll } from "@/lib/browser-pairing";
import { BrowserControlError } from "@/lib/browser-protocol";
import { assertDirectLoopbackConnection } from "@/lib/automation-local-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    // Extension-only unpair path: always require a proven loopback peer.
    assertDirectLoopbackConnection(req);
    const body = await req.json().catch(() => ({})) as { clientId?: unknown; all?: unknown };
    const manager = getBrowserBindingManager();
    if (body.all === true) {
      const installations = listInstallations();
      for (const item of installations) manager.unpairClient(item.clientId);
      unpairAll();
      return NextResponse.json({ success: true, unpaired: installations.length });
    }
    if (typeof body.clientId !== "string" || !body.clientId) {
      return NextResponse.json({ error: "clientId is required (or all: true)" }, { status: 400 });
    }
    manager.unpairClient(body.clientId);
    return NextResponse.json({ success: true, clientId: body.clientId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusFromError = error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
    const status = error instanceof BrowserControlError
      ? 400
      : (Number.isFinite(statusFromError) ? statusFromError! : 500);
    const code = error instanceof BrowserControlError
      ? undefined
      : (error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "error")
        : undefined);
    return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
  }
}
