import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import {
  DEFAULT_BUNDLED_PI_EXTENSION_ENABLEMENT,
  type BundledPiExtensionId,
} from "./bundled-pi-extension-registry";

/**
 * Expand ~ paths the same way as pi SDK expandTildePath/normalizePath
 * (exact `~`, `~/...`, and Windows `~\...`) without importing the ESM-only package.
 * Does not trim: env values are preserved unless tilde-expanded.
 */
function expandTildePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Resolve ~/.pi/agent (or PI_CODING_AGENT_DIR) without importing the ESM-only pi package. */
function getAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    return expandTildePath(envDir);
  }
  return join(homedir(), ".pi", "agent");
}

export interface PiWebWorktreeConfig {
  baseRef: string;
  branchNameTemplate: string;
  baseDirTemplate: string;
  pathTemplate: string;
  sessionDisplay: "separate" | "tag";
}

/** Generic model-selection mode used by Terminal env assistant (and similar) policies. */
export type PiWebSubagentModelMode = "followMain" | "piDefault" | "specific" | "unset";
/** Generic thinking level used by Terminal env assistant (and similar) policies. */
export type PiWebSubagentThinking = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiWebSubagentModelRef {
  mode: PiWebSubagentModelMode;
  provider?: string;
  modelId?: string;
}

export interface PiWebSubagentRunPolicy {
  model: PiWebSubagentModelRef;
  thinking: PiWebSubagentThinking;
}

export interface PiWebUsageConfig {
  includeArchived: boolean;
}

export interface PiWebVisionModelRef {
  provider: string;
  modelId: string;
}

export interface PiWebVisionConfig {
  enabled: boolean;
  model: PiWebVisionModelRef | null;
}

export interface PiWebChatGptWarmupConfig {
  enabled: boolean;
  accountIds: string[];
  times: string[];
}

export type PiWebTerminalShell = "zsh" | "bash" | "sh" | "cmd" | "powershell" | "pwsh" | "custom";

export interface PiWebTerminalConfig {
  enabled: boolean;
  shell: PiWebTerminalShell;
  customShellPath: string;
  env: Record<string, string>;
  envAssistant: PiWebSubagentRunPolicy;
  envAssistantFallback: PiWebSubagentRunPolicy;
}

export interface PiWebGrokConfig {
  usagePanelEnabled: boolean;
  autoRefreshEnabled: boolean;
  refreshCycleIntervalSeconds: number;
  refreshCycleSaltMinSeconds: number;
  refreshCycleSaltMaxSeconds: number;
  refreshAccountIntervalSeconds: number;
  refreshAccountSaltMinSeconds: number;
  refreshAccountSaltMaxSeconds: number;
}

export type PiWebBundledExtensionsConfig = Record<BundledPiExtensionId, boolean>;

export interface PiWebWorkflowConfig {
  /**
   * @deprecated Ignored. SnFlow is per-project: initialized projects use it,
   * uninitialized ones do not. Kept optional so older pi-web.json files still parse.
   */
  enabled?: boolean;
  includeArchived: boolean;
  /**
   * When false (default), SnFlow init/update keeps managed asset paths in the
   * project .gitignore so generated files are not committed accidentally.
   * When true, the managed ignore block is removed.
   */
  trackInGit: boolean;
}

export interface PiWebChatGptConfig {
  usagePanelEnabled: boolean;
  warmup: PiWebChatGptWarmupConfig;
  autoRefreshEnabled: boolean;
  refreshCycleIntervalSeconds: number;
  refreshCycleSaltMinSeconds: number;
  refreshCycleSaltMaxSeconds: number;
  refreshAccountIntervalSeconds: number;
  refreshAccountSaltMinSeconds: number;
  refreshAccountSaltMaxSeconds: number;
}

export type PiWebEditorKind = "monaco";

export interface PiWebEditorShortcutConfig {
  saveFile: boolean;
  addSelectionToChat: boolean;
  findReferences: boolean;
  findJavaImplementations: boolean;
  cmdClickDrillDown: boolean;
  shiftClickHierarchy: boolean;
}

export interface PiWebEditorConfig {
  kind: PiWebEditorKind;
  shortcuts: PiWebEditorShortcutConfig;
}

/**
 * Public WebUI config projection. Unknown raw root keys (including legacy
 * `trellis`) are intentionally omitted here and left untouched on disk.
 */
