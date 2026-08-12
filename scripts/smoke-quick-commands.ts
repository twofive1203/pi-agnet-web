/**
 * Smoke checks for project quick commands:
 * config isolation, path bounds, commandId-only execution, trust digests,
 * concurrency, cancel/process tree, bounded output, and route wiring.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAllowedRoot } from "../lib/allowed-roots";
import {
  buildShellInvocation,
  cancelQuickCommandRun,
  getQuickCommandRun,
  listQuickCommandRuns,
  resetQuickCommandRunnerForTests,
  startQuickCommandRun,
  subscribeQuickCommandRun,
} from "../lib/quick-command-runner";
import {
  clearQuickCommandTrustForTests,
  computeExecutableDigest,
  getTrustRequirement,
  parseQuickCommandConfig,
  readQuickCommandConfig,
  resolveCommandWorkingDirectory,
  writeQuickCommandConfig,
  QuickCommandStoreError,
} from "../lib/quick-command-store";
import {
  QUICK_COMMAND_MAX_GLOBAL_CONCURRENT,
  QUICK_COMMAND_MAX_OUTPUT_BYTES,
} from "../lib/quick-command-types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function checkParseAndPathBounds(project: string): void {
  const config = parseQuickCommandConfig({
    schemaVersion: 1,
    commands: [
      {
        id: "build",
        name: "Build",
        command: "npm run build",
        description: "compile",
        cwd: "packages/app",
        env: { NODE_ENV: "production" },
        confirmBeforeRun: false,
        autoExpandOutput: true,
        enabled: true,
        order: 0,
      },
    ],
  });
  assert(config.commands.length === 1, "parse one command");
  assert(config.revision.length >= 8, "revision assigned");

  mkdirSync(join(project, "packages", "app"), { recursive: true });
  const resolved = resolveCommandWorkingDirectory(project, "packages/app");
  assert(resolved.includes("packages"), "relative cwd resolves inside project");

  let outsideFailed = false;
  try {
    resolveCommandWorkingDirectory(project, "../outside");
  } catch (error) {
    outsideFailed = error instanceof QuickCommandStoreError;
  }
  assert(outsideFailed, "parent-relative cwd must be rejected");

  let absFailed = false;
  try {
    parseQuickCommandConfig({
      schemaVersion: 1,
      commands: [{ id: "x", name: "X", command: "echo", cwd: process.platform === "win32" ? "C:\\\\temp" : "/tmp" }],
    });
  } catch (error) {
    absFailed = error instanceof QuickCommandStoreError;
  }
  assert(absFailed, "absolute cwd in config must be rejected");
}

function checkConfigRoundTrip(project: string): void {
  const saved = writeQuickCommandConfig(project, [
    {
      id: "echo-ok",
      name: "Echo OK",
      command: process.platform === "win32" ? "echo quick-ok" : "echo quick-ok",
      description: "smoke",
      cwd: "",
      env: {},
      confirmBeforeRun: false,
      autoExpandOutput: true,
      enabled: true,
      order: 0,
    },
    {
      id: "disabled",
      name: "Disabled",
      command: "echo no",
      enabled: false,
      order: 1,
    },
  ]);
  assert(saved.commands.length === 2, "two commands saved");
  const loaded = readQuickCommandConfig(project);
  assert(loaded.revision === saved.revision, "revision stable on read");
  assert(loaded.commands[0].id === "echo-ok", "ids preserved");

  let conflict = false;
  try {
    writeQuickCommandConfig(project, loaded.commands, "stale-revision");
  } catch (error) {
    conflict = error instanceof QuickCommandStoreError && error.status === 409;
  }
  assert(conflict, "stale revision must conflict");
}

function checkShellInvocation(): void {
  const unix = buildShellInvocation({ command: "/bin/bash", args: [], label: "bash" }, "echo hi");
  assert(unix.args.includes("-c"), "unix shell uses -c");
  assert(unix.args.includes("echo hi"), "command line preserved");

  const cmd = buildShellInvocation({ command: "C:\\\\Windows\\\\System32\\\\cmd.exe", args: [], label: "cmd" }, "echo hi");
  assert(cmd.args[0] === "/d" && cmd.args.includes("/c"), "cmd uses /d /s /c");
}

async function checkRunLifecycle(project: string): Promise<void> {
  resetQuickCommandRunnerForTests();
  clearQuickCommandTrustForTests(project);

  writeQuickCommandConfig(project, [
    {
      id: "echo-ok",
      name: "Echo OK",
      command: process.platform === "win32" ? "echo quick-ok" : "printf 'quick-ok\\n'",
      cwd: "",
      env: {},
      confirmBeforeRun: false,
      autoExpandOutput: true,
      enabled: true,
      order: 0,
    },
  ]);

  const first = await startQuickCommandRun({ cwd: project, commandId: "echo-ok" });
  assert(!first.ok && first.code === "trust_required", "first run requires trust");
  assert(first.trust?.command.includes("quick-ok") || first.trust?.command.includes("printf"), "trust shows command");
  assert(Array.isArray(first.trust?.envKeys), "trust exposes env key names only");

  const confirmed = await startQuickCommandRun({
    cwd: project,
    commandId: "echo-ok",
    trustConfirmed: true,
    trustDigest: first.trust!.digest,
  });
  assert(confirmed.ok, "trusted start succeeds");
  assert(confirmed.run.status === "starting" || confirmed.run.status === "running", "starts active");

  const chunks: string[] = [];
  const unsub = subscribeQuickCommandRun(confirmed.run.id, (event) => {
    if (event.type === "output") chunks.push(event.chunk);
  });

  await waitFor(() => {
    const detail = getQuickCommandRun(confirmed.run.id);
    return Boolean(detail && (detail.status === "succeeded" || detail.status === "failed"));
  }, "echo run terminal");

  unsub();
  const done = getQuickCommandRun(confirmed.run.id);
  assert(done?.status === "succeeded", `echo should succeed, got ${done?.status}`);
  assert((done?.outputText || chunks.join("")).includes("quick-ok"), "output contains marker");
  assert(done?.exitCode === 0, "exit code 0");
  assert(typeof done?.durationMs === "number", "duration recorded");

  // Same command while not active starts a new run using latest definition.
  const again = await startQuickCommandRun({ cwd: project, commandId: "echo-ok" });
  assert(again.ok, "second run after trust does not re-prompt");
  await waitFor(() => {
    const detail = getQuickCommandRun(again.run!.id);
    return Boolean(detail && detail.status === "succeeded");
  }, "second echo");

  // command text changes must invalidate trust.
  writeQuickCommandConfig(project, [
    {
      id: "echo-ok",
      name: "Echo OK",
      command: process.platform === "win32" ? "echo changed" : "printf 'changed\\n'",
      cwd: "",
      env: {},
      enabled: true,
      order: 0,
    },
  ]);
  const changed = await startQuickCommandRun({ cwd: project, commandId: "echo-ok" });
  assert(!changed.ok && changed.code === "trust_required" && changed.trust?.reason === "changed", "changed command re-confirms");
}

async function checkDuplicateAndCancel(project: string): Promise<void> {
  resetQuickCommandRunnerForTests();
  clearQuickCommandTrustForTests(project);

  const longCommand =
    process.platform === "win32"
      ? "ping -n 30 127.0.0.1 >nul"
      : "sleep 30";

  writeQuickCommandConfig(project, [
    {
      id: "long",
      name: "Long",
      command: longCommand,
      enabled: true,
      order: 0,
      autoExpandOutput: true,
    },
  ]);

  const trust = getTrustRequirement(project, readQuickCommandConfig(project).commands[0]);
  assert(trust, "trust required for long command");

  const started = await startQuickCommandRun({
    cwd: project,
    commandId: "long",
    trustConfirmed: true,
    trustDigest: trust!.digest,
  });
  assert(started.ok, "long start ok");

  await waitFor(() => {
    const detail = getQuickCommandRun(started.run!.id);
    return Boolean(detail && (detail.status === "running" || detail.status === "starting"));
  }, "long running");

  const dup = await startQuickCommandRun({ cwd: project, commandId: "long" });
  assert(dup.ok && dup.alreadyRunning === true, "duplicate focuses existing run");
  assert(dup.run!.id === started.run!.id, "same run id returned");

  const cancelled = cancelQuickCommandRun(started.run!.id);
  assert(cancelled.status === "cancelled" || cancelled.status === "running" || cancelled.status === "starting", "cancel accepted");
  await waitFor(() => getQuickCommandRun(started.run!.id)?.status === "cancelled", "cancelled terminal");
}

async function checkConcurrencyLimit(project: string): Promise<void> {
  resetQuickCommandRunnerForTests();
  clearQuickCommandTrustForTests(project);

  const commands = Array.from({ length: QUICK_COMMAND_MAX_GLOBAL_CONCURRENT + 1 }, (_, index) => ({
    id: `c${index}`,
    name: `C${index}`,
    command: process.platform === "win32" ? "ping -n 20 127.0.0.1 >nul" : "sleep 20",
    enabled: true,
    order: index,
  }));
  writeQuickCommandConfig(project, commands);

  const digests = commands.map((command) => {
    const def = readQuickCommandConfig(project).commands.find((entry) => entry.id === command.id)!;
    return computeExecutableDigest(def);
  });

  for (let i = 0; i < QUICK_COMMAND_MAX_GLOBAL_CONCURRENT; i += 1) {
    const result = await startQuickCommandRun({
      cwd: project,
      commandId: `c${i}`,
      trustConfirmed: true,
      trustDigest: digests[i],
    });
    assert(result.ok, `start c${i}`);
  }

  const over = await startQuickCommandRun({
    cwd: project,
    commandId: `c${QUICK_COMMAND_MAX_GLOBAL_CONCURRENT}`,
    trustConfirmed: true,
    trustDigest: digests[QUICK_COMMAND_MAX_GLOBAL_CONCURRENT],
  });
  assert(!over.ok && over.code === "limit", "global concurrency enforced");

  // Cleanup active runs.
  for (const run of listQuickCommandRuns(project)) {
    try {
      cancelQuickCommandRun(run.id);
    } catch {
      // ignore
    }
  }
  await sleep(300);
}

async function checkBoundedOutput(project: string): Promise<void> {
  resetQuickCommandRunnerForTests();
  clearQuickCommandTrustForTests(project);

  // Generate more than the byte cap.
  const command =
    process.platform === "win32"
      ? `node -e "process.stdout.write('x'.repeat(${QUICK_COMMAND_MAX_OUTPUT_BYTES + 4096}))"`
      : `node -e 'process.stdout.write("x".repeat(${QUICK_COMMAND_MAX_OUTPUT_BYTES + 4096}))'`;

  writeQuickCommandConfig(project, [
    {
      id: "big",
      name: "Big",
      command,
      enabled: true,
      order: 0,
    },
  ]);
  const def = readQuickCommandConfig(project).commands[0];
  const started = await startQuickCommandRun({
    cwd: project,
    commandId: "big",
    trustConfirmed: true,
    trustDigest: computeExecutableDigest(def),
  });
  assert(started.ok, "big start");
  await waitFor(() => {
    const detail = getQuickCommandRun(started.run!.id);
    return Boolean(detail && (detail.status === "succeeded" || detail.status === "failed"));
  }, "big terminal", 15_000);
  const detail = getQuickCommandRun(started.run!.id)!;
  assert(detail.truncated === true, "output marked truncated");
  assert(detail.outputBytes <= QUICK_COMMAND_MAX_OUTPUT_BYTES + 200, "output bytes bounded");
  assert(detail.outputText.includes("truncated"), "truncation notice present");
}

function checkRequestRejectsCommandText(): void {
  // Route must only accept commandId — verified by source contract.
  const route = readFileSync(join(ROOT, "app", "api", "quick-commands", "runs", "route.ts"), "utf8");
  assert(route.includes("commandId"), "runs route accepts commandId");
  assert(!route.includes("body.command"), "runs route must not read arbitrary command text from body");
  assert(route.includes("startQuickCommandRun"), "runs route delegates to runner");
}

function checkWiring(): void {
  const apiDocs = readFileSync(join(ROOT, "docs", "modules", "api.md"), "utf8");
  assert(apiDocs.includes("quick-commands"), "api docs mention quick-commands");

  const bar = readFileSync(join(ROOT, "components", "QuickCommandBar.tsx"), "utf8");
  assert(bar.includes("startCommand"), "bar starts by command id");

  const panel = readFileSync(join(ROOT, "components", "QuickCommandOutputPanel.tsx"), "utf8");
  assert(panel.includes("@xterm/xterm"), "output panel uses xterm ANSI rendering");
  assert(panel.includes("setPanelOpen(false)"), "closing panel does not call cancel");

  const runner = readFileSync(join(ROOT, "lib", "quick-command-runner.ts"), "utf8");
  assert(!runner.includes("createTerminalSession"), "runner must not use Web Terminal sessions");
  assert(runner.includes("taskkill") || runner.includes("process.kill(-pid"), "process tree cancel strategy present");

  const appShell = readFileSync(join(ROOT, "components", "AppShell.tsx"), "utf8");
  assert(appShell.includes("QuickCommandOutputPanel"), "AppShell mounts task output dock");
  assert(appShell.includes("QuickCommandBar"), "AppShell mounts composer bar");
}

async function main(): Promise<void> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "pi-qc-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const project = mkdtempSync(join(tmpdir(), "pi-qc-project-"));
  registerAllowedRoot(project);
  mkdirSync(join(project, ".pi"), { recursive: true });

  try {
    checkParseAndPathBounds(project);
    checkConfigRoundTrip(project);
    checkShellInvocation();
    await checkRunLifecycle(project);
    await checkDuplicateAndCancel(project);
    await checkConcurrencyLimit(project);
    await checkBoundedOutput(project);
    checkRequestRejectsCommandText();
    checkWiring();
    console.log("quick commands smoke checks passed");
  } finally {
    resetQuickCommandRunnerForTests();
    rmSync(project, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
