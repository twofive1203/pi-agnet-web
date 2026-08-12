/**
 * Project-local quick-command configuration and trust digests.
 *
 * Config lives at `<cwd>/.pi/quick-commands.json` (project / worktree scoped).
 * Trust confirmations live under the agent dir and never store env secret values.
 */

import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { getAllowedRoots, isPathAllowed } from "./allowed-roots";
import { canonicalizeCwd, existingCanonicalCwd } from "./cwd";
import {
  QUICK_COMMAND_MAX_COMMAND_CHARS,
  QUICK_COMMAND_MAX_COMMANDS,
  QUICK_COMMAND_MAX_CWD_CHARS,
  QUICK_COMMAND_MAX_DESCRIPTION_CHARS,
  QUICK_COMMAND_MAX_ENV_ENTRIES,
  QUICK_COMMAND_MAX_ENV_KEY_CHARS,
  QUICK_COMMAND_MAX_ENV_VALUE_CHARS,
  QUICK_COMMAND_MAX_NAME_CHARS,
  QUICK_COMMAND_SCHEMA_VERSION,
  type QuickCommandDefinition,
  type QuickCommandProjectConfig,
  type QuickCommandTrustPreview,
} from "./quick-command-types";

const CONFIG_DIR_SEGMENTS = [".pi"] as const;
const CONFIG_FILE_NAME = "quick-commands.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export class QuickCommandStoreError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: string = "invalid",
  ) {
    super(message);
    this.name = "QuickCommandStoreError";
  }
}

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent");
}

function trustStorePath(): string {
  return join(getAgentDir(), "quick-command-trust.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pathIsInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // Reject Windows drive-hop edge cases already covered by isAbsolute(rel).
  return true;
}

function normalizeRelativeCwd(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === ".") return "";
  if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
    throw new QuickCommandStoreError("Working directory must be project-relative", 400, "invalid_cwd");
  }
  const parts = trimmed.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new QuickCommandStoreError("Working directory must stay inside the project", 400, "invalid_cwd");
  }
  if (trimmed.length > QUICK_COMMAND_MAX_CWD_CHARS) {
    throw new QuickCommandStoreError("Working directory path is too long", 400, "invalid_cwd");
  }
  return parts.join("/");
}

function normalizeEnv(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new QuickCommandStoreError("env must be an object", 400, "invalid_env");
  const entries = Object.entries(raw);
  if (entries.length > QUICK_COMMAND_MAX_ENV_ENTRIES) {
    throw new QuickCommandStoreError(`env supports at most ${QUICK_COMMAND_MAX_ENV_ENTRIES} entries`, 400, "invalid_env");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    const cleanKey = key.trim();
    if (!ENV_KEY_RE.test(cleanKey) || cleanKey.length > QUICK_COMMAND_MAX_ENV_KEY_CHARS) {
      throw new QuickCommandStoreError(`Invalid environment variable name: ${key}`, 400, "invalid_env");
    }
    if (typeof value !== "string") {
      throw new QuickCommandStoreError(`env.${cleanKey} must be a string`, 400, "invalid_env");
    }
    if (value.length > QUICK_COMMAND_MAX_ENV_VALUE_CHARS) {
      throw new QuickCommandStoreError(`env.${cleanKey} is too long`, 400, "invalid_env");
    }
    out[cleanKey] = value;
  }
  return out;
}

