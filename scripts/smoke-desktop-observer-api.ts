/**
 * Smoke checks for desktop observer access gate, hub, and health boundary (U4).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-observer-api.ts
 */
import assert from "node:assert/strict";

import { withTestRemoteAddress } from "../lib/automation-connection-context";
import {
  assertDesktopObserverLocalAccess,
  assertDesktopObserverLoopback,
  assertDesktopObserverNetworkAccess,
  assertDesktopObserverSessionOrigin,
  assertDesktopObserverToken,
  buildDesktopObserverProtocolPayload,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DesktopObserverAccessError,
  issueDesktopObserverToken,
  isDesktopObserverServerMode,
  resetDesktopObserverTokensForTests,
} from "../lib/desktop-observer-access";
import { buildProcessHealthSnapshot } from "../lib/process-runtime";
import { isPublicPath } from "../lib/server-access-policy";
import {
  getTaskObserverHub,
  resetTaskObserverHubForTests,
  TaskObserverHub,
  TASK_OBSERVER_PROGRESS_COALESCE_MS,
  type TaskObserverCollectors,
} from "../lib/task-observer-hub";
import {
  notifyTaskObserverSourceChange,
  resetTaskObserverInvalidateForTests,
} from "../lib/task-observer-invalidate";
import { TASK_OBSERVER_PROTOCOL_VERSION } from "../lib/task-observer-types";
import { parseAndAssertPublicSnapshot } from "../lib/task-observer-projection";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

