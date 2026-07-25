declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export type RawData = Buffer | ArrayBuffer | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;
    readonly readyState: number;
    constructor(address: string, options?: unknown);
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    addEventListener?(type: string, listener: (...args: unknown[]) => void): void;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: {
      server?: import("node:http").Server;
      maxPayload?: number;
      clientTracking?: boolean;
    });
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    close(cb?: () => void): void;
  }

  export { WebSocket as default };
  export type { IncomingMessage, Duplex };
}
