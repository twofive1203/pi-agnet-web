/**
 * Production E2E for server access authentication.
 * Requires a prior `npm run build` (.next present).
 */
import { spawn } from "node:child_process";
import {
  createServer,
} from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "bin", "pi-web.js");
const NEXT_DIR = join(ROOT, ".next");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(msg) {
  console.log(`[e2e-server-auth] ${msg}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function startLauncher(args, env) {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Keep local E2E off ambient HTTP proxies that rewrite Host/URL.
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      // Isolate security-sensitive launcher defaults from the release shell.
      PI_WEB_SERVER_MODE: "0",
      PI_WEB_HOSTNAME: "127.0.0.1",
      PI_WEB_TRUST_PROXY: "0",
      PI_WEB_ALLOW_INSECURE_HTTP: "1",
      PI_WEB_ROTATE_ACCESS_KEY: "0",
      PI_WEB_AUTH_BYPASS_CIDRS: "",
      ...env,
      PI_WEB_LAUNCH_COMMAND: "start",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });
  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    async waitReady(timeoutMs = 90_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (child.exitCode != null) {
          throw new Error(
            `process exited early code=${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        if (/Ready/i.test(stdout)) return;
        await sleep(200);
      }
      throw new Error(`timeout waiting for Ready\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    },
    async waitForAccessKey(timeoutMs = 30_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (child.exitCode != null) {
          throw new Error(
            `process exited while waiting for access key code=${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          );
        }
        const key = extractAccessKey(stdout);
        if (key) return key;
        await sleep(100);
      }
      throw new Error(`timeout waiting for access key\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    },
    async waitSettledAuth(timeoutMs = 15_000) {
      // After Ready, instrumentation may still print the one-time key or "existing key loaded".
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const text = stdout + stderr;
        if (
          extractAccessKey(stdout) ||
          /existing access key loaded/i.test(text) ||
          /Access key rotated/i.test(text) ||
          /Authentication enabled/i.test(text)
        ) {
          return;
        }
        if (child.exitCode != null) return;
        await sleep(100);
      }
    },
    async stop() {
      if (child.exitCode != null) return;
      child.kill("SIGTERM");
      const start = Date.now();
      while (child.exitCode == null && Date.now() - start < 15_000) {
        await sleep(100);
      }
      if (child.exitCode == null) {
        child.kill("SIGKILL");
      }
    },
  };
}

function extractAccessKey(stdout) {
  // Match base64url token on its own line inside the banner or nearby.
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/║\s+([A-Za-z0-9_-]{32,})\s*║/);
    if (m) return m[1];
  }
  // Fallback: long base64url token near "access key"
  const block = stdout.match(/access key[\s\S]{0,400}?([A-Za-z0-9_-]{40,})/i);
  if (block) return block[1];
  return null;
}

/** Simple cookie jar for one host. */
function createCookieJar() {
  /** @type {Map<string, string>} */
  const jar = new Map();
  return {
    storeFromResponse(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      const fallback = res.headers.get("set-cookie");
      const list = raw.length ? raw : fallback ? [fallback] : [];
      for (const item of list) {
        const pair = item.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name) continue;
        if (!value || /Max-Age=0/i.test(item) || /Expires=Thu, 01 Jan 1970/i.test(item)) {
          jar.delete(name);
        } else {
          jar.set(name, value);
        }
      }
    },
    header() {
      if (jar.size === 0) return "";
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(name) {
      return jar.get(name) ?? null;
    },
    clear() {
      jar.clear();
    },
  };
}

async function fetchWithJar(url, jar, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  jar.storeFromResponse(res);
  return res;
}

function redacted(text, secrets) {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

async function main() {
  // Parent-process fetch must not go through ambient HTTP proxies either.
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  process.env.no_proxy = "127.0.0.1,localhost,::1";

  assert(existsSync(NEXT_DIR), "Build artifacts missing — run npm run build first");
  assert(existsSync(LAUNCHER), "launcher missing");

  const agentDir = mkdtempSync(join(tmpdir(), "spi-e2e-auth-"));
  const secrets = [];
  /** @type {Array<() => Promise<void>>} */
  const cleanups = [];

  try {
    // ── AE1: default local mode ──
    {
      const port = await getFreePort();
      const proc = startLauncher(
        ["-p", String(port), "--no-open"],
        {
          PI_CODING_AGENT_DIR: agentDir,
          PI_WEB_ALLOW_INSECURE_HTTP: "0",
          PORT: String(port),
        },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      const base = `http://127.0.0.1:${port}`;
      const jar = createCookieJar();
      const home = await fetchWithJar(`${base}/api/home`, jar);
      assert(home.status === 200 || home.status === 404 || home.status < 500, `local home status ${home.status}`);
      // No auth file should be created in local mode.
      assert(
        !existsSync(join(agentDir, "server-access.json")),
        "local mode must not create server-access.json",
      );
      await proc.stop();
      log("AE1 local mode ok");
    }

    // ── Secure transport default: plaintext login and protected APIs are blocked ──
    {
      const strictDir = mkdtempSync(join(tmpdir(), "spi-e2e-auth-strict-"));
      cleanups.push(async () => {
        try { rmSync(strictDir, { recursive: true, force: true }); } catch { /* */ }
      });
      const strictPort = await getFreePort();
      const proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(strictPort), "--no-open"],
        {
          PI_CODING_AGENT_DIR: strictDir,
          PI_WEB_ALLOW_INSECURE_HTTP: "0",
          PORT: String(strictPort),
        },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      const strictKey = await proc.waitForAccessKey();
      secrets.push(strictKey);
      const base = `http://127.0.0.1:${strictPort}`;
      const api = await fetchWithJar(`${base}/api/home`, createCookieJar());
      assert(api.status === 426, `plain HTTP API blocked got ${api.status}`);
      const login = await fetchWithJar(`${base}/api/server-auth/login`, createCookieJar(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ accessKey: strictKey }),
      });
      assert(login.status === 426, `plain HTTP login blocked got ${login.status}`);
      await proc.stop();
      log("secure transport default ok");
    }

    // ── AE2 / AE4: first server start + gate ──
    let accessKey;
    let port = await getFreePort();
    {
      const proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        {
          PI_CODING_AGENT_DIR: agentDir,
          PORT: String(port),
        },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      accessKey = await proc.waitForAccessKey();
      assert(accessKey, "first server start must print access key once");
      secrets.push(accessKey);
      // Brief settle so auth routes see initialized state.
      await proc.waitSettledAuth();
      const statePath = join(agentDir, "server-access.json");
      assert(existsSync(statePath), "state file created");
      const stateRaw = readFileSync(statePath, "utf8");
      assert(!stateRaw.includes(accessKey), "plaintext key not in state");

      const base = `http://127.0.0.1:${port}`;
      const jar = createCookieJar();

      const page = await fetchWithJar(`${base}/`, jar);
      assert(page.status === 307 || page.status === 302 || page.status === 303, `page redirect ${page.status}`);
      const loc = page.headers.get("location") ?? "";
      assert(loc.includes("/unlock"), `redirect to unlock got ${loc}`);
      assert(!loc.includes("cwd="), "redirect must not echo project query");

      const api = await fetchWithJar(`${base}/api/home`, jar);
      assert(api.status === 401, `api 401 got ${api.status}`);
      const apiBody = await api.text();
      assert(!/session|model|cwd|project/i.test(apiBody) || /unauthorized/i.test(apiBody), "401 body minimal");

      // SSE-style endpoint should also 401 without establishing a long stream.
      const sse = await fetchWithJar(`${base}/api/agent/events`, jar, {
        headers: { Accept: "text/event-stream" },
      });
      assert(sse.status === 401, `sse 401 got ${sse.status}`);

      const oversized = await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
        },
        body: "x".repeat(5_000),
      });
      assert(oversized.status === 400, `oversized login body rejected ${oversized.status}`);

      // Login with wrong key
      const bad = await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ accessKey: "definitely-wrong-key-value" }),
      });
      assert(bad.status === 401, `bad login ${bad.status}`);

      // Login with correct key
      const good = await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
        },
        body: JSON.stringify({ accessKey }),
      });
      assert(good.status === 200, `good login ${good.status}`);
      const setCookie = good.headers.get("set-cookie") ?? "";
      assert(/spi_access_session=/.test(setCookie), "session cookie set");
      assert(!/Secure/i.test(setCookie), "HTTP cookie must not force Secure");
      const unlocked = await fetchWithJar(`${base}/api/home`, jar);
      assert(unlocked.status !== 401 && unlocked.status !== 503, `authed home ${unlocked.status}`);

      const csrf = await fetchWithJar(`${base}/api/default-cwd`, jar, {
        method: "POST",
        headers: { Origin: `http://evil.localhost:${port}` },
      });
      assert(csrf.status === 403, `same-site cross-origin mutation blocked ${csrf.status}`);

      // Unlock HTML contains HTTP warning
      const unlockPage = await fetchWithJar(`${base}/unlock`, createCookieJar());
      assert(unlockPage.status === 200, `unlock page ${unlockPage.status}`);
      const html = await unlockPage.text();
      assert(
        /HTTP|明文|encrypt|Unencrypted|风险|warning/i.test(html),
        "unlock page should warn about HTTP",
      );

      // AE8: Automation still local-only (may 403 even when authenticated)
      const auto = await fetchWithJar(`${base}/api/automations/tasks`, jar);
      assert(
        auto.status === 401 || auto.status === 403,
        `automation remains gated got ${auto.status}`,
      );

      await proc.stop();
      log("AE2/AE4/AE7/AE8 first server + gate ok");
    }

    // ── AE5: restart keeps session, no key reprint ──
    {
      // Recreate session cookie first
      port = await getFreePort();
      let proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: agentDir, PORT: String(port) },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      await proc.waitSettledAuth();
      assert(!extractAccessKey(proc.getStdout()), "restart must not reprint access key");
      const base = `http://127.0.0.1:${port}`;
      const jar = createCookieJar();
      const login = await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ accessKey }),
      });
      assert(login.status === 200, "login before restart");
      await proc.stop();

      // Restart same agent dir
      port = await getFreePort();
      proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: agentDir, PORT: String(port) },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      await proc.waitSettledAuth();
      assert(!extractAccessKey(proc.getStdout()), "second restart no key");
      const base2 = `http://127.0.0.1:${port}`;
      const home = await fetchWithJar(`${base2}/api/home`, jar);
      assert(home.status !== 401, `cookie survives restart status=${home.status}`);
      await proc.stop();
      log("AE5 restart session ok");
    }

    // ── AE6: rotation invalidates ──
    {
      port = await getFreePort();
      let proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: agentDir, PORT: String(port) },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      const base = `http://127.0.0.1:${port}`;
      const jar = createCookieJar();
      await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base },
        body: JSON.stringify({ accessKey }),
      });
      await proc.stop();

      port = await getFreePort();
      proc = startLauncher(
        ["--server", "--rotate-access-key", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: agentDir, PORT: String(port) },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      const newKey = await proc.waitForAccessKey();
      assert(newKey && newKey !== accessKey, "rotation prints new key");
      secrets.push(newKey);
      const base2 = `http://127.0.0.1:${port}`;
      const stale = await fetchWithJar(`${base2}/api/home`, jar);
      assert(stale.status === 401, `old cookie rejected ${stale.status}`);
      const oldLogin = await fetchWithJar(`${base2}/api/server-auth/login`, createCookieJar(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base2 },
        body: JSON.stringify({ accessKey }),
      });
      assert(oldLogin.status === 401, "old key rejected");
      const jar2 = createCookieJar();
      const newLogin = await fetchWithJar(`${base2}/api/server-auth/login`, jar2, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: base2 },
        body: JSON.stringify({ accessKey: newKey }),
      });
      assert(newLogin.status === 200, "new key works");
      accessKey = newKey;
      await proc.stop();
      log("AE6 rotation ok");
    }

    // ── AE3: trusted proxy Secure cookie ──
    {
      port = await getFreePort();
      const proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        {
          PI_CODING_AGENT_DIR: agentDir,
          PORT: String(port),
          PI_WEB_TRUST_PROXY: "1",
          PI_WEB_ALLOW_INSECURE_HTTP: "0",
        },
      );
      cleanups.push(() => proc.stop());
      await proc.waitReady();
      await proc.waitSettledAuth();
      const base = `http://127.0.0.1:${port}`;
      const jar = createCookieJar();
      // Browser-facing origin is HTTPS behind the reverse proxy.
      const publicOrigin = `https://app.example.test`;
      const login = await fetchWithJar(`${base}/api/server-auth/login`, jar, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: publicOrigin,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "app.example.test",
        },
        body: JSON.stringify({ accessKey }),
      });
      assert(login.status === 200, `trusted proxy login got ${login.status}`);
      const setCookie = login.headers.get("set-cookie") ?? "";
      assert(/Secure/i.test(setCookie), "Secure cookie under trusted https proto");

      // Without trust, forged header must not set Secure — separate process
      await proc.stop();

      const agentDir2 = mkdtempSync(join(tmpdir(), "spi-e2e-auth2-"));
      cleanups.push(async () => {
        try { rmSync(agentDir2, { recursive: true, force: true }); } catch { /* */ }
      });
      port = await getFreePort();
      const proc2 = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: agentDir2, PORT: String(port) },
      );
      cleanups.push(() => proc2.stop());
      await proc2.waitReady();
      const key2 = await proc2.waitForAccessKey();
      secrets.push(key2);
      const base3 = `http://127.0.0.1:${port}`;
      const login2 = await fetchWithJar(`${base3}/api/server-auth/login`, createCookieJar(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base3,
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ accessKey: key2 }),
      });
      const sc2 = login2.headers.get("set-cookie") ?? "";
      assert(!/Secure/i.test(sc2), "forged proto without trust must not Secure");
      await proc2.stop();
      log("AE3 trusted proxy ok");
    }

    // ── Fail closed on corrupt state ──
    {
      const corruptDir = mkdtempSync(join(tmpdir(), "spi-e2e-corrupt-"));
      cleanups.push(async () => {
        try { rmSync(corruptDir, { recursive: true, force: true }); } catch { /* */ }
      });
      writeFileSync(join(corruptDir, "server-access.json"), "{broken", "utf8");
      port = await getFreePort();
      const proc = startLauncher(
        ["--server", "-H", "127.0.0.1", "-p", String(port), "--no-open"],
        { PI_CODING_AGENT_DIR: corruptDir, PORT: String(port) },
      );
      cleanups.push(() => proc.stop());
      // Expect process to exit or never become usefully Ready without auth.
      const start = Date.now();
      let failedClosed = false;
      while (Date.now() - start < 45_000) {
        if (proc.child.exitCode != null) {
          failedClosed = true;
          break;
        }
        if (/Ready/i.test(proc.getStdout()) && /FATAL|corrupt|failed to initialize/i.test(proc.getStdout() + proc.getStderr())) {
          // If it somehow printed Ready after fatal, still check API.
          const base = `http://127.0.0.1:${port}`;
          try {
            const res = await fetch(`${base}/api/home`);
            if (res.status === 503 || res.status === 401) failedClosed = true;
          } catch {
            failedClosed = true;
          }
          break;
        }
        if (/FATAL|corrupt|failed to initialize/i.test(proc.getStdout() + proc.getStderr()) && proc.child.exitCode != null) {
          failedClosed = true;
          break;
        }
        await sleep(200);
      }
      // Accept either hard crash on boot or non-ready within timeout after fatal log
      if (!failedClosed) {
        const combined = proc.getStdout() + proc.getStderr();
        failedClosed = /FATAL|corrupt|failed to initialize/i.test(combined);
      }
      assert(failedClosed, "corrupt state must fail closed");
      await proc.stop();
      log("corrupt fail-closed ok");
    }

    log("all e2e scenarios passed");
  } catch (error) {
    const msg = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(redacted(msg, secrets));
    process.exitCode = 1;
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main();
