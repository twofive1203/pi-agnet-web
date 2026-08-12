import {
  QuickCommandRunnerError,
  subscribeQuickCommandRun,
} from "@/lib/quick-command-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = subscribeQuickCommandRun(id, (event) => {
          send(event);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ type: "error", error: message });
        controller.close();
        return;
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // stream closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal?.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Keep runner error type referenced for tooling/typecheck stability.
void QuickCommandRunnerError;
