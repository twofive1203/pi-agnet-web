import { existsSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const PI_CLI_SEGMENTS = [
  ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
  ["node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"],
];

const EXPLICIT_PI_CLI_ENV_KEYS = ["PI_WEB_PI_CLI_JS", "TRELLIS_PI_CLI_JS"] as const;
const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

interface PreparePiRuntimeEnvironmentOptions {
  cwd: string;
  agentDir: string;
}

interface PiCliResolution {
  cliPath: string;
  source: string;
}

interface PiRuntimeEnvironmentResult {
  ok: boolean;
  cliPath?: string;
  shimPath?: string;
  packageLinkPath?: string;
  source?: string;
  error?: string;
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function addPackageCliCandidates(candidates: string[], base: string | undefined): void {
  if (!base) return;
  for (const segments of PI_CLI_SEGMENTS) {
    candidates.push(join(base, ...segments));
  }
}

function resolveExplicitCli(): PiCliResolution | undefined {
  for (const key of EXPLICIT_PI_CLI_ENV_KEYS) {
    const value = trimEnv(process.env[key]);
    if (!value) continue;
    const cliPath = resolve(value);
    if (existsSync(cliPath)) return { cliPath, source: key };
  }
  return undefined;
}

function resolveLocalPiCli(cwd: string, agentDir: string): PiCliResolution | undefined {
  const explicit = resolveExplicitCli();
  if (explicit) return explicit;

  const candidates: string[] = [];
  for (const arg of process.argv) {
    if (/pi-coding-agent[\\/]dist[\\/]cli\.js$/i.test(arg)) {
      candidates.push(resolve(arg));
    }
  }

  addPackageCliCandidates(candidates, cwd);
  addPackageCliCandidates(candidates, process.cwd());
  addPackageCliCandidates(candidates, join(agentDir, "npm"));

  const prefix = trimEnv(process.env.npm_config_prefix) ?? trimEnv(process.env.NPM_CONFIG_PREFIX);
  if (prefix) {
    addPackageCliCandidates(candidates, prefix);
    addPackageCliCandidates(candidates, join(prefix, "lib"));
  }

  const appData = trimEnv(process.env.APPDATA);
  if (appData) addPackageCliCandidates(candidates, join(appData, "npm"));

  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    addPackageCliCandidates(candidates, dir);
    addPackageCliCandidates(candidates, dirname(dir));
    addPackageCliCandidates(candidates, join(dirname(dir), "lib"));
  }

  for (const candidate of [...new Set(candidates)]) {
    if (existsSync(candidate)) return { cliPath: candidate, source: "local-package" };
  }
  return undefined;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeCmdPath(value: string): string {
  return value.replace(/%/g, "%%");
}

function ensurePiPackageResolution(agentDir: string, cliPath: string): string | undefined {
  const packageRoot = dirname(dirname(cliPath));
  const packageLinkPath = join(agentDir, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(join(packageLinkPath, "package.json"))) return packageLinkPath;

  try {
    if (lstatSync(packageLinkPath).isSymbolicLink()) rmSync(packageLinkPath, { recursive: true, force: true });
  } catch {
    // Missing paths are expected; non-link directories are left untouched.
  }

  try {
    mkdirSync(dirname(packageLinkPath), { recursive: true });
    symlinkSync(packageRoot, packageLinkPath, process.platform === "win32" ? "junction" : "dir");
    return packageLinkPath;
  } catch {
    // The PATH/binary shim still helps Unix-like launches, and the main web
    // session should not fail just because this optional compatibility link
    // cannot be created.
    return undefined;
  }
}

function writePiShim(agentDir: string, cliPath: string): { shimDir: string; shimPath: string } {
  const shimDir = join(agentDir, "pi-web-runtime", "bin");
  mkdirSync(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = join(shimDir, "pi.cmd");
    const content = [
      "@echo off",
      "setlocal",
      `"${escapeCmdPath(process.execPath)}" "${escapeCmdPath(cliPath)}" %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
    writeFileSync(shimPath, content, "utf-8");
    return { shimDir, shimPath };
  }

  const shimPath = join(shimDir, "pi");
  const content = [
    "#!/usr/bin/env sh",
    `exec ${quoteShell(process.execPath)} ${quoteShell(cliPath)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(shimPath, content, { encoding: "utf-8", mode: 0o755 });
  chmodSync(shimPath, 0o755);
  return { shimDir, shimPath };
}

function pathEnvKey(): "PATH" | "Path" {
  return Object.keys(process.env).find((key) => key.toLowerCase() === "path") === "Path" ? "Path" : "PATH";
}

function prependPathOnce(dir: string): void {
  const key = pathEnvKey();
  const current = process.env[key] ?? "";
  const parts = current.split(delimiter).filter(Boolean);
  const normalized = process.platform === "win32" ? dir.toLowerCase() : dir;
  const exists = parts.some((part) => (process.platform === "win32" ? part.toLowerCase() : part) === normalized);
  if (!exists) process.env[key] = [dir, ...parts].join(delimiter);
}

/**
 * Prepare a deterministic Pi CLI executable for extension tools that spawn
 * nested Pi processes. In web/PM2/desktop launches the process PATH often does
 * not contain `pi`, while pi-subagents still shells out to a Pi runtime. This
 * creates a local `pi` shim pointing at the same package CLI used by the WebUI
 * dependency. Unix-like runtimes also receive pi-subagents' binary override;
 * Windows receives a package-resolution link because shell-less Node spawns
 * cannot execute .cmd shims directly.
 */
export function preparePiRuntimeEnvironment(options: PreparePiRuntimeEnvironmentOptions): PiRuntimeEnvironmentResult {
  try {
    const resolution = resolveLocalPiCli(options.cwd, options.agentDir);
    if (!resolution) {
      return { ok: false, error: "Unable to locate @earendil-works/pi-coding-agent dist/cli.js" };
    }

    const packageLinkPath = ensurePiPackageResolution(options.agentDir, resolution.cliPath);
    const { shimDir, shimPath } = writePiShim(options.agentDir, resolution.cliPath);
    prependPathOnce(shimDir);

    process.env.PI_WEB_PI_CLI_JS = resolution.cliPath;
    if (!trimEnv(process.env.TRELLIS_PI_CLI_JS)) process.env.TRELLIS_PI_CLI_JS = resolution.cliPath;
    // pi-subagents' Windows path can resolve a package CLI and spawn it through
    // Node. Do not point PI_SUBAGENT_PI_BINARY at a .cmd shim on Windows: Node's
    // shell-less spawn rejects direct .cmd execution. The package-resolution
    // link above is the Windows compatibility path; Unix can spawn the shim.
    if (process.platform !== "win32" && !trimEnv(process.env[PI_SUBAGENT_PI_BINARY_ENV])) {
      process.env[PI_SUBAGENT_PI_BINARY_ENV] = shimPath;
    }

    return {
      ok: true,
      cliPath: resolution.cliPath,
      shimPath,
      packageLinkPath,
      source: resolution.source,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
