#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
const {
  detectMultiInstanceRisk,
  formatRuntimeIdentityLine,
  printHelp,
  resolveProcessInstanceId,
  resolveRuntimeOptions,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./runtime-options");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

function main() {
  let options;
  try {
    options = resolveRuntimeOptions({
      argv: process.argv,
      env: process.env,
    });
  } catch (error) {
    if (error && error.code === "HELP") {
      printHelp();
      process.exit(0);
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  if (options.requireBuild && !fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Run npm run build first, or use npm run dev.");
    process.exit(1);
    return;
  }

  for (const warning of options.warnings) {
    console.warn(`[spi] WARNING: ${warning}`);
  }

  const multiInstance = detectMultiInstanceRisk(process.env);
  if (!multiInstance.ok) {
    for (const reason of multiInstance.reasons) {
      console.error(`[spi] FATAL multi-instance risk: ${reason}`);
    }
    console.error(
      "[spi] Chat sessions, SSE listeners, and access-auth counters are process-local.",
    );
    console.error(
      "[spi] Use ecosystem.config.cjs (instances:1, exec_mode:fork). Sticky routing does not make multi-replica supported.",
    );
    if (multiInstance.fatal) {
      console.error(
        "[spi] Refusing to start. Set PI_WEB_ALLOW_MULTI_INSTANCE=1 only as an emergency override (still unsupported).",
      );
      process.exit(1);
      return;
    }
    console.warn(
      "[spi] WARNING: PI_WEB_ALLOW_MULTI_INSTANCE=1 override active — continuing with unsupported multi-instance markers.",
    );
  }

  const instanceId = resolveProcessInstanceId({ env: process.env, pid: process.pid });

  if (options.serverMode) {
    console.log(
      `[spi] Server mode on ${options.hostname}:${options.port} — global access authentication required.`,
    );
    if (options.rotateAccessKey) {
      console.log("[spi] Access key rotation requested; a new key will be printed once at startup.");
    }
  } else {
    console.log(`[spi] Local mode on ${options.hostname}:${options.port} — authentication disabled.`);
  }
  console.log(
    formatRuntimeIdentityLine({
      pid: process.pid,
      instanceId,
      serverMode: options.serverMode,
      hostname: options.hostname,
      port: options.port,
      singleInstanceOk: multiInstance.ok,
    }),
  );

  function appendNodeOption(current, option) {
    const parts = (current ?? "").split(/\s+/).filter(Boolean);
    return parts.includes(option) ? current ?? "" : [...parts, option].join(" ");
  }

  function createRuntimeEnv(baseEnv) {
    const env = { ...baseEnv, ...options.envOverrides };
    // Propagate a stable id so Next instrumentation / health share the launcher id.
    env.PI_WEB_INSTANCE_ID = instanceId;
    if (options.httpProxy) {
      env.HTTP_PROXY = options.httpProxy;
      env.HTTPS_PROXY = options.httpProxy;
      env.http_proxy = options.httpProxy;
      env.https_proxy = options.httpProxy;
    }
    if (options.socksProxy) {
      env.ALL_PROXY = options.socksProxy;
      env.all_proxy = options.socksProxy;
    }
    if (options.noProxy) {
      env.NO_PROXY = options.noProxy;
      env.no_proxy = options.noProxy;
    }
    if (options.httpProxy || options.socksProxy || options.noProxy) {
      env.NODE_OPTIONS = appendNodeOption(env.NODE_OPTIONS, "--use-env-proxy");
    }
    return env;
  }

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, [nextBin, ...options.nextArgs], {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: createRuntimeEnv(process.env),
  });

  let browserOpened = false;
  const displayHost =
    options.hostname === "0.0.0.0" || options.hostname === "::"
      ? "localhost"
      : options.hostname.includes(":") && !options.hostname.startsWith("[")
        ? `[${options.hostname}]`
        : options.hostname;
  const url = `http://${displayHost}:${options.port}`;

  let readyIdentityLogged = false;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!readyIdentityLogged && /\bReady\b/i.test(text)) {
      readyIdentityLogged = true;
      // Child PID is the Next process that owns sessions/SSE; log it at Ready.
      console.log(
        formatRuntimeIdentityLine({
          pid: child.pid ?? process.pid,
          instanceId,
          serverMode: options.serverMode,
          hostname: options.hostname,
          port: options.port,
          singleInstanceOk: multiInstance.ok,
        }),
      );
    }
    if (options.openBrowser && !browserOpened && text.includes("Ready")) {
      browserOpened = true;
      const isWindows = process.platform === "win32";
      const isMac = process.platform === "darwin";
      const openCmd = isWindows ? "explorer.exe" : isMac ? "open" : "xdg-open";
      spawn(openCmd, [url], { stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  });

  function forwardSignal(signal) {
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  }

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(0);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
