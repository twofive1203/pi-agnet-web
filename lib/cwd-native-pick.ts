/**
 * Open a host-OS folder chooser on the WebUI server machine and return the path.
 * Windows: PowerShell FolderBrowserDialog (STA)
 * macOS: osascript "choose folder"
 * Linux: zenity, then kdialog
 *
 * Only useful when the operator can see the server desktop. Callers must gate
 * with loopback local-access checks and fall back to the web directory picker.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import { existsSync } from "fs";
import { homedir } from "os";
import path from "path";
import { canonicalizeCwd, expandCwd } from "./cwd";

/** Hard cap so a forgotten dialog cannot pin an API worker forever. */
export const NATIVE_PICK_TIMEOUT_MS = 5 * 60 * 1000;

export type NativePickPlatform = "win32" | "darwin" | "linux" | "other";

export type NativePickResult =
  | { ok: true; path: string }
  | { ok: false; code: "cancelled" | "unavailable" | "timeout" | "busy" | "invalid"; error: string };

export interface NativePickCapabilities {
  platform: NativePickPlatform;
  nodePlatform: NodeJS.Platform;
  /** Whether this OS has a known folder-dialog backend we can attempt. */
  nativePickerSupported: boolean;
  /** Backend id used when supported (best-effort; linux may probe at pick time). */
  backend: "powershell-folder-browser" | "osascript" | "zenity" | "kdialog" | "none";
  /** True when a Linux display variable is present (not required on Windows/macOS). */
  hasDisplayHint: boolean;
}

let pickInFlight = false;

export function getNativePickPlatform(nodePlatform: NodeJS.Platform = process.platform): NativePickPlatform {
  if (nodePlatform === "win32") return "win32";
  if (nodePlatform === "darwin") return "darwin";
  if (nodePlatform === "linux" || nodePlatform === "freebsd" || nodePlatform === "openbsd") return "linux";
  return "other";
}

function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where.exe", [command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      });
      return result.status === 0 && Boolean(result.stdout?.trim());
    }
    const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
      encoding: "utf8",
      timeout: 3000,
    });
    return result.status === 0 && Boolean(result.stdout?.trim());
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasUnixDisplay(): boolean {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function resolveLinuxBackend(): "zenity" | "kdialog" | "none" {
  if (commandExists("zenity")) return "zenity";
  if (commandExists("kdialog")) return "kdialog";
  return "none";
}

/**
 * Static capability probe — does not open a dialog.
 * Linux backend presence is checked; Windows/macOS assume the platform tool exists.
 */
export function getNativePickCapabilities(
  nodePlatform: NodeJS.Platform = process.platform,
): NativePickCapabilities {
  const platform = getNativePickPlatform(nodePlatform);
  const hasDisplayHint = platform === "linux" ? hasUnixDisplay() : platform !== "other";

  if (platform === "win32") {
    return {
      platform,
      nodePlatform,
      nativePickerSupported: true,
      backend: "powershell-folder-browser",
      hasDisplayHint,
    };
  }

  if (platform === "darwin") {
    return {
      platform,
      nodePlatform,
      nativePickerSupported: commandExists("osascript"),
      backend: "osascript",
      hasDisplayHint,
    };
  }

  if (platform === "linux") {
    const backend = resolveLinuxBackend();
    return {
      platform,
      nodePlatform,
      nativePickerSupported: backend !== "none" && hasDisplayHint,
      backend,
      hasDisplayHint,
    };
  }

  return {
    platform,
    nodePlatform,
    nativePickerSupported: false,
    backend: "none",
    hasDisplayHint: false,
  };
}

function safeInitialDirectory(raw?: string | null): string | undefined {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return undefined;
  try {
    const expanded = expandCwd(trimmed);
    const canonical = canonicalizeCwd(expanded);
    if (existsSync(canonical)) return canonical;
  } catch {
    // ignore invalid start paths
  }
  return undefined;
}

function normalizePickedPath(raw: string): string | null {
  let value = raw.trim();
  // osascript often returns paths with a trailing slash.
  if (value.length > 1 && (value.endsWith("/") || value.endsWith("\\"))) {
    value = value.replace(/[/\\]+$/, "");
  }
  // Strip wrapping quotes some shells emit.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return null;
  try {
    return canonicalizeCwd(value);
  } catch {
    try {
      return path.resolve(expandCwd(value));
    } catch {
      return null;
    }
  }
}

function buildWindowsScript(initialPath?: string): string {
  const description = "Select project folder";
  const selected = initialPath
    ? `$dialog.SelectedPath = ${psString(initialPath)}; `
    : `$dialog.SelectedPath = ${psString(homedir())}; `;
  // STA is required for WinForms dialogs. Output only the selected path on OK.
  return [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
    `$dialog.Description = ${psString(description)};`,
    "$dialog.ShowNewFolderButton = $true;",
    selected,
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  [Console]::Out.Write($dialog.SelectedPath);",
    "  exit 0",
    "}",
    "exit 1",
  ].join(" ");
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface SpawnSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function resolveSpawnSpecs(initialPath?: string): SpawnSpec[] {
  const platform = getNativePickPlatform();
  const start = initialPath ?? homedir();

  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          buildWindowsScript(initialPath),
        ],
      },
    ];
  }

  if (platform === "darwin") {
    const defaultClause = initialPath
      ? ` default location (POSIX file ${JSON.stringify(initialPath)})`
      : "";
    const script =
      `try\n` +
      `set theFolder to choose folder with prompt "Select project folder"${defaultClause}\n` +
      `return POSIX path of theFolder\n` +
      `on error number -128\n` +
      `return ""\n` +
      `end try`;
    return [{ command: "osascript", args: ["-e", script] }];
  }

  if (platform === "linux") {
    const specs: SpawnSpec[] = [];
    if (commandExists("zenity")) {
      specs.push({
        command: "zenity",
        args: [
          "--file-selection",
          "--directory",
          "--title=Select project folder",
          `--filename=${start}${path.sep}`,
        ],
      });
    }
    if (commandExists("kdialog")) {
      specs.push({
        command: "kdialog",
        args: ["--getexistingdirectory", start],
      });
    }
    return specs;
  }

  return [];
}

