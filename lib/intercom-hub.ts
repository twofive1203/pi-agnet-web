import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type IntercomSessionInfo = {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
};

export type IntercomListResult = {
  connected: boolean;
  selfId: string | null;
  sessions: IntercomSessionInfo[];
  socketPath: string;
  error?: string;
};

function sanitizePipeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}

export function getIntercomBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }
  return join(homeDir, ".pi/agent/intercom/broker.sock");
}

function writeMessage(socket: Socket, msg: unknown): void {
  const payload = Buffer.from(JSON.stringify(msg), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

function createMessageReader(onMessage: (msg: unknown) => void, onError: (error: Error) => void) {
  let buffer = Buffer.alloc(0);
  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(payload.toString("utf-8")));
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  };
}

function isSessionInfo(value: unknown): value is IntercomSessionInfo {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string"
    && typeof s.cwd === "string"
    && typeof s.model === "string"
    && typeof s.pid === "number"
    && typeof s.startedAt === "number"
    && typeof s.lastActivity === "number"
  );
}

type HubConnection = {
  socket: Socket;
  selfId: string;
  close: () => Promise<void>;
  listSessions: () => Promise<IntercomSessionInfo[]>;
  send: (to: string, text: string) => Promise<{ id: string; delivered: boolean; reason?: string }>;
};

/**
 * Open a short-lived hub connection to the local intercom broker.
 * Does not spawn the broker — returns a clear error if nothing is listening.
 */
export async function connectIntercomHub(options?: {
  name?: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<HubConnection> {
  const socketPath = getIntercomBrokerSocketPath();
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const cwd = options?.cwd ?? process.cwd();
  const name = options?.name ?? `pi-web-hub-${process.pid}`;

  return await new Promise<HubConnection>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let selfId: string | null = null;
    let settled = false;
    const pendingLists = new Map<string, {
      resolve: (sessions: IntercomSessionInfo[]) => void;
      reject: (error: Error) => void;
    }>();
    const pendingSends = new Map<string, {
      resolve: (result: { id: string; delivered: boolean; reason?: string }) => void;
      reject: (error: Error) => void;
    }>();

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      reject(error);
    };

    const timer = setTimeout(() => fail(new Error("Intercom broker connection timeout")), timeoutMs);

    const reader = createMessageReader((msg) => {
      if (!msg || typeof msg !== "object") return;
      const message = msg as Record<string, unknown>;
      if (message.type === "registered" && typeof message.sessionId === "string") {
        selfId = message.sessionId;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            socket,
            selfId,
            close: async () => {
              try {
                writeMessage(socket, { type: "unregister" });
              } catch { /* ignore */ }
              await new Promise<void>((res) => {
                socket.once("close", () => res());
                socket.end();
                setTimeout(() => {
                  try { socket.destroy(); } catch { /* ignore */ }
                  res();
                }, 500);
              });
            },
            listSessions: () => new Promise((listResolve, listReject) => {
              const requestId = randomUUID();
              const listTimer = setTimeout(() => {
                pendingLists.delete(requestId);
                listReject(new Error("List sessions timeout"));
              }, 5_000);
              pendingLists.set(requestId, {
                resolve: (sessions) => {
                  clearTimeout(listTimer);
                  listResolve(sessions);
                },
                reject: (error) => {
                  clearTimeout(listTimer);
                  listReject(error);
                },
              });
              try {
                writeMessage(socket, { type: "list", requestId });
              } catch (error) {
                clearTimeout(listTimer);
                pendingLists.delete(requestId);
                listReject(error instanceof Error ? error : new Error(String(error)));
              }
            }),
            send: (to, text) => new Promise((sendResolve, sendReject) => {
              const messageId = randomUUID();
              const sendTimer = setTimeout(() => {
                pendingSends.delete(messageId);
                sendReject(new Error("Send timeout"));
              }, 8_000);
              pendingSends.set(messageId, {
                resolve: (result) => {
                  clearTimeout(sendTimer);
                  sendResolve(result);
                },
                reject: (error) => {
                  clearTimeout(sendTimer);
                  sendReject(error);
                },
              });
              try {
                writeMessage(socket, {
                  type: "send",
                  to,
                  message: {
                    id: messageId,
                    timestamp: Date.now(),
                    content: { text },
                  },
                });
              } catch (error) {
                clearTimeout(sendTimer);
                pendingSends.delete(messageId);
                sendReject(error instanceof Error ? error : new Error(String(error)));
              }
            }),
          });
        }
        return;
      }

      if (message.type === "sessions" && typeof message.requestId === "string") {
        const pending = pendingLists.get(message.requestId);
        if (!pending) return;
        pendingLists.delete(message.requestId);
        const sessions = Array.isArray(message.sessions)
          ? message.sessions.filter(isSessionInfo)
          : [];
        pending.resolve(sessions);
        return;
      }

      if (message.type === "delivered" && typeof message.messageId === "string") {
        const pending = pendingSends.get(message.messageId);
        if (!pending) return;
        pendingSends.delete(message.messageId);
        pending.resolve({ id: message.messageId, delivered: true });
        return;
      }

      if (message.type === "delivery_failed" && typeof message.messageId === "string") {
        const pending = pendingSends.get(message.messageId);
        if (!pending) return;
        pendingSends.delete(message.messageId);
        pending.resolve({
          id: message.messageId,
          delivered: false,
          reason: typeof message.reason === "string" ? message.reason : "delivery failed",
        });
        return;
      }

      if (message.type === "error" && typeof message.error === "string") {
        fail(new Error(message.error));
      }
    }, (error) => fail(error));

    socket.on("connect", () => {
      writeMessage(socket, {
        type: "register",
        session: {
          name,
          cwd,
          model: "snail-pi-web",
          pid: process.pid,
          startedAt: Date.now(),
          lastActivity: Date.now(),
          status: "web-hub",
        },
      });
    });
    socket.on("data", reader);
    socket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => {
      if (!settled) fail(new Error("Intercom broker closed before registration"));
    });
  });
}

/**
 * List intercom sessions for the Web UI. Best-effort; never throws.
 */
export async function listIntercomSessions(cwd?: string): Promise<IntercomListResult> {
  const socketPath = getIntercomBrokerSocketPath();
  try {
    const hub = await connectIntercomHub({
      cwd: cwd || getAgentDir(),
      name: `pi-web-${process.pid}`,
    });
    try {
      const sessions = await hub.listSessions();
      return {
        connected: true,
        selfId: hub.selfId,
        sessions,
        socketPath,
      };
    } finally {
      await hub.close();
    }
  } catch (error) {
    return {
      connected: false,
      selfId: null,
      sessions: [],
      socketPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send a one-shot intercom message via a temporary hub registration.
 */
export async function sendIntercomMessage(input: {
  to: string;
  text: string;
  cwd?: string;
}): Promise<{ ok: boolean; delivered?: boolean; reason?: string; selfId?: string; error?: string }> {
  const to = input.to?.trim();
  const text = input.text?.trim();
  if (!to) return { ok: false, error: "to is required" };
  if (!text) return { ok: false, error: "text is required" };

  try {
    const hub = await connectIntercomHub({
      cwd: input.cwd || getAgentDir(),
      name: `pi-web-send-${process.pid}`,
    });
    try {
      const result = await hub.send(to, text);
      return {
        ok: result.delivered,
        delivered: result.delivered,
        reason: result.reason,
        selfId: hub.selfId,
        error: result.delivered ? undefined : (result.reason || "not delivered"),
      };
    } finally {
      await hub.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
