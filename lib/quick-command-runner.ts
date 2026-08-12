/**
 * Independent one-shot quick-command executor.
 *
 * Does not use Web Terminal PTY sessions or inject into interactive shells.
 * Shares default shell/env policy from pi-web Terminal settings only.
 */

import { randomUUID } from "crypto";
import { accessSync, constants, statSync } from "fs";
import { delimiter, isAbsolute } from "path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { readPiWebConfig, type PiWebTerminalConfig, type PiWebTerminalShell } from "./pi-web-config";
import {
  confirmQuickCommandTrust,
  findQuickCommand,
  getTrustRequirement,
  resolveAuthorizedProjectCwd,
  resolveCommandWorkingDirectory,
  QuickCommandStoreError,
} from "./quick-command-store";
import {
  isQuickCommandActiveStatus,
  isQuickCommandTerminalStatus,
  QUICK_COMMAND_DEFAULT_TIMEOUT_MS,
  QUICK_COMMAND_MAX_GLOBAL_CONCURRENT,
  QUICK_COMMAND_MAX_OUTPUT_BYTES,
  QUICK_COMMAND_MAX_OUTPUT_CHUNKS,
  QUICK_COMMAND_RECENT_RUNS,
  type QuickCommandDefinition,
  type QuickCommandRunDetail,
  type QuickCommandRunStatus,
  type QuickCommandRunSummary,
  type QuickCommandStartResult,
} from "./quick-command-types";

export class QuickCommandRunnerError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: string = "invalid",
  ) {
    super(message);
    this.name = "QuickCommandRunnerError";
  }
}

interface ResolvedShell {
  command: string;
  args: string[];
  label: string;
}

interface QuickCommandRunRecord {
  id: string;
  cwd: string;
  commandId: string;
  name: string;
  command: string;
  resolvedCwd: string;
  status: QuickCommandRunStatus;
  exitCode: number | null;
  exitReason: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  autoExpandOutput: boolean;
  chunks: string[];
  outputBytes: number;
  truncated: boolean;
  child: ChildProcessWithoutNullStreams | null;
  timeoutTimer: NodeJS.Timeout | null;
  subscribers: Set<(event: QuickCommandSseEvent) => void>;
  killRequested: boolean;
}

export type QuickCommandSseEvent =
  | { type: "connected"; runId: string }
  | { type: "snapshot"; run: QuickCommandRunDetail }
  | { type: "output"; chunk: string }
  | { type: "status"; run: QuickCommandRunSummary }
  | { type: "error"; error: string };

declare global {
  var __piQuickCommandRuns: Map<string, QuickCommandRunRecord> | undefined;
  var __piQuickCommandProjectIndex: Map<string, string[]> | undefined;
}

function getRuns(): Map<string, QuickCommandRunRecord> {
  if (!globalThis.__piQuickCommandRuns) globalThis.__piQuickCommandRuns = new Map();
  return globalThis.__piQuickCommandRuns;
}

function getProjectIndex(): Map<string, string[]> {
  if (!globalThis.__piQuickCommandProjectIndex) globalThis.__piQuickCommandProjectIndex = new Map();
  return globalThis.__piQuickCommandProjectIndex;
}

function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

function validateEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new QuickCommandRunnerError(`Invalid environment variable name: ${key}`);
    }
    out[key] = value;
  }
  return out;
}

function assertExecutablePath(filePath: string): void {
  if (!isAbsolute(filePath)) {
    throw new QuickCommandRunnerError("Custom shell path must be an absolute path");
  }
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new QuickCommandRunnerError("Custom shell path must point to a file");
    if (process.platform !== "win32") accessSync(filePath, constants.X_OK);
  } catch (error) {
    if (error instanceof QuickCommandRunnerError) throw error;
    throw new QuickCommandRunnerError(`Custom shell path is not executable or does not exist: ${filePath}`);
  }
}

