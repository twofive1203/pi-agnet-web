/**
 * Loopback-only authenticated WebSocket browser bridge.
 * Separate from Agent SSE and extension_ui_request transport.
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_EXTENSION_FEATURES,
  BrowserControlError,
  MAX_ENVELOPE_AGE_MS,
  MAX_FRAME_BYTES,
  RECENT_REQUEST_CACHE,
  createEnvelope,
  parseEnvelope,
  type BrowserCommandRequest,
  type BrowserCommandResponse,
  type BrowserEnvelope,
  type BrowserEventPayload,
  type BrowserExtensionFeature,
  isRecord,
} from "./browser-protocol";
import {
  getInstallation,
  readBrowserBridgeState,
  verifyConnectHandshake,
} from "./browser-pairing";
import { recordBrowserAudit } from "./browser-audit";

export type BridgeClient = {
  clientId: string;
  socket: WebSocket;
  connectedAt: number;
  lastPongAt: number;
  extensionOrigin?: string;
  extensionFeatures: BrowserExtensionFeature[];
};

type PendingBridgeRequest = {
  clientId: string;
  resolve: (value: BrowserCommandResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
};

export type BrowserBridgeStatus = {
  running: boolean;
  enabled: boolean;
  host: "127.0.0.1";
  port: number;
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION;
  connectedClients: Array<{
    clientId: string;
    connectedAt: number;
    lastPongAt: number;
    extensionFeatures: BrowserExtensionFeature[];
  }>;
  pendingRequests: number;
};

type BridgeEventListener = (event: BrowserEventPayload & { clientId: string }) => void;
type ClientRequestHandler = (
  clientId: string,
  payload: Record<string, unknown>,
) => Promise<BrowserCommandResponse>;

function normalizeExtensionOrigin(origin: string | undefined): string {
  if (!origin) return "";
  return origin.replace(/\/$/, "").toLowerCase();
}

function isEnvelopeFresh(timestamp: number, now = Date.now()): boolean {
  return Math.abs(now - timestamp) <= MAX_ENVELOPE_AGE_MS;
}

export class BrowserBridge {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, BridgeClient>();
  private pending = new Map<string, PendingBridgeRequest>();
  private recentResponses = new Map<string, BrowserCommandResponse>();
  private recentOrder: string[] = [];
  private recentInboundIds = new Map<string, number>();
  private listeners = new Set<BridgeEventListener>();
  private clientRequestHandler: ClientRequestHandler | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private port = 0;
  private started = false;

  onEvent(listener: BridgeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setClientRequestHandler(handler: ClientRequestHandler | null): void {
    this.clientRequestHandler = handler;
  }

  isRunning(): boolean {
    return this.started;
  }

  getStatus(): BrowserBridgeStatus {
    const state = readBrowserBridgeState();
    return {
      running: this.started,
      enabled: state.enabled,
      host: "127.0.0.1",
      port: this.port || state.port,
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      connectedClients: [...this.clients.values()].map((c) => ({
        clientId: c.clientId,
        connectedAt: c.connectedAt,
        lastPongAt: c.lastPongAt,
        extensionFeatures: [...c.extensionFeatures],
      })),
      pendingRequests: this.pending.size,
    };
  }

  async start(port?: number): Promise<BrowserBridgeStatus> {
    if (this.started) return this.getStatus();
    const state = readBrowserBridgeState();
    const listenPort = port ?? state.port;

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        // Tiny health endpoint for local diagnostics (no secrets).
        if (req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, protocolVersion: BROWSER_PROTOCOL_VERSION }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.on("error", (error) => {
        reject(error);
      });

      // Bind loopback only.
      server.listen(listenPort, "127.0.0.1", () => {
        this.httpServer = server;
        this.port = listenPort;
        this.wss = new WebSocketServer({
          server,
          maxPayload: MAX_FRAME_BYTES,
          clientTracking: true,
        });
        this.wss.on("connection", (socket, req) => this.handleConnection(socket, req));
        this.started = true;
        this.heartbeatTimer = setInterval(() => this.heartbeat(), 20_000);
        if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
        resolve();
      });
    });

    recordBrowserAudit({ action: "bridge.start", status: "ok", params: { port: this.port } });
    return this.getStatus();
  }

  async stop(): Promise<void> {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BrowserControlError("BRIDGE_DISCONNECTED", "Bridge stopped"));
      this.pending.delete(requestId);
    }
    for (const client of this.clients.values()) {
      try {
        client.socket.close(1001, "bridge_stop");
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = null;
    await new Promise<void>((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
    this.started = false;
    this.recentInboundIds.clear();
    // Bridge restart revokes temporary server bindings; extension reconciles on next auth_ok.
    try {
      // Dynamic import avoids circular init with binding-manager.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getBrowserBindingManager } = require("./browser-binding-manager") as typeof import("./browser-binding-manager");
      getBrowserBindingManager().resetTemporaryState();
    } catch {
      // manager may be unavailable in isolated tests
    }
    recordBrowserAudit({ action: "bridge.stop", status: "ok" });
  }

  async sendEvent(clientId: string, payload: BrowserEventPayload): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Extension is not connected");
    }
    this.sendEnvelope(
      client.socket,
      createEnvelope("event", clientId, randomUUID(), payload),
    );
  }

  isClientConnected(clientId: string): boolean {
    const client = this.clients.get(clientId);
    return Boolean(client && client.socket.readyState === WebSocket.OPEN);
  }

  getClientExtensionFeatures(clientId: string): BrowserExtensionFeature[] {
    return [...(this.clients.get(clientId)?.extensionFeatures ?? [])];
  }

  async sendCommand(
    clientId: string,
    command: BrowserCommandRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; requestId?: string; timeoutCode?: "REQUEST_TIMEOUT" | "WAIT_TIMEOUT"; abortCode?: "REQUEST_TIMEOUT" | "REQUEST_CANCELLED" },
  ): Promise<BrowserCommandResponse> {
    if (!this.started) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Browser bridge is not running");
    }
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Extension is not connected");
    }

    const requestId = options?.requestId ?? randomUUID();
    const cached = this.recentResponses.get(requestId);
    if (cached) return cached;

    const timeoutMs = options?.timeoutMs ?? command.deadlineMs ?? 30_000;
    const envelope = createEnvelope("request", clientId, requestId, command);

    return await new Promise<BrowserCommandResponse>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new BrowserControlError(options?.abortCode ?? "REQUEST_TIMEOUT", "Browser command aborted"));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new BrowserControlError(options?.timeoutCode ?? "REQUEST_TIMEOUT", `Browser command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        options?.signal?.removeEventListener("abort", onAbort);
      };

      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new BrowserControlError(options?.abortCode ?? "REQUEST_TIMEOUT", "Browser command aborted"));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(requestId, {
        clientId,
        resolve: (value) => {
          cleanup();
          this.rememberResponse(requestId, value);
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
        createdAt: Date.now(),
      });

      try {
        this.sendEnvelope(client.socket, envelope);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendCancel(clientId: string, requestId: string): void {
    const client = this.clients.get(clientId);
    if (!client || client.socket.readyState !== WebSocket.OPEN) return;
    try {
      this.sendEnvelope(client.socket, createEnvelope("cancel", clientId, requestId, { requestId }));
    } catch {
      // ignore
    }
  }

  private rememberResponse(requestId: string, response: BrowserCommandResponse): void {
    this.recentResponses.set(requestId, response);
    this.recentOrder.push(requestId);
    while (this.recentOrder.length > RECENT_REQUEST_CACHE) {
      const old = this.recentOrder.shift();
      if (old) this.recentResponses.delete(old);
    }
  }

  private handleConnection(socket: WebSocket, req: IncomingMessage): void {
    const remote = req.socket.remoteAddress;
    if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== ":ffff:127.0.0.1") {
      socket.close(1008, "loopback_only");
      recordBrowserAudit({ action: "bridge.reject_remote", status: "error", code: "AUTH_FAILED", params: { remote } });
      return;
    }

    let clientId: string | null = null;
    let authed = false;
    const extensionOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;

    const authTimer = setTimeout(() => {
      if (!authed) {
        try { socket.close(1008, "auth_timeout"); } catch { /* ignore */ }
      }
    }, 15_000);

    socket.on("message", (data) => {
      void this.onSocketMessage(socket, data, {
        getClientId: () => clientId,
        setClientId: (id) => { clientId = id; },
        isAuthed: () => authed,
        setAuthed: (value) => { authed = value; clearTimeout(authTimer); },
        extensionOrigin,
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (clientId) {
        const existing = this.clients.get(clientId);
        if (existing?.socket === socket) {
          this.clients.delete(clientId);
          this.emitEvent({ event: "extension.disconnected", clientId });
          // Fail in-flight requests for this client.
          for (const [requestId, pending] of this.pending) {
            if (pending.clientId !== clientId) continue;
            clearTimeout(pending.timer);
            pending.reject(new BrowserControlError("BRIDGE_DISCONNECTED", "Extension disconnected"));
            this.pending.delete(requestId);
          }
        }
      }
    });

    socket.on("error", () => {
      // close handler performs cleanup
    });
  }

  private async onSocketMessage(
    socket: WebSocket,
    data: RawData,
    ctx: {
      getClientId: () => string | null;
      setClientId: (id: string) => void;
      isAuthed: () => boolean;
      setAuthed: (value: boolean) => void;
      extensionOrigin?: string;
    },
  ): Promise<void> {
    let text: string;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else if (Array.isArray(data)) text = Buffer.concat(data).toString("utf8");
    else text = Buffer.from(data).toString("utf8");

    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      socket.close(1009, "frame_too_large");
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      socket.close(1003, "invalid_json");
      return;
    }

    // Auth handshake before normal envelopes.
    if (!ctx.isAuthed()) {
      if (!isRecord(parsedJson) || parsedJson.type !== "auth") {
        socket.close(1008, "auth_required");
        return;
      }
      const clientId = typeof parsedJson.clientId === "string" ? parsedJson.clientId : "";
      const connectToken = typeof parsedJson.connectToken === "string" ? parsedJson.connectToken : "";
      const nonce = typeof parsedJson.nonce === "string" ? parsedJson.nonce : "";
      const response = typeof parsedJson.response === "string" ? parsedJson.response : "";
      const extensionFeatures = Array.isArray(parsedJson.extensionFeatures)
        ? parsedJson.extensionFeatures.filter((feature): feature is BrowserExtensionFeature => (
          BROWSER_EXTENSION_FEATURES.includes(feature as typeof BROWSER_EXTENSION_FEATURES[number])
        ))
        : [];
      if (!clientId || !connectToken || !nonce || !response) {
        socket.close(1008, "auth_invalid");
        return;
      }
      if (parsedJson.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
        socket.close(1008, "protocol_mismatch");
        return;
      }
      const ok = verifyConnectHandshake({ clientId, connectToken, nonce, response });
      if (!ok) {
        recordBrowserAudit({
          action: "bridge.auth_failed",
          status: "error",
          code: "AUTH_FAILED",
          clientId,
        });
        socket.close(1008, "auth_failed");
        return;
      }

      // When a stable extension origin was recorded at pairing, require a non-empty exact Origin match.
      // Missing Origin must fail closed — a valid connect token alone is not enough.
      const installation = getInstallation(clientId);
      const pairedOrigin = normalizeExtensionOrigin(installation?.extensionOrigin);
      const socketOrigin = normalizeExtensionOrigin(ctx.extensionOrigin);
      if (pairedOrigin) {
        if (!socketOrigin || pairedOrigin !== socketOrigin) {
          recordBrowserAudit({
            action: "bridge.auth_failed",
            status: "error",
            code: "AUTH_FAILED",
            clientId,
            params: { reason: socketOrigin ? "origin_mismatch" : "origin_missing" },
          });
          socket.close(1008, socketOrigin ? "origin_mismatch" : "origin_missing");
          return;
        }
      }

      // Replace existing connection for same client.
      const previous = this.clients.get(clientId);
      if (previous && previous.socket !== socket) {
        try { previous.socket.close(1000, "replaced"); } catch { /* ignore */ }
      }

      ctx.setClientId(clientId);
      ctx.setAuthed(true);
      const now = Date.now();
      this.clients.set(clientId, {
        clientId,
        socket,
        connectedAt: now,
        lastPongAt: now,
        extensionOrigin: ctx.extensionOrigin ?? installation?.extensionOrigin,
        extensionFeatures,
      });

      this.sendRaw(socket, {
        type: "auth_ok",
        protocolVersion: BROWSER_PROTOCOL_VERSION,
        clientId,
        serverTime: now,
        reconcileRequired: true,
      });
      this.emitEvent({ event: "extension.ready", clientId });
      recordBrowserAudit({ action: "bridge.auth_ok", status: "ok", clientId });
      return;
    }

    let envelope: BrowserEnvelope;
    try {
      envelope = parseEnvelope(parsedJson);
    } catch (error) {
      const message = error instanceof BrowserControlError ? error.message : "invalid envelope";
      this.sendRaw(socket, { type: "error", code: "INVALID_FRAME", message });
      return;
    }

    const clientId = ctx.getClientId();
    if (!clientId || envelope.clientId !== clientId) {
      socket.close(1008, "client_mismatch");
      return;
    }

    if (!isEnvelopeFresh(envelope.timestamp)) {
      this.sendRaw(socket, {
        type: "error",
        code: "INVALID_FRAME",
        message: "Stale or replayed envelope timestamp",
      });
      return;
    }

    // Drop duplicate inbound envelopes (replay protection).
    if (envelope.kind === "request" || envelope.kind === "response" || envelope.kind === "event") {
      const inboundKey = `${clientId}:${envelope.kind}:${envelope.requestId}`;
      if (this.recentInboundIds.has(inboundKey)) {
        return;
      }
      this.recentInboundIds.set(inboundKey, Date.now());
      if (this.recentInboundIds.size > RECENT_REQUEST_CACHE * 2) {
        const cutoff = Date.now() - MAX_ENVELOPE_AGE_MS;
        for (const [key, ts] of this.recentInboundIds) {
          if (ts < cutoff) this.recentInboundIds.delete(key);
        }
      }
    }

    if (envelope.kind === "pong") {
      const client = this.clients.get(clientId);
      if (client) client.lastPongAt = Date.now();
      return;
    }

    if (envelope.kind === "ping") {
      this.sendEnvelope(socket, createEnvelope("pong", clientId, envelope.requestId, { t: Date.now() }));
      return;
    }

    if (envelope.kind === "request") {
      // Extension-originated commands (binding.accept, reconcile pull, pending).
      if (!this.clientRequestHandler) {
        this.sendEnvelope(socket, createEnvelope("response", clientId, envelope.requestId, {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "No client request handler",
            recovery: "Restart Snail Pi",
          },
        } satisfies BrowserCommandResponse));
        return;
      }
      const payload = isRecord(envelope.payload) ? envelope.payload : {};
      try {
        const result = await this.clientRequestHandler(clientId, payload);
        this.sendEnvelope(socket, createEnvelope("response", clientId, envelope.requestId, result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendEnvelope(socket, createEnvelope("response", clientId, envelope.requestId, {
          ok: false,
          error: {
            code: error instanceof BrowserControlError ? error.code : "INTERNAL_ERROR",
            message,
            recovery: error instanceof BrowserControlError ? error.recovery : "Retry after reconnect",
          },
        } satisfies BrowserCommandResponse));
      }
      return;
    }

    if (envelope.kind === "response") {
      const pending = this.pending.get(envelope.requestId);
      if (!pending) return;
      const payload = envelope.payload;
      if (!isRecord(payload) || typeof payload.ok !== "boolean") {
        pending.reject(new BrowserControlError("INVALID_FRAME", "Invalid command response"));
        return;
      }
      const response: BrowserCommandResponse = {
        ok: payload.ok,
        result: payload.result,
      };
      if (isRecord(payload.error)) {
        response.error = {
          code: (typeof payload.error.code === "string"
            ? payload.error.code
            : "INTERNAL_ERROR") as NonNullable<BrowserCommandResponse["error"]>["code"],
          message: typeof payload.error.message === "string" ? payload.error.message : "error",
          recovery: typeof payload.error.recovery === "string" ? payload.error.recovery : "",
          details: isRecord(payload.error.details) ? payload.error.details : undefined,
        };
      }
      pending.resolve(response);
      return;
    }

    if (envelope.kind === "event") {
      const payload = envelope.payload;
      if (!isRecord(payload) || typeof payload.event !== "string") return;
      this.emitEvent({
        event: payload.event as BrowserEventPayload["event"],
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        bindingId: typeof payload.bindingId === "string" ? payload.bindingId : undefined,
        data: isRecord(payload.data) ? payload.data : undefined,
        clientId,
      });
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (now - client.lastPongAt > 90_000) {
        try { client.socket.close(1001, "heartbeat_timeout"); } catch { /* ignore */ }
        continue;
      }
      try {
        this.sendEnvelope(
          client.socket,
          createEnvelope("ping", client.clientId, randomUUID(), { t: now }),
        );
      } catch {
        // ignore
      }
    }
  }

  private emitEvent(event: BrowserEventPayload & { clientId: string }): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private sendEnvelope(socket: WebSocket, envelope: BrowserEnvelope): void {
    // Outbound envelopes always use a fresh timestamp from createEnvelope.
    if (!isEnvelopeFresh(envelope.timestamp)) {
      throw new BrowserControlError("INVALID_FRAME", "Refusing to send stale envelope");
    }
    this.sendRaw(socket, envelope);
  }

  private sendRaw(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new BrowserControlError("BRIDGE_DISCONNECTED", "Socket is not open");
    }
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
      throw new BrowserControlError("OUTPUT_LIMIT_EXCEEDED", "Outbound frame exceeds limit");
    }
    socket.send(text);
  }
}

declare global {
  var __piBrowserBridge: BrowserBridge | undefined;
  var __piBrowserBridgeStart: Promise<BrowserBridge> | undefined;
}

export function getBrowserBridge(): BrowserBridge {
  if (!globalThis.__piBrowserBridge) {
    globalThis.__piBrowserBridge = new BrowserBridge();
  }
  return globalThis.__piBrowserBridge;
}

export async function ensureBrowserBridgeStarted(port?: number): Promise<BrowserBridge> {
  const bridge = getBrowserBridge();
  if (bridge.isRunning()) return bridge;
  if (!globalThis.__piBrowserBridgeStart) {
    globalThis.__piBrowserBridgeStart = bridge.start(port).then(() => bridge).finally(() => {
      globalThis.__piBrowserBridgeStart = undefined;
    });
  }
  return globalThis.__piBrowserBridgeStart;
}

export async function stopBrowserBridge(): Promise<void> {
  const bridge = getBrowserBridge();
  await bridge.stop();
}
