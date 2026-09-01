/**
 * Production startup E2E for WebUI-bundled Pi extensions.
 * Requires a prior `npm run build` so it exercises the emitted Next server chunks.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(ROOT, "bin", "pi-web.js");
const EXPECTED_TOOLS = [
  "subagent",
  "subagent_wait",
  "web_search",
  "web_fetch",
  "ask_user",
  "manage_todo_list",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(child.exitCode != null), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopProcessTree(child) {
  if (child.exitCode != null) return;

  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
  } else {
    child.kill("SIGTERM");
  }

  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2_000);
}

async function waitForResources(port, workspace, child, getLogs) {
  const deadline = Date.now() + 90_000;
  const url = `http://127.0.0.1:${port}/api/pi/resources?cwd=${encodeURIComponent(workspace)}`;
  let lastError;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Production server exited early with code ${child.exitCode}.\n${getLogs()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`Resource diagnostics returned HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for production resource diagnostics: ${String(lastError)}\n${getLogs()}`);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "spi-prod-bundled-ext-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const port = await getFreePort();
  const env = {
    ...process.env,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_SERVER_MODE: "0",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PI_WEB_TRUST_PROXY: "0",
    PI_WEB_ALLOW_INSECURE_HTTP: "0",
    PI_WEB_ROTATE_ACCESS_KEY: "0",
    PI_WEB_AUTH_BYPASS_CIDRS: "",
    PI_WEB_LAUNCH_COMMAND: "start",
  };
  const child = spawn(
    process.execPath,
    [LAUNCHER, "--no-open", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const resources = await waitForResources(port, workspace, child, () => `stdout:\n${stdout}\nstderr:\n${stderr}`);
    const bundles = Array.isArray(resources.bundledExtensions) ? resources.bundledExtensions : [];
    assert(bundles.length === 4, `Expected four bundled extensions, received ${bundles.length}`);
    for (const bundle of bundles) {
      assert(bundle.enabled === true, `${bundle.id} must default to enabled in a fresh agent directory`);
      assert(bundle.available === true, `${bundle.id} is unavailable: ${bundle.diagnostic ?? "no diagnostic"}`);
      assert(
        bundle.installedVersion === bundle.pinnedVersion,
        `${bundle.id} resolved ${bundle.installedVersion ?? "no version"}, expected ${bundle.pinnedVersion}`,
      );
    }

    const toolNames = new Set((resources.tools ?? []).map((tool) => tool.name));
    for (const toolName of EXPECTED_TOOLS) {
      assert(toolNames.has(toolName), `Production session resource schema is missing ${toolName}`);
    }
    const bundleErrors = (resources.diagnostics ?? []).filter((diagnostic) =>
      String(diagnostic.path ?? "").startsWith("<webui-bundled:"),
    );
    assert(bundleErrors.length === 0, `Production bundle diagnostics contain errors: ${JSON.stringify(bundleErrors)}`);

    console.log("Production bundled Pi extension E2E passed.");
  } finally {
    await stopProcessTree(child);
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