function normalizeCommandId(raw: unknown, fallback?: string): string {
  if (typeof raw === "string" && COMMAND_ID_RE.test(raw.trim())) return raw.trim();
  if (fallback && COMMAND_ID_RE.test(fallback)) return fallback;
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

function normalizeBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function normalizeOrder(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  return fallback;
}

export function emptyQuickCommandConfig(): QuickCommandProjectConfig {
  return {
    schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
    revision: computeConfigRevision({ schemaVersion: QUICK_COMMAND_SCHEMA_VERSION, commands: [] }),
    commands: [],
  };
}

export function computeExecutableDigest(command: Pick<QuickCommandDefinition, "command" | "cwd" | "env">): string {
  const envKeys = Object.keys(command.env).sort();
  const payload = JSON.stringify({
    command: command.command,
    cwd: command.cwd,
    env: envKeys.map((key) => [key, command.env[key]]),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function computeConfigRevision(config: Omit<QuickCommandProjectConfig, "revision">): string {
  const payload = JSON.stringify({
    schemaVersion: config.schemaVersion,
    commands: config.commands.map((command) => ({
      id: command.id,
      name: command.name,
      command: command.command,
      description: command.description,
      cwd: command.cwd,
      env: command.env,
      confirmBeforeRun: command.confirmBeforeRun,
      autoExpandOutput: command.autoExpandOutput,
      enabled: command.enabled,
      order: command.order,
    })),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function parseQuickCommandDefinition(raw: unknown, index: number): QuickCommandDefinition {
  if (!isRecord(raw)) {
    throw new QuickCommandStoreError(`commands[${index}] must be an object`, 400, "invalid");
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!name) throw new QuickCommandStoreError(`commands[${index}].name is required`, 400, "invalid");
  if (!command) throw new QuickCommandStoreError(`commands[${index}].command is required`, 400, "invalid");
  if (name.length > QUICK_COMMAND_MAX_NAME_CHARS) {
    throw new QuickCommandStoreError(`commands[${index}].name is too long`, 400, "invalid");
  }
  if (command.length > QUICK_COMMAND_MAX_COMMAND_CHARS) {
    throw new QuickCommandStoreError(`commands[${index}].command is too long`, 400, "invalid");
  }
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (description.length > QUICK_COMMAND_MAX_DESCRIPTION_CHARS) {
    throw new QuickCommandStoreError(`commands[${index}].description is too long`, 400, "invalid");
  }
  const cwd = normalizeRelativeCwd(typeof raw.cwd === "string" ? raw.cwd : "");
  const env = normalizeEnv(raw.env);
  const id = normalizeCommandId(raw.id);
  return {
    id,
    name,
    command,
    description,
    cwd,
    env,
    confirmBeforeRun: normalizeBoolean(raw.confirmBeforeRun, false),
    autoExpandOutput: normalizeBoolean(raw.autoExpandOutput, true),
    enabled: normalizeBoolean(raw.enabled, true),
    order: normalizeOrder(raw.order, index),
  };
}

export function parseQuickCommandConfig(raw: unknown): QuickCommandProjectConfig {
  if (raw === undefined || raw === null) return emptyQuickCommandConfig();
  if (!isRecord(raw)) throw new QuickCommandStoreError("quick-commands config must be an object", 400, "invalid");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== QUICK_COMMAND_SCHEMA_VERSION) {
    throw new QuickCommandStoreError(`Unsupported quick-commands schemaVersion: ${String(raw.schemaVersion)}`, 400, "invalid");
  }
  const list = Array.isArray(raw.commands) ? raw.commands : [];
  if (list.length > QUICK_COMMAND_MAX_COMMANDS) {
    throw new QuickCommandStoreError(`At most ${QUICK_COMMAND_MAX_COMMANDS} quick commands are allowed`, 400, "invalid");
  }
  const commands = list.map((entry, index) => parseQuickCommandDefinition(entry, index));
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.id)) {
      throw new QuickCommandStoreError(`Duplicate quick command id: ${command.id}`, 400, "invalid");
    }
    seen.add(command.id);
  }
  commands.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const withoutRevision = {
    schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
    commands,
  } as const;
  const expectedRevision = computeConfigRevision(withoutRevision);
  const revision =
    typeof raw.revision === "string" && raw.revision.trim()
      ? raw.revision.trim()
      : expectedRevision;
  return { ...withoutRevision, revision };
}

export async function resolveAuthorizedProjectCwd(cwdInput: unknown): Promise<string> {
  if (typeof cwdInput !== "string" || !cwdInput.trim()) {
    throw new QuickCommandStoreError("cwd is required", 400, "invalid");
  }
  const cwd = existingCanonicalCwd(cwdInput);
  if (!cwd) throw new QuickCommandStoreError("cwd does not exist", 400, "invalid");
  const roots = await getAllowedRoots();
  if (!isPathAllowed(cwd, roots)) {
    throw new QuickCommandStoreError("cwd is outside allowed workspaces", 403, "forbidden");
  }
  return cwd;
}

export function getQuickCommandConfigPath(projectCwd: string): string {
  return join(projectCwd, ...CONFIG_DIR_SEGMENTS, CONFIG_FILE_NAME);
}

function atomicWriteText(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${CONFIG_FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw error;
  }
}

export function readQuickCommandConfig(projectCwd: string): QuickCommandProjectConfig {
  const filePath = getQuickCommandConfigPath(projectCwd);
  if (!existsSync(filePath)) return emptyQuickCommandConfig();
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return emptyQuickCommandConfig();
  }
  if (!stat.isFile()) {
    throw new QuickCommandStoreError("quick-commands path is not a file", 500, "invalid");
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new QuickCommandStoreError("quick-commands config is too large", 400, "invalid");
  }
  const text = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new QuickCommandStoreError("quick-commands config is not valid JSON", 400, "invalid");
  }
  return parseQuickCommandConfig(parsed);
}

export function writeQuickCommandConfig(
  projectCwd: string,
  nextCommands: unknown,
  expectedRevision?: string | null,
): QuickCommandProjectConfig {
  const current = readQuickCommandConfig(projectCwd);
  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== current.revision) {
    throw new QuickCommandStoreError("quick-commands config was modified elsewhere", 409, "conflict");
  }

  const list = Array.isArray(nextCommands) ? nextCommands : null;
  if (!list) throw new QuickCommandStoreError("commands must be an array", 400, "invalid");
  if (list.length > QUICK_COMMAND_MAX_COMMANDS) {
    throw new QuickCommandStoreError(`At most ${QUICK_COMMAND_MAX_COMMANDS} quick commands are allowed`, 400, "invalid");
  }

  const commands = list.map((entry, index) => parseQuickCommandDefinition(entry, index));
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.id)) {
      throw new QuickCommandStoreError(`Duplicate quick command id: ${command.id}`, 400, "invalid");
    }
    seen.add(command.id);
  }
  commands.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  // Validate each relative cwd resolves inside the project (existence optional until run).
  for (const command of commands) {
    resolveCommandWorkingDirectory(projectCwd, command.cwd, { requireExists: false });
  }

  const withoutRevision = {
    schemaVersion: QUICK_COMMAND_SCHEMA_VERSION,
    commands,
  } as const;
  const config: QuickCommandProjectConfig = {
    ...withoutRevision,
    revision: computeConfigRevision(withoutRevision),
  };
  const filePath = getQuickCommandConfigPath(projectCwd);
  atomicWriteText(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function findQuickCommand(
  projectCwd: string,
  commandId: string,
): QuickCommandDefinition | null {
  const config = readQuickCommandConfig(projectCwd);
  return config.commands.find((command) => command.id === commandId) ?? null;
}

export function resolveCommandWorkingDirectory(
  projectCwd: string,
  relativeCwd: string,
  options: { requireExists?: boolean } = {},
): string {
  const requireExists = options.requireExists ?? true;
  const base = canonicalizeCwd(projectCwd);
  const target = relativeCwd ? resolve(base, ...relativeCwd.split("/")) : base;
  if (!pathIsInside(base, target)) {
    throw new QuickCommandStoreError("Working directory must stay inside the project", 400, "invalid_cwd");
  }
  if (requireExists) {
    const existing = existingCanonicalCwd(target);
    if (!existing) {
      throw new QuickCommandStoreError("Working directory does not exist", 400, "invalid_cwd");
    }
    if (!pathIsInside(base, existing)) {
      throw new QuickCommandStoreError("Working directory must stay inside the project", 400, "invalid_cwd");
    }
    return existing;
  }
  return canonicalizeCwd(target);
}

interface TrustFile {
  entries: Record<string, { digest: string; confirmedAt: string }>;
}

function readTrustFile(): TrustFile {
  const filePath = trustStorePath();
  if (!existsSync(filePath)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.entries)) return { entries: {} };
    const entries: TrustFile["entries"] = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!isRecord(value)) continue;
      if (typeof value.digest !== "string" || typeof value.confirmedAt !== "string") continue;
      entries[key] = { digest: value.digest, confirmedAt: value.confirmedAt };
    }
    return { entries };
  } catch {
    return { entries: {} };
  }
}

