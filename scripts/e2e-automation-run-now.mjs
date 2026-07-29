/**
 * Authenticated draft → activate → run-now E2E against a live server.
 * Requires non-worker_exit terminal status.
 *
 * Usage: node scripts/e2e-automation-run-now.mjs --port 62901 --label prod --mode start
 */
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return def;
}
const port = Number(flag("port", "62901"));
const label = flag("label", "e2e");
const mode = flag("mode", "start"); // start | dev
// Next.js request URL host is typically `localhost` even when bound to 127.0.0.1.
// Same-origin checks compare Origin/Referer host to req.url.host — use localhost.
const base = `http://localhost:${port}`;
const bindHost = "127.0.0.1";

const agentDir = mkdtempSync(join(tmpdir(), `auto-e2e-${label}-`));
const cwdDir = join(agentDir, "proj");
mkdirSync(cwdDir, { recursive: true });
writeFileSync(join(cwdDir, "README.md"), "# e2e\n", "utf8");
// Seed auth/models so activate preflight can pass without real network credentials.
// The run may still fail at the provider call; acceptance requires non-worker_exit.
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify(
    {
      anthropic: { type: "api_key", key: "sk-ant-e2e-test-not-real" },
    },
    null,
    2,
  ),
  "utf8",
);
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        anthropic: {
          models: [{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" }],
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PORT: String(port),
  AUTOMATION_WORKER_HOST_PATH: join(process.cwd(), "lib", "automation-worker-runtime.cjs"),
};

function log(...m) {
  console.log(`[${label}]`, ...m);
}

async function waitHealth(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/`, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {
      // retry
    }
    await sleep(400);
  }
  throw new Error("server did not become ready");
}

async function issueControlSession() {
  const r = await fetch(`${base}/api/automations/session`, {
    method: "POST",
    headers: {
      Origin: base,
      Referer: `${base}/`,
      "content-type": "application/json",
    },
  });
  const setCookie = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  let cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (!cookieHeader) {
    const sc = r.headers.get("set-cookie");
    if (sc) cookieHeader = sc.split(",").map((c) => c.split(";")[0].trim()).join("; ");
  }
  const body = await r.json().catch(() => ({}));
  return { cookieHeader, body, status: r.status };
}

async function api(path, { method = "GET", cookie, body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: base,
      Referer: `${base}/`,
      "content-type": "application/json",
      cookie: cookie || "",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}

async function challengeAndConfirm(cookie, action, fields) {
  const ch = await api("/api/automations/approvals", {
    method: "POST",
    cookie,
    body: { action, ...fields },
  });
  if (ch.status >= 400) throw new Error(`challenge failed ${ch.status} ${JSON.stringify(ch.json)}`);
  const challengeId = ch.json.challengeId ?? ch.json.id ?? ch.json.challenge?.id;
  if (!challengeId) throw new Error(`no challengeId: ${JSON.stringify(ch.json)}`);
  const conf = await api("/api/automations/approvals/confirm", {
    method: "POST",
    cookie,
    body: { challengeId },
  });
  if (conf.status >= 400) throw new Error(`confirm failed ${conf.status} ${JSON.stringify(conf.json)}`);
  const secret = conf.json.secret ?? conf.json.challenge?.secret;
  if (!secret) throw new Error(`no secret after confirm: ${JSON.stringify(conf.json)}`);
  return { challengeId, secret };
}

let child = null;
let serverLog = "";
try {
  if (!existsSync(env.AUTOMATION_WORKER_HOST_PATH)) {
    throw new Error(`worker missing: ${env.AUTOMATION_WORKER_HOST_PATH}`);
  }

  const cmd =
    mode === "dev"
      ? ["node_modules/next/dist/bin/next", "dev", "-p", String(port), "-H", bindHost]
      : ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", bindHost];

  log("starting", mode, "on", port);
  child = spawn(process.execPath, cmd, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    serverLog += d.toString();
  });
  child.stderr.on("data", (d) => {
    serverLog += d.toString();
  });
  child.on("exit", (code) => {
    log("server exited", code);
  });

  await waitHealth(mode === "dev" ? 180_000 : 90_000);
  log("server up");

  const { cookieHeader, status: csStatus } = await issueControlSession();
  log("control session", csStatus, cookieHeader ? "cookie-ok" : "no-cookie");
  if (!cookieHeader) throw new Error("no control session cookie");

  const draft = await api("/api/automations/tasks", {
    method: "POST",
    cookie: cookieHeader,
    body: {
      name: `e2e-${label}`,
      description: "e2e",
      cron: "0 8 * * *",
      timezone: "UTC",
      cwd: cwdDir,
      cwdSource: "project",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      prompt: "Say hello in one word.",
      tools: [{ name: "read", origin: "builtin" }],
      maxRuntimeMs: 120_000,
    },
  });
  log("draft", draft.status, draft.json?.task?.id ?? draft.json);
  if (draft.status >= 400) throw new Error(`draft failed: ${JSON.stringify(draft.json)}`);
  const taskId = draft.json.task.id;
  let revision = draft.json.task.revision;

  const actProof = await challengeAndConfirm(cookieHeader, "activate", {
    taskId,
    revision,
  });
  const act = await api(`/api/automations/tasks/${taskId}/actions`, {
    method: "POST",
    cookie: cookieHeader,
    body: {
      action: "activate",
      expectedRevision: revision,
      challengeId: actProof.challengeId,
      secret: actProof.secret,
    },
  });
  log("activate", act.status, act.json?.task?.status ?? act.json);
  if (act.status >= 400) throw new Error(`activate failed: ${JSON.stringify(act.json)}`);
  revision = act.json.task.revision;

  const runProof = await challengeAndConfirm(cookieHeader, "run_now", {
    taskId,
    revision,
  });
  const runRes = await api(`/api/automations/tasks/${taskId}/runs`, {
    method: "POST",
    cookie: cookieHeader,
    body: {
      expectedRevision: revision,
      challengeId: runProof.challengeId,
      secret: runProof.secret,
    },
  });
  log("run-now", runRes.status, runRes.json?.run?.id ?? runRes.json);
  if (runRes.status >= 400) throw new Error(`run-now failed: ${JSON.stringify(runRes.json)}`);
  const runId = runRes.json.run.id;

  let final = runRes.json.run;
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000);
    const g = await api(`/api/automations/runs/${runId}`, { cookie: cookieHeader });
    final = g.json?.run ?? g.json;
    if (
      final?.terminal ||
      ["succeeded", "failed", "blocked", "timed_out", "cancelled", "ambiguous", "skipped"].includes(
        final?.status,
      )
    ) {
      break;
    }
    if (i % 5 === 0) log("poll", final?.status, final?.errorCategory);
  }

  log("final", {
    status: final?.status,
    errorCategory: final?.errorCategory,
    errorMessage: final?.errorMessage,
    terminal: final?.terminal,
  });

  if (final?.errorCategory === "worker_exit") {
    throw new Error(
      `worker_exit failure: ${final?.errorMessage}\nserverLog tail:\n${serverLog.slice(-3000)}`,
    );
  }
  if (final?.errorMessage && /Worker exited with code/.test(String(final.errorMessage))) {
    throw new Error(`worker exit message: ${final.errorMessage}\n${serverLog.slice(-2000)}`);
  }
  if (!final?.status) {
    throw new Error(`no final status: ${JSON.stringify(final)}`);
  }

  console.log(
    `E2E_${label.toUpperCase()}_OK status=${final.status} category=${final.errorCategory ?? "none"}`,
  );
  process.exitCode = 0;
} catch (error) {
  console.error(`E2E_${label.toUpperCase()}_FAIL`, error);
  if (serverLog) console.error("serverLog tail:\n", serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  if (child && !child.killed) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // ignore
    }
    await sleep(1500);
  }
  try {
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