async function main() {
  console.log("smoke-desktop-observer-api: start");

  resetDesktopObserverTokensForTests();
  resetTaskObserverHubForTests();
  resetTaskObserverInvalidateForTests();

  // --- Public path policy: observer is NOT anonymously public ---
  assert.equal(isPublicPath("/api/health"), true);
  assert.equal(isPublicPath("/api/desktop-observer/protocol"), false);
  assert.equal(isPublicPath("/api/desktop-observer/session"), false);
  assert.equal(isPublicPath("/api/desktop-observer/snapshot"), false);
  assert.equal(isPublicPath("/api/desktop-observer/events"), false);

  // --- Protocol payload ---
  const protocol = buildDesktopObserverProtocolPayload({ PI_WEB_SERVER_MODE: "0" });
  assert.equal(protocol.protocolVersion, TASK_OBSERVER_PROTOCOL_VERSION);
  assert.equal(protocol.product, "snail-pi-web");
  assert.equal(protocol.mode, "local");
  assert.equal(protocol.compatible, true);
  assert.equal(protocol.reasonCode, null);
  assert.deepEqual(protocol.capabilities, ["quick_session", "remote_attach"]);

  const serverProtocol = buildDesktopObserverProtocolPayload({ PI_WEB_SERVER_MODE: "1" });
  assert.equal(serverProtocol.mode, "server");
  assert.equal(serverProtocol.compatible, true);
  assert.equal(serverProtocol.authRequired, true);
  assert.equal(serverProtocol.reasonCode, null);
  assert.equal(isDesktopObserverServerMode({ PI_WEB_SERVER_MODE: "1" }), true);

  const localProtocol = buildDesktopObserverProtocolPayload({ PI_WEB_SERVER_MODE: "0" });
  assert.equal(localProtocol.authRequired, false);

  // --- Access: missing remote fails closed ---
  assert.throws(
    () =>
      assertDesktopObserverLoopback(
        req("http://127.0.0.1:62666/api/desktop-observer/protocol", {
          headers: { host: "127.0.0.1:62666" },
        }),
      ),
    (error: unknown) => error instanceof DesktopObserverAccessError,
  );

  // --- Access: remote non-loopback rejected ---
  withTestRemoteAddress("8.8.8.8", () => {
    assert.throws(
      () =>
        assertDesktopObserverLoopback(
          req("http://127.0.0.1:62666/api/desktop-observer/protocol", {
            headers: { host: "127.0.0.1:62666" },
          }),
        ),
      (error: unknown) => error instanceof DesktopObserverAccessError,
    );
  });

  // --- Access: localhost Host rejected (R15 IPv4 only) ---
  withTestRemoteAddress("127.0.0.1", () => {
    assert.throws(
      () =>
        assertDesktopObserverLoopback(
          req("http://localhost:62666/api/desktop-observer/protocol", {
            headers: { host: "localhost:62666" },
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopObserverAccessError &&
        error.message.includes("127.0.0.1"),
    );
  });

  // --- Access: forwarded non-loopback rejected ---
  withTestRemoteAddress("127.0.0.1", () => {
    assert.throws(
      () =>
        assertDesktopObserverLoopback(
          req("http://127.0.0.1:62666/api/desktop-observer/protocol", {
            headers: {
              host: "127.0.0.1:62666",
              "x-forwarded-for": "203.0.113.9",
            },
          }),
        ),
      (error: unknown) => error instanceof DesktopObserverAccessError,
    );
  });

  // --- Access: happy path loopback ---
  withTestRemoteAddress("127.0.0.1", () => {
    const remote = assertDesktopObserverLoopback(
      req("http://127.0.0.1:62666/api/desktop-observer/protocol", {
        headers: { host: "127.0.0.1:62666" },
      }),
    );
    assert.ok(remote);
  });

  // --- Server mode loopback attach is allowed (access key checked separately) ---
  const prevMode = process.env.PI_WEB_SERVER_MODE;
  process.env.PI_WEB_SERVER_MODE = "1";
  try {
    withTestRemoteAddress("127.0.0.1", () => {
      const remote = assertDesktopObserverLocalAccess(
        req("http://127.0.0.1:62666/api/desktop-observer/session", {
          headers: { host: "127.0.0.1:62666" },
          method: "POST",
        }),
      );
      assert.ok(remote);
    });
  } finally {
    if (prevMode === undefined) delete process.env.PI_WEB_SERVER_MODE;
    else process.env.PI_WEB_SERVER_MODE = prevMode;
  }

  // --- Cross-origin session mint rejected ---
  withTestRemoteAddress("127.0.0.1", () => {
    assert.throws(
      () =>
        assertDesktopObserverSessionOrigin(
          req("http://127.0.0.1:62666/api/desktop-observer/session", {
            headers: {
              host: "127.0.0.1:62666",
              origin: "http://evil.example",
            },
            method: "POST",
          }),
        ),
      (error: unknown) => error instanceof DesktopObserverAccessError,
    );
    // No Origin → allowed (Electron main)
    assert.doesNotThrow(() =>
      assertDesktopObserverSessionOrigin(
        req("http://127.0.0.1:62666/api/desktop-observer/session", {
          headers: { host: "127.0.0.1:62666" },
          method: "POST",
        }),
      ),
    );
    // Loopback origin + matching port OK
    assert.doesNotThrow(() =>
      assertDesktopObserverSessionOrigin(
        req("http://127.0.0.1:62666/api/desktop-observer/session", {
          headers: {
            host: "127.0.0.1:62666",
            origin: "http://127.0.0.1:62666",
          },
          method: "POST",
        }),
      ),
    );
  });

  // --- Token mint + auth ---
  withTestRemoteAddress("127.0.0.1", () => {
    resetDesktopObserverTokensForTests();
    const issued = issueDesktopObserverToken({ remote: "127.0.0.1", ttlMs: 60_000 });
    assert.ok(issued.token.includes("."));

    assert.throws(
      () =>
        assertDesktopObserverToken(
          req("http://127.0.0.1:62666/api/desktop-observer/snapshot", {
            headers: { host: "127.0.0.1:62666" },
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopObserverAccessError && error.status === 401,
    );

    const ok = assertDesktopObserverToken(
      req("http://127.0.0.1:62666/api/desktop-observer/snapshot", {
        headers: {
          host: "127.0.0.1:62666",
          [DESKTOP_OBSERVER_TOKEN_HEADER]: issued.token,
        },
      }),
    );
    assert.equal(ok.instanceId, issued.instanceId);

    assert.throws(
      () =>
        assertDesktopObserverToken(
          req("http://127.0.0.1:62666/api/desktop-observer/snapshot", {
            headers: {
              host: "127.0.0.1:62666",
              [DESKTOP_OBSERVER_TOKEN_HEADER]: `${issued.token}x`,
            },
          }),
        ),
      (error: unknown) => error instanceof DesktopObserverAccessError,
    );

    // Control-token header must never authenticate an observer route.
    assert.throws(
      () =>
        assertDesktopObserverToken(
          req("http://127.0.0.1:62666/api/desktop-observer/snapshot", {
            headers: {
              host: "127.0.0.1:62666",
              "x-spi-desktop-control-token": issued.token,
            },
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopObserverAccessError && error.status === 401,
    );
  });

  // --- Remote attach: local mode still rejects non-loopback ---
  {
    const prevMode = process.env.PI_WEB_SERVER_MODE;
    process.env.PI_WEB_SERVER_MODE = "0";
    try {
      withTestRemoteAddress("203.0.113.10", () => {
        assert.throws(
          () =>
            assertDesktopObserverNetworkAccess(
              req("https://203.0.113.10:8443/api/desktop-observer/protocol", {
                headers: { host: "203.0.113.10:8443" },
              }),
            ),
          (error: unknown) => error instanceof DesktopObserverAccessError,
        );
      });
    } finally {
      if (prevMode === undefined) delete process.env.PI_WEB_SERVER_MODE;
      else process.env.PI_WEB_SERVER_MODE = prevMode;
    }
  }

  const prevServer = process.env.PI_WEB_SERVER_MODE;
  const prevInsecure = process.env.PI_WEB_ALLOW_INSECURE_HTTP;
  process.env.PI_WEB_SERVER_MODE = "1";
  delete process.env.PI_WEB_ALLOW_INSECURE_HTTP;
  try {
    withTestRemoteAddress("203.0.113.10", () => {
      const identity = assertDesktopObserverNetworkAccess(
        req("https://203.0.113.10:8443/api/desktop-observer/protocol", {
          headers: { host: "203.0.113.10:8443" },
        }),
      );
      assert.equal(identity.kind, "remote_direct");
      assert.equal(identity.bindKey, "direct:203.0.113.10");

      assert.throws(
        () =>
          assertDesktopObserverNetworkAccess(
            req("http://203.0.113.10:62666/api/desktop-observer/protocol", {
              headers: { host: "203.0.113.10:62666" },
            }),
          ),
        (error: unknown) =>
          error instanceof DesktopObserverAccessError && error.code === "insecure_http",
      );

      resetDesktopObserverTokensForTests();
      const minted = issueDesktopObserverToken({
        remote: identity.remote,
        identity,
        ttlMs: 60_000,
      });
      const ok = assertDesktopObserverToken(
        req("https://203.0.113.10:8443/api/desktop-observer/snapshot", {
          headers: {
            host: "203.0.113.10:8443",
            [DESKTOP_OBSERVER_TOKEN_HEADER]: minted.token,
          },
        }),
      );
      assert.equal(ok.instanceId, minted.instanceId);

      withTestRemoteAddress("198.51.100.20", () => {
        assert.throws(
          () =>
            assertDesktopObserverToken(
              req("https://203.0.113.10:8443/api/desktop-observer/snapshot", {
                headers: {
                  host: "203.0.113.10:8443",
                  [DESKTOP_OBSERVER_TOKEN_HEADER]: minted.token,
                  "x-forwarded-for": "203.0.113.10",
                },
              }),
            ),
          (error: unknown) => error instanceof DesktopObserverAccessError,
        );
      });
    });
  } finally {
    if (prevServer === undefined) delete process.env.PI_WEB_SERVER_MODE;
    else process.env.PI_WEB_SERVER_MODE = prevServer;
    if (prevInsecure === undefined) delete process.env.PI_WEB_ALLOW_INSECURE_HTTP;
    else process.env.PI_WEB_ALLOW_INSECURE_HTTP = prevInsecure;
  }

  // --- Hub: snapshot budgets, privacy, revision stability (inject empty collectors; no pi SDK) ---
  const emptyCollectors: TaskObserverCollectors = {
    listAgentActivities: () => [],
    listAgentCwds: () => [],
    listSnflowProjections: () => [],
    filterAgentForSnflow: (agents) => agents,
    listAutomationActivities: () => [],
    listQuickCommandActivities: () => [],
  };
  const hub = new TaskObserverHub({ collectors: emptyCollectors });
  const first = hub.getSnapshot({ reset: true });
  parseAndAssertPublicSnapshot(first.json);
  assert.equal(first.snapshot.protocolVersion, TASK_OBSERVER_PROTOCOL_VERSION);
  assert.equal(first.snapshot.reset, true);
  assert.ok(first.snapshot.revision >= 1);

  const second = hub.getSnapshot({ reset: false });
  // Time-only / unchanged content must not bump revision when fingerprint matches.
  assert.equal(second.snapshot.revision, first.snapshot.revision);

  // Observer subscribe is independent of chat SSE ownership (hub never touches rpc listeners).
  let emissions = 0;
  const unsub = hub.subscribe(() => {
    emissions += 1;
  });
  assert.equal(hub.getListenerCount(), 1);
  unsub();
  assert.equal(hub.getListenerCount(), 0);
  assert.equal(emissions, 0);

  // Invalidate coalesce + urgent flush
  const hub2 = new TaskObserverHub({ collectors: emptyCollectors });
  let coalesceHits = 0;
  const unsub2 = hub2.subscribe(() => {
    coalesceHits += 1;
  });
  hub2.invalidate();
  hub2.invalidate();
  assert.equal(coalesceHits, 0, "progress invalidates are coalesced");
  hub2.invalidate({ urgent: true });
  assert.equal(coalesceHits >= 1, true, "urgent invalidate flushes immediately");
  unsub2();

  // Global hub wires invalidate bus without becoming chat SSE
  resetTaskObserverHubForTests();
  const globalHub = getTaskObserverHub();
  assert.equal(globalHub.getListenerCount(), 0);
  notifyTaskObserverSourceChange();
  assert.equal(TASK_OBSERVER_PROGRESS_COALESCE_MS, 500);

  // Urgent option must reach the hub (Agent prompt/settle path).
  let urgentHits = 0;
  const unsubUrgent = globalHub.subscribe(() => {
    urgentHits += 1;
  });
  notifyTaskObserverSourceChange({ urgent: true });
  assert.equal(urgentHits >= 1, true, "urgent source notify flushes hub");
  unsubUrgent();

  // Regression: ordinary Agent wrappers must push observer invalidates.
  // Without this wire, the pet stays at 活动 0 for chat prompts forever.
  const fsPromises = await import("node:fs/promises");
  const rpcSource = await fsPromises.readFile(
    new URL("../lib/rpc-manager.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    rpcSource,
    /notifyTaskObserverSourceChange/,
    "rpc-manager must notify desktop-observer hub on Agent activity",
  );
  assert.match(
    rpcSource,
    /beginUserPrompt\(command\.message\)[\s\S]{0,200}notifyTaskObserverChanged/,
    "prompt dispatch must invalidate the observer hub",
  );

  // Production Next bundles rpc-manager as an async module because it imports
  // the Pi SDK. Synchronously requiring it from the observer hub makes Agent
  // collection fail even though health still sees live wrappers.
  const hubSource = await fsPromises.readFile(
    new URL("../lib/task-observer-hub.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    hubSource,
    /require\(["']\.\/rpc-manager["']\)/,
    "observer hub must not synchronously require async rpc-manager",
  );
  assert.match(
    hubSource,
    /task-observer-agent-registry/,
    "observer hub must collect Agent rows through the SDK-free registry adapter",
  );

  // --- Health remains task-metadata-free ---
  const health = await buildProcessHealthSnapshot();
  const healthJson = JSON.stringify(health);
  assert.equal(healthJson.includes("taskKey"), false);
  assert.equal(healthJson.includes("firstMessage"), false);
  assert.equal(healthJson.includes("desktop-observer"), false);
  assert.equal(healthJson.includes("activityId"), false);
  assert.ok("instanceId" in health);
  assert.ok("pid" in health);

  console.log("smoke-desktop-observer-api: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
