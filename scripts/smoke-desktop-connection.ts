/**
 * Smoke checks for desktop pet connection state machine + attach client (U6).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-connection.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  acknowledgeConnectionBaseline,
  buildDesktopOrigin,
  canCopyStartCommand,
  createInitialConnectionState,
  DESKTOP_DEFAULT_PORT,
  DESKTOP_START_COMMAND,
  isServiceNotRunning,
  reduceConnectionState,
} from "../desktop/main/connection-state";
import {
  classifyFetchFailure,
  connectionReasonLabel,
  DesktopObserverClient,
  interpretHealthPayload,
  interpretProtocolPayload,
  interpretSessionPayload,
  parseSseBlock,
} from "../desktop/main/observer-client";
import {
  assertDesktopSettingsSafe,
  createDefaultDesktopSettings,
  DESKTOP_SETTINGS_FORBIDDEN_KEYS,
  normalizeDesktopSettings,
  parseDesktopSettingsJson,
  pushTransitionLru,
  serializeDesktopSettings,
  updateDesktopSettings,
} from "../desktop/main/settings-store";
import { DESKTOP_OBSERVER_PRODUCT } from "../lib/desktop-observer-access";
import { TASK_OBSERVER_PROTOCOL_VERSION } from "../lib/task-observer-types";

function mockFetch(sequence: Array<{
  match: RegExp;
  status?: number;
  body?: unknown;
  connectionRefused?: boolean;
  throwMessage?: string;
}>) {
  const remaining = [...sequence];
  return async (url: string) => {
    const next = remaining.find((item) => item.match.test(url));
    if (!next) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const idx = remaining.indexOf(next);
    remaining.splice(idx, 1);
    if (next.throwMessage) throw new Error(next.throwMessage);
    if (next.connectionRefused) {
      return {
        ok: false,
        status: 0,
        connectionRefused: true,
        json: async () => ({}),
        text: async () => "",
      };
    }
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
}

async function main() {
  console.log("smoke-desktop-connection: start");

  // --- Pure state machine ---
  let state = createInitialConnectionState({ port: 62666, now: 1 });
  assert.equal(state.status, "probing");
  assert.equal(state.origin, "http://127.0.0.1:62666");
  assert.equal(state.startCommand, DESKTOP_START_COMMAND);
  assert.equal(buildDesktopOrigin(DESKTOP_DEFAULT_PORT), "http://127.0.0.1:62666");

  state = reduceConnectionState(state, { type: "connection_refused" }, 2);
  assert.equal(state.status, "service-not-running");
  assert.equal(state.reasonCode, "connection_refused");
  assert.equal(isServiceNotRunning(state), true);
  assert.equal(canCopyStartCommand(state), true);
  assert.equal(state.startCommand, "spi --no-open");

  state = reduceConnectionState(state, { type: "retry" }, 3);
  assert.equal(state.status, "probing");
  assert.equal(state.attempt, 1);

  state = reduceConnectionState(
    state,
    { type: "connected", instanceId: "inst-a", resetBaseline: true },
    4,
  );
  assert.equal(state.status, "connected");
  assert.equal(state.instanceId, "inst-a");
  assert.equal(state.resetNotificationBaseline, true);
  state = acknowledgeConnectionBaseline(state, 5);
  assert.equal(state.resetNotificationBaseline, false);

  state = reduceConnectionState(state, { type: "stream_lost", detail: "sse drop" }, 6);
  assert.equal(state.status, "reconnecting");
  assert.equal(state.reasonCode, "stream_error");

  state = reduceConnectionState(
    state,
    { type: "incompatible", reasonCode: "server_mode" },
    7,
  );
  assert.equal(state.status, "incompatible");
  assert.equal(state.reasonCode, "server_mode");
  assert.equal(connectionReasonLabel("server_mode"), "Server mode unsupported");

  state = reduceConnectionState(state, { type: "quit" }, 8);
  assert.equal(state.status, "service-not-running");
  assert.equal(state.detail, "desktop_quit");

  // Instance change forces baseline reset
  state = createInitialConnectionState({ now: 10 });
  state = reduceConnectionState(state, { type: "connected", instanceId: "a" }, 11);
  state = acknowledgeConnectionBaseline(state, 12);
  state = reduceConnectionState(state, { type: "connected", instanceId: "b" }, 13);
  assert.equal(state.instanceId, "b");
  assert.equal(state.resetNotificationBaseline, true);

  // --- Protocol interpreters ---
  assert.equal(
    interpretHealthPayload({ ok: true, instanceId: "i1" }, 200),
    null,
  );
  assert.equal(
    interpretHealthPayload({ ok: true }, 200)?.type,
    "incompatible",
  );
  const serverProto = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "server",
      compatible: false,
      reasonCode: "server_mode",
      instanceId: "i1",
    },
    200,
  );
  assert.equal(serverProto.type, "incompatible");
  if (serverProto.type === "incompatible") {
    assert.equal(serverProto.reasonCode, "server_mode");
  }

  const mismatch = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: 999,
      mode: "local",
      compatible: true,
      instanceId: "i1",
    },
    200,
  );
  assert.equal(mismatch.type, "incompatible");
  if (mismatch.type === "incompatible") {
    assert.equal(mismatch.reasonCode, "protocol_mismatch");
  }

  const okProto = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "local",
      compatible: true,
      instanceId: "i1",
    },
    200,
  );
  assert.equal(okProto.type, "protocol_ok");

  const session = interpretSessionPayload(
    { token: "tok", expiresAt: 123, instanceId: "i1" },
    200,
  );
  assert.equal("ok" in session && session.ok, true);

  const refused = classifyFetchFailure(new Error("connect ECONNREFUSED 127.0.0.1:62666"));
  assert.equal(refused.type, "connection_refused");

  const sse = parseSseBlock("event: reset\ndata: {\"revision\":1}\n");
  assert.deepEqual(sse, { event: "reset", data: "{\"revision\":1}" });

  // --- Client probe happy path ---
  const states: string[] = [];
  const client = new DesktopObserverClient({
    port: 62666,
    now: () => 1000,
    onStateChange: (s) => states.push(s.status),
    fetch: mockFetch([
      {
        match: /\/api\/health$/,
        body: { ok: true, instanceId: "inst-1", status: "ready" },
      },
      {
        match: /\/api\/desktop-observer\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "local",
          compatible: true,
          reasonCode: null,
          instanceId: "inst-1",
        },
      },
      {
        match: /\/api\/desktop-observer\/session$/,
        body: {
          token: "secret-token",
          expiresAt: 999999,
          instanceId: "inst-1",
          tokenHeader: "x-spi-desktop-observer-token",
        },
      },
    ]),
  });
  const probeOk = await client.probe();
  assert.equal(probeOk.ok, true);
  if (probeOk.ok) {
    assert.equal(probeOk.instanceId, "inst-1");
    assert.equal(probeOk.token, "secret-token");
  }

  // Connection refused → service-not-running
  const refusedClient = new DesktopObserverClient({
    port: 62666,
    fetch: mockFetch([{ match: /\/api\/health$/, connectionRefused: true }]),
  });
  refusedClient.start();
  // allow microtask probe
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(refusedClient.getState().status, "service-not-running");
  assert.equal(refusedClient.getState().startCommand, "spi --no-open");
  assert.equal(refusedClient.getTokenForTests(), null);

  // Server mode → incompatible
  const serverClient = new DesktopObserverClient({
    port: 62666,
    fetch: mockFetch([
      { match: /\/api\/health$/, body: { ok: true, instanceId: "i" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "server",
          compatible: false,
          reasonCode: "server_mode",
          instanceId: "i",
        },
      },
    ]),
  });
  serverClient.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(serverClient.getState().status, "incompatible");
  assert.equal(serverClient.getState().reasonCode, "server_mode");

  // Connected client + instance change resets notification baseline
  const live = new DesktopObserverClient({
    port: 62666,
    fetch: mockFetch([
      { match: /\/api\/health$/, body: { ok: true, instanceId: "old" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "local",
          compatible: true,
          instanceId: "old",
        },
      },
      {
        match: /\/session$/,
        body: { token: "t-old", expiresAt: 9, instanceId: "old" },
      },
      // Re-probe after instance change (may or may not run synchronously)
      { match: /\/api\/health$/, body: { ok: true, instanceId: "new" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "local",
          compatible: true,
          instanceId: "new",
        },
      },
      {
        match: /\/session$/,
        body: { token: "t-new", expiresAt: 9, instanceId: "new" },
      },
    ]),
  });
  live.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(live.getState().status, "connected");
  assert.equal(live.getState().instanceId, "old");
  live.consumeNotificationBaseline();
  assert.equal(live.getState().resetNotificationBaseline, false);
  live.handleSseMessage({
    event: "snapshot",
    data: JSON.stringify({ instanceId: "new", reset: false, revision: 2 }),
  });
  // instance change triggers reconnect / baseline path
  assert.equal(live.getState().reasonCode === "instance_changed" || live.getState().resetNotificationBaseline, true);

  // Quit stops only local client state — static contract on source files below
  live.quit();
  assert.equal(live.getState().status, "service-not-running");
  assert.equal(live.getTokenForTests(), null);

  const desktopDir = path.join(process.cwd(), "desktop", "main");
  for (const file of ["connection-state.ts", "observer-client.ts", "settings-store.ts"]) {
    const source = readFileSync(path.join(desktopDir, file), "utf8");
    // Forbid real process-control usage (comments may mention the words).
    assert.equal(
      /from\s+["']child_process["']|require\(\s*["']child_process["']\s*\)/.test(source),
      false,
      `${file} must not import child_process`,
    );
    assert.equal(/\b(?:spawn|fork|exec|execFile)\s*\(/.test(source), false, `${file} must not spawn/exec`);
    assert.equal(/\bprocess\.kill\b/.test(source), false, `${file} must not process.kill`);
    assert.equal(/\bservicePid\b\s*[:=]/.test(source), false, `${file} must not track servicePid`);
  }
  assert.deepEqual(DesktopObserverClient.forbiddenApis().includes("child_process"), true);

  // --- Settings store ---
  const defaults = createDefaultDesktopSettings();
  assert.equal(defaults.port, 62666);
  assert.equal(defaults.version, 1);
  assertDesktopSettingsSafe(defaults);

  const dirty = normalizeDesktopSettings({
    port: 99999,
    selectedPetId: "../evil",
    token: "leak",
    notification: { completion: "nope" },
    acknowledgedTransitionIds: ["a", "a", "b"],
  });
  assert.equal(dirty.port, DESKTOP_DEFAULT_PORT);
  assert.equal(dirty.selectedPetId, "snail-default");
  assert.equal(dirty.notification.completion, "background-only");
  assert.deepEqual(dirty.acknowledgedTransitionIds, ["a", "b"]);
  // Forbidden keys stripped by normalization (not present on public shape)
  assert.equal("token" in dirty, false);

  const updated = updateDesktopSettings(defaults, { port: 62667, alwaysOnTop: false });
  assert.equal(updated.port, 62667);
  assert.equal(updated.alwaysOnTop, false);

  const roundTrip = parseDesktopSettingsJson(serializeDesktopSettings(updated));
  assert.equal(roundTrip.port, 62667);

  let lru = pushTransitionLru([], "t1");
  lru = pushTransitionLru(lru, "t2");
  lru = pushTransitionLru(lru, "t1");
  assert.deepEqual(lru, ["t2", "t1"]);

  for (const key of DESKTOP_SETTINGS_FORBIDDEN_KEYS) {
    if (key === "startCommand") continue;
    assert.throws(() => assertDesktopSettingsSafe({ [key]: "x" }));
  }

  console.log("smoke-desktop-connection: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