export interface PiWebConfig {
  worktree: PiWebWorktreeConfig;
  workflow: PiWebWorkflowConfig;
  usage: PiWebUsageConfig;
  vision: PiWebVisionConfig;
  terminal: PiWebTerminalConfig;
  chatgpt: PiWebChatGptConfig;
  editor: PiWebEditorConfig;
  grok: PiWebGrokConfig;
  bundledExtensions: PiWebBundledExtensionsConfig;
}

/** Supported patch sections only. Legacy raw `trellis` is never accepted or rewritten. */
export interface PiWebConfigPatch {
  worktree?: unknown;
  workflow?: unknown;
  usage?: unknown;
  vision?: unknown;
  terminal?: unknown;
  chatgpt?: unknown;
  editor?: unknown;
  grok?: unknown;
  bundledExtensions?: unknown;
}

export interface PiWebConfigReadResult {
  config: PiWebConfig;
  defaults: PiWebConfig;
  path: string;
  exists: boolean;
  parseError?: string;
}

export class PiWebConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiWebConfigValidationError";
  }
}

export const DEFAULT_PI_WEB_CONFIG: PiWebConfig = {
  worktree: {
    baseRef: "HEAD",
    branchNameTemplate: "pi/{yyyyMMdd-HHmmss}",
    baseDirTemplate: "{repoParent}/{repoName}.worktrees",
    pathTemplate: "{baseDir}/{branchSlug}",
    sessionDisplay: "separate",
  },
  usage: {
    includeArchived: true,
  },
  vision: {
    enabled: false,
    model: null,
  },
  terminal: {
    enabled: false,
    shell: process.platform === "win32" ? "powershell" : "zsh",
    customShellPath: "",
    env: {},
    envAssistant: {
      model: { mode: "piDefault" },
      thinking: "minimal",
    },
    envAssistantFallback: {
      model: { mode: "piDefault" },
      thinking: "minimal",
    },
  },
  chatgpt: {
    usagePanelEnabled: false,
    warmup: {
      enabled: false,
      accountIds: [],
      times: ["07:00", "13:00"],
    },
    autoRefreshEnabled: false,
    refreshCycleIntervalSeconds: 1800,
    refreshCycleSaltMinSeconds: 0,
    refreshCycleSaltMaxSeconds: 120,
    refreshAccountIntervalSeconds: 20,
    refreshAccountSaltMinSeconds: 0,
    refreshAccountSaltMaxSeconds: 15,
  },
  editor: {
    kind: "monaco",
    shortcuts: {
      saveFile: true,
      addSelectionToChat: true,
      findReferences: true,
      findJavaImplementations: true,
      cmdClickDrillDown: true,
      shiftClickHierarchy: true,
    },
  },
  workflow: {
    includeArchived: false,
    trackInGit: false,
  },
  grok: {
    usagePanelEnabled: false,
    autoRefreshEnabled: false,
    refreshCycleIntervalSeconds: 1800,
    refreshCycleSaltMinSeconds: 0,
    refreshCycleSaltMaxSeconds: 120,
    refreshAccountIntervalSeconds: 20,
    refreshAccountSaltMinSeconds: 0,
    refreshAccountSaltMaxSeconds: 15,
  },
  bundledExtensions: {
    ...DEFAULT_BUNDLED_PI_EXTENSION_ENABLEMENT,
  },
};