function writeTrustFile(file: TrustFile): void {
  atomicWriteText(trustStorePath(), `${JSON.stringify(file, null, 2)}\n`);
}

function trustKey(projectCwd: string, commandId: string): string {
  return `${canonicalizeCwd(projectCwd)}${sep}${commandId}`;
}

export function buildTrustPreview(
  projectCwd: string,
  command: QuickCommandDefinition,
  reason: QuickCommandTrustPreview["reason"],
): QuickCommandTrustPreview {
  const resolvedCwd = resolveCommandWorkingDirectory(projectCwd, command.cwd, { requireExists: false });
  return {
    commandId: command.id,
    name: command.name,
    command: command.command,
    resolvedCwd,
    envKeys: Object.keys(command.env).sort(),
    digest: computeExecutableDigest(command),
    reason,
  };
}

export function getTrustRequirement(
  projectCwd: string,
  command: QuickCommandDefinition,
): QuickCommandTrustPreview | null {
  if (command.confirmBeforeRun) {
    return buildTrustPreview(projectCwd, command, "always_confirm");
  }
  const digest = computeExecutableDigest(command);
  const entry = readTrustFile().entries[trustKey(projectCwd, command.id)];
  if (!entry) return buildTrustPreview(projectCwd, command, "first_run");
  if (entry.digest !== digest) return buildTrustPreview(projectCwd, command, "changed");
  return null;
}

export function confirmQuickCommandTrust(
  projectCwd: string,
  command: QuickCommandDefinition,
  digest: string,
): void {
  const expected = computeExecutableDigest(command);
  if (digest !== expected) {
    throw new QuickCommandStoreError("Trust digest does not match current command definition", 409, "trust_stale");
  }
  // Validate path before recording trust so confirmation cannot approve an invalid cwd.
  resolveCommandWorkingDirectory(projectCwd, command.cwd, { requireExists: true });
  const file = readTrustFile();
  file.entries[trustKey(projectCwd, command.id)] = {
    digest: expected,
    confirmedAt: new Date().toISOString(),
  };
  writeTrustFile(file);
}

/** Test helper: wipe in-memory/disk trust for a project command. */
export function clearQuickCommandTrustForTests(projectCwd: string, commandId?: string): void {
  const file = readTrustFile();
  if (!commandId) {
    const prefix = `${canonicalizeCwd(projectCwd)}${sep}`;
    for (const key of Object.keys(file.entries)) {
      if (key.startsWith(prefix)) delete file.entries[key];
    }
  } else {
    delete file.entries[trustKey(projectCwd, commandId)];
  }
  writeTrustFile(file);
}
