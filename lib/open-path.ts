import { spawn, type SpawnOptions } from "child_process";
import { statSync } from "fs";

export type OpenPathResult =
  | { ok: true }
  | { ok: false; error: string };

interface OpenCommand {
  command: string;
  args: string[];
  /** When true, a non-zero exit code still counts as success (Windows explorer). */
  ignoreExitCode?: boolean;
  options?: SpawnOptions;
}

/**
 * Open a local filesystem path in the OS file manager.
 * Windows: explorer.exe (launched with a visible window state)
 * macOS: open
 * Linux/other: xdg-open
 *
 * Returns as soon as the opener is launched. File-manager processes are detached
 * so the API does not wait for the window to close.
 */
export async function openPathInFileManager(targetPath: string): Promise<OpenPathResult> {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    return { ok: false, error: "Path is required" };
  }

  try {
    const st = statSync(trimmed);
    if (!st.isDirectory() && !st.isFile()) {
      return { ok: false, error: `Path is not a file or directory: ${trimmed}` };
    }
  } catch {
    return { ok: false, error: `Path does not exist: ${trimmed}` };
  }

  const commands = resolveOpenCommands(trimmed);
  let lastError = "Failed to open path";

  for (const spec of commands) {
    const result = await runOpenCommand(spec);
    if (result.ok) return result;
    lastError = result.error;
  }

  return { ok: false, error: lastError };
}

function resolveOpenCommands(targetPath: string): OpenCommand[] {
  if (process.platform === "win32") {
    const windowsPath = targetPath.replace(/\//g, "\\");
    return [
      {
        // A hidden launcher state is inherited by Explorer and creates an invisible folder window.
        command: "explorer.exe",
        args: [windowsPath],
        ignoreExitCode: true,
        options: { windowsHide: false },
      },
    ];
  }

  if (process.platform === "darwin") {
    return [{ command: "open", args: [targetPath] }];
  }

  return [{ command: "xdg-open", args: [targetPath] }];
}

function runOpenCommand(spec: OpenCommand): Promise<OpenPathResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OpenPathResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        ...spec.options,
      });
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.once("error", (error) => {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Fail fast only when the opener dies immediately with an error code.
    child.once("exit", (code) => {
      if (settled) return;
      if (spec.ignoreExitCode || code === 0 || code === null) {
        finish({ ok: true });
        return;
      }
      finish({ ok: false, error: `${spec.command} exited with code ${code}` });
    });

    // Most openers either error at spawn or keep running; don't block the API.
    setTimeout(() => {
      finish({ ok: true });
    }, 400);

    try {
      child.unref();
    } catch {
      // ignore
    }
  });
}
