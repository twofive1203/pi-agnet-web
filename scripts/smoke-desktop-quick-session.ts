/**
 * Smoke checks for desktop pet quick-session access, catalog, and launch (U1+).
 * Run: npx --yes tsx@4.23.1 scripts/smoke-desktop-quick-session.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runWithAutomationConnectionContext,
  withTestRemoteAddress,
} from "../lib/automation-connection-context";
import {
  assertDesktopControlAccessKey,
  assertDesktopControlLocalAccess,
  assertDesktopControlLoopback,
  assertDesktopControlSessionOrigin,
  assertDesktopControlToken,
  DESKTOP_CONTROL_SCOPE_QUICK_SESSION,
  DESKTOP_CONTROL_TOKEN_HEADER,
  DesktopControlAccessError,
  issueDesktopControlToken,
  resetDesktopControlTokensForTests,
} from "../lib/desktop-control-access";
import {
  DESKTOP_CONTROL_API_PREFIX,
  DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION,
  DESKTOP_PROTOCOL_CAPABILITY_REMOTE_ATTACH,
} from "../lib/desktop-control-constants";
import {
  assertDesktopObserverAccessKey,
  assertDesktopObserverToken,
  buildDesktopObserverProtocolPayload,
  DESKTOP_OBSERVER_TOKEN_HEADER,
  DesktopObserverAccessError,
  issueDesktopObserverToken,
  protocolHasQuickSessionCapability,
  resetDesktopObserverTokensForTests,
} from "../lib/desktop-observer-access";
import { isDesktopControlPath, isDesktopObserverPath, isPublicPath } from "../lib/server-access-policy";
import {
  __resetServerAccessRateLimitForTests,
  ensureServerAccessInitialized,
} from "../lib/server-access-auth";
import {
  interpretProtocolPayload,
  protocolHasQuickSessionCapability as clientProtocolHasQuickSession,
} from "../desktop/main/observer-client";
import { DESKTOP_OBSERVER_PRODUCT } from "../lib/desktop-observer-constants";
import { TASK_OBSERVER_PROTOCOL_VERSION } from "../lib/task-observer-types";
import {
  createInitialConnectionState,
  reduceConnectionState,
} from "../desktop/main/connection-state";
import {
  assertDesktopProjectCatalogSafe,
  buildDesktopProjectCatalog,
  resolveDesktopProjectRef,
} from "../lib/desktop-project-catalog";
import {
  createDesktopQuickSession,
  newDesktopQuickSessionRequestIdForTests,
  parseDesktopQuickSessionCreateBody,
  resetDesktopQuickSessionIdempotencyForTests,
} from "../lib/desktop-quick-session";
import {
  assertDesktopQuickSessionModelCatalogSafe,
  buildDesktopQuickSessionModelCatalog,
  projectDesktopQuickSessionModels,
  resolveDesktopQuickSessionModel,
} from "../lib/desktop-quick-session-models";
import { startNewAgentSession } from "../lib/new-agent-session";
import { selectDefaultNewSessionModel } from "../lib/model-metadata";
import { buildProjectKeyFromCwd } from "../lib/task-observer-agent";
import {
  DesktopQuickSessionClient,
  sanitizeQuickSessionCreateInput,
} from "../desktop/main/quick-session-client";
import type { DesktopFetch } from "../desktop/main/observer-client";
import {
  canSubmitQuickSession,
  createInitialQuickSessionState,
  filterQuickSessionModels,
  filterQuickSessionProjects,
  formatQuickSessionModelLabel,
  formatQuickSessionProjectLabel,
  newQuickSessionRequestId,
  reduceQuickSessionState,
  selectedQuickSessionModel,
  selectedQuickSessionProject,
} from "../desktop/renderer/quick-session-state";

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function loopbackHeaders(extra?: HeadersInit): HeadersInit {
  return { host: "127.0.0.1:62666", ...extra };
}

async function withTempAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "spi-desktop-control-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function main() {
  console.log("smoke-desktop-quick-session: start");

  resetDesktopObserverTokensForTests();
  resetDesktopControlTokensForTests();
  __resetServerAccessRateLimitForTests();

  // --- Path policy: control is not anonymously public ---
  assert.equal(isPublicPath("/api/desktop-control/session"), false);
  assert.equal(isPublicPath("/api/desktop-control/projects"), false);
  assert.equal(isPublicPath("/api/desktop-control/models"), false);
  assert.equal(isPublicPath("/api/desktop-control/quick-sessions"), false);
  assert.equal(isDesktopControlPath("/api/desktop-control/session"), true);
  assert.equal(isDesktopControlPath("/api/desktop-control/models"), true);
  assert.equal(isDesktopControlPath(`${DESKTOP_CONTROL_API_PREFIX}/projects`), true);
  assert.equal(isDesktopControlPath("/api/desktop-observer/session"), false);
  assert.equal(isDesktopObserverPath("/api/desktop-control/session"), false);

  // --- Protocol capability is additive ---
  const localProtocol = buildDesktopObserverProtocolPayload({ PI_WEB_SERVER_MODE: "0" });
  assert.equal(localProtocol.protocolVersion, TASK_OBSERVER_PROTOCOL_VERSION);
  assert.equal(localProtocol.compatible, true);
  assert.deepEqual(localProtocol.capabilities, [
    DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION,
    DESKTOP_PROTOCOL_CAPABILITY_REMOTE_ATTACH,
  ]);
  assert.equal(protocolHasQuickSessionCapability(localProtocol), true);

  const serverProtocol = buildDesktopObserverProtocolPayload({ PI_WEB_SERVER_MODE: "1" });
  assert.equal(serverProtocol.mode, "server");
  assert.equal(serverProtocol.authRequired, true);
  assert.equal(protocolHasQuickSessionCapability(serverProtocol), true);

  assert.equal(protocolHasQuickSessionCapability({}), false);
  assert.equal(protocolHasQuickSessionCapability({ capabilities: ["other"] }), false);
  assert.equal(clientProtocolHasQuickSession(undefined), false);
  assert.equal(clientProtocolHasQuickSession(["quick_session"]), true);

  const oldServer = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "local",
      compatible: true,
      instanceId: "old-server",
    },
    200,
  );
  assert.equal(oldServer.type, "protocol_ok");
  if (oldServer.type === "protocol_ok") {
    assert.equal(oldServer.quickSessionAvailable, false);
  }

  const newServer = interpretProtocolPayload(
    {
      product: DESKTOP_OBSERVER_PRODUCT,
      protocolVersion: TASK_OBSERVER_PROTOCOL_VERSION,
      mode: "local",
      compatible: true,
      instanceId: "new-server",
      capabilities: ["quick_session"],
    },
    200,
  );
  assert.equal(newServer.type, "protocol_ok");
  if (newServer.type === "protocol_ok") {
    assert.equal(newServer.quickSessionAvailable, true);
  }

  let connection = createInitialConnectionState({ now: 1 });
  assert.equal(connection.quickSessionAvailable, false);
  connection = reduceConnectionState(
    connection,
    { type: "connected", instanceId: "i1", quickSessionAvailable: true },
    2,
  );
  assert.equal(connection.status, "connected");
  assert.equal(connection.quickSessionAvailable, true);
  connection = reduceConnectionState(connection, { type: "instance_changed", instanceId: "i2" }, 3);
  assert.equal(connection.quickSessionAvailable, false);

  // --- Control loopback / Host / Origin characterization ---
  assert.throws(
    () =>
      assertDesktopControlLoopback(
        req("http://127.0.0.1:62666/api/desktop-control/session", {
          headers: loopbackHeaders(),
        }),
      ),
    (error: unknown) => error instanceof DesktopControlAccessError,
  );

  withTestRemoteAddress("8.8.8.8", () => {
    assert.throws(
      () =>
        assertDesktopControlLoopback(
          req("http://127.0.0.1:62666/api/desktop-control/session", {
            headers: loopbackHeaders(),
          }),
        ),
      (error: unknown) => error instanceof DesktopControlAccessError,
    );
  });

  withTestRemoteAddress("127.0.0.1", () => {
    assert.throws(
      () =>
        assertDesktopControlLoopback(
          req("http://localhost:62666/api/desktop-control/session", {
            headers: { host: "localhost:62666" },
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.message.includes("127.0.0.1"),
    );

    assert.throws(
      () =>
        assertDesktopControlLoopback(
          req("http://127.0.0.1:62666/api/desktop-control/session", {
            headers: {
              host: "127.0.0.1:62666",
              "x-forwarded-for": "203.0.113.9",
            },
          }),
        ),
      (error: unknown) => error instanceof DesktopControlAccessError,
    );

    const remote = assertDesktopControlLocalAccess(
      req("http://127.0.0.1:62666/api/desktop-control/session", {
        headers: loopbackHeaders(),
        method: "POST",
      }),
    );
    assert.ok(remote);

    assert.throws(
      () =>
        assertDesktopControlSessionOrigin(
          req("http://127.0.0.1:62666/api/desktop-control/session", {
            headers: loopbackHeaders({ origin: "http://evil.example" }),
            method: "POST",
          }),
        ),
      (error: unknown) => error instanceof DesktopControlAccessError,
    );
    assert.doesNotThrow(() =>
      assertDesktopControlSessionOrigin(
        req("http://127.0.0.1:62666/api/desktop-control/session", {
          headers: loopbackHeaders(),
          method: "POST",
        }),
      ),
    );
    assert.throws(
      () =>
        assertDesktopControlSessionOrigin(
          req("http://127.0.0.1:62666/api/desktop-control/session", {
            headers: loopbackHeaders({ origin: "http://127.0.0.1:9" }),
            method: "POST",
          }),
        ),
      (error: unknown) => error instanceof DesktopControlAccessError,
    );
  });

  // --- Happy path: local-mode control token is scoped and usable ---
  withTestRemoteAddress("127.0.0.1", () => {
    resetDesktopControlTokensForTests();
    resetDesktopObserverTokensForTests();
    const issued = issueDesktopControlToken({ remote: "127.0.0.1", ttlMs: 60_000 });
    assert.ok(issued.token.includes("."));
    assert.deepEqual(issued.scopes, [DESKTOP_CONTROL_SCOPE_QUICK_SESSION]);
    assert.notEqual(issued.ttlMs, 15 * 60 * 1000);

    const ok = assertDesktopControlToken(
      req("http://127.0.0.1:62666/api/desktop-control/projects", {
        headers: loopbackHeaders({
          [DESKTOP_CONTROL_TOKEN_HEADER]: issued.token,
        }),
      }),
    );
    assert.equal(ok.instanceId, issued.instanceId);
    assert.deepEqual(ok.scopes, [DESKTOP_CONTROL_SCOPE_QUICK_SESSION]);

    const createOk = assertDesktopControlToken(
      req("http://127.0.0.1:62666/api/desktop-control/quick-sessions", {
        method: "POST",
        headers: loopbackHeaders({
          [DESKTOP_CONTROL_TOKEN_HEADER]: issued.token,
        }),
      }),
    );
    assert.equal(createOk.instanceId, issued.instanceId);

    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders(),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.status === 401,
    );

    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders({
              [DESKTOP_CONTROL_TOKEN_HEADER]: `${issued.token}x`,
            }),
          }),
        ),
      (error: unknown) => error instanceof DesktopControlAccessError,
    );
  });

  // --- Observer and control tokens never cross ---
  withTestRemoteAddress("127.0.0.1", () => {
    resetDesktopControlTokensForTests();
    resetDesktopObserverTokensForTests();
    const observer = issueDesktopObserverToken({ remote: "127.0.0.1", ttlMs: 60_000 });
    const control = issueDesktopControlToken({ remote: "127.0.0.1", ttlMs: 60_000 });

    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders({
              [DESKTOP_CONTROL_TOKEN_HEADER]: observer.token,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.status === 401,
    );
    assert.throws(
      () =>
        assertDesktopObserverToken(
          req("http://127.0.0.1:62666/api/desktop-observer/snapshot", {
            headers: loopbackHeaders({
              [DESKTOP_OBSERVER_TOKEN_HEADER]: control.token,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopObserverAccessError && error.status === 401,
    );
    // Wrong header namespace on the matching route is also unauthorized.
    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders({
              [DESKTOP_OBSERVER_TOKEN_HEADER]: control.token,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.code === "unauthorized",
    );
  });

  // --- Expiry + instance binding ---
  withTestRemoteAddress("127.0.0.1", () => {
    resetDesktopControlTokensForTests();
    const expired = issueDesktopControlToken({ remote: "127.0.0.1", ttlMs: 0 });
    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders({
              [DESKTOP_CONTROL_TOKEN_HEADER]: expired.token,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.status === 401,
    );

    const otherInstance = issueDesktopControlToken({
      remote: "127.0.0.1",
      ttlMs: 60_000,
      instanceId: "other-instance",
    });
    assert.throws(
      () =>
        assertDesktopControlToken(
          req("http://127.0.0.1:62666/api/desktop-control/projects", {
            headers: loopbackHeaders({
              [DESKTOP_CONTROL_TOKEN_HEADER]: otherInstance.token,
            }),
          }),
        ),
      (error: unknown) =>
        error instanceof DesktopControlAccessError && error.code === "instance_mismatch",
    );
  });

  // --- Server mode access key + shared login budget ---
  await withTempAgentDir(async () => {
    const boot = await ensureServerAccessInitialized();
    assert.ok(boot.accessKeyOnce);
    const previousMode = process.env.PI_WEB_SERVER_MODE;
    process.env.PI_WEB_SERVER_MODE = "1";
    __resetServerAccessRateLimitForTests();
    try {
      await runWithAutomationConnectionContext(
        {
          remoteAddress: "127.0.0.1",
          localAddress: "127.0.0.1",
          capturedAt: Date.now(),
        },
        async () => {
          const mintReq = req("http://127.0.0.1:62666/api/desktop-control/session", {
            method: "POST",
            headers: loopbackHeaders(),
          });
          await assert.rejects(
            () => assertDesktopControlAccessKey(mintReq, ""),
            (error: unknown) =>
              error instanceof DesktopControlAccessError && error.code === "auth_required",
          );
          await assert.rejects(
            () => assertDesktopControlAccessKey(mintReq, "not-the-key"),
            (error: unknown) =>
              error instanceof DesktopControlAccessError && error.code === "auth_invalid",
          );
          await assertDesktopControlAccessKey(mintReq, boot.accessKeyOnce);

          // Observer mint on the same socket IP shares the login attempt budget.
          __resetServerAccessRateLimitForTests();
          const observerReq = req("http://127.0.0.1:62666/api/desktop-observer/session", {
            method: "POST",
            headers: loopbackHeaders(),
          });
          for (let i = 0; i < 10; i += 1) {
            await assert.rejects(
              () => assertDesktopObserverAccessKey(observerReq, "wrong"),
              (error: unknown) =>
                error instanceof DesktopObserverAccessError && error.code === "auth_invalid",
            );
          }
          await assert.rejects(
            () => assertDesktopControlAccessKey(mintReq, boot.accessKeyOnce),
            (error: unknown) =>
              error instanceof DesktopControlAccessError && error.code === "rate_limited",
          );
        },
      );
    } finally {
      if (previousMode === undefined) delete process.env.PI_WEB_SERVER_MODE;
      else process.env.PI_WEB_SERVER_MODE = previousMode;
      __resetServerAccessRateLimitForTests();
    }
  });

  // --- U2: path-free project catalog ---
  const existing = new Set([
    "D:\\work\\alpha",
    "D:\\work\\beta",
    "C:\\other\\alpha",
    "D:\\archive\\legacy",
    "D:\\work\\gone",
  ]);
  const catalogDeps = {
    listActiveSummaries: async () => [
      {
        cwd: "D:\\work\\alpha",
        latestModified: "2026-08-17T12:00:00.000Z",
        latestSession: { id: "sess-a", firstMessage: "secret prompt" },
        worktree: { isWorktree: true, branch: "feat/secret" },
      },
      {
        cwd: "D:/work/alpha",
        latestModified: "2026-08-17T11:00:00.000Z",
      },
      {
        cwd: "C:\\other\\alpha",
        latestModified: "2026-08-17T10:00:00.000Z",
      },
      {
        cwd: "D:\\work\\gone",
        latestModified: "2026-08-17T13:00:00.000Z",
      },
    ],
    listArchivedIndexEntries: async () => [
      {
        cwd: "D:\\archive\\legacy",
        mtimeMs: Date.parse("2026-08-16T09:00:00.000Z"),
        firstMessage: "archived secret",
      },
      {
        cwd: "D:\\work\\alpha",
        mtimeMs: Date.parse("2026-08-10T00:00:00.000Z"),
      },
    ],
    canonicalizeCwd: (cwd: string) => cwd.replace(/\//g, "\\"),
    directoryExists: (cwd: string) => existing.has(cwd),
  };

  existing.delete("D:\\work\\gone");
  const catalog = await buildDesktopProjectCatalog(catalogDeps);
  assertDesktopProjectCatalogSafe(catalog);
  assert.equal(catalog.projects.length, 3);
  assert.equal(catalog.projects[0].displayName, "alpha");
  assert.equal(catalog.projects[0].worktree, true);
  assert.equal(catalog.projects[0].archived, false);
  assert.equal(catalog.projects.some((item) => item.displayName === "legacy"), true);
  const sameName = catalog.projects.filter((item) => item.displayName === "alpha");
  assert.equal(sameName.length, 2);
  assert.ok(sameName[0].disambiguator);
  assert.ok(sameName[1].disambiguator);
  assert.notEqual(sameName[0].disambiguator, sameName[1].disambiguator);
  assert.notEqual(sameName[0].projectRef, sameName[1].projectRef);
  const serialized = JSON.stringify(catalog);
  assert.equal(/"cwd"\s*:/.test(serialized), false);
  assert.equal(serialized.includes("firstMessage"), false);
  assert.equal(serialized.includes("latestSession"), false);
  assert.equal(serialized.includes("feat/secret"), false);
  assert.equal(serialized.includes("D:\\work"), false);

  const alphaRef = catalog.projects.find((item) => item.projectRef === buildProjectKeyFromCwd("D:\\work\\alpha"))?.projectRef;
  assert.ok(alphaRef);
  const resolved = await resolveDesktopProjectRef(alphaRef, catalogDeps);
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.cwd, "D:\\work\\alpha");
  }

  const deleted = await resolveDesktopProjectRef(alphaRef, {
    ...catalogDeps,
    directoryExists: (cwd: string) => cwd !== "D:\\work\\alpha" && existing.has(cwd),
  });
  assert.equal(deleted.ok, false);
  if (!deleted.ok) assert.equal(deleted.code, "project_unavailable");

  const rawPath = await resolveDesktopProjectRef("D:\\work\\alpha", catalogDeps);
  assert.equal(rawPath.ok, false);
  if (!rawPath.ok) assert.equal(rawPath.code, "project_unknown");

  const collidingKey = "p_aaaaaaaaaaaaaaaa";
  const collision = await resolveDesktopProjectRef(collidingKey, {
    ...catalogDeps,
    listActiveSummaries: async () => [
      { cwd: "D:\\work\\alpha", latestModified: "2026-08-17T12:00:00.000Z" },
      { cwd: "C:\\other\\alpha", latestModified: "2026-08-17T10:00:00.000Z" },
    ],
    listArchivedIndexEntries: async () => [],
    buildProjectKey: () => collidingKey,
  });
  assert.equal(collision.ok, false);
  if (!collision.ok) assert.equal(collision.code, "project_collision");
  const collisionCatalog = await buildDesktopProjectCatalog({
    ...catalogDeps,
    listActiveSummaries: async () => [
      { cwd: "D:\\work\\alpha", latestModified: "2026-08-17T12:00:00.000Z" },
      { cwd: "C:\\other\\alpha", latestModified: "2026-08-17T10:00:00.000Z" },
    ],
    listArchivedIndexEntries: async () => [],
    buildProjectKey: () => collidingKey,
  });
  assert.equal(collisionCatalog.projects.length, 0);
  assert.equal(
    collisionCatalog.diagnostics.some((item) => item.code === "project_ref_collision"),
    true,
  );

  const many = Array.from({ length: 105 }, (_, index) => ({
    cwd: `D:\\work\\proj-${String(index).padStart(3, "0")}`,
    latestModified: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString(),
  }));
  const truncated = await buildDesktopProjectCatalog({
    listActiveSummaries: async () => many,
    listArchivedIndexEntries: async () => [],
    canonicalizeCwd: (cwd: string) => cwd,
    directoryExists: () => true,
  });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.omitted, 5);
  assert.equal(truncated.projects.length, 100);
  assert.equal(truncated.projects[0].displayName, "proj-104");
  const omittedRef = buildProjectKeyFromCwd("D:\\work\\proj-000");
  const omitted = await resolveDesktopProjectRef(omittedRef, {
    listActiveSummaries: async () => many,
    listArchivedIndexEntries: async () => [],
    canonicalizeCwd: (cwd: string) => cwd,
    directoryExists: () => true,
  });
  assert.equal(omitted.ok, false);
  if (!omitted.ok) assert.equal(omitted.code, "project_out_of_catalog");
  assertDesktopProjectCatalogSafe(truncated);

  // --- U3: shared starter + desktop idempotency ---
  resetDesktopQuickSessionIdempotencyForTests();
  const defaultModel = selectDefaultNewSessionModel({
    defaultModel: { provider: "openai", modelId: "gone" },
    modelList: [
      { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
      { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
    ],
  });
  assert.deepEqual(defaultModel, { provider: "acme", modelId: "first" });
  const configured = selectDefaultNewSessionModel({
    defaultModel: { provider: "openai", modelId: "kept" },
    modelList: [
      { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
      { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
    ],
  });
  assert.deepEqual(configured, { provider: "openai", modelId: "kept" });
  assert.equal(selectDefaultNewSessionModel({ defaultModel: null, modelList: [] }), null);

  const sent: Array<{ cwd: string; command: Record<string, unknown> }> = [];
  const fakeSession = {
    send: async (payload: Record<string, unknown>) => {
      sent.push({ cwd: "unused", command: payload });
      return { type: payload.type };
    },
  };
  const browser = await startNewAgentSession(
    {
      cwd: "D:\\work\\alpha",
      command: {
        type: "prompt",
        message: "from browser",
        images: [{ type: "image", data: "abc", mimeType: "image/png" }],
        provider: "openai",
        modelId: "kept",
        thinkingLevel: "high",
        toolPreset: "read-only",
      },
    },
    {
      canonicalizeCwd: (cwd) => cwd,
      directoryExists: () => true,
      registerAllowedRoot: () => undefined,
      startRpcSession: async () => ({ session: fakeSession as never, realSessionId: "sess-browser" }),
    },
  );
  assert.equal(browser.success, true);
  if (browser.success) {
    assert.equal(browser.sessionId, "sess-browser");
    assert.deepEqual(browser.data, { type: "prompt" });
  }
  assert.deepEqual(
    sent.map((item) => item.command.type),
    ["set_model", "set_thinking_level", "prompt"],
  );
  assert.equal((sent[2]?.command as { images?: unknown[] }).images?.length, 1);

  let startCalls = 0;
  const requestId = newDesktopQuickSessionRequestIdForTests();
  const createDeps = {
    catalog: catalogDeps,
    loadModelMetadata: async () => ({
      models: {},
      modelList: [{ id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true }],
      defaultModel: { provider: "openai", modelId: "kept" },
      thinkingLevels: {},
      thinkingLevelMaps: {},
    }),
    startSession: async (input: { cwd: string; command: Record<string, unknown> }) => {
      startCalls += 1;
      assert.equal(input.cwd, "D:\\work\\alpha");
      assert.equal(input.command.provider, "openai");
      assert.equal(input.command.modelId, "kept");
      assert.equal(input.command.toolPreset, "all");
      assert.equal(input.command.thinkingLevel, undefined);
      return { success: true as const, sessionId: "sess-desk", data: { type: "prompt" } };
    },
    instanceId: "inst-u3",
  };
  const [first, second] = await Promise.all([
    createDesktopQuickSession(
      { projectRef: alphaRef, message: "check tests", requestId },
      createDeps,
    ),
    createDesktopQuickSession(
      { projectRef: alphaRef, message: "check tests", requestId },
      createDeps,
    ),
  ]);
  assert.equal(startCalls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.sessionId, "sess-desk");
    assert.equal(second.sessionId, "sess-desk");
    assert.equal(first.deepLink, "/?session=sess-desk");
    assert.equal(second.duplicate, true);
  }
  const retry = await createDesktopQuickSession(
    { projectRef: alphaRef, message: "check tests", requestId },
    createDeps,
  );
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.duplicate, true);
  assert.equal(startCalls, 1);

  const conflict = await createDesktopQuickSession(
    { projectRef: alphaRef, message: "different text", requestId },
    createDeps,
  );
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "request_conflict");
  assert.equal(startCalls, 1);

  const stale = await createDesktopQuickSession(
    { projectRef: "p_bbbbbbbbbbbbbbbb", message: "check tests", requestId: newDesktopQuickSessionRequestIdForTests() },
    createDeps,
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "project_unknown");

  const noModel = await createDesktopQuickSession(
    { projectRef: alphaRef, message: "check tests", requestId: newDesktopQuickSessionRequestIdForTests() },
    {
      ...createDeps,
      loadModelMetadata: async () => ({
        models: {},
        modelList: [],
        defaultModel: null,
        thinkingLevels: {},
        thinkingLevelMaps: {},
      }),
    },
  );
  assert.equal(noModel.ok, false);
  if (!noModel.ok) assert.equal(noModel.code, "model_unavailable");
  assert.equal(startCalls, 1);

  const explicitModel = await createDesktopQuickSession(
    {
      projectRef: alphaRef,
      message: "use first",
      requestId: newDesktopQuickSessionRequestIdForTests(),
      provider: "acme",
      modelId: "first",
    },
    {
      ...createDeps,
      loadModelMetadata: async () => ({
        models: {},
        modelList: [
          { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
          { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
        ],
        defaultModel: { provider: "openai", modelId: "kept" },
        thinkingLevels: {},
        thinkingLevelMaps: {},
      }),
      startSession: async (input: { cwd: string; command: Record<string, unknown> }) => {
        startCalls += 1;
        assert.equal(input.command.provider, "acme");
        assert.equal(input.command.modelId, "first");
        return { success: true as const, sessionId: "sess-explicit", data: { type: "prompt" } };
      },
    },
  );
  assert.equal(explicitModel.ok, true);
  assert.equal(startCalls, 2);

  const unknownModel = await createDesktopQuickSession(
    {
      projectRef: alphaRef,
      message: "missing model",
      requestId: newDesktopQuickSessionRequestIdForTests(),
      provider: "openai",
      modelId: "gone",
    },
    createDeps,
  );
  assert.equal(unknownModel.ok, false);
  if (!unknownModel.ok) assert.equal(unknownModel.code, "model_unavailable");
  assert.equal(startCalls, 2);

  const halfModel = parseDesktopQuickSessionCreateBody({
    projectRef: alphaRef,
    message: "ok",
    requestId: newDesktopQuickSessionRequestIdForTests(),
    provider: "openai",
  });
  assert.equal(halfModel.ok, false);
  if (!halfModel.ok) assert.equal(halfModel.code, "bad_request");

  const projected = projectDesktopQuickSessionModels({
    defaultModel: { provider: "openai", modelId: "kept" },
    modelList: [
      { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
      { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
    ],
  });
  assert.equal(projected.models.length, 1);
  assert.equal(projected.models[0]?.modelId, "kept");
  assert.deepEqual(projected.defaultModel, { provider: "openai", modelId: "kept" });
  assert.deepEqual(
    resolveDesktopQuickSessionModel(
      {
        defaultModel: { provider: "openai", modelId: "kept" },
        modelList: [
          { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
          { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
        ],
      },
      { provider: "acme", modelId: "first" },
    ),
    { provider: "acme", modelId: "first" },
  );

  const modelCatalog = await buildDesktopQuickSessionModelCatalog(alphaRef, {
    catalog: catalogDeps,
    loadModelMetadata: async (cwd) => {
      assert.equal(cwd, "D:\\work\\alpha");
      return {
        models: {},
        modelList: [
          { id: "first", name: "First", provider: "acme", supportsImage: false, primaryCandidate: false },
          { id: "kept", name: "Kept", provider: "openai", supportsImage: false, primaryCandidate: true },
        ],
        defaultModel: { provider: "openai", modelId: "kept" },
        thinkingLevels: {},
        thinkingLevelMaps: {},
      };
    },
  });
  assert.equal(modelCatalog.ok, true);
  if (modelCatalog.ok) {
    assert.equal(modelCatalog.catalog.projectRef, alphaRef);
    assert.equal(modelCatalog.catalog.models.length, 1);
    assert.equal(JSON.stringify(modelCatalog.catalog).includes("D:\\work\\alpha"), false);
    assert.doesNotThrow(() => assertDesktopQuickSessionModelCatalogSafe(modelCatalog.catalog));
  }

  const empty = parseDesktopQuickSessionCreateBody({
    projectRef: alphaRef,
    message: "   ",
    requestId: newDesktopQuickSessionRequestIdForTests(),
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, "message_empty");
  const tooLong = parseDesktopQuickSessionCreateBody({
    projectRef: alphaRef,
    message: "x".repeat(8001),
    requestId: newDesktopQuickSessionRequestIdForTests(),
  });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, "message_too_long");
  const smuggled = parseDesktopQuickSessionCreateBody({
    projectRef: alphaRef,
    message: "ok",
    requestId: newDesktopQuickSessionRequestIdForTests(),
    cwd: "D:\\evil",
  });
  assert.equal(smuggled.ok, false);
  if (!smuggled.ok) assert.equal(smuggled.code, "bad_request");

  const precheckId = newDesktopQuickSessionRequestIdForTests();
  const precheckFail = await createDesktopQuickSession(
    { projectRef: "p_cccccccccccccccc", message: "later", requestId: precheckId },
    createDeps,
  );
  assert.equal(precheckFail.ok, false);
  const precheckRetry = await createDesktopQuickSession(
    { projectRef: alphaRef, message: "later", requestId: precheckId },
    createDeps,
  );
  assert.equal(precheckRetry.ok, true);
  if (precheckRetry.ok) assert.equal(precheckRetry.duplicate, false);

  const serializedCreate = JSON.stringify(first);
  assert.equal(serializedCreate.includes("check tests"), false);
  assert.equal(/"cwd"\s*:/.test(serializedCreate), false);
  assert.equal(serializedCreate.includes("accessKey"), false);

  // --- U4: main control client ---
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const clientFetch: DesktopFetch = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    if (/\/desktop-control\/session$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "ctrl.token",
          expiresAt: Date.now() + 60_000,
          instanceId: "inst-u4",
          scopes: ["quick_session"],
        }),
        text: async () => "",
      };
    }
    if (/\/desktop-control\/projects$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projects: [{
            projectRef: alphaRef,
            displayName: "alpha",
            latestModified: "2026-08-17T12:00:00.000Z",
            archived: false,
            worktree: false,
          }],
          truncated: false,
          omitted: 0,
          diagnostics: [],
        }),
        text: async () => "",
      };
    }
    if (/\/desktop-control\/models\?/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projectRef: alphaRef,
          defaultModel: { provider: "openai", modelId: "kept" },
          models: [{ provider: "openai", modelId: "kept", name: "Kept", primaryCandidate: true }],
          truncated: false,
        }),
        text: async () => "",
      };
    }
    if (/\/desktop-control\/quick-sessions$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionId: "sess-u4", deepLink: "/?session=sess-u4", duplicate: false }),
        text: async () => "",
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const qsClient = new DesktopQuickSessionClient({
    port: 62666,
    fetch: clientFetch,
    accessKey: "saved-key",
  });
  qsClient.setConnection({
    connected: true,
    quickSessionAvailable: true,
    instanceId: "inst-u4",
    port: 62666,
  });
  const listed = await qsClient.listProjects();
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal(listed.value.projects[0]?.projectRef, alphaRef);
    assert.equal(JSON.stringify(listed.value).includes("saved-key"), false);
    assert.equal(JSON.stringify(listed.value).includes("ctrl.token"), false);
  }
  assert.ok(calls.some((call) => call.body?.includes("saved-key")));
  const models = await qsClient.listModels(alphaRef);
  assert.equal(models.ok, true);
  if (models.ok) {
    assert.equal(models.value.models[0]?.modelId, "kept");
    assert.equal(JSON.stringify(models.value).includes("saved-key"), false);
  }
  const created = await qsClient.createSession({
    projectRef: alphaRef,
    message: "from pet",
    requestId,
    provider: "openai",
    modelId: "kept",
  });
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.value.sessionId, "sess-u4");
    assert.equal(created.value.deepLink, "/?session=sess-u4");
  }
  assert.equal(qsClient.getTokenForTests(), "ctrl.token");

  const unavailable = new DesktopQuickSessionClient({ port: 62666, fetch: clientFetch });
  unavailable.setConnection({ connected: true, quickSessionAvailable: false, instanceId: "inst-u4" });
  const hidden = await unavailable.createSession({
    projectRef: alphaRef,
    message: "from pet",
    requestId,
  });
  assert.equal(hidden.ok, false);
  if (!hidden.ok) assert.equal(hidden.code, "feature_unavailable");

  qsClient.setConnection({
    connected: true,
    quickSessionAvailable: true,
    instanceId: "inst-other",
  });
  assert.equal(qsClient.getTokenForTests(), null);
  qsClient.quit();
  const afterQuit = await qsClient.createSession({
    projectRef: alphaRef,
    message: "from pet",
    requestId,
  });
  assert.equal(afterQuit.ok, false);
  if (!afterQuit.ok) assert.equal(afterQuit.code, "disconnected");

  const rawPathCreate = sanitizeQuickSessionCreateInput({
    projectRef: "D:\\work\\alpha",
    message: "from pet",
    requestId,
  });
  assert.equal("ok" in rawPathCreate && rawPathCreate.ok === false, true);
  const tooLongCreate = sanitizeQuickSessionCreateInput({
    projectRef: alphaRef,
    message: "x".repeat(8001),
    requestId,
  });
  assert.equal("ok" in tooLongCreate && tooLongCreate.ok === false, true);
  if ("ok" in tooLongCreate && tooLongCreate.ok === false) {
    assert.equal(tooLongCreate.code, "message_too_long");
  }

  // --- U5: in-tray composer reducer ---
  let ui = createInitialQuickSessionState();
  ui = reduceQuickSessionState(ui, { type: "open" });
  assert.equal(ui.phase, "loading");
  ui = reduceQuickSessionState(ui, {
    type: "catalog_loaded",
    catalog: {
      projects: [
        { projectRef: alphaRef!, displayName: "alpha", latestModified: "2026-08-17T12:00:00.000Z", archived: false, worktree: false },
        { projectRef: buildProjectKeyFromCwd("C:\\other\\alpha"), displayName: "alpha", disambiguator: "aa11", latestModified: "2026-08-17T10:00:00.000Z", archived: false, worktree: false },
      ],
      truncated: false,
      omitted: 0,
    },
  });
  assert.equal(ui.phase, "editing");
  assert.equal(ui.selectedProjectRef, alphaRef);
  assert.equal(formatQuickSessionProjectLabel(selectedQuickSessionProject(ui)), "alpha");
  ui = reduceQuickSessionState(ui, { type: "set_draft", draft: "检查测试" });
  assert.equal(canSubmitQuickSession(ui), true);
  const firstSubmit = reduceQuickSessionState(ui, { type: "submit" });
  const secondSubmit = reduceQuickSessionState(firstSubmit, { type: "submit" });
  assert.equal(firstSubmit.phase, "submitting");
  assert.equal(secondSubmit.requestId, firstSubmit.requestId);
  const unknown = reduceQuickSessionState(firstSubmit, { type: "submit_error", code: "result_unknown" });
  const retried = reduceQuickSessionState(unknown, { type: "retry" });
  assert.equal(retried.requestId, firstSubmit.requestId);
  const edited = reduceQuickSessionState(unknown, { type: "set_draft", draft: "换一句" });
  assert.equal(edited.requestId, null);
  const closed = reduceQuickSessionState(edited, { type: "close" });
  assert.equal(closed.phase, "closed");
  assert.equal(closed.draft, "换一句");
  const cancelled = reduceQuickSessionState(closed, { type: "cancel" });
  assert.equal(cancelled.draft, "");
  assert.equal(filterQuickSessionProjects(ui.projects, "aa11").length, 1);
  assert.equal(filterQuickSessionProjects(ui.projects, "").length, 2);
  ui = reduceQuickSessionState(ui, { type: "toggle_picker", picker: "project" });
  assert.equal(ui.openPicker, "project");
  ui = reduceQuickSessionState(ui, { type: "close_picker" });
  assert.equal(ui.openPicker, "none");
  ui = reduceQuickSessionState(ui, { type: "toggle_picker", picker: "project" });
  assert.equal(ui.openPicker, "project");
  ui = reduceQuickSessionState(ui, {
    type: "models_loaded",
    catalog: {
      projectRef: alphaRef!,
      defaultModel: { provider: "openai", modelId: "kept" },
      models: [
        { provider: "openai", modelId: "kept", name: "Kept", primaryCandidate: true },
        { provider: "acme", modelId: "first", name: "First", primaryCandidate: false },
      ],
      truncated: false,
    },
  });
  assert.equal(ui.selectedModelId, "kept");
  assert.equal(formatQuickSessionModelLabel(selectedQuickSessionModel(ui)), "Kept");
  ui = reduceQuickSessionState(ui, { type: "select_model", provider: "acme", modelId: "first" });
  assert.equal(ui.selectedModelId, "first");
  assert.equal(ui.openPicker, "none");
  assert.equal(filterQuickSessionModels(ui.models, "acme").length, 1);
  const switched = reduceQuickSessionState(ui, {
    type: "select_project",
    projectRef: buildProjectKeyFromCwd("C:\\other\\alpha"),
  });
  assert.equal(switched.modelsPhase, "idle");
  assert.equal(switched.selectedModelId, null);
  assert.ok(newQuickSessionRequestId());

  console.log("smoke-desktop-quick-session: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
