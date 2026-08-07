"use strict";

/**
 * Pure launcher option parsing shared by spi / npm start / npm run dev / PM2.
 * CommonJS so the published npx entry can require it without a TS build step.
 */

/**
 * @typedef {"loopback" | "wildcard" | "remote"} HostnameClass
 */

/**
 * @typedef {object} RuntimeOptions
 * @property {string} port
 * @property {string} hostname
 * @property {boolean} serverMode
 * @property {boolean} rotateAccessKey
 * @property {boolean} openBrowser
 * @property {boolean} trustProxy
 * @property {string | null} httpProxy
 * @property {string | null} socksProxy
 * @property {string | null} noProxy
 * @property {"start" | "dev"} nextCommand
 * @property {boolean} requireBuild
 * @property {string[]} nextArgs
 * @property {Record<string, string>} envOverrides
 * @property {string[]} warnings
 */

/**
 * @param {string | null | undefined} hostname
 * @returns {HostnameClass}
 */
function classifyHostname(hostname) {
  if (!hostname) return "loopback";
  const h = String(hostname).trim().toLowerCase();
  if (!h) return "loopback";

  // Strip IPv6 brackets.
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;

  if (bare === "localhost" || bare.endsWith(".localhost")) return "loopback";
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return "loopback";
  if (bare === "0.0.0.0" || bare === "::" || bare === "0:0:0:0:0:0:0:0") return "wildcard";

  // IPv4 loopback 127.0.0.0/8
  const v4 = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map((p) => Number(p));
    if (parts.every((n) => n >= 0 && n <= 255)) {
      if (parts[0] === 127) return "loopback";
      if (parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0) return "wildcard";
      return "remote";
    }
  }

  // IPv4-mapped IPv6 ::ffff:127.0.0.1
  const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return classifyHostname(mapped[1]);

  // Other IPv6: treat link-local / unique-local / global as remote; only ::1 is loopback above.
  if (bare.includes(":")) return "remote";

  // DNS names are non-loopback.
  return "remote";
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function envFlagEnabled(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * @param {object} input
 * @param {string[]} [input.argv]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [input.env]
 * @param {"start" | "dev"} [input.command]
 * @returns {RuntimeOptions}
 */
function resolveRuntimeOptions(input = {}) {
  const argv = Array.isArray(input.argv) ? input.argv.slice(2) : [];
  const env = input.env ?? process.env;

  /** @type {Record<string, string | boolean | undefined>} */
  const flags = {};
  /** @type {string[]} */
  const unknown = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--server") {
      flags.server = true;
      continue;
    }
    if (arg === "--dev") {
      flags.dev = true;
      continue;
    }
    if (arg === "--rotate-access-key") {
      flags.rotateAccessKey = true;
      continue;
    }
    if (arg === "--no-open") {
      flags.noOpen = true;
      continue;
    }
    if (arg === "--open") {
      flags.open = true;
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      flags.port = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      flags.port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--hostname" || arg === "-H") {
      flags.hostname = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--hostname=")) {
      flags.hostname = arg.slice("--hostname=".length);
      continue;
    }
    if (arg === "--proxy") {
      flags.proxy = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--proxy=")) {
      flags.proxy = arg.slice("--proxy=".length);
      continue;
    }
    if (arg === "--socks-proxy") {
      flags.socksProxy = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--socks-proxy=")) {
      flags.socksProxy = arg.slice("--socks-proxy=".length);
      continue;
    }
    if (arg === "--no-proxy") {
      flags.noProxy = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--no-proxy=")) {
      flags.noProxy = arg.slice("--no-proxy=".length);
      continue;
    }
    if (arg.startsWith("-")) {
      unknown.push(arg);
    }
  }

  if (flags.help) {
    const err = new Error("HELP");
    // @ts-expect-error tag
    err.code = "HELP";
    throw err;
  }

  const command =
    flags.dev === true ||
    input.command === "dev" ||
    env.PI_WEB_LAUNCH_COMMAND === "dev"
      ? "dev"
      : "start";

  const port = String(flags.port ?? env.PORT ?? "62666");
  const explicitHostname =
    (typeof flags.hostname === "string" && flags.hostname.trim()) ||
    (typeof env.PI_WEB_HOSTNAME === "string" && env.PI_WEB_HOSTNAME.trim()) ||
    null;

  const serverFlag =
    flags.server === true || envFlagEnabled(env.PI_WEB_SERVER_MODE);

  const hostnameClass = classifyHostname(explicitHostname);
  const nonLoopback = hostnameClass === "wildcard" || hostnameClass === "remote";

  // Server mode: explicit --server / PI_WEB_SERVER_MODE, or any non-loopback bind.
  const serverMode = serverFlag || nonLoopback;

  let hostname;
  if (explicitHostname) {
    hostname = explicitHostname;
  } else if (serverFlag) {
    hostname = "0.0.0.0";
  } else {
    hostname = "127.0.0.1";
  }

  const rotateAccessKey =
    flags.rotateAccessKey === true || envFlagEnabled(env.PI_WEB_ROTATE_ACCESS_KEY);

  if (rotateAccessKey && !serverMode) {
    const err = new Error(
      "--rotate-access-key requires server mode (--server, PI_WEB_SERVER_MODE=1, or a non-loopback hostname)",
    );
    // @ts-expect-error tag
    err.code = "ROTATE_REQUIRES_SERVER";
    throw err;
  }

  const trustProxy = envFlagEnabled(env.PI_WEB_TRUST_PROXY);
  if (trustProxy && classifyHostname(hostname) !== "loopback") {
    const err = new Error(
      "PI_WEB_TRUST_PROXY=1 requires a loopback backend bind (e.g. --server -H 127.0.0.1)",
    );
    // @ts-expect-error tag
    err.code = "TRUST_PROXY_REQUIRES_LOOPBACK";
    throw err;
  }

  /** @type {string[]} */
  const warnings = [];
  if (serverMode) {
    warnings.push(
      "Server access authentication is enabled. HTTP does not encrypt the access key or session cookie; use an HTTPS reverse proxy for any untrusted network.",
    );
  }

  // Browser open: local default yes; server mode default no; flags override.
  let openBrowser = !serverMode;
  if (flags.noOpen === true) openBrowser = false;
  if (flags.open === true) openBrowser = true;

  const httpProxy =
    (typeof flags.proxy === "string" && flags.proxy) ||
    env.PROXY_URL ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    null;
  const socksProxy =
    (typeof flags.socksProxy === "string" && flags.socksProxy) ||
    env.SOCKS_PROXY_URL ||
    env.ALL_PROXY ||
    env.all_proxy ||
    null;
  const noProxy =
    (typeof flags.noProxy === "string" && flags.noProxy) ||
    env.NO_PROXY ||
    env.no_proxy ||
    null;

  /** @type {Record<string, string>} */
  const envOverrides = {
    PORT: port,
    PI_WEB_HOSTNAME: hostname,
  };
  if (serverMode) {
    envOverrides.PI_WEB_SERVER_MODE = "1";
  } else {
    envOverrides.PI_WEB_SERVER_MODE = "0";
  }
  if (rotateAccessKey) {
    envOverrides.PI_WEB_ROTATE_ACCESS_KEY = "1";
  }
  if (trustProxy) {
    envOverrides.PI_WEB_TRUST_PROXY = "1";
  } else {
    envOverrides.PI_WEB_TRUST_PROXY = "0";
  }

  const nextArgs = [command, "-p", port, "-H", hostname];

  return {
    port,
    hostname,
    serverMode,
    rotateAccessKey,
    openBrowser,
    trustProxy,
    httpProxy: httpProxy ? String(httpProxy) : null,
    socksProxy: socksProxy ? String(socksProxy) : null,
    noProxy: noProxy ? String(noProxy) : null,
    nextCommand: command,
    requireBuild: command === "start",
    nextArgs,
    envOverrides,
    warnings,
    // @ts-expect-error extra debug
    unknownFlags: unknown,
  };
}

