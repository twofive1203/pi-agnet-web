import assert from "node:assert/strict";
import {
  disposeAgentSession,
  drainAgentSession,
  type DisposableAgentSession,
} from "../lib/pi-session-lifecycle";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function main() {
  const order: string[] = [];
  const abortStarted = createDeferred();
  const allowAbortFinish = createDeferred();

  const session: DisposableAgentSession = {
    abort: async () => {
      order.push("abort-start");
      abortStarted.resolve();
      await allowAbortFinish.promise;
      order.push("abort-end");
    },
    abortCompaction: () => {
      order.push("abort-compaction");
    },
    extensionRunner: {
      getRegisteredCommands: () => [],
      hasHandlers: (eventType) => eventType === "session_shutdown",
      emit: async (event) => {
        order.push(`shutdown:${event.reason}`);
      },
    },
    dispose: () => {
      order.push("dispose");
    },
  };

  const disposePromise = disposeAgentSession(session, "fork");
  await abortStarted.promise;
  assert.deepEqual(order, ["abort-compaction", "abort-start"]);
  allowAbortFinish.resolve();
  await disposePromise;
  assert.deepEqual(order, [
    "abort-compaction",
    "abort-start",
    "abort-end",
    "shutdown:fork",
    "dispose",
  ]);

  // Drain timeout must not hang forever when abort is slow.
  const slowAbort = createDeferred();
  const hung: DisposableAgentSession = {
    abort: () => slowAbort.promise,
  };
  const startedAt = Date.now();
  await drainAgentSession(hung, 40);
  assert.ok(Date.now() - startedAt >= 35, "drain should wait for timeout");
  assert.ok(Date.now() - startedAt < 1000, "drain timeout should release promptly");
  slowAbort.resolve();

  // Missing session is a no-op.
  await disposeAgentSession(undefined, "quit");

  console.log("smoke-pi-session-lifecycle: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
