import { NextResponse } from "next/server";
import { getBrowserBindingManager } from "@/lib/browser-binding-manager";
import { listInstallations, unpairAll } from "@/lib/browser-pairing";
import { BrowserControlError } from "@/lib/browser-protocol";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
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
    const status = error instanceof BrowserControlError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
