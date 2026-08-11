import { NextResponse } from "next/server";
import {
  exchangePairingCode,
  issueConnectToken,
  issuePairingCode,
  listInstallations,
  readBrowserBridgeState,
  setBrowserBridgeEnabled,
  setBrowserBridgePort,
} from "@/lib/browser-pairing";
import { ensureBrowserBridgeStarted } from "@/lib/browser-bridge";
import { BrowserControlError, DEFAULT_BROWSER_BRIDGE_PORT } from "@/lib/browser-protocol";
import { assertDirectLoopbackConnection } from "@/lib/automation-local-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Create a short-lived pairing code for the Chrome extension. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as {
      action?: unknown;
      pairingCode?: unknown;
      installationSecret?: unknown;
      clientId?: unknown;
      extensionOrigin?: unknown;
      label?: unknown;
      enabled?: unknown;
      port?: unknown;
    };

    const action = typeof body.action === "string" ? body.action : "issue";

    if (action === "configure") {
      if (typeof body.enabled === "boolean") setBrowserBridgeEnabled(body.enabled);
      if (typeof body.port === "number") setBrowserBridgePort(body.port);
      const state = readBrowserBridgeState();
      if (state.enabled) {
        await ensureBrowserBridgeStarted(state.port);
      }
      return NextResponse.json({
        success: true,
        enabled: state.enabled,
        port: state.port,
        installations: listInstallations(),
      });
    }

    if (action === "exchange") {
      // Extension-owned: always hits http://127.0.0.1 without WebUI cookies.
      assertDirectLoopbackConnection(req);
      if (typeof body.pairingCode !== "string") {
        return NextResponse.json({ error: "pairingCode is required" }, { status: 400 });
      }
      const state = readBrowserBridgeState();
      if (!state.enabled) setBrowserBridgeEnabled(true);
      await ensureBrowserBridgeStarted(state.port || DEFAULT_BROWSER_BRIDGE_PORT);
      const result = exchangePairingCode({
        pairingCode: body.pairingCode,
        extensionOrigin: typeof body.extensionOrigin === "string" ? body.extensionOrigin : undefined,
        label: typeof body.label === "string" ? body.label : undefined,
      });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "connect_token") {
      // Extension-owned reconnect handshake; keep loopback-only even in server mode.
      assertDirectLoopbackConnection(req);
      if (typeof body.clientId !== "string" || typeof body.installationSecret !== "string") {
        return NextResponse.json({ error: "clientId and installationSecret are required" }, { status: 400 });
      }
      const state = readBrowserBridgeState();
      await ensureBrowserBridgeStarted(state.port);
      const token = issueConnectToken({
        clientId: body.clientId,
        installationSecret: body.installationSecret,
      });
      return NextResponse.json({
        success: true,
        ...token,
        port: state.port,
        host: "127.0.0.1",
        wsPath: "/ws",
      });
    }

    // default: issue pairing code
    const state = readBrowserBridgeState();
    if (!state.enabled) setBrowserBridgeEnabled(true);
    await ensureBrowserBridgeStarted(state.port || DEFAULT_BROWSER_BRIDGE_PORT);
    const offer = issuePairingCode({ port: state.port || DEFAULT_BROWSER_BRIDGE_PORT });
    return NextResponse.json({ success: true, ...offer, installations: listInstallations() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusFromError = error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
    const status = error instanceof BrowserControlError
      ? 400
      : (Number.isFinite(statusFromError) ? statusFromError! : 500);
    const code = error instanceof BrowserControlError
      ? error.code
      : (error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "error")
        : undefined);
    return NextResponse.json({ error: message, code }, { status });
  }
}

export async function GET() {
  const state = readBrowserBridgeState();
  return NextResponse.json({
    enabled: state.enabled,
    port: state.port,
    installations: listInstallations(),
    hasPendingPairing: Boolean(state.pendingPairing && state.pendingPairing.expiresAt > Date.now()),
  });
}