function printHelp(stdout = console.log) {
  stdout(`Snail Pi Web (spi)

Usage:
  spi [options]
  spi --server [options]
  spi --server --rotate-access-key
  spi --dev [options]

Options:
  --dev                     Run next dev (used by npm run dev)
  -p, --port <port>         Port (default: 62666 or PORT)
  -H, --hostname <host>     Listen address (default: 127.0.0.1;
                            with --server default: 0.0.0.0)
  --server                  Enable global access authentication.
                            Implied by any non-loopback hostname.
  --rotate-access-key       Generate a new access key and invalidate
                            all sessions (requires server mode)
  --no-open                 Do not open a browser on Ready
  --open                    Force open browser on Ready
  --proxy <url>             HTTP(S) proxy for the Node process
  --socks-proxy <url>       SOCKS/ALL proxy
  --no-proxy <list>         NO_PROXY list
  -h, --help                Show help

Environment:
  PORT                      Listen port
  PI_WEB_HOSTNAME           Listen hostname (not system HOSTNAME)
  PI_WEB_SERVER_MODE=1      Force authentication on
  PI_WEB_TRUST_PROXY=1      Trust X-Forwarded-Proto when backend is loopback
  PI_WEB_AUTH_BYPASS_CIDRS  Optional env override for client IPs/CIDRs that
                            skip the access key (socket remote only).
                            Durable default lives in:
                            <agentDir>/server-access-policy.json
                            Example Tailscale range: 100.64.0.0/10
  PI_WEB_ROTATE_ACCESS_KEY=1  Rotate access key on boot
  PI_CODING_AGENT_DIR       Agent data directory (persists access key state)

Security defaults:
  Local starts bind 127.0.0.1 and skip authentication.
  Any official non-loopback listen enables authentication.
  Access keys are shown once at first server start or rotation.
`);
}

module.exports = {
  classifyHostname,
  envFlagEnabled,
  resolveRuntimeOptions,
  printHelp,
};
