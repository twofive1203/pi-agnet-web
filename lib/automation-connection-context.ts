/**
 * Server-derived connection remote-address context for Automation local-only gates.
 * Captured from the Node HTTP socket at request start; Host/URL are never trusted alone.
 *
 * Shared state lives on globalThis so Next.js instrumentation and route-handler bundles
 * observe the same capture (webpack may duplicate module instances otherwise).
 *
 * The Server/EventEmitter emit hook must preserve the real server instance as `this`
 * so ordinary HTTP serving continues to work.
 */

import { AsyncLocalStorage, createHook, executionAsyncId } from "async_hooks";
import type { IncomingMessage, Server } from "http";
import type { Server as HttpsServer } from "https";
import { isIP } from "net";

export type AutomationConnectionContext = {
  remoteAddress: string | null;
  localAddress: string | null;
  capturedAt: number;
};

type SharedConnState = {
  storage: AsyncLocalStorage<AutomationConnectionContext>;
  contextByAsyncId: Map<number, AutomationConnectionContext>;
  hooksInstalled: boolean;
  emitHookInstalled: boolean;
};

declare global {
  var __piAutomationConnShared: SharedConnState | undefined;
  var __piAutomationConnHookInstalled: boolean | undefined;
}

function shared(): SharedConnState {
  if (!globalThis.__piAutomationConnShared) {
    globalThis.__piAutomationConnShared = {
      storage: new AsyncLocalStorage<AutomationConnectionContext>(),
      contextByAsyncId: new Map(),
      hooksInstalled: false,
      emitHookInstalled: false,
    };
  }
  return globalThis.__piAutomationConnShared;
}

function ensureAsyncHooks(): void {
  const s = shared();
  if (s.hooksInstalled) return;
  s.hooksInstalled = true;
  createHook({
    init(asyncId, _type, triggerAsyncId) {
      const parent = s.contextByAsyncId.get(triggerAsyncId);
      if (parent) s.contextByAsyncId.set(asyncId, parent);
    },
    destroy(asyncId) {
      s.contextByAsyncId.delete(asyncId);
    },
  }).enable();
}

function bindContextToCurrentAsync(ctx: AutomationConnectionContext): void {
  ensureAsyncHooks();
  shared().contextByAsyncId.set(executionAsyncId(), ctx);
}

function contextFromAsyncHooks(): AutomationConnectionContext | undefined {
  return shared().contextByAsyncId.get(executionAsyncId());
}

export function getAutomationRemoteAddress(): string | null {
  const fromAls = shared().storage.getStore()?.remoteAddress ?? null;
  if (fromAls) return fromAls;
  return contextFromAsyncHooks()?.remoteAddress ?? null;
}

export function getAutomationConnectionContext(): AutomationConnectionContext | undefined {
  return shared().storage.getStore() ?? contextFromAsyncHooks();
}

export function runWithAutomationConnectionContext<T>(
  ctx: AutomationConnectionContext,
  fn: () => T,
): T {
  bindContextToCurrentAsync(ctx);
  return shared().storage.run(ctx, () => {
    bindContextToCurrentAsync(ctx);
    return fn();
  });
}

export function normalizeIp(address: string | null | undefined): string | null {
  if (!address) return null;
  let value = address.trim().toLowerCase();
  if (value.startsWith("::ffff:")) value = value.slice(7);
  if (value === "0:0:0:0:0:0:0:1") value = "::1";
  return value;
}

export function isLoopbackIp(address: string | null | undefined): boolean {
  const ip = normalizeIp(address);
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (isIP(ip) === 4) return ip.startsWith("127.");
  return false;
}

export function captureFromIncomingMessage(req: IncomingMessage): AutomationConnectionContext {
  const socket = req.socket;
  return {
    remoteAddress: normalizeIp(socket?.remoteAddress ?? null),
    localAddress: normalizeIp(socket?.localAddress ?? null),
    capturedAt: Date.now(),
  };
}

/**
 * Wrap a Node request listener so every invocation runs inside ALS with the real
 * socket remoteAddress. Prefer this over prototype patching when a server instance
 * is available (e.g. custom Node servers / tests).
 */
export function wrapRequestListener<
  T extends (req: IncomingMessage, res: unknown, ...rest: unknown[]) => unknown,
>(listener: T): T {
  const wrapped = function automationRequestListener(
    this: unknown,
    req: IncomingMessage,
    res: unknown,
    ...rest: unknown[]
  ) {
    const ctx = captureFromIncomingMessage(req);
    return runWithAutomationConnectionContext(ctx, () =>
      (listener as (this: unknown, ...args: unknown[]) => unknown).call(this, req, res, ...rest),
    );
  };
  return wrapped as T;
}

type EmitFn = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

function wrapEmitPrototype(proto: { emit?: EmitFn } | null | undefined): void {
  if (!proto?.emit) return;
  const current = proto.emit as EmitFn & { __piAutomationWrapped?: boolean };
  if (current.__piAutomationWrapped) return;

  const original: EmitFn = current;
  const wrapped: EmitFn & { __piAutomationWrapped?: boolean } = function patchedEmit(
    this: unknown,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "request") {
      const req = args[0] as IncomingMessage | undefined;
      if (req && typeof req.socket === "object") {
        const ctx = captureFromIncomingMessage(req);
        try {
          Object.defineProperty(req, "__piAutomationConnection", {
            value: ctx,
            enumerable: false,
            configurable: true,
            writable: true,
          });
        } catch {
          (req as { __piAutomationConnection?: AutomationConnectionContext }).__piAutomationConnection =
            ctx;
        }
        bindContextToCurrentAsync(ctx);
        try {
          shared().storage.enterWith(ctx);
        } catch {
          // ignore
        }
        return shared().storage.run(ctx, () => {
          bindContextToCurrentAsync(ctx);
          return original.apply(this, [event, ...args]);
        });
      }
    }
    return original.apply(this, [event, ...args]);
  };
  wrapped.__piAutomationWrapped = true;
  proto.emit = wrapped;
}

/**
 * Install once per process: wrap HTTP(S) Server + EventEmitter emit so every
 * "request" event runs with the real socket remoteAddress available to Automation gates.
 */
export function installAutomationConnectionCapture(): { installed: boolean } {
  const s = shared();
  if (s.emitHookInstalled || globalThis.__piAutomationConnHookInstalled) {
    return { installed: true };
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require("http") as typeof import("http");
    wrapEmitPrototype(http.Server.prototype as unknown as { emit?: EmitFn });
  } catch {
    // ignore
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const https = require("https") as typeof import("https");
    wrapEmitPrototype(https.Server.prototype as unknown as { emit?: EmitFn });
  } catch {
    // ignore
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { EventEmitter } = require("events") as typeof import("events");
    wrapEmitPrototype(EventEmitter.prototype as unknown as { emit?: EmitFn });
  } catch {
    // ignore
  }

  s.emitHookInstalled = true;
  globalThis.__piAutomationConnHookInstalled = true;
  return { installed: true };
}

/** Test helper: run fn under a synthetic remote address. */
export function withTestRemoteAddress<T>(remoteAddress: string | null, fn: () => T): T {
  return runWithAutomationConnectionContext(
    {
      remoteAddress: normalizeIp(remoteAddress),
      localAddress: "127.0.0.1",
      capturedAt: Date.now(),
    },
    fn,
  );
}

void (null as unknown as Server | HttpsServer);