export function getPiWebConfigPath(): string {
  return join(getAgentDir(), "pi-web.json");
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function readSessionDisplay(value: unknown, fallback: "separate" | "tag"): "separate" | "tag" {
  return value === "separate" || value === "tag" ? value : fallback;
}

function normalizeDailyTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readDailyTimes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalizeDailyTime(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result.length > 0 ? result : fallback;
}

function readTerminalShell(value: unknown, fallback: PiWebTerminalShell): PiWebTerminalShell {
  return value === "zsh" || value === "bash" || value === "sh" || value === "cmd" || value === "powershell" || value === "pwsh" || value === "custom" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSubagentModelRef(value: unknown, fallback: PiWebSubagentModelRef): PiWebSubagentModelRef {
  if (!isRecord(value)) return fallback;
  const mode = value.mode;
  if (mode === "followMain" || mode === "piDefault" || mode === "unset") return { mode };
  if (mode === "specific") {
    const provider = typeof value.provider === "string" ? value.provider.trim() : "";
    const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
    if (provider && modelId) return { mode, provider, modelId };
  }
  return fallback;
}

function readVisionModelRef(value: unknown): PiWebVisionModelRef | null {
  if (!isRecord(value)) return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  return provider && modelId ? { provider, modelId } : null;
}

function readSubagentThinking(value: unknown, fallback: PiWebSubagentThinking): PiWebSubagentThinking {
  return value === "inherit" || value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function readSubagentPolicy(value: unknown, fallback: PiWebSubagentRunPolicy): PiWebSubagentRunPolicy {
  const root = isRecord(value) ? value : {};
  return {
    model: readSubagentModelRef(root.model, fallback.model),
    thinking: readSubagentThinking(root.thinking, fallback.thinking),
  };
}

function readChatGptWarmupConfig(value: unknown, fallback: PiWebChatGptWarmupConfig): PiWebChatGptWarmupConfig {
  const root = isRecord(value) ? value : {};
  return {
    enabled: readBoolean(root.enabled, fallback.enabled),
    accountIds: normalizeStringList(root.accountIds),
    times: readDailyTimes(root.times, fallback.times),
  };
}

function normalizePiWebConfig(raw: unknown): PiWebConfig {
  const defaults = DEFAULT_PI_WEB_CONFIG;
  const root = isRecord(raw) ? raw : {};
  const worktree = isRecord(root.worktree) ? root.worktree : {};
  const workflow = isRecord(root.workflow) ? root.workflow : {};
  const usage = isRecord(root.usage) ? root.usage : {};
  const vision = isRecord(root.vision) ? root.vision : {};
  const terminal = isRecord(root.terminal) ? root.terminal : {};
  const chatgpt = isRecord(root.chatgpt) ? root.chatgpt : {};
  const editor = isRecord(root.editor) ? root.editor : {};
  const grok = isRecord(root.grok) ? root.grok : {};
  const bundledExtensions = isRecord(root.bundledExtensions) ? root.bundledExtensions : {};
  const editorShortcuts = isRecord(editor.shortcuts) ? editor.shortcuts : {};
  const terminalEnv: Record<string, string> = {};
  if (isRecord(terminal.env)) {
    for (const [key, value] of Object.entries(terminal.env)) {
      if (typeof value === "string") terminalEnv[key] = value;
    }
  }
  return {
    worktree: {
      baseRef: readString(worktree.baseRef, defaults.worktree.baseRef),
      branchNameTemplate: readString(worktree.branchNameTemplate, defaults.worktree.branchNameTemplate),
      baseDirTemplate: readString(worktree.baseDirTemplate, defaults.worktree.baseDirTemplate),
      pathTemplate: readString(worktree.pathTemplate, defaults.worktree.pathTemplate),
      sessionDisplay: readSessionDisplay(worktree.sessionDisplay, defaults.worktree.sessionDisplay),
    },
    usage: {
      includeArchived: readBoolean(usage.includeArchived, defaults.usage.includeArchived),
    },
    vision: {
      enabled: readBoolean(vision.enabled, defaults.vision.enabled),
      model: readVisionModelRef(vision.model),
    },
    terminal: {
      enabled: readBoolean(terminal.enabled, defaults.terminal.enabled),
      shell: readTerminalShell(terminal.shell, defaults.terminal.shell),
      customShellPath: typeof terminal.customShellPath === "string" ? terminal.customShellPath.trim() : defaults.terminal.customShellPath,
      env: terminalEnv,
      envAssistant: readSubagentPolicy(terminal.envAssistant, defaults.terminal.envAssistant),
      envAssistantFallback: readSubagentPolicy(terminal.envAssistantFallback, defaults.terminal.envAssistantFallback),
    },
    chatgpt: {
      usagePanelEnabled: readBoolean(chatgpt.usagePanelEnabled, defaults.chatgpt.usagePanelEnabled),
      warmup: readChatGptWarmupConfig(chatgpt.warmup, defaults.chatgpt.warmup),
      autoRefreshEnabled: readBoolean(chatgpt.autoRefreshEnabled, defaults.chatgpt.autoRefreshEnabled),
      refreshCycleIntervalSeconds: readInteger(chatgpt.refreshCycleIntervalSeconds, defaults.chatgpt.refreshCycleIntervalSeconds),
      refreshCycleSaltMinSeconds: readInteger(chatgpt.refreshCycleSaltMinSeconds, defaults.chatgpt.refreshCycleSaltMinSeconds),
      refreshCycleSaltMaxSeconds: readInteger(chatgpt.refreshCycleSaltMaxSeconds, defaults.chatgpt.refreshCycleSaltMaxSeconds),
      refreshAccountIntervalSeconds: readInteger(chatgpt.refreshAccountIntervalSeconds, defaults.chatgpt.refreshAccountIntervalSeconds),
      refreshAccountSaltMinSeconds: readInteger(chatgpt.refreshAccountSaltMinSeconds, defaults.chatgpt.refreshAccountSaltMinSeconds),
      refreshAccountSaltMaxSeconds: readInteger(chatgpt.refreshAccountSaltMaxSeconds, defaults.chatgpt.refreshAccountSaltMaxSeconds),
    },
    editor: {
      kind: editor.kind === "monaco" ? "monaco" : defaults.editor.kind,
      shortcuts: {
        saveFile: readBoolean(editorShortcuts.saveFile, defaults.editor.shortcuts.saveFile),
        addSelectionToChat: readBoolean(editorShortcuts.addSelectionToChat, defaults.editor.shortcuts.addSelectionToChat),
        findReferences: readBoolean(editorShortcuts.findReferences, defaults.editor.shortcuts.findReferences),
        findJavaImplementations: readBoolean(editorShortcuts.findJavaImplementations, defaults.editor.shortcuts.findJavaImplementations),
        cmdClickDrillDown: readBoolean(editorShortcuts.cmdClickDrillDown, defaults.editor.shortcuts.cmdClickDrillDown),
        shiftClickHierarchy: readBoolean(editorShortcuts.shiftClickHierarchy, defaults.editor.shortcuts.shiftClickHierarchy),
      },
    },
    grok: {
      usagePanelEnabled: readBoolean(grok.usagePanelEnabled, defaults.grok.usagePanelEnabled),
      autoRefreshEnabled: readBoolean(grok.autoRefreshEnabled, defaults.grok.autoRefreshEnabled),
      refreshCycleIntervalSeconds: readInteger(grok.refreshCycleIntervalSeconds, defaults.grok.refreshCycleIntervalSeconds),
      refreshCycleSaltMinSeconds: readInteger(grok.refreshCycleSaltMinSeconds, defaults.grok.refreshCycleSaltMinSeconds),
      refreshCycleSaltMaxSeconds: readInteger(grok.refreshCycleSaltMaxSeconds, defaults.grok.refreshCycleSaltMaxSeconds),
      refreshAccountIntervalSeconds: readInteger(grok.refreshAccountIntervalSeconds, defaults.grok.refreshAccountIntervalSeconds),
      refreshAccountSaltMinSeconds: readInteger(grok.refreshAccountSaltMinSeconds, defaults.grok.refreshAccountSaltMinSeconds),
      refreshAccountSaltMaxSeconds: readInteger(grok.refreshAccountSaltMaxSeconds, defaults.grok.refreshAccountSaltMaxSeconds),
    },
    bundledExtensions: {
      "pi-subagents": readBoolean(bundledExtensions["pi-subagents"], defaults.bundledExtensions["pi-subagents"]),
      "rpiv-web-tools": readBoolean(bundledExtensions["rpiv-web-tools"], defaults.bundledExtensions["rpiv-web-tools"]),
      "pi-ask-user": readBoolean(bundledExtensions["pi-ask-user"], defaults.bundledExtensions["pi-ask-user"]),
      "pi-manage-todo-list": readBoolean(bundledExtensions["pi-manage-todo-list"], defaults.bundledExtensions["pi-manage-todo-list"]),
    },
    workflow: {
      // enabled is intentionally ignored — SnFlow activation is project-local init only.
      includeArchived: readBoolean(workflow.includeArchived, defaults.workflow.includeArchived),
      trackInGit: readBoolean(workflow.trackInGit, defaults.workflow.trackInGit),
    },
  };
}

function readRawConfigFile(path: string): { raw: Record<string, unknown>; exists: boolean; parseError?: string } {
  if (!existsSync(path)) return { raw: {}, exists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { raw: {}, exists: true, parseError: "Config file root must be a JSON object" };
    }
    return { raw: parsed, exists: true };
  } catch (error) {
    return { raw: {}, exists: true, parseError: error instanceof Error ? error.message : String(error) };
  }
}

export function readPiWebConfigForApi(): PiWebConfigReadResult {
  const path = getPiWebConfigPath();
  const { raw, exists, parseError } = readRawConfigFile(path);
  return {
    config: normalizePiWebConfig(parseError ? {} : raw),
    defaults: DEFAULT_PI_WEB_CONFIG,
    path,
    exists,
    parseError,
  };
}

export function readPiWebConfig(): PiWebConfig {
  return readPiWebConfigForApi().config;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PiWebConfigValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function validatePiWebWorktreeConfig(value: unknown): PiWebWorktreeConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("worktree config must be an object");
  }
  const sessionDisplay = value.sessionDisplay;
  if (sessionDisplay !== "separate" && sessionDisplay !== "tag") {
    throw new PiWebConfigValidationError("worktree.sessionDisplay must be \"separate\" or \"tag\"");
  }
  return {
    baseRef: requireNonEmptyString(value.baseRef, "worktree.baseRef"),
    branchNameTemplate: requireNonEmptyString(value.branchNameTemplate, "worktree.branchNameTemplate"),
    baseDirTemplate: requireNonEmptyString(value.baseDirTemplate, "worktree.baseDirTemplate"),
    pathTemplate: requireNonEmptyString(value.pathTemplate, "worktree.pathTemplate"),
    sessionDisplay,
  };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PiWebConfigValidationError(`${field} must be a boolean`);
  }
  return value;
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PiWebConfigValidationError(`${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new PiWebConfigValidationError(`${field} must be between ${min} and ${max}`);
  }
  return value;
}

function requireSaltRange(minValue: unknown, maxValue: unknown, minField: string, maxField: string, maxAllowed: number): { min: number; max: number } {
  const min = requireIntegerInRange(minValue, minField, 0, maxAllowed);
  const max = requireIntegerInRange(maxValue, maxField, 0, maxAllowed);
  if (max < min) {
    throw new PiWebConfigValidationError(`${maxField} must be greater than or equal to ${minField}`);
  }
  return { min, max };
}

function validateSubagentModelRef(value: unknown, field: string): PiWebSubagentModelRef {
  if (!isRecord(value)) throw new PiWebConfigValidationError(`${field}.model must be an object`);
  const mode = value.mode;
  if (mode === "followMain" || mode === "piDefault" || mode === "unset") return { mode };
  if (mode !== "specific") throw new PiWebConfigValidationError(`${field}.model.mode is invalid`);
  return {
    mode,
    provider: requireNonEmptyString(value.provider, `${field}.model.provider`),
    modelId: requireNonEmptyString(value.modelId, `${field}.model.modelId`),
  };
}

function validateSubagentThinking(value: unknown, field: string): PiWebSubagentThinking {
  if (value === "inherit" || value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new PiWebConfigValidationError(`${field}.thinking is invalid`);
}

function validateSubagentPolicy(value: unknown, field: string): PiWebSubagentRunPolicy {
  if (!isRecord(value)) throw new PiWebConfigValidationError(`${field} must be an object`);
  return {
    model: validateSubagentModelRef(value.model, field),
    thinking: validateSubagentThinking(value.thinking, field),
  };
}

export function validatePiWebUsageConfig(value: unknown): PiWebUsageConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("usage config must be an object");
  }
  return {
    includeArchived: requireBoolean(value.includeArchived, "usage.includeArchived"),
  };
}

export function validatePiWebVisionConfig(value: unknown): PiWebVisionConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("vision config must be an object");
  }
  const enabled = requireBoolean(value.enabled, "vision.enabled");
  const model = readVisionModelRef(value.model);
  if (enabled && !model) {
    throw new PiWebConfigValidationError("vision.model is required when vision is enabled");
  }
  if (value.model !== null && value.model !== undefined && !model) {
    throw new PiWebConfigValidationError("vision.model must include provider and modelId");
  }
  return { enabled, model };
}

function validateTerminalShell(value: unknown): PiWebTerminalShell {
  if (value === "zsh" || value === "bash" || value === "sh" || value === "cmd" || value === "powershell" || value === "pwsh" || value === "custom") return value;
  throw new PiWebConfigValidationError("terminal.shell must be zsh, bash, sh, cmd, powershell, pwsh, or custom");
}

function validateTerminalEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new PiWebConfigValidationError("terminal.env must be an object");
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const cleanKey = key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) {
      throw new PiWebConfigValidationError(`terminal.env contains invalid variable name: ${key}`);
    }
    if (typeof rawValue !== "string") {
      throw new PiWebConfigValidationError(`terminal.env.${cleanKey} must be a string`);
    }
    env[cleanKey] = rawValue;
  }
  return env;
}

export function validatePiWebTerminalConfig(value: unknown): PiWebTerminalConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("terminal config must be an object");
  }
  return {
    enabled: requireBoolean(value.enabled, "terminal.enabled"),
    shell: validateTerminalShell(value.shell),
    customShellPath: typeof value.customShellPath === "string" ? value.customShellPath.trim() : "",
    env: validateTerminalEnv(value.env),
    envAssistant: value.envAssistant === undefined
      ? DEFAULT_PI_WEB_CONFIG.terminal.envAssistant
      : validateSubagentPolicy(value.envAssistant, "terminal.envAssistant"),
    envAssistantFallback: value.envAssistantFallback === undefined
      ? DEFAULT_PI_WEB_CONFIG.terminal.envAssistantFallback
      : validateSubagentPolicy(value.envAssistantFallback, "terminal.envAssistantFallback"),
  };
}

function validateDailyTimes(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new PiWebConfigValidationError(`${field} must be an array`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalizeDailyTime(item);
    if (!normalized) throw new PiWebConfigValidationError(`${field} entries must be HH:mm times`);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (result.length === 0) throw new PiWebConfigValidationError(`${field} must include at least one time`);
  return result;
}

function validateChatGptWarmupConfig(value: unknown): PiWebChatGptWarmupConfig {
  if (value === undefined) return DEFAULT_PI_WEB_CONFIG.chatgpt.warmup;
  if (!isRecord(value)) throw new PiWebConfigValidationError("chatgpt.warmup must be an object");
  return {
    enabled: requireBoolean(value.enabled, "chatgpt.warmup.enabled"),
    accountIds: normalizeStringList(value.accountIds),
    times: validateDailyTimes(value.times, "chatgpt.warmup.times"),
  };
}

export function validatePiWebChatGptConfig(value: unknown): PiWebChatGptConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("chatgpt config must be an object");
  }
  const cycleSalt = requireSaltRange(value.refreshCycleSaltMinSeconds, value.refreshCycleSaltMaxSeconds, "chatgpt.refreshCycleSaltMinSeconds", "chatgpt.refreshCycleSaltMaxSeconds", 3600);
  const accountSalt = requireSaltRange(value.refreshAccountSaltMinSeconds, value.refreshAccountSaltMaxSeconds, "chatgpt.refreshAccountSaltMinSeconds", "chatgpt.refreshAccountSaltMaxSeconds", 300);
  return {
    usagePanelEnabled: requireBoolean(value.usagePanelEnabled, "chatgpt.usagePanelEnabled"),
    warmup: validateChatGptWarmupConfig(value.warmup),
    autoRefreshEnabled: requireBoolean(value.autoRefreshEnabled, "chatgpt.autoRefreshEnabled"),
    refreshCycleIntervalSeconds: requireIntegerInRange(value.refreshCycleIntervalSeconds, "chatgpt.refreshCycleIntervalSeconds", 300, 86400),
    refreshCycleSaltMinSeconds: cycleSalt.min,
    refreshCycleSaltMaxSeconds: cycleSalt.max,
    refreshAccountIntervalSeconds: requireIntegerInRange(value.refreshAccountIntervalSeconds, "chatgpt.refreshAccountIntervalSeconds", 5, 3600),
    refreshAccountSaltMinSeconds: accountSalt.min,
    refreshAccountSaltMaxSeconds: accountSalt.max,
  };
}

export function validatePiWebGrokConfig(value: unknown): PiWebGrokConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("grok config must be an object");
  }
  const cycleSalt = requireSaltRange(value.refreshCycleSaltMinSeconds, value.refreshCycleSaltMaxSeconds, "grok.refreshCycleSaltMinSeconds", "grok.refreshCycleSaltMaxSeconds", 3600);
  const accountSalt = requireSaltRange(value.refreshAccountSaltMinSeconds, value.refreshAccountSaltMaxSeconds, "grok.refreshAccountSaltMinSeconds", "grok.refreshAccountSaltMaxSeconds", 300);
  return {
    usagePanelEnabled: requireBoolean(value.usagePanelEnabled, "grok.usagePanelEnabled"),
    autoRefreshEnabled: requireBoolean(value.autoRefreshEnabled, "grok.autoRefreshEnabled"),
    refreshCycleIntervalSeconds: requireIntegerInRange(value.refreshCycleIntervalSeconds, "grok.refreshCycleIntervalSeconds", 300, 86400),
    refreshCycleSaltMinSeconds: cycleSalt.min,
    refreshCycleSaltMaxSeconds: cycleSalt.max,
    refreshAccountIntervalSeconds: requireIntegerInRange(value.refreshAccountIntervalSeconds, "grok.refreshAccountIntervalSeconds", 5, 3600),
    refreshAccountSaltMinSeconds: accountSalt.min,
    refreshAccountSaltMaxSeconds: accountSalt.max,
  };
}

export function validatePiWebBundledExtensionsConfig(value: unknown): PiWebBundledExtensionsConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("bundledExtensions config must be an object");
  }
  return {
    "pi-subagents": requireBoolean(value["pi-subagents"], "bundledExtensions.pi-subagents"),
    "rpiv-web-tools": requireBoolean(value["rpiv-web-tools"], "bundledExtensions.rpiv-web-tools"),
    "pi-ask-user": requireBoolean(value["pi-ask-user"], "bundledExtensions.pi-ask-user"),
    "pi-manage-todo-list": requireBoolean(value["pi-manage-todo-list"], "bundledExtensions.pi-manage-todo-list"),
  };
}

export function validatePiWebEditorConfig(value: unknown): PiWebEditorConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("editor config must be an object");
  }
  if (value.kind !== "monaco") {
    throw new PiWebConfigValidationError("editor.kind must be monaco");
  }
  if (!isRecord(value.shortcuts)) {
    throw new PiWebConfigValidationError("editor.shortcuts must be an object");
  }
  return {
    kind: "monaco",
    shortcuts: {
      saveFile: requireBoolean(value.shortcuts.saveFile, "editor.shortcuts.saveFile"),
      addSelectionToChat: requireBoolean(value.shortcuts.addSelectionToChat, "editor.shortcuts.addSelectionToChat"),
      findReferences: requireBoolean(value.shortcuts.findReferences, "editor.shortcuts.findReferences"),
      findJavaImplementations: requireBoolean(value.shortcuts.findJavaImplementations, "editor.shortcuts.findJavaImplementations"),
      cmdClickDrillDown: requireBoolean(value.shortcuts.cmdClickDrillDown, "editor.shortcuts.cmdClickDrillDown"),
      shiftClickHierarchy: requireBoolean(value.shortcuts.shiftClickHierarchy, "editor.shortcuts.shiftClickHierarchy"),
    },
  };
}

export function validatePiWebWorkflowConfig(value: unknown): PiWebWorkflowConfig {
  if (!isRecord(value)) {
    throw new PiWebConfigValidationError("workflow config must be an object");
  }
  return {
    includeArchived: requireBoolean(value.includeArchived, "workflow.includeArchived"),
    // Optional for older clients that only patch includeArchived; default stays false.
    trackInGit:
      value.trackInGit === undefined
        ? DEFAULT_PI_WEB_CONFIG.workflow.trackInGit
        : requireBoolean(value.trackInGit, "workflow.trackInGit"),
  };
}

export function writePiWebConfigPatch(patch: PiWebConfigPatch): PiWebConfigReadResult {
  if (!isRecord(patch)) {
    throw new PiWebConfigValidationError("config patch must be an object");
  }

  const hasWorktree = Object.prototype.hasOwnProperty.call(patch, "worktree");
  const hasWorkflow = Object.prototype.hasOwnProperty.call(patch, "workflow");
  const hasUsage = Object.prototype.hasOwnProperty.call(patch, "usage");
  const hasVision = Object.prototype.hasOwnProperty.call(patch, "vision");
  const hasTerminal = Object.prototype.hasOwnProperty.call(patch, "terminal");
  const hasChatGpt = Object.prototype.hasOwnProperty.call(patch, "chatgpt");
  const hasEditor = Object.prototype.hasOwnProperty.call(patch, "editor");
  const hasGrok = Object.prototype.hasOwnProperty.call(patch, "grok");
  const hasBundledExtensions = Object.prototype.hasOwnProperty.call(patch, "bundledExtensions");
  if (!hasWorktree && !hasWorkflow && !hasUsage && !hasVision && !hasTerminal && !hasChatGpt && !hasEditor && !hasGrok && !hasBundledExtensions) {
    throw new PiWebConfigValidationError("no supported config sections provided");
  }

  const path = getPiWebConfigPath();
  const current = readRawConfigFile(path);
  const raw = current.parseError ? {} : current.raw;
  const currentConfig = normalizePiWebConfig(raw);
  const chatGptPatch = hasChatGpt ? patch.chatgpt : undefined;
  const normalizedWorktree = hasWorktree ? validatePiWebWorktreeConfig(patch.worktree) : undefined;
  const normalizedGrok = hasGrok ? validatePiWebGrokConfig(patch.grok) : undefined;
  const normalizedBundledExtensions = hasBundledExtensions ? validatePiWebBundledExtensionsConfig(patch.bundledExtensions) : undefined;
  const normalizedWorkflow = hasWorkflow ? validatePiWebWorkflowConfig(patch.workflow) : undefined;
  const normalizedUsage = hasUsage ? validatePiWebUsageConfig(patch.usage) : undefined;
  const normalizedVision = hasVision ? validatePiWebVisionConfig(patch.vision) : undefined;
  const normalizedTerminal = hasTerminal ? validatePiWebTerminalConfig(patch.terminal) : undefined;
  const normalizedChatGpt = hasChatGpt ? validatePiWebChatGptConfig(isRecord(chatGptPatch) ? {
    ...currentConfig.chatgpt,
    ...chatGptPatch,
    warmup: Object.prototype.hasOwnProperty.call(chatGptPatch, "warmup")
      ? chatGptPatch.warmup
      : currentConfig.chatgpt.warmup,
  } : chatGptPatch) : undefined;
  const normalizedEditor = hasEditor ? validatePiWebEditorConfig(patch.editor) : undefined;
  // Spread preserves unknown root keys such as legacy `trellis` without reading them.
  const nextRaw: Record<string, unknown> = { ...raw };

  if (normalizedWorktree) {
    const previousWorktree = isRecord(raw.worktree) ? raw.worktree : {};
    nextRaw.worktree = {
      ...previousWorktree,
      ...normalizedWorktree,
    };
  }

  if (normalizedWorkflow) {
    const previousWorkflow = isRecord(raw.workflow) ? raw.workflow : {};
    nextRaw.workflow = {
      ...previousWorkflow,
      ...normalizedWorkflow,
    };
  }

  if (normalizedUsage) {
    const previousUsage = isRecord(raw.usage) ? raw.usage : {};
    nextRaw.usage = {
      ...previousUsage,
      ...normalizedUsage,
    };
  }

  if (normalizedVision) {
    const previousVision = isRecord(raw.vision) ? raw.vision : {};
    nextRaw.vision = {
      ...previousVision,
      ...normalizedVision,
    };
  }

  if (normalizedTerminal) {
    const previousTerminal = isRecord(raw.terminal) ? raw.terminal : {};
    nextRaw.terminal = {
      ...previousTerminal,
      ...normalizedTerminal,
    };
  }

  if (normalizedChatGpt) {
    const previousChatGpt = isRecord(raw.chatgpt) ? raw.chatgpt : {};
    nextRaw.chatgpt = {
      ...previousChatGpt,
      ...normalizedChatGpt,
    };
  }

  if (normalizedEditor) {
    const previousEditor = isRecord(raw.editor) ? raw.editor : {};
    nextRaw.editor = {
      ...previousEditor,
      ...normalizedEditor,
    };
  }

  if (normalizedGrok) {
    const previousGrok = isRecord(raw.grok) ? raw.grok : {};
    nextRaw.grok = {
      ...previousGrok,
      ...normalizedGrok,
    };
  }

  if (normalizedBundledExtensions) {
    const previousBundledExtensions = isRecord(raw.bundledExtensions) ? raw.bundledExtensions : {};
    nextRaw.bundledExtensions = {
      ...previousBundledExtensions,
      ...normalizedBundledExtensions,
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(nextRaw, null, 2)}\n`, "utf8");

  return {
    config: normalizePiWebConfig(nextRaw),
    defaults: DEFAULT_PI_WEB_CONFIG,
    path,
    exists: true,
  };
}

export function writePiWebWorktreeConfig(worktree: unknown): PiWebConfigReadResult {
  return writePiWebConfigPatch({ worktree });
}