function findWindowsExecutable(command: string): string | null {
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = command.includes(".")
    ? [command]
    : [
        command,
        ...extensions.map((extension) => `${command}${extension.toLowerCase()}`),
        ...extensions.map((extension) => `${command}${extension.toUpperCase()}`),
      ];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const candidate of candidates) {
      const filePath = `${directory.replace(/[\\/]$/, "")}\\${candidate}`;
      try {
        const stat = statSync(filePath);
        if (stat.isFile()) return filePath;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function resolveNamedShell(shell: Exclude<PiWebTerminalShell, "custom">): ResolvedShell {
  if (process.platform === "win32") {
    const windowsCommand =
      shell === "cmd"
        ? "cmd.exe"
        : shell === "powershell"
          ? "powershell.exe"
          : shell === "pwsh"
            ? "pwsh.exe"
            : shell;
    const resolved = findWindowsExecutable(windowsCommand);
    if (!resolved) throw new QuickCommandRunnerError(`Shell is not available on PATH: ${windowsCommand}`);
    if (shell === "cmd") return { command: resolved, args: [], label: "cmd" };
    if (shell === "powershell" || shell === "pwsh") return { command: resolved, args: ["-NoLogo"], label: shell };
    // Git Bash / similar on Windows — non-interactive.
    return { command: resolved, args: [], label: shell };
  }

  if (shell === "cmd" || shell === "powershell" || shell === "pwsh") {
    throw new QuickCommandRunnerError(`Shell is only supported on Windows: ${shell}`);
  }
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${shell}`], { encoding: "utf8" });
  const resolved = result.stdout.trim().split(/\r?\n/)[0];
  if (result.status === 0 && resolved) return { command: resolved, args: [], label: shell };
  throw new QuickCommandRunnerError(`Shell is not available on PATH: ${shell}`);
}

function resolveShell(config: PiWebTerminalConfig): ResolvedShell {
  if (config.shell === "custom") {
    const customShellPath = config.customShellPath.trim();
    if (!customShellPath) throw new QuickCommandRunnerError("Custom shell path is required when terminal shell is custom");
    assertExecutablePath(customShellPath);
    return { command: customShellPath, args: [], label: customShellPath };
  }
  return resolveNamedShell(config.shell);
}

/** Build non-interactive argv for a one-shot command line. */
export function buildShellInvocation(shell: ResolvedShell, commandLine: string): { command: string; args: string[] } {
  const label = shell.label.toLowerCase();
  if (process.platform === "win32") {
    if (label === "cmd" || shell.command.toLowerCase().endsWith("cmd.exe")) {
      return { command: shell.command, args: ["/d", "/s", "/c", commandLine] };
    }
    if (label === "powershell" || label === "pwsh" || /powershell|pwsh/i.test(shell.command)) {
      return {
        command: shell.command,
        args: [...shell.args, "-NoProfile", "-NonInteractive", "-Command", commandLine],
      };
    }
    // bash/sh/custom on Windows
    return { command: shell.command, args: [...shell.args, "-c", commandLine] };
  }
  return { command: shell.command, args: [...shell.args, "-c", commandLine] };
}

function toSummary(run: QuickCommandRunRecord): QuickCommandRunSummary {
  const endedAtMs = run.endedAtMs;
  return {
    id: run.id,
    cwd: run.cwd,
    commandId: run.commandId,
    name: run.name,
    command: run.command,
    resolvedCwd: run.resolvedCwd,
    status: run.status,
    exitCode: run.exitCode,
    exitReason: run.exitReason,
    startedAt: nowIso(run.startedAtMs),
    endedAt: endedAtMs == null ? null : nowIso(endedAtMs),
    durationMs: endedAtMs == null ? Date.now() - run.startedAtMs : endedAtMs - run.startedAtMs,
    truncated: run.truncated,
    outputBytes: run.outputBytes,
    autoExpandOutput: run.autoExpandOutput,
  };
}

function toDetail(run: QuickCommandRunRecord): QuickCommandRunDetail {
  return {
    ...toSummary(run),
    outputText: run.chunks.join(""),
  };
}

function emit(run: QuickCommandRunRecord, event: QuickCommandSseEvent): void {
  for (const listener of run.subscribers) {
    try {
      listener(event);
    } catch {
      // ignore subscriber failures
    }
  }
}

function appendOutput(run: QuickCommandRunRecord, chunk: string): void {
  if (!chunk) return;
  const remaining = QUICK_COMMAND_MAX_OUTPUT_BYTES - run.outputBytes;
  if (remaining <= 0) {
    if (!run.truncated) {
      run.truncated = true;
      const notice = "\n[output truncated: server bounded buffer limit reached]\n";
      run.chunks.push(notice);
      run.outputBytes += Buffer.byteLength(notice, "utf8");
      emit(run, { type: "output", chunk: notice });
    }
    return;
  }
  let next = chunk;
  const byteLength = Buffer.byteLength(chunk, "utf8");
  if (byteLength > remaining) {
    // Best-effort UTF-8-safe trim by binary slice.
    next = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
    run.truncated = true;
    next += "\n[output truncated: server bounded buffer limit reached]\n";
  }
  run.chunks.push(next);
  run.outputBytes += Buffer.byteLength(next, "utf8");
  while (run.chunks.length > QUICK_COMMAND_MAX_OUTPUT_CHUNKS) {
    const removed = run.chunks.shift();
    if (removed) run.outputBytes = Math.max(0, run.outputBytes - Buffer.byteLength(removed, "utf8"));
    run.truncated = true;
  }
  emit(run, { type: "output", chunk: next });
}

function trackProjectRun(projectCwd: string, runId: string): void {
  const index = getProjectIndex();
  const list = index.get(projectCwd) ?? [];
  list.unshift(runId);
  // Bound per-project remembered runs.
  while (list.length > QUICK_COMMAND_RECENT_RUNS) {
    const dropped = list.pop();
    if (!dropped) break;
    const run = getRuns().get(dropped);
    if (run && isQuickCommandTerminalStatus(run.status) && run.subscribers.size === 0) {
      getRuns().delete(dropped);
    }
  }
  index.set(projectCwd, list);
}

function countActiveRuns(): number {
  let count = 0;
  for (const run of getRuns().values()) {
    if (isQuickCommandActiveStatus(run.status)) count += 1;
  }
  return count;
}

function findActiveRunForCommand(projectCwd: string, commandId: string): QuickCommandRunRecord | null {
  for (const run of getRuns().values()) {
    if (run.cwd === projectCwd && run.commandId === commandId && isQuickCommandActiveStatus(run.status)) {
      return run;
    }
  }
  return null;
}

function finalizeRun(
  run: QuickCommandRunRecord,
  status: Exclude<QuickCommandRunStatus, "starting" | "running">,
  exitCode: number | null,
  exitReason: string | null,
): void {
  // Idempotent on endedAtMs so timeout/cancel can pre-stamp status before close.
  if (run.endedAtMs != null) return;
  run.status = status;
  run.exitCode = exitCode;
  run.exitReason = exitReason;
  run.endedAtMs = Date.now();
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = null;
  }
  run.child = null;
  emit(run, { type: "status", run: toSummary(run) });
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    return;
  }

  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    return;
  }

  // Unix: try process-group kill first (spawned detached), then direct.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, 1_500).unref?.();
}

function spawnQuickCommand(
  shell: ResolvedShell,
  commandLine: string,
  cwd: string,
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const invocation = buildShellInvocation(shell, commandLine);
  const childEnv = {
    ...process.env,
    ...env,
    TERM: env.TERM ?? process.env.TERM ?? "xterm-256color",
  } as NodeJS.ProcessEnv;

  if (process.platform === "win32") {
    return spawn(invocation.command, invocation.args, {
      cwd,
      env: childEnv,
      stdio: "pipe",
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }

  return spawn(invocation.command, invocation.args, {
    cwd,
    env: childEnv,
    stdio: "pipe",
    detached: true,
  }) as ChildProcessWithoutNullStreams;
}

function startProcess(run: QuickCommandRunRecord, definition: QuickCommandDefinition): void {
  let shell: ResolvedShell;
  let baseEnv: Record<string, string>;
  try {
    const terminal = readPiWebConfig().terminal;
    shell = resolveShell(terminal);
    baseEnv = validateEnv(terminal.env ?? {});
  } catch (error) {
    finalizeRun(
      run,
      "failed",
      null,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const env = {
    ...baseEnv,
    ...validateEnv(definition.env),
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnQuickCommand(shell, definition.command, run.resolvedCwd, env);
  } catch (error) {
    finalizeRun(
      run,
      "failed",
      null,
      `Failed to start command: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  run.child = child;
  run.status = "running";
  emit(run, { type: "status", run: toSummary(run) });

  const onChunk = (buf: Buffer) => {
    appendOutput(run, buf.toString("utf8"));
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("error", (error) => {
    appendOutput(run, `\n[process error] ${error.message}\n`);
    finalizeRun(run, "failed", null, error.message);
  });

  child.on("close", (code, signal) => {
    if (run.endedAtMs != null) return;
    if (run.killRequested) {
      finalizeRun(run, "cancelled", code ?? null, signal ? `signal ${signal}` : "cancelled by user");
      return;
    }
    if (run.status === "timed_out" || run.exitReason === "timed out") {
      finalizeRun(run, "timed_out", code ?? null, "timed out");
      return;
    }
    if (code === 0) {
      finalizeRun(run, "succeeded", 0, null);
      return;
    }
    finalizeRun(
      run,
      "failed",
      code ?? null,
      signal ? `signal ${signal}` : code == null ? "unknown exit" : `exit ${code}`,
    );
  });

  run.timeoutTimer = setTimeout(() => {
    if (isQuickCommandTerminalStatus(run.status)) return;
    // Mark intent without terminalizing yet so the close handler can observe timeout.
    run.exitReason = "timed out";
    appendOutput(run, "\n[timed out]\n");
    const child = run.child;
    if (child) {
      // Temporarily stamp timed_out so the close handler maps correctly.
      (run as { status: QuickCommandRunStatus }).status = "timed_out";
      killProcessTree(child);
      setTimeout(() => {
        if (run.endedAtMs == null) finalizeRun(run, "timed_out", null, "timed out");
      }, 2_000).unref?.();
      return;
    }
    finalizeRun(run, "timed_out", null, "timed out");
  }, QUICK_COMMAND_DEFAULT_TIMEOUT_MS);
  run.timeoutTimer.unref?.();
}

export async function startQuickCommandRun(input: {
  cwd?: unknown;
  commandId?: unknown;
  trustConfirmed?: unknown;
  trustDigest?: unknown;
}): Promise<QuickCommandStartResult> {
  let projectCwd: string;
  try {
    projectCwd = await resolveAuthorizedProjectCwd(input.cwd);
  } catch (error) {
    if (error instanceof QuickCommandStoreError) {
      return {
        ok: false,
        code: error.code === "forbidden" ? "forbidden" : "invalid",
        error: error.message,
      };
    }
    throw error;
  }

  if (typeof input.commandId !== "string" || !input.commandId.trim()) {
    return { ok: false, code: "invalid", error: "commandId is required" };
  }
  const commandId = input.commandId.trim();

  // Always re-read project config — never execute client-supplied command text.
  let definition: QuickCommandDefinition | null;
  try {
    definition = findQuickCommand(projectCwd, commandId);
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!definition) {
    return { ok: false, code: "not_found", error: "Quick command not found in this project" };
  }
  if (!definition.enabled) {
    return { ok: false, code: "disabled", error: "Quick command is disabled" };
  }

  const existing = findActiveRunForCommand(projectCwd, commandId);
  if (existing) {
    return { ok: true, run: toSummary(existing), alreadyRunning: true };
  }

  if (countActiveRuns() >= QUICK_COMMAND_MAX_GLOBAL_CONCURRENT) {
    return {
      ok: false,
      code: "limit",
      error: `Too many concurrent quick commands (limit ${QUICK_COMMAND_MAX_GLOBAL_CONCURRENT})`,
    };
  }

  const trustNeeded = getTrustRequirement(projectCwd, definition);
  const trustConfirmed = input.trustConfirmed === true;
  const trustDigest = typeof input.trustDigest === "string" ? input.trustDigest : "";
  if (trustNeeded) {
    if (!trustConfirmed || !trustDigest) {
      return {
        ok: false,
        code: "trust_required",
        error: "Trust confirmation required before running this command",
        trust: trustNeeded,
      };
    }
    try {
      confirmQuickCommandTrust(projectCwd, definition, trustDigest);
    } catch (error) {
      if (error instanceof QuickCommandStoreError && error.code === "trust_stale") {
        const refreshed = getTrustRequirement(projectCwd, definition) ?? trustNeeded;
        return {
          ok: false,
          code: "trust_required",
          error: error.message,
          trust: refreshed,
        };
      }
      return {
        ok: false,
        code: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let resolvedCwd: string;
  try {
    resolvedCwd = resolveCommandWorkingDirectory(projectCwd, definition.cwd, { requireExists: true });
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const run: QuickCommandRunRecord = {
    id: randomUUID(),
    cwd: projectCwd,
    commandId: definition.id,
    name: definition.name,
    command: definition.command,
    resolvedCwd,
    status: "starting",
    exitCode: null,
    exitReason: null,
    startedAtMs: Date.now(),
    endedAtMs: null,
    autoExpandOutput: definition.autoExpandOutput,
    chunks: [],
    outputBytes: 0,
    truncated: false,
    child: null,
    timeoutTimer: null,
    subscribers: new Set(),
    killRequested: false,
  };

  getRuns().set(run.id, run);
  trackProjectRun(projectCwd, run.id);

  // Defer spawn so the HTTP response can return the starting snapshot first.
  setImmediate(() => {
    if (isQuickCommandTerminalStatus(run.status)) return;
    startProcess(run, definition);
  });

  return { ok: true, run: toSummary(run) };
}

export function getQuickCommandRun(runId: string): QuickCommandRunDetail | null {
  const run = getRuns().get(runId);
  if (!run) return null;
  return toDetail(run);
}

export function listQuickCommandRuns(projectCwd: string): QuickCommandRunSummary[] {
  const ids = getProjectIndex().get(projectCwd) ?? [];
  const out: QuickCommandRunSummary[] = [];
  for (const id of ids) {
    const run = getRuns().get(id);
    if (run) out.push(toSummary(run));
  }
  return out;
}

export function listActiveQuickCommandRuns(projectCwd: string): QuickCommandRunSummary[] {
  return listQuickCommandRuns(projectCwd).filter((run) => isQuickCommandActiveStatus(run.status));
}

export function subscribeQuickCommandRun(
  runId: string,
  listener: (event: QuickCommandSseEvent) => void,
): () => void {
  const run = getRuns().get(runId);
  if (!run) throw new QuickCommandRunnerError("Quick command run not found", 404, "not_found");
  run.subscribers.add(listener);
  listener({ type: "connected", runId });
  listener({ type: "snapshot", run: toDetail(run) });
  return () => {
    run.subscribers.delete(listener);
  };
}

export function cancelQuickCommandRun(runId: string): QuickCommandRunSummary {
  const run = getRuns().get(runId);
  if (!run) throw new QuickCommandRunnerError("Quick command run not found", 404, "not_found");
  if (isQuickCommandTerminalStatus(run.status)) return toSummary(run);
  run.killRequested = true;
  appendOutput(run, "\n[cancelling…]\n");
  if (run.child) {
    killProcessTree(run.child);
  } else {
    finalizeRun(run, "cancelled", null, "cancelled before start");
  }
  // If the process ignores signals, force a cancelled terminal state after a grace period.
  setTimeout(() => {
    if (!isQuickCommandTerminalStatus(run.status)) {
      finalizeRun(run, "cancelled", null, "force cancelled");
    }
  }, 3_000).unref?.();
  return toSummary(run);
}

export function dismissQuickCommandRun(runId: string): void {
  const run = getRuns().get(runId);
  if (!run) return;
  if (!isQuickCommandTerminalStatus(run.status)) {
    throw new QuickCommandRunnerError("Cannot dismiss an active run", 409, "busy");
  }
  getRuns().delete(runId);
  const index = getProjectIndex();
  for (const [cwd, ids] of index.entries()) {
    const next = ids.filter((id) => id !== runId);
    if (next.length === 0) index.delete(cwd);
    else index.set(cwd, next);
  }
}

/** Test-only reset of in-memory run registry. */
export function resetQuickCommandRunnerForTests(): void {
  for (const run of getRuns().values()) {
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.child) {
      try {
        killProcessTree(run.child);
      } catch {
        // ignore
      }
    }
  }
  getRuns().clear();
  getProjectIndex().clear();
}