function runPickerProcess(spec: SpawnSpec, timeoutMs: number): Promise<NativePickResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: NativePickResult) => {
      if (settled) return;
      settled = true;
      try {
        if (!child.killed) child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(result);
    };

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({
        ok: false,
        code: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64_000) stdout = stdout.slice(-32_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });

    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: "timeout",
        error: `Native folder picker timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      });
    });

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (settled) return;

      const picked = normalizePickedPath(stdout);
      if (picked) {
        finish({ ok: true, path: picked });
        return;
      }

      // User cancel: non-zero exit with empty stdout is the common pattern.
      if (!stdout.trim()) {
        finish({
          ok: false,
          code: "cancelled",
          error: "Folder selection cancelled",
        });
        return;
      }

      const detail = (stderr || stdout || `exit ${exitCode ?? "unknown"}`).trim();
      finish({
        ok: false,
        code: "unavailable",
        error: `Native folder picker failed: ${detail.slice(0, 400)}`,
      });
    });
  });
}

/**
 * Open one native folder dialog and return the selected absolute path.
 * Serializes concurrent calls (second caller receives busy).
 */
export async function pickDirectoryNative(options?: {
  initialPath?: string | null;
  timeoutMs?: number;
}): Promise<NativePickResult> {
  if (pickInFlight) {
    return {
      ok: false,
      code: "busy",
      error: "A native folder picker is already open",
    };
  }

  const caps = getNativePickCapabilities();
  if (!caps.nativePickerSupported) {
    return {
      ok: false,
      code: "unavailable",
      error:
        caps.platform === "linux" && !caps.hasDisplayHint
          ? "No graphical display available for a native folder picker"
          : "Native folder picker is not available on this host",
    };
  }

  const initialPath = safeInitialDirectory(options?.initialPath);
  const specs = resolveSpawnSpecs(initialPath);
  if (specs.length === 0) {
    return {
      ok: false,
      code: "unavailable",
      error: "No native folder picker backend is available",
    };
  }

  const timeoutMs = Math.max(5_000, options?.timeoutMs ?? NATIVE_PICK_TIMEOUT_MS);
  pickInFlight = true;
  try {
    let last: NativePickResult = {
      ok: false,
      code: "unavailable",
      error: "Native folder picker failed",
    };
    for (const spec of specs) {
      last = await runPickerProcess(spec, timeoutMs);
      if (last.ok || last.code === "cancelled" || last.code === "timeout") {
        return last;
      }
      // Try next backend (e.g. zenity missing at runtime → kdialog).
    }
    return last;
  } finally {
    pickInFlight = false;
  }
}

/** Test helper — reset the in-process busy latch. */
export function __resetNativePickLockForTests(): void {
  pickInFlight = false;
}
