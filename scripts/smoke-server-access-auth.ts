/**
 * Pure-domain smoke for server access auth (no Next.js).
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVER_ACCESS_COOKIE_NAME,
  SERVER_ACCESS_MAX_SESSIONS,
  SERVER_ACCESS_RATE_LIMIT,
  SERVER_ACCESS_SESSION_TTL_MS,
  SERVER_ACCESS_STATE_FILENAME,
  ServerAccessError,
  __resetServerAccessRateLimitForTests,
  __setServerAccessClockForTests,
  bootstrapServerAccessAuth,
  consumeLoginAttempt,
  createServerAccessSession,
  ensureServerAccessInitialized,
  getServerAccessStatePath,
  recordLoginSuccess,
  revokeServerAccessSession,
  rotateServerAccessKey,
  validateServerAccessSession,
  verifyAccessKey,
} from "../lib/server-access-auth";
import {
  classifyHostname,
  detectMultiInstanceRisk,
  formatRuntimeIdentityLine,
  resolveProcessInstanceId,
  resolveRuntimeOptions,
} from "../bin/runtime-options.js";
import {
  assertSingleInstanceOrThrow,
  buildProcessHealthSnapshot,
  getProcessIdentity,
} from "../lib/process-runtime";
import { withTestRemoteAddress } from "../lib/automation-connection-context";
import { POST as loginRoutePost } from "../app/api/server-auth/login/route";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spi-server-auth-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
}

async function testFirstInitAndReuse(): Promise<void> {
  await withTempDir(async (dir) => {
    const first = await ensureServerAccessInitialized(dir);
    assert(first.created === true, "first init creates state");
    assert(typeof first.accessKeyOnce === "string" && first.accessKeyOnce.length >= 32, "one-time key");
    const path = getServerAccessStatePath(dir);
    assert(existsSync(path), "state file exists");
    const raw = readFileSync(path, "utf8");
    assert(!raw.includes(first.accessKeyOnce!), "plaintext key never stored");
    assert(raw.includes("verifier"), "verifier stored");
    assert(raw.includes("\"algorithm\": \"scrypt\""), "scrypt algorithm recorded");

    const second = await ensureServerAccessInitialized(dir);
    assert(second.created === false, "second init does not recreate");
    assert(second.accessKeyOnce === undefined, "second init does not return key");
    assert(verifyAccessKey(first.accessKeyOnce!, dir), "original key verifies");
    assert(!verifyAccessKey("wrong-key-value-xxxxxxxxxxxx", dir), "wrong key fails");
    assert(!verifyAccessKey("", dir), "empty key fails");
    assert(!verifyAccessKey("x".repeat(600), dir), "overlong key fails");
  });
  console.log("OK first-init-reuse");
}

async function testSessionLifecycle(): Promise<void> {
  await withTempDir(async (dir) => {
    let fakeNow = 1_700_000_000_000;
    __setServerAccessClockForTests(() => fakeNow);
    try {
      const { accessKeyOnce } = await ensureServerAccessInitialized(dir);
      assert(accessKeyOnce, "key required");

      const session = await createServerAccessSession(accessKeyOnce!, dir);
      assert(session.token.length >= 32, "opaque token");
      assert(session.expiresAt === fakeNow + SERVER_ACCESS_SESSION_TTL_MS, "fixed 7d expiry");
      assert(validateServerAccessSession(session.token, dir).ok === true, "session valid");

      // Reload path (re-read file) still valid — absolute, not sliding.
      fakeNow += 60_000;
      assert(validateServerAccessSession(session.token, dir).ok === true, "still valid after 1m");

      fakeNow = session.expiresAt + 1;
      assert(validateServerAccessSession(session.token, dir).ok === false, "expired after absolute TTL");

      // Fresh session for logout
      fakeNow = 1_700_000_000_000;
      const s2 = await createServerAccessSession(accessKeyOnce!, dir);
      assert(validateServerAccessSession(s2.token, dir).ok, "s2 valid");
      await revokeServerAccessSession(s2.token, dir);
      assert(!validateServerAccessSession(s2.token, dir).ok, "logout revokes");
      await revokeServerAccessSession(s2.token, dir); // idempotent
    } finally {
      __setServerAccessClockForTests(null);
    }
  });
  console.log("OK session-lifecycle");
}

async function testRotation(): Promise<void> {
  await withTempDir(async (dir) => {
    const first = await ensureServerAccessInitialized(dir);
    const session = await createServerAccessSession(first.accessKeyOnce!, dir);
    assert(validateServerAccessSession(session.token, dir).ok, "pre-rotate session ok");

    const rotated = await rotateServerAccessKey(dir);
    assert(rotated.rotated === true, "rotated flag");
    assert(rotated.accessKeyOnce && rotated.accessKeyOnce !== first.accessKeyOnce, "new key");
    assert(!verifyAccessKey(first.accessKeyOnce!, dir), "old key dead");
    assert(!validateServerAccessSession(session.token, dir).ok, "old sessions dead");
    assert(verifyAccessKey(rotated.accessKeyOnce!, dir), "new key works");
    const nextSession = await createServerAccessSession(rotated.accessKeyOnce!, dir);
    assert(validateServerAccessSession(nextSession.token, dir).ok, "new session ok");
  });
  console.log("OK rotation");
}

async function testSessionCap(): Promise<void> {
  await withTempDir(async (dir) => {
    let fakeNow = 1_000_000;
    __setServerAccessClockForTests(() => fakeNow);
    try {
      const { accessKeyOnce } = await ensureServerAccessInitialized(dir);
      const tokens: string[] = [];
      for (let i = 0; i < SERVER_ACCESS_MAX_SESSIONS + 5; i += 1) {
        fakeNow += 10;
        const s = await createServerAccessSession(accessKeyOnce!, dir);
        tokens.push(s.token);
      }
      const state = JSON.parse(readFileSync(getServerAccessStatePath(dir), "utf8")) as {
        sessions: unknown[];
      };
      assert(state.sessions.length <= SERVER_ACCESS_MAX_SESSIONS, "hard session cap");
      // Earliest tokens should be gone.
      assert(!validateServerAccessSession(tokens[0]!, dir).ok, "oldest evicted");
      assert(validateServerAccessSession(tokens[tokens.length - 1]!, dir).ok, "newest kept");
    } finally {
      __setServerAccessClockForTests(null);
    }
  });
  console.log("OK session-cap");
}

async function testConcurrentVerificationCap(): Promise<void> {
  await withTempDir(async (dir) => {
    __resetServerAccessRateLimitForTests();
    try {
      const { accessKeyOnce } = await ensureServerAccessInitialized(dir);
      assert(accessKeyOnce, "concurrency test key");
      const attempts = Array.from(
        { length: SERVER_ACCESS_RATE_LIMIT.maxConcurrentVerifications + 1 },
        () => createServerAccessSession(accessKeyOnce!, dir),
      );
      const settled = await Promise.allSettled(attempts);
      const fulfilled = settled.filter((item) => item.status === "fulfilled");
      const rejected = settled.filter((item) => item.status === "rejected");
      assert(
        fulfilled.length === SERVER_ACCESS_RATE_LIMIT.maxConcurrentVerifications,
        "bounded verifier concurrency succeeds up to cap",
      );
      assert(rejected.length === 1, "excess verifier rejected instead of queued");
      const reason = rejected[0]!.status === "rejected" ? rejected[0]!.reason : null;
      assert(
        reason instanceof ServerAccessError && reason.code === "rate_limited",
        "excess verifier returns typed rate limit",
      );
    } finally {
      __resetServerAccessRateLimitForTests();
    }
  });
  console.log("OK concurrent-verification-cap");
}

async function testCorruptFailClosed(): Promise<void> {
  await withTempDir(async (dir) => {
    const path = getServerAccessStatePath(dir);
    writeFileSync(path, "{not-json", "utf8");
    let threw = false;
    try {
      await ensureServerAccessInitialized(dir);
    } catch (error) {
      threw = true;
      assert(error instanceof ServerAccessError, "typed error");
      assert((error as ServerAccessError).code === "corrupt_state", "corrupt code");
    }
    assert(threw, "corrupt state fails closed on ensure when file exists");
    assert(existsSync(path), "corrupt file not auto-wiped");

    // Explicit rotation recovers.
    const recovered = await rotateServerAccessKey(dir);
    assert(recovered.accessKeyOnce, "rotation recovers");
    assert(verifyAccessKey(recovered.accessKeyOnce!, dir), "recovered key works");
  });
  console.log("OK corrupt-fail-closed");
}

async function testLoginRouteBoundaries(): Promise<void> {
  await withTempDir(async (dir) => {
    const previous = {
      agentDir: process.env.PI_CODING_AGENT_DIR,
      serverMode: process.env.PI_WEB_SERVER_MODE,
      insecureHttp: process.env.PI_WEB_ALLOW_INSECURE_HTTP,
    };
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_WEB_SERVER_MODE = "1";
    process.env.PI_WEB_ALLOW_INSECURE_HTTP = "1";
    __resetServerAccessRateLimitForTests();
    try {
      const { accessKeyOnce } = await ensureServerAccessInitialized(dir);
      assert(accessKeyOnce, "route test access key");
      const url = "http://localhost:62666/api/server-auth/login";
      const commonHeaders = {
        "Content-Type": "application/json",
        Origin: "http://localhost:62666",
        Host: "localhost:62666",
      };

      const oversized = await withTestRemoteAddress("100.64.1.2", () =>
        loginRoutePost(new Request(url, {
          method: "POST",
          headers: commonHeaders,
          body: "x".repeat(5_000),
        })),
      );
      assert(oversized.status === 400, "streamed oversized login body rejected");

      const valid = await withTestRemoteAddress("100.64.1.2", () =>
        loginRoutePost(new Request(url, {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify({ accessKey: accessKeyOnce }),
        })),
      );
      assert(valid.status === 200, "valid bounded login body accepted");
    } finally {
      if (previous.agentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
      if (previous.serverMode == null) delete process.env.PI_WEB_SERVER_MODE;
      else process.env.PI_WEB_SERVER_MODE = previous.serverMode;
      if (previous.insecureHttp == null) delete process.env.PI_WEB_ALLOW_INSECURE_HTTP;
      else process.env.PI_WEB_ALLOW_INSECURE_HTTP = previous.insecureHttp;
      __resetServerAccessRateLimitForTests();
    }
  });
  console.log("OK login-route-boundaries");
}

async function testRateLimit(): Promise<void> {
  __resetServerAccessRateLimitForTests();
  let fakeNow = 5_000_000;
  __setServerAccessClockForTests(() => fakeNow);
  try {
    const client = "10.0.0.9";
    for (let i = 0; i < SERVER_ACCESS_RATE_LIMIT.clientMaxAttempts; i += 1) {
      assert(consumeLoginAttempt(client).allowed, `client attempt ${i} allowed`);
    }
    const blocked = consumeLoginAttempt(client);
    assert(!blocked.allowed, "client bucket trips");
    if (!blocked.allowed) {
      assert(blocked.retryAfterSec > 0, "retry-after present");
    }

    // A noisy client cannot consume another socket client's budget.
    const other = consumeLoginAttempt("10.0.0.10");
    assert(other.allowed, "other client independent");

    // Advance past window — recovers.
    fakeNow += SERVER_ACCESS_RATE_LIMIT.clientWindowMs + 1;
    assert(consumeLoginAttempt(client).allowed, "client recovers after window");

    // A successful login clears only that client's attempt bucket.
    assert(consumeLoginAttempt("g1").allowed, "success client attempt reserved");
    recordLoginSuccess("g1");
    assert(consumeLoginAttempt("g1").allowed, "success clears client");
  } finally {
    __setServerAccessClockForTests(null);
    __resetServerAccessRateLimitForTests();
  }
  console.log("OK rate-limit");
}

function testRuntimeOptions(): void {
  // Default local
  {
    const r = resolveRuntimeOptions({ argv: ["node", "spi"], env: {} });
    assert(r.hostname === "127.0.0.1", "default hostname loopback");
    assert(r.serverMode === false, "default auth off");
    assert(r.openBrowser === true, "default open browser");
    assert(r.rotateAccessKey === false, "no rotate");
  }
  // --server
  {
    const r = resolveRuntimeOptions({ argv: ["node", "spi", "--server"], env: {} });
    assert(r.hostname === "0.0.0.0", "server default wildcard");
    assert(r.serverMode === true, "server auth on");
    assert(r.openBrowser === false, "server no auto-open");
    assert(r.allowInsecureHttp === false, "server requires https by default");
    assert(r.envOverrides.PI_WEB_ALLOW_INSECURE_HTTP === "0", "strict transport env");
  }
  // Explicit HTTP compatibility escape hatch
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi", "--server", "--allow-insecure-http"],
      env: {},
    });
    assert(r.allowInsecureHttp === true, "explicit insecure http enabled");
    assert(r.envOverrides.PI_WEB_ALLOW_INSECURE_HTTP === "1", "insecure transport env");
  }
  // non-loopback auto auth
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi", "-H", "0.0.0.0"],
      env: {},
    });
    assert(r.serverMode === true, "wildcard forces auth");
  }
  // reverse proxy loopback + server
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi", "--server", "-H", "127.0.0.1"],
      env: {},
    });
    assert(r.hostname === "127.0.0.1", "explicit loopback kept");
    assert(r.serverMode === true, "server flag forces auth on loopback");
  }
  // PI_WEB_HOSTNAME
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi"],
      env: { PI_WEB_HOSTNAME: "10.0.0.5" },
    });
    assert(r.hostname === "10.0.0.5", "PI_WEB_HOSTNAME honored");
    assert(r.serverMode === true, "LAN hostname forces auth");
  }
  // system HOSTNAME ignored
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi"],
      env: { HOSTNAME: "my-laptop" },
    });
    assert(r.hostname === "127.0.0.1", "system HOSTNAME ignored");
    assert(r.serverMode === false, "system HOSTNAME does not enable auth");
  }
  // env server mode (equivalent to --server)
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi"],
      env: { PI_WEB_SERVER_MODE: "1" },
    });
    assert(r.serverMode === true, "PI_WEB_SERVER_MODE=1");
    assert(r.hostname === "0.0.0.0", "env server mode defaults wildcard bind like --server");
  }
  // Security-sensitive compatibility flags require server mode.
  {
    let threw = false;
    try {
      resolveRuntimeOptions({
        argv: ["node", "spi", "--allow-insecure-http"],
        env: {},
      });
    } catch {
      threw = true;
    }
    assert(threw, "insecure HTTP without server mode rejected");
  }
  // rotate requires server mode
  {
    let threw = false;
    try {
      resolveRuntimeOptions({
        argv: ["node", "spi", "--rotate-access-key"],
        env: {},
      });
    } catch {
      threw = true;
    }
    assert(threw, "rotate without server mode rejected");
  }
  {
    const r = resolveRuntimeOptions({
      argv: ["node", "spi", "--server", "--rotate-access-key"],
      env: {},
    });
    assert(r.rotateAccessKey === true, "rotate with server ok");
  }
  // classify helpers
  assert(classifyHostname("127.0.0.1") === "loopback", "127.0.0.1");
  assert(classifyHostname("127.0.0.2") === "loopback", "127.0.0.2");
  assert(classifyHostname("localhost") === "loopback", "localhost");
  assert(classifyHostname("::1") === "loopback", "::1");
  assert(classifyHostname("0.0.0.0") === "wildcard", "0.0.0.0");
  assert(classifyHostname("::") === "wildcard", "::");
  assert(classifyHostname("10.0.0.1") === "remote", "LAN");
  assert(classifyHostname("example.com") === "remote", "DNS");

  assert(SERVER_ACCESS_COOKIE_NAME === "spi_access_session", "cookie name stable");
  assert(SERVER_ACCESS_STATE_FILENAME === "server-access.json", "state filename");
  console.log("OK runtime-options");
}

function testSingleInstanceAndHealth(): void {
  {
    const clean = detectMultiInstanceRisk({});
    assert(clean.ok && !clean.fatal, "default env is single-instance ok");
    assert(clean.reasons.length === 0, "no reasons when clean");
  }
  {
    const cluster = detectMultiInstanceRisk({ NODE_APP_INSTANCE: "0" });
    assert(!cluster.ok && cluster.fatal, "PM2 cluster marker is fatal by default");
    assert(cluster.signals.includes("NODE_APP_INSTANCE"), "signal recorded");
  }
  {
    const worker = detectMultiInstanceRisk({ NODE_UNIQUE_ID: "1" });
    assert(!worker.ok && worker.fatal, "node cluster worker is fatal");
  }
  {
    const many = detectMultiInstanceRisk({ WEB_CONCURRENCY: "2" });
    assert(!many.ok && many.fatal, "WEB_CONCURRENCY>1 is fatal");
  }
  {
    const instances = detectMultiInstanceRisk({ instances: "2" });
    assert(!instances.ok && instances.fatal, "instances>1 is fatal");
  }
  {
    const override = detectMultiInstanceRisk({
      NODE_APP_INSTANCE: "1",
      PI_WEB_ALLOW_MULTI_INSTANCE: "1",
    });
    assert(!override.ok && !override.fatal && override.allowOverride, "override demotes fatal");
  }
  {
    let threw = false;
    try {
      assertSingleInstanceOrThrow({ NODE_APP_INSTANCE: "0" });
    } catch {
      threw = true;
    }
    assert(threw, "assertSingleInstanceOrThrow refuses cluster");
    const allowed = assertSingleInstanceOrThrow({
      NODE_APP_INSTANCE: "0",
      PI_WEB_ALLOW_MULTI_INSTANCE: "1",
    });
    assert(allowed.allowOverride, "assert allows override");
  }

  const id = resolveProcessInstanceId({
    env: {},
    pid: 4242,
    now: () => 1_700_000_000_000,
    randomHex: () => "abcdef",
  });
  assert(id.startsWith("4242-"), "instance id includes pid");
  assert(
    resolveProcessInstanceId({ env: { PI_WEB_INSTANCE_ID: "fixed-id" } }) === "fixed-id",
    "env instance id preferred",
  );

  const line = formatRuntimeIdentityLine({
    pid: 9,
    instanceId: "abc",
    serverMode: true,
    hostname: "127.0.0.1",
    port: 62666,
    singleInstanceOk: true,
  });
  assert(line.includes("pid=9"), "identity line pid");
  assert(line.includes("instanceId=abc"), "identity line instance");
  assert(line.includes("mode=server"), "identity line mode");
  assert(line.includes("bind=127.0.0.1:62666"), "identity line bind");
  assert(line.includes("singleInstance=ok"), "identity line single ok");

  const identity = getProcessIdentity({
    PI_WEB_SERVER_MODE: "0",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PORT: "62666",
    PI_WEB_INSTANCE_ID: "test-instance",
  });
  assert(identity.mode === "local", "identity local mode");
  assert(identity.instanceId === "test-instance", "identity uses env id");
  assert(identity.bind.port === "62666", "identity bind port");

  console.log("OK single-instance-and-health-helpers");
}

async function testHealthSnapshot(): Promise<void> {
  const snap = await buildProcessHealthSnapshot({
    PI_WEB_SERVER_MODE: "0",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PORT: "62666",
    PI_WEB_INSTANCE_ID: "health-snap",
  });
  assert(snap.status === "ready", "health status ready");
  assert(snap.instanceId === "health-snap", "health instance id");
  assert(typeof snap.pid === "number" && snap.pid > 0, "health pid");
  assert(typeof snap.liveSessions === "number", "health liveSessions");
  assert(typeof snap.sseListeners === "number", "health sseListeners");
  assert(snap.scheduler && typeof snap.scheduler.role === "string", "health scheduler role");
  assert(snap.singleInstance && typeof snap.singleInstance.ok === "boolean", "health singleInstance");
  // Must not leak path-like secrets in the public snapshot surface.
  const json = JSON.stringify(snap);
  assert(!json.includes("server-access.json"), "health omits auth state path");
  console.log("OK health-snapshot");
}

async function testBootstrap(): Promise<void> {
  await withTempDir(async (dir) => {
    const a = await bootstrapServerAccessAuth({ agentDir: dir });
    assert(a.created && a.accessKeyOnce, "bootstrap create");
    const b = await bootstrapServerAccessAuth({ agentDir: dir });
    assert(!b.created && !b.accessKeyOnce, "bootstrap reuse");
    const c = await bootstrapServerAccessAuth({ agentDir: dir, rotate: true });
    assert(c.rotated && c.accessKeyOnce, "bootstrap rotate");
  });
  console.log("OK bootstrap");
}

async function main(): Promise<void> {
  testRuntimeOptions();
  testSingleInstanceAndHealth();
  await testHealthSnapshot();
  await testFirstInitAndReuse();
  await testSessionLifecycle();
  await testRotation();
  await testSessionCap();
  await testConcurrentVerificationCap();
  await testCorruptFailClosed();
  await testLoginRouteBoundaries();
  await testRateLimit();
  await testBootstrap();
  console.log("server-access-auth smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
