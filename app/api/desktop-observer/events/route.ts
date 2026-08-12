/**
 * GET /api/desktop-observer/events — full-snapshot SSE + heartbeat comments.
 * Token required; stream ends when token expires or client aborts.
 */

import {
  assertDesktopObserverToken,
  DesktopObserverAccessError,
} from "@/lib/desktop-observer-access";
import {
  getTaskObserverHub,
  TASK_OBSERVER_SSE_HEARTBEAT_MS,
} from "@/lib/task-observer-hub";
import { noStoreHeaders } from "@/lib/server-access-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof DesktopObserverAccessError) {
    return new Response(
      JSON.stringify({ error: error.message, code: error.code }),
      {
        status: error.status,
        headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
      },
    );
  }
  return new Response(JSON.stringify({ error: "Internal error", code: "error" }), {
    status: 500,
    headers: noStoreHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = assertDesktopObserverToken(req);
    const hub = getTaskObserverHub();

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let unsubscribe: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let expiryTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          if (expiryTimer) clearTimeout(expiryTimer);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        const safeEnqueue = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };

        const sendSnapshot = (type: "snapshot" | "reset", json: string) => {
          safeEnqueue(`data: ${JSON.stringify({ type, snapshot: JSON.parse(json) })}\n\n`);
        };

        // Initial baseline is always a reset snapshot (no notification replay).
        try {
          const initial = hub.getSnapshot({ reset: true });
          sendSnapshot("reset", initial.json);
        } catch {
          safeEnqueue(
            `data: ${JSON.stringify({ type: "error", code: "snapshot_failed" })}\n\n`,
          );
          cleanup();
          return;
        }

        unsubscribe = hub.subscribe((event) => {
          sendSnapshot(event.type, event.json);
        });

        heartbeat = setInterval(() => {
          // Heartbeat comments must not change revision / snapshot content.
          safeEnqueue(":\n\n");
        }, TASK_OBSERVER_SSE_HEARTBEAT_MS);
        heartbeat.unref?.();

        const remainingMs = Math.max(1_000, auth.expiresAt - Date.now());
        expiryTimer = setTimeout(() => {
          safeEnqueue(
            `data: ${JSON.stringify({ type: "error", code: "token_expired" })}\n\n`,
          );
          cleanup();
        }, remainingMs);
        expiryTimer.unref?.();

        req.signal?.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: noStoreHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
