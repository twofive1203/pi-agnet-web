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
  protocolHasQuickSessionCapability,
  unwrapObserverSseData,
} from "../desktop/main/observer-client";
import {
  clearDesktopAccessKey,
  createMemoryAccessKeyCodec,
  loadDesktopAccessKey,
  normalizeAccessKeyInput,
  saveDesktopAccessKey,
} from "../desktop/main/access-key-store";
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
  // Legacy server payload (compatible:false) stays incompatible.
  const legacyServerProto = interpretProtocolPayload(
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
  assert.equal(legacyServerProto.type, "incompatible");
  if (legacyServerProto.type === "incompatible") {
    assert.equal(legacyServerProto.reasonCode, "server_mode");
  }

  // Current server payload is compatible but requires access key.
  const serverProto = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "server",
      compatible: true,
      authRequired: true,
      reasonCode: null,
      instanceId: "i1",
    },
    200,
  );
  assert.equal(serverProto.type, "protocol_ok");
  if (serverProto.type === "protocol_ok") {
    assert.equal(serverProto.authRequired, true);
    assert.equal(serverProto.quickSessionAvailable, false);
  }

  const authHttp = interpretProtocolPayload({}, 401);
  assert.equal(authHttp.type, "incompatible");
  if (authHttp.type === "incompatible") {
    assert.equal(authHttp.reasonCode, "auth_required");
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
  if (okProto.type === "protocol_ok") {
    assert.equal(okProto.quickSessionAvailable, false);
  }

  const capableProto = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "local",
      compatible: true,
      instanceId: "i1",
      capabilities: ["quick_session"],
    },
    200,
  );
  assert.equal(capableProto.type, "protocol_ok");
  if (capableProto.type === "protocol_ok") {
    assert.equal(capableProto.quickSessionAvailable, true);
  }
  const liveCapable = reduceConnectionState(
    createInitialConnectionState({ now: 20 }),
    { type: "connected", instanceId: "i1", quickSessionAvailable: true },
    21,
  );
  assert.equal(liveCapable.quickSessionAvailable, true);
  assert.equal(protocolHasQuickSessionCapability(undefined), false);
  assert.equal(protocolHasQuickSessionCapability(["other"]), false);

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
    enableSse: false,
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
    enableSse: false,
    fetch: mockFetch([{ match: /\/api\/health$/, connectionRefused: true }]),
  });
  refusedClient.start();
  // allow microtask probe
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(refusedClient.getState().status, "service-not-running");
  assert.equal(refusedClient.getState().startCommand, "spi --no-open");
  assert.equal(refusedClient.getTokenForTests(), null);
  refusedClient.quit();

  // Legacy server mode (compatible:false) → incompatible
  const legacyServerClient = new DesktopObserverClient({
    port: 62666,
    enableSse: false,
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
  legacyServerClient.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(legacyServerClient.getState().status, "incompatible");
  assert.equal(legacyServerClient.getState().reasonCode, "server_mode");
  legacyServerClient.quit();

  // Server mode without access key → auth_required
  const authRequiredClient = new DesktopObserverClient({
    port: 62666,
    enableSse: false,
    fetch: mockFetch([
      { match: /\/api\/health$/, body: { ok: true, instanceId: "i" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "server",
          compatible: true,
          authRequired: true,
          instanceId: "i",
        },
      },
    ]),
  });
  authRequiredClient.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(authRequiredClient.getState().status, "incompatible");
  assert.equal(authRequiredClient.getState().reasonCode, "auth_required");
  authRequiredClient.quit();

  // Server mode with access key → connected
  const bodies: string[] = [];
  const authOkClient = new DesktopObserverClient({
    port: 62666,
    enableSse: false,
    accessKey: "test-access-key",
    fetch: async (url, init) => {
      if (typeof init?.body === "string") bodies.push(init.body);
      if (/\/api\/health$/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, instanceId: "i-auth" }),
          text: async () => "",
        };
      }
      if (/\/protocol$/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            product: DESKTOP_OBSERVER_PRODUCT,
            protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
            mode: "server",
            compatible: true,
            authRequired: true,
            instanceId: "i-auth",
          }),
          text: async () => "",
        };
      }
      if (/\/session$/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token: "tok-auth",
            expiresAt: 999999,
            instanceId: "i-auth",
          }),
          text: async () => "",
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const authProbe = await authOkClient.probe();
  assert.equal(authProbe.ok, true);
  assert.ok(bodies.some((body) => body.includes("test-access-key")));
  authOkClient.quit();

  // Invalid access key → auth_invalid
  const badKeyClient = new DesktopObserverClient({
    port: 62666,
    enableSse: false,
    accessKey: "wrong",
    fetch: mockFetch([
      { match: /\/api\/health$/, body: { ok: true, instanceId: "i" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "server",
          compatible: true,
          authRequired: true,
          instanceId: "i",
        },
      },
      {
        match: /\/session$/,
        status: 401,
        body: { error: "Invalid access key", code: "auth_invalid" },
      },
    ]),
  });
  badKeyClient.start();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(badKeyClient.getState().status, "incompatible");
  assert.equal(badKeyClient.getState().reasonCode, "auth_invalid");
  badKeyClient.quit();

  // Connected client + instance change resets notification baseline
  const live = new DesktopObserverClient({
    port: 62666,
    enableSse: false,
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

  // --- SSE envelope unwrap (server events route shape) ---
  const envReset = unwrapObserverSseData(
    JSON.stringify({
      type: "reset",
      snapshot: { instanceId: "i1", revision: 1, reset: true, projects: [] },
    }),
  );
  assert.equal(envReset.kind, "snapshot");
  assert.equal(envReset.reset, true);
  assert.ok(envReset.snapshotJson?.includes("\"instanceId\":\"i1\""));

  const envErr = unwrapObserverSseData(JSON.stringify({ type: "error", code: "token_expired" }));
  assert.equal(envErr.kind, "error");
  assert.equal(envErr.code, "token_expired");

  const legacy = unwrapObserverSseData(JSON.stringify({ instanceId: "x", revision: 3 }));
  assert.equal(legacy.kind, "snapshot");

  // SSE transport injects one reset envelope then ends → snapshot callback fires
  const snapshots: string[] = [];
  async function* oneChunk() {
    yield `data: ${
      JSON.stringify({
        type: "reset",
        snapshot: { instanceId: "sse-1", revision: 1, reset: true, projects: [] },
      })
    }\n\n`;
    // Keep the stream open until the client aborts (matches long-lived SSE).
    await new Promise<void>(() => undefined);
  }
  const sseClient = new DesktopObserverClient({
    port: 62666,
    enableSse: true,
    reconnectDelayMs: 60_000,
    fetch: mockFetch([
      { match: /\/api\/health$/, body: { ok: true, instanceId: "sse-1" } },
      {
        match: /\/protocol$/,
        body: {
          product: DESKTOP_OBSERVER_PRODUCT,
          protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
          mode: "local",
          compatible: true,
          instanceId: "sse-1",
        },
      },
      {
        match: /\/session$/,
        body: { token: "sse-token", expiresAt: Date.now() + 60_000, instanceId: "sse-1" },
      },
    ]),
    sseTransport: async () => ({
      ok: true as const,
      status: 200,
      chunks: oneChunk(),
    }),
    onSnapshot: (json) => {
      snapshots.push(json);
    },
  });
  sseClient.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sseClient.getState().status, "connected");
  assert.equal(sseClient.getTokenForTests(), "sse-token");
  assert.ok(snapshots.length >= 1);
  assert.ok(snapshots[0].includes("sse-1"));
  sseClient.quit();

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
  assert.equal(defaults.petScale, "medium");
  assert.equal(defaults.bubbleTheme, "cream");
  assert.equal(defaults.showContextMeter, true);
  assert.equal(defaults.rightClickAggregatedMenu, false);
  assertDesktopSettingsSafe(defaults);

  const dirty = normalizeDesktopSettings({
    port: 99999,
    selectedPetId: "../evil",
    petScale: "xl",
    token: "leak",
    notification: { completion: "nope" },
    acknowledgedTransitionIds: ["a", "a", "b"],
  });
  assert.equal(dirty.port, DESKTOP_DEFAULT_PORT);
  assert.equal(dirty.selectedPetId, "snail-default");
  assert.equal(dirty.petScale, "medium");
  assert.equal(normalizeDesktopSettings({ bubbleTheme: "night" }).bubbleTheme, "night");
  assert.equal(normalizeDesktopSettings({ bubbleTheme: "ember" }).bubbleTheme, "ember");
  assert.equal(normalizeDesktopSettings({ bubbleTheme: 1 }).bubbleTheme, "cream");
  assert.equal(dirty.showContextMeter, true);
  assert.equal(dirty.rightClickAggregatedMenu, false);
  assert.equal(dirty.notification.completion, "background-only");
  assert.deepEqual(dirty.acknowledgedTransitionIds, ["a", "b"]);
  // Forbidden keys stripped by normalization (not present on public shape)
  assert.equal("token" in dirty, false);

  const updated = updateDesktopSettings(defaults, {
    port: 62667,
    alwaysOnTop: false,
    showContextMeter: false,
    rightClickAggregatedMenu: true,
  });
  assert.equal(updated.port, 62667);
  assert.equal(updated.alwaysOnTop, false);
  assert.equal(updated.showContextMeter, false);
  assert.equal(updated.rightClickAggregatedMenu, true);

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
  assert.ok(DESKTOP_SETTINGS_FORBIDDEN_KEYS.includes("accessKey"));
  assert.equal(normalizeAccessKeyInput("  abc  "), "abc");
  assert.equal(normalizeAccessKeyInput(""), null);

  // Memory codec refuses disk persistence (no encryption available).
  const memFs: Record<string, string> = {};
  const memStore = {
    readFile: (p: string) => {
      if (!(p in memFs)) throw new Error("missing");
      return memFs[p]!;
    },
    writeFile: (p: string, data: string) => {
      memFs[p] = data;
    },
    mkdirp: () => undefined,
    exists: (p: string) => p in memFs,
    unlink: (p: string) => {
      delete memFs[p];
    },
  };
  const memCodec = createMemoryAccessKeyCodec();
  assert.equal(memCodec.isAvailable(), false);
  const memSave = saveDesktopAccessKey("/tmp/pet-test", "secret-key", memStore, memCodec);
  assert.equal(memSave.persisted, false);
  assert.equal(loadDesktopAccessKey("/tmp/pet-test", memStore, memCodec), null);

  // Encrypting codec round-trips on disk without plaintext.
  const encCodec = {
    isAvailable: () => true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`, "utf8").toString("base64"),
    decrypt: (blob: string) => {
      const raw = Buffer.from(blob, "base64").toString("utf8");
      assert.ok(raw.startsWith("enc:"));
      return raw.slice(4);
    },
  };
  const encSave = saveDesktopAccessKey("/tmp/pet-test", "secret-key", memStore, encCodec);
  assert.equal(encSave.persisted, true);
  const stored = Object.values(memFs)[0] ?? "";
  assert.equal(stored.includes("secret-key"), false);
  assert.equal(loadDesktopAccessKey("/tmp/pet-test", memStore, encCodec), "secret-key");
  clearDesktopAccessKey("/tmp/pet-test", memStore);
  assert.equal(loadDesktopAccessKey("/tmp/pet-test", memStore, encCodec), null);

  const observerClientSrc = readFileSync(
    path.join(process.cwd(), "desktop", "main", "observer-client.ts"),
    "utf8",
  );
  const quickClientSrc = readFileSync(
    path.join(process.cwd(), "desktop", "main", "quick-session-client.ts"),
    "utf8",
  );
  assert.ok(observerClientSrc.includes("quickSessionAvailable"));
  assert.ok(quickClientSrc.includes("DESKTOP_CONTROL_TOKEN_HEADER"));
  assert.equal(/child_process|spawn\(/.test(quickClientSrc), false);

  console.log("smoke-desktop-connection: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
