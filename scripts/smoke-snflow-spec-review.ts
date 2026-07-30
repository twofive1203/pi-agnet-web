#!/usr/bin/env npx tsx
/**
 * Deterministic smoke checks for the managed /snflow-spec-review command.
 * No model, browser, server, or network is required.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import snflowExtension from "../.pi/extensions/snflow/index";
import { getExtensionCommandWebSupport } from "../lib/extension-command-web-support";

type CommandContext = {
  cwd?: string;
  isIdle?: () => boolean;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

type Command = {
  description?: string;
  handler: (args: string, ctx: CommandContext) => unknown;
};

type EventHandler = (
  event: Record<string, unknown>,
  ctx: { cwd?: string },
) => unknown;

type Harness = {
  commands: Map<string, Command>;
  events: Map<string, EventHandler>;
  messages: string[];
  notifications: Array<{ message: string; type?: string }>;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createHarness(options: { withSendUserMessage?: boolean } = {}): Harness {
  const commands = new Map<string, Command>();
  const events = new Map<string, EventHandler>();
  const messages: string[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const api: {
    on: (event: string, handler: EventHandler) => void;
    registerCommand: (name: string, command: Command) => void;
    sendUserMessage?: (content: string) => void;
  } = {
    on: (event, handler) => events.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  if (options.withSendUserMessage !== false) {
    api.sendUserMessage = (content) => messages.push(content);
  }
  snflowExtension(api);
  return { commands, events, messages, notifications };
}

function commandContext(
  cwd: string | undefined,
  harness: Harness,
  idle = true,
): CommandContext {
  return {
    cwd,
    isIdle: () => idle,
    ui: {
      notify: (message, type) => harness.notifications.push({ message, type }),
    },
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createProject(options: {
  taskId?: string;
  status?: string;
  archived?: boolean;
  includeCurrent?: boolean;
  includeSpec?: boolean;
} = {}): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "snflow-spec-review-"));
  const taskId = options.taskId ?? "review-task";
  const taskDir = path.join(cwd, ".pi", "snflows", "tasks", taskId);
  mkdirSync(path.join(cwd, ".pi", "snflows", "archived"), { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeJson(path.join(taskDir, "task.json"), {
    schemaVersion: 1,
    id: taskId,
    title: "Review task",
    description: "",
    status: options.status ?? "ready_to_commit",
    priority: "P2",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    completedAt: null,
    revision: "0123456789abcdef",
    activeRunId: null,
    latestImplementRunId: null,
    latestCheckRunId: null,
    commit: null,
    archived: options.archived ?? false,
  });
  for (const name of ["requirements.md", "design.md", "plan.md"]) {
    writeFileSync(path.join(taskDir, name), `# ${name}\n`, "utf8");
  }
  if (options.includeCurrent !== false) {
    writeJson(path.join(cwd, ".pi", "snflows", "current.json"), {
      taskId,
      updatedAt: new Date(0).toISOString(),
      source: "agent",
    });
  }
  if (options.includeSpec !== false) {
    const specDir = path.join(cwd, ".pi", "snflows", "spec");
    mkdirSync(path.join(specDir, "guides"), { recursive: true });
    writeFileSync(path.join(specDir, "index.md"), "# Project Specifications\n", "utf8");
    writeFileSync(path.join(specDir, "guides", "index.md"), "# Guides\n", "utf8");
  }
  return cwd;
}

function snapshotTree(root: string): string[] {
  const output: string[] = [];
  function visit(current: string): void {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      try {
        const entries = readdirSync(absolute);
        output.push(`dir:${relative}`);
        if (entries.length > 0) visit(absolute);
      } catch {
        output.push(`file:${relative}:${readFileSync(absolute, "utf8")}`);
      }
    }
  }
  visit(root);
  return output;
}

function runCommand(cwd: string | undefined, args = "", idle = true, withSend = true): Harness {
  const harness = createHarness({ withSendUserMessage: withSend });
  const command = harness.commands.get("snflow-spec-review");
  assert(command, "snflow-spec-review command should register");
  command.handler(args, commandContext(cwd, harness, idle));
  return harness;
}

function assertRejected(harness: Harness, label: string, expectedText: string): void {
  assert(harness.messages.length === 0, `${label}: must not send an Agent message`);
  assert(
    harness.notifications.some((item) => item.message.includes(expectedText)),
    `${label}: expected diagnostic containing ${expectedText}`,
  );
}

const projects: string[] = [];
const priorChild = process.env.PI_SUBAGENT_CHILD;
const priorEnabled = process.env.PI_WEB_SNFLOW_ENABLED;

try {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_WEB_SNFLOW_ENABLED;

  const registration = createHarness();
  const registered = registration.commands.get("snflow-spec-review");
  assert(registered, "command should register in the main session");
  assert(registered.description?.includes("reusable project Spec"), "command description should be discoverable");
  assert(
    getExtensionCommandWebSupport("snflow-spec-review").support === "full",
    "command should default to full Web support",
  );

  const valid = createProject();
  projects.push(valid);
  const before = snapshotTree(valid);
  const validRun = runCommand(valid);
  const after = snapshotTree(valid);
  assert(JSON.stringify(before) === JSON.stringify(after), "candidate generation command must not mutate the workspace");
  assert(validRun.messages.length === 1, "valid command should send exactly one Agent message");
  const prompt = validRun.messages[0];
  for (const expected of [
    "SNFLOW_SPEC_REVIEW v1",
    "review-task: Review task",
    ".pi/snflows/tasks/review-task/task.json",
    ".pi/snflows/tasks/review-task/requirements.md",
    ".pi/snflows/tasks/review-task/runs/*.json when present",
    ".pi/snflows/spec/index.md",
    "Do not dispatch subagents",
    "strictly read-only",
    "add | revise | remove | do_not_capture",
    "background_or_root_cause",
    "target_spec_path",
    "evidence_paths",
    "relationship_to_existing_spec",
    "本任务无需更新规范",
    "physical paths inside the canonical workspace",
    "Apply only explicitly accepted candidate IDs",
    "synchronize affected indexes",
    "Do not change workflow status or AGENTS.md",
  ]) {
    assert(prompt.includes(expected), `valid prompt missing contract text: ${expected}`);
  }
  const beforeAgentStart = validRun.events.get("before_agent_start");
  assert(beforeAgentStart, "extension should register before_agent_start guidance");
  const reviewTurn = beforeAgentStart(
    { prompt, systemPrompt: "base-system" },
    { cwd: valid },
  ) as { systemPrompt?: string } | undefined;
  assert(
    reviewTurn?.systemPrompt?.includes("<workflow-state:spec_review_candidates>"),
    "review marker should receive read-only candidate system guidance",
  );
  assert(
    reviewTurn?.systemPrompt?.includes("Candidate output is not approval"),
    "review system guidance should preserve the confirmation boundary",
  );
  assert(
    !reviewTurn?.systemPrompt?.includes("Check passed. Hand off commit"),
    "review turn must not receive ordinary ready-to-commit write guidance",
  );

  const completed = createProject({ status: "completed" });
  projects.push(completed);
  assert(runCommand(completed).messages.length === 1, "current completed-but-unarchived task should be reviewable");

  assertRejected(runCommand(valid, "other-task"), "argument rejection", "v1 only reviews the current task");
  assertRejected(runCommand(valid, "", false), "busy rejection", "Agent is busy");
  assertRejected(runCommand(undefined), "cwd rejection", "Cannot resolve the current workspace");
  assertRejected(runCommand(valid, "", true, false), "runtime rejection", "cannot start the SnFlow Spec review");

  const noCurrent = createProject({ includeCurrent: false });
  projects.push(noCurrent);
  assertRejected(runCommand(noCurrent), "missing current", "No current SnFlow task");

  const malformedCurrent = createProject();
  projects.push(malformedCurrent);
  writeFileSync(path.join(malformedCurrent, ".pi", "snflows", "current.json"), "{}\n", "utf8");
  assertRejected(runCommand(malformedCurrent), "malformed current", "current SnFlow task pointer is malformed");

  const archivedOnly = createProject();
  projects.push(archivedOnly);
  const activeTaskDir = path.join(archivedOnly, ".pi", "snflows", "tasks", "review-task");
  renameSync(activeTaskDir, path.join(archivedOnly, ".pi", "snflows", "archived", "review-task"));
  assertRejected(runCommand(archivedOnly), "archived fallback", "missing from .pi/snflows/tasks/");

  const archivedMetadata = createProject({ archived: true });
  projects.push(archivedMetadata);
  assertRejected(runCommand(archivedMetadata), "archived metadata", "malformed or archived task metadata");

  const missingDocument = createProject();
  projects.push(missingDocument);
  rmSync(path.join(missingDocument, ".pi", "snflows", "tasks", "review-task", "design.md"));
  assertRejected(runCommand(missingDocument), "missing document", "missing physical design.md");

  const missingSpec = createProject({ includeSpec: false });
  projects.push(missingSpec);
  assertRejected(runCommand(missingSpec), "missing Spec", "missing .pi/snflows/spec/index.md");

  const bootstrap = createProject({ taskId: "00-bootstrap-spec" });
  projects.push(bootstrap);
  assertRejected(runCommand(bootstrap), "bootstrap task", "bootstrap task already owns initial Spec authoring");

  process.env.PI_SUBAGENT_CHILD = "1";
  assert(!createHarness().commands.has("snflow-spec-review"), "child runtime must not register the command");
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.PI_WEB_SNFLOW_ENABLED = "0";
  assert(!createHarness().commands.has("snflow-spec-review"), "disabled Web runtime must not register the command");

  console.log("SnFlow spec review smoke checks passed.");
} finally {
  if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = priorChild;
  if (priorEnabled === undefined) delete process.env.PI_WEB_SNFLOW_ENABLED;
  else process.env.PI_WEB_SNFLOW_ENABLED = priorEnabled;
  for (const project of projects) rmSync(project, { recursive: true, force: true });
}
