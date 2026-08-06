"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentsConfig } from "./AgentsConfig";
import { ExtensionsConfig } from "./ExtensionsConfig";
import { McpConfig } from "./McpConfig";
import { SkillsConfig } from "./SkillsConfig";
import { WebToolsConfig } from "./WebToolsConfig";
import type {
  PiWebBundledExtensionsConfig,
  PiWebChatGptConfig,
  PiWebConfig,
  PiWebEditorConfig,
  PiWebSubagentModelRef,
  PiWebSubagentRunPolicy,
  PiWebTerminalConfig,
  PiWebUsageConfig,
  PiWebWorkflowConfig,
  PiWebWorktreeConfig,
} from "@/lib/pi-web-config";
import type { WorkflowSetupCommandResponse, WorkflowSetupStatus } from "@/lib/workflow-setup";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsButton,
  SettingsField as Field,
  SettingsInput,
  SettingsNotice,
  SettingsSectionHeader,
  SettingsSelect,
  SettingsState,
  SettingsTextarea,
  SettingsTextInput as TextInput,
  SettingsToggle as ToggleField,
} from "@/components/ui/SettingsPrimitives";
import type { Locale } from "@/lib/i18n";
import { BUNDLED_PI_EXTENSIONS } from "@/lib/bundled-pi-extension-registry";

interface WebConfigResponse {
  config: PiWebConfig;
  defaults: PiWebConfig;
  path: string;
  exists: boolean;
  parseError?: string;
  error?: string;
}

interface WorkflowStatusResponse {
  status?: WorkflowSetupStatus;
  error?: string;
}

interface WorkflowActionResponse extends WorkflowSetupCommandResponse {
  config?: PiWebConfig;
  error?: string;
}

interface ModelListItem {
  id: string;
  name: string;
  provider: string;
}

interface ModelsResponse {
  modelList?: ModelListItem[];
  defaultModel?: { provider: string; modelId: string } | null;
  error?: string;
}

const TEMPLATE_VARIABLES = [
  { token: "{repoRoot}", descriptionKey: "settings.pathVarsRepoAbs" },
  { token: "{repoParent}", descriptionKey: "settings.pathVarsRepoParent" },
  { token: "{repoName}", descriptionKey: "settings.pathVarsRepoName" },
  { token: "{baseDir}", descriptionKey: "settings.pathVarsBaseDir" },
  { token: "{branchName}", descriptionKey: "settings.pathVarsBranch" },
  { token: "{branchSlug}", descriptionKey: "settings.pathVarsBranchSlug" },
  { token: "{yyyyMMdd-HHmmss}", descriptionKey: "settings.pathVarsTimestamp" },
];

type SettingsSection = "language" | "worktree" | "usage" | "terminal" | "editor" | "agents" | "mcp" | "skills" | "webtools" | "workflow" | "extensions";
type SubagentThinkingOption = PiWebSubagentRunPolicy["thinking"];

const SUBAGENT_THINKING_OPTIONS: SubagentThinkingOption[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];

function formatModelValue(model: PiWebSubagentModelRef): string {
  if (model.mode !== "specific") return model.mode;
  return `specific:${model.provider ?? ""}/${model.modelId ?? ""}`;
}

function parseModelValue(value: string): PiWebSubagentModelRef {
  if (value === "followMain" || value === "piDefault" || value === "unset") return { mode: value };
  if (value.startsWith("specific:")) {
    const [provider, modelId] = value.slice("specific:".length).split("/");
    if (provider && modelId) return { mode: "specific", provider, modelId };
  }
  return { mode: "unset" };
}

function ModelPolicySelect({
  value,
  onChange,
  models,
  disabled = false,
}: {
  value: PiWebSubagentModelRef;
  onChange: (value: PiWebSubagentModelRef) => void;
  models: ModelListItem[];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SettingsSelect
      value={formatModelValue(value)}
      onChange={(e) => onChange(parseModelValue(e.target.value))}
      disabled={disabled}
    >
      <option value="followMain">{t("settings.followMainModel")}</option>
      <option value="piDefault">{t("settings.piDefaultModel")}</option>
      <option value="unset">{t("settings.unsetModel")}</option>
      {models.length > 0 && <option disabled>──────────</option>}
      {models.map((model) => (
        <option key={`${model.provider}/${model.id}`} value={`specific:${model.provider}/${model.id}`}>
          {model.name} · {model.provider}/{model.id}
        </option>
      ))}
    </SettingsSelect>
  );
}

function ThinkingSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: SubagentThinkingOption;
  onChange: (value: SubagentThinkingOption) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <SettingsSelect
      value={value}
      onChange={(e) => onChange(e.target.value as SubagentThinkingOption)}
      disabled={disabled}
    >
      {SUBAGENT_THINKING_OPTIONS.map((option) => (
        <option key={option} value={option}>{option === "inherit" ? t("settings.followMainThinking") : option === "off" ? t("settings.thinkingOff") : option}</option>
      ))}
    </SettingsSelect>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  const { t } = useI18n();
  return (
    <span className={`settings-status-badge ${ok ? "settings-status-badge-success" : "settings-status-badge-danger"}`}>
      {label ?? (ok ? t("settings.passed") : t("settings.needsAttention"))}
    </span>
  );
}

function StatusRow({ label, value, ok, detail }: { label: string; value: string; ok: boolean; detail?: string }) {
  return (
    <div className="settings-status-row">
      <span className="settings-status-row-label">{label}</span>
      <span title={detail} className="settings-status-row-value">{value}</span>
      <StatusBadge ok={ok} />
    </div>
  );
}

function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  for (const char of line) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function parseRawEnv(text: string, translate: (key: string, params?: Record<string, string | number>) => string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const words = splitShellWords(trimmed);
    const candidates = words[0] === "export" ? words.slice(1) : words;
    let parsedAny = false;
    for (const word of candidates) {
      const eq = word.indexOf("=");
      if (eq <= 0) continue;
      const key = word.slice(0, eq).trim();
      const value = word.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        errors.push(translate("settings.envInvalidKey", { n: index + 1, key }));
        continue;
      }
      env[key] = value;
      parsedAny = true;
    }
    if (!parsedAny) errors.push(translate("settings.envNoKv", { n: index + 1 }));
  });
  return { env, errors };
}

function formatWorkflowRecommendedAction(status: WorkflowSetupStatus, t: (key: string) => string): string {
  if (status.recommendedAction === "initialize") return t("settings.workflowNeedsInit");
  if (status.recommendedAction === "update") return t("settings.workflowNeedsUpdate");
  if (status.recommendedAction === "ready") return t("settings.workflowReady");
  return t("settings.selectWorkspace");
}

function worktreeConfigsEqual(a: PiWebWorktreeConfig | null, b: PiWebWorktreeConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.baseRef === b.baseRef
    && a.branchNameTemplate === b.branchNameTemplate
    && a.baseDirTemplate === b.baseDirTemplate
    && a.pathTemplate === b.pathTemplate
    && a.sessionDisplay === b.sessionDisplay;
}

function workflowConfigsEqual(a: PiWebWorkflowConfig | null, b: PiWebWorkflowConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.includeArchived === b.includeArchived && a.trackInGit === b.trackInGit;
}

function usageConfigsEqual(a: PiWebUsageConfig | null, b: PiWebUsageConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.includeArchived === b.includeArchived;
}

function terminalConfigsEqual(a: PiWebTerminalConfig | null, b: PiWebTerminalConfig | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function chatGptConfigsEqual(a: PiWebChatGptConfig | null, b: PiWebChatGptConfig | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function editorConfigsEqual(a: PiWebEditorConfig | null, b: PiWebEditorConfig | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SettingsConfig({ cwd, onClose, onConfigChange }: { cwd: string | null; onClose: () => void; onConfigChange?: () => void }) {
  const { locale, setLocale, t } = useI18n();
  const [section, setSection] = useState<SettingsSection>("language");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configPath, setConfigPath] = useState("");
  const [exists, setExists] = useState(false);
  const [defaults, setDefaults] = useState<PiWebConfig | null>(null);
  const [worktree, setWorktree] = useState<PiWebWorktreeConfig | null>(null);
  const [savedWorktree, setSavedWorktree] = useState<PiWebWorktreeConfig | null>(null);
  const [workflow, setWorkflow] = useState<PiWebWorkflowConfig | null>(null);
  const [savedWorkflow, setSavedWorkflow] = useState<PiWebWorkflowConfig | null>(null);
  const [usage, setUsage] = useState<PiWebUsageConfig | null>(null);
  const [savedUsage, setSavedUsage] = useState<PiWebUsageConfig | null>(null);
  const [terminal, setTerminal] = useState<PiWebTerminalConfig | null>(null);
  const [savedTerminal, setSavedTerminal] = useState<PiWebTerminalConfig | null>(null);
  const [rawEnvImport, setRawEnvImport] = useState("");
  const [terminalEnvAssistLoading, setTerminalEnvAssistLoading] = useState(false);
  const [chatgpt, setChatgpt] = useState<PiWebChatGptConfig | null>(null);
  const [savedChatgpt, setSavedChatgpt] = useState<PiWebChatGptConfig | null>(null);
  const [grok, setGrok] = useState<import("@/lib/pi-web-config").PiWebGrokConfig | null>(null);
  const [savedGrok, setSavedGrok] = useState<import("@/lib/pi-web-config").PiWebGrokConfig | null>(null);
  const [editor, setEditor] = useState<PiWebEditorConfig | null>(null);
  const [savedEditor, setSavedEditor] = useState<PiWebEditorConfig | null>(null);
  const [bundledExtensions, setBundledExtensions] = useState<PiWebBundledExtensionsConfig | null>(null);
  const [savedBundledExtensions, setSavedBundledExtensions] = useState<PiWebBundledExtensionsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<WorkflowSetupStatus | null>(null);
  const [workflowStatusLoading, setWorkflowStatusLoading] = useState(false);
  const [workflowStatusError, setWorkflowStatusError] = useState<string | null>(null);
  const [workflowAction, setWorkflowAction] = useState<"init" | "update" | null>(null);
  const [workflowOutput, setWorkflowOutput] = useState<string | null>(null);
  const [modelList, setModelList] = useState<ModelListItem[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const dirty = useMemo(
    () => !worktreeConfigsEqual(worktree, savedWorktree) || !workflowConfigsEqual(workflow, savedWorkflow) || !usageConfigsEqual(usage, savedUsage) || !terminalConfigsEqual(terminal, savedTerminal) || !chatGptConfigsEqual(chatgpt, savedChatgpt) || JSON.stringify(grok) !== JSON.stringify(savedGrok) || !editorConfigsEqual(editor, savedEditor) || JSON.stringify(bundledExtensions) !== JSON.stringify(savedBundledExtensions),
    [worktree, savedWorktree, workflow, savedWorkflow, usage, savedUsage, terminal, savedTerminal, chatgpt, savedChatgpt, grok, savedGrok, editor, savedEditor, bundledExtensions, savedBundledExtensions],
  );

  const loadConfig = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/web-config", { signal });
      const data = await res.json() as WebConfigResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDefaults(data.defaults);
      setWorktree(data.config.worktree);
      setSavedWorktree(data.config.worktree);
      setWorkflow(data.config.workflow);
      setSavedWorkflow(data.config.workflow);
      setUsage(data.config.usage);
      setSavedUsage(data.config.usage);
      setTerminal(data.config.terminal);
      setSavedTerminal(data.config.terminal);
      setChatgpt(data.config.chatgpt);
      setSavedChatgpt(data.config.chatgpt);
      setGrok(data.config.grok);
      setSavedGrok(data.config.grok);
      setEditor(data.config.editor);
      setSavedEditor(data.config.editor);
      setBundledExtensions(data.config.bundledExtensions);
      setSavedBundledExtensions(data.config.bundledExtensions);
      setConfigPath(data.path);
      setExists(data.exists);
      if (data.parseError) {
        setNotice(`${t("settings.configParseError", { detail: data.parseError ?? "" })}`);
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    setModelsError(null);
    try {
      const res = await fetch("/api/models", { signal });
      const data = await res.json() as ModelsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setModelList(data.modelList ?? []);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setModelsError(err instanceof Error ? err.message : String(err));
      setModelList([]);
    }
  }, []);

  const loadWorkflowStatus = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) {
      setWorkflowStatus(null);
      setWorkflowStatusError(null);
      setWorkflowStatusLoading(false);
      return;
    }
    setWorkflowStatusLoading(true);
    setWorkflowStatusError(null);
    try {
      const res = await fetch(`/api/workflows/setup/status?cwd=${encodeURIComponent(cwd)}`, { signal });
      const data = await res.json() as WorkflowStatusResponse;
      if (!res.ok || data.error || !data.status) throw new Error(data.error ?? `HTTP ${res.status}`);
      setWorkflowStatus(data.status);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setWorkflowStatus(null);
      setWorkflowStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkflowStatusLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);

  useEffect(() => {
    setWorkflowOutput(null);
  }, [cwd]);

  useEffect(() => {
    if (section !== "terminal" && section !== "workflow") return;
    const controller = new AbortController();
    if (section === "workflow") void loadWorkflowStatus(controller.signal);
    if (section === "terminal") void loadModels(controller.signal);
    return () => controller.abort();
  }, [section, loadModels, loadWorkflowStatus]);

  const updateWorktree = useCallback((patch: Partial<PiWebWorktreeConfig>) => {
    setWorktree((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateWorkflow = useCallback((patch: Partial<PiWebWorkflowConfig>) => {
    setWorkflow((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateUsage = useCallback((patch: Partial<PiWebUsageConfig>) => {
    setUsage((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateChatgpt = useCallback((patch: Partial<PiWebChatGptConfig>) => {
    setChatgpt((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateGrok = useCallback((patch: Partial<import("@/lib/pi-web-config").PiWebGrokConfig>) => {
    setGrok((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateEditor = useCallback((patch: Partial<PiWebEditorConfig>) => {
    setEditor((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateEditorShortcuts = useCallback((patch: Partial<PiWebEditorConfig["shortcuts"]>) => {
    setEditor((prev) => prev ? { ...prev, shortcuts: { ...prev.shortcuts, ...patch } } : prev);
    setNotice(null);
  }, []);

  const updateTerminal = useCallback((patch: Partial<PiWebTerminalConfig>) => {
    setTerminal((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateTerminalEnv = useCallback((key: string, nextKey: string, value: string) => {
    setTerminal((prev) => {
      if (!prev) return prev;
      const nextEnv = { ...prev.env };
      delete nextEnv[key];
      if (nextKey) nextEnv[nextKey] = value;
      return { ...prev, env: nextEnv };
    });
    setNotice(null);
  }, []);

  const deleteTerminalEnv = useCallback((key: string) => {
    setTerminal((prev) => {
      if (!prev) return prev;
      const nextEnv = { ...prev.env };
      delete nextEnv[key];
      return { ...prev, env: nextEnv };
    });
    setNotice(null);
  }, []);

  const importRawEnv = useCallback(() => {
    const parsed = parseRawEnv(rawEnvImport, t);
    if (parsed.errors.length > 0) {
      setError(parsed.errors.join("；"));
      return;
    }
    setTerminal((prev) => prev ? { ...prev, env: { ...prev.env, ...parsed.env } } : prev);
    setRawEnvImport("");
    setError(null);
    setNotice(t("settings.envParsed"));
  }, [rawEnvImport, t]);

  const importRawEnvWithAi = useCallback(async () => {
    if (!cwd || !rawEnvImport.trim()) return;
    setTerminalEnvAssistLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/terminal/env/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, raw: rawEnvImport }),
      });
      const data = await res.json() as { env?: Record<string, string>; error?: string };
      if (!res.ok || data.error || !data.env) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTerminal((prev) => prev ? { ...prev, env: { ...prev.env, ...data.env } } : prev);
      setRawEnvImport("");
      setNotice(t("settings.envParsedAi"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTerminalEnvAssistLoading(false);
    }
  }, [cwd, rawEnvImport, t]);

  const updateTerminalEnvAssistantPolicy = useCallback((patch: Partial<PiWebSubagentRunPolicy>) => {
    setTerminal((prev) => prev ? { ...prev, envAssistant: { ...prev.envAssistant, ...patch } } : prev);
    setNotice(null);
  }, []);

  const updateTerminalEnvAssistantFallbackPolicy = useCallback((patch: Partial<PiWebSubagentRunPolicy>) => {
    setTerminal((prev) => prev ? { ...prev, envAssistantFallback: { ...prev.envAssistantFallback, ...patch } } : prev);
    setNotice(null);
  }, []);

  const applyLoadedConfig = useCallback((config: PiWebConfig, path: string, configExists: boolean, nextDefaults?: PiWebConfig) => {
    if (nextDefaults) setDefaults(nextDefaults);
    setWorktree(config.worktree);
    setSavedWorktree(config.worktree);
    setWorkflow(config.workflow);
    setSavedWorkflow(config.workflow);
    setUsage(config.usage);
    setSavedUsage(config.usage);
    setTerminal(config.terminal);
    setSavedTerminal(config.terminal);
    setChatgpt(config.chatgpt);
    setSavedChatgpt(config.chatgpt);
    setGrok(config.grok);
    setSavedGrok(config.grok);
    setEditor(config.editor);
    setSavedEditor(config.editor);
    setBundledExtensions(config.bundledExtensions);
    setSavedBundledExtensions(config.bundledExtensions);
    setConfigPath(path);
    setExists(configExists);
    onConfigChange?.();
  }, [onConfigChange]);

  const saveConfig = useCallback(async (successNotice?: string): Promise<boolean> => {
    if (!worktree || !workflow || !usage || !terminal || !chatgpt || !grok || !editor || !bundledExtensions) return false;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/web-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Intentionally omit legacy trellis so inert pi-web.json.trellis data is preserved.
        body: JSON.stringify({ worktree, workflow, usage, terminal, chatgpt, grok, editor, bundledExtensions }),
      });
      const data = await res.json() as WebConfigResponse & { success?: boolean };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      applyLoadedConfig(data.config, data.path, data.exists, data.defaults);
      if (successNotice) setNotice(successNotice);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [applyLoadedConfig, worktree, workflow, usage, terminal, chatgpt, grok, editor, bundledExtensions]);

  const handleSave = useCallback(async () => {
    await saveConfig(t("settings.savedToast"));
  }, [saveConfig, t]);

  const resetToDefaults = useCallback(() => {
    if (!defaults) return;
    setWorktree(defaults.worktree);
    setWorkflow(defaults.workflow);
    setUsage(defaults.usage);
    setTerminal(defaults.terminal);
    setChatgpt(defaults.chatgpt);
    setGrok(defaults.grok);
    setEditor(defaults.editor);
    setBundledExtensions(defaults.bundledExtensions);
    setNotice(t("settings.restoredDefaults"));
  }, [defaults, t]);

  const applyConfigFromResponse = useCallback((config: PiWebConfig) => {
    setWorktree(config.worktree);
    setSavedWorktree(config.worktree);
    setWorkflow(config.workflow);
    setSavedWorkflow(config.workflow);
    setUsage(config.usage);
    setSavedUsage(config.usage);
    setTerminal(config.terminal);
    setSavedTerminal(config.terminal);
    setChatgpt(config.chatgpt);
    setSavedChatgpt(config.chatgpt);
    setGrok(config.grok);
    setSavedGrok(config.grok);
    setEditor(config.editor);
    setSavedEditor(config.editor);
    setBundledExtensions(config.bundledExtensions);
    setSavedBundledExtensions(config.bundledExtensions);
    onConfigChange?.();
  }, [onConfigChange]);

  const runWorkflowSetupAction = useCallback(async (action: "init" | "update") => {
    if (!cwd || !workflow) return;
    if (dirty) {
      const saved = await saveConfig();
      if (!saved) return;
    }
    setWorkflowAction(action);
    setError(null);
    setNotice(null);
    setWorkflowOutput(null);
    try {
      const res = await fetch(`/api/workflows/setup/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = await res.json() as WorkflowActionResponse;
      if (!res.ok || data.error || !data.status) throw new Error(data.error ?? `HTTP ${res.status}`);
      setWorkflowStatus(data.status);
      setWorkflowOutput(data.output || t("settings.operationDone"));
      if (data.config) applyConfigFromResponse(data.config);
      setNotice(action === "init" ? t("settings.workflowInitialized") : t("settings.workflowUpdated"));
      void loadWorkflowStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkflowAction(null);
    }
  }, [applyConfigFromResponse, cwd, dirty, loadWorkflowStatus, saveConfig, t, workflow]);

  const renderSectionButton = (id: SettingsSection, label: string, description: string) => {
    const active = section === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => setSection(id)}
        className={`settings-section-nav-button${active ? " settings-section-nav-button-active" : ""}`}
        aria-current={active ? "page" : undefined}
        title={description}
      >
        {label}
      </button>
    );
  };

  const workflowBusy = !!workflowAction || saving;
  const workflowBlockingReason = !cwd
    ? t("settings.selectWorkspaceFirst")
    : workflowStatusError
      ? workflowStatusError
      : null;
  const canInitializeWorkflow =
    !!cwd && workflowStatus?.recommendedAction === "initialize" && !workflowBusy && !workflowStatusLoading;
  const canUpdateWorkflow =
    !!cwd &&
    !!workflowStatus?.initialized &&
    !!workflowStatus.updateAvailable &&
    !workflowBusy &&
    !workflowStatusLoading;

  return (
    <>
    <div className="pi-modal-overlay" onClick={onClose}>
      <div
        className="pi-modal-panel settings-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pi-modal-header">
          <div className="pi-modal-header-copy">
            <h2 id="settings-modal-title" className="pi-modal-title">{t("settings.title")}</h2>
            <p className="pi-modal-subtitle">{t("settings.subtitle")}</p>
          </div>
          <button type="button" onClick={onClose} className="pi-modal-close" title={t("settings.close")} aria-label={t("settings.close")}>
            ×
          </button>
        </div>

        <div className="settings-modal-body">
          <nav className="settings-section-nav" aria-label={t("settings.title")}>
            {renderSectionButton("language", t("common.language"), t("settings.languageSection"))}
            {renderSectionButton("worktree", t("settings.sectionWorktree"), t("settings.worktreeSection"))}
            {renderSectionButton("usage", t("settings.sectionUsage"), t("settings.usageSection"))}
            {renderSectionButton("terminal", t("settings.sectionTerminal"), t("settings.terminalSection"))}
            {renderSectionButton("editor", t("settings.sectionEditor"), t("settings.editorSection"))}
            {renderSectionButton("agents", t("settings.sectionAgents"), t("settings.agentsSection"))}
            {renderSectionButton("mcp", t("settings.sectionMcp"), t("settings.mcpSection"))}
            {renderSectionButton("skills", t("settings.sectionSkills"), t("settings.skillsSection"))}
            {renderSectionButton("webtools", t("settings.webTools.nav"), t("settings.webTools.title"))}
            {renderSectionButton("workflow", "SnFlow", t("settings.workflowSection"))}
            {renderSectionButton("extensions", "Extensions", t("settings.extensionsSection"))}
          </nav>

          <div className="settings-modal-content">
            {loading ? (
              <SettingsState kind="loading" title={t("settings.loadingSettings")} />
            ) : worktree && workflow && usage && terminal && chatgpt && editor && bundledExtensions ? (
              <div className="settings-section">
                {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
                {notice && <SettingsNotice>{notice}</SettingsNotice>}

                {section === "language" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader title={t("settings.languageSection")} description={t("settings.languageHint")} />
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {(["zh", "en"] as Locale[]).map((item) => {
                        const active = locale === item;
                        return (
                          <SettingsButton
                            key={item}
                            variant={active ? "primary" : "secondary"}
                            onClick={() => setLocale(item)}
                            aria-pressed={active}
                          >
                            {item === "zh" ? t("common.chinese") : t("common.english")}
                          </SettingsButton>
                        );
                      })}
                    </div>
                  </div>
                ) : section === "worktree" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.worktreeSection")}
                      description={<>{t("settings.saveTo")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />

                    <div className="settings-grid">
                      <Field label={t("settings.baseRef")} description={t("settings.baseRefHint")}>
                        <TextInput value={worktree.baseRef} onChange={(baseRef) => updateWorktree({ baseRef })} placeholder="HEAD" />
                      </Field>
                      <Field label={t("settings.sessionDisplay")} description={t("settings.sessionDisplayHint")}>
                        <SettingsSelect
                          value={worktree.sessionDisplay}
                          onChange={(e) => updateWorktree({ sessionDisplay: e.target.value as PiWebWorktreeConfig["sessionDisplay"] })}
                        >
                          <option value="separate">{t("settings.sessionDisplaySeparate")}</option>
                          <option value="tag">{t("settings.sessionDisplayTag")}</option>
                        </SettingsSelect>
                      </Field>
                    </div>

                    <Field label={t("settings.branchTemplate")} description={t("settings.branchTemplateHint")}>
                      <TextInput value={worktree.branchNameTemplate} onChange={(branchNameTemplate) => updateWorktree({ branchNameTemplate })} placeholder="pi/{yyyyMMdd-HHmmss}" />
                    </Field>
                    <Field label={t("settings.baseDirTemplate")} description={t("settings.baseDirTemplateHint")}>
                      <TextInput value={worktree.baseDirTemplate} onChange={(baseDirTemplate) => updateWorktree({ baseDirTemplate })} placeholder="{repoParent}/{repoName}.worktrees" />
                    </Field>
                    <Field label={t("settings.pathTemplate")} description={t("settings.pathTemplateHint")}>
                      <TextInput value={worktree.pathTemplate} onChange={(pathTemplate) => updateWorktree({ pathTemplate })} placeholder="{baseDir}/{branchSlug}" />
                    </Field>

                    <div className="settings-surface">
                      <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, marginBottom: 8 }}>{t("settings.templateVariables")}</div>
                      <div className="settings-grid" style={{ gridTemplateColumns: "minmax(150px, max-content) 1fr", gap: "7px 12px", alignItems: "baseline" }}>
                        {TEMPLATE_VARIABLES.map((variable) => (
                          <div key={variable.token} style={{ display: "contents" }}>
                            <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, padding: "3px 6px", borderRadius: 5, background: "var(--bg)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                              {variable.token}
                            </code>
                            <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t(variable.descriptionKey)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : section === "usage" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.usageSection")}
                      description={<>{t("settings.usageDescription")} {t("settings.saveTo")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />
                    <ToggleField
                      label={t("settings.includeArchivedSessions")}
                      description={t("settings.includeArchivedSessionsHint")}
                      checked={usage.includeArchived}
                      onChange={(includeArchived) => updateUsage({ includeArchived })}
                    />

                    <SettingsSectionHeader
                      title="ChatGPT"
                      description={<>{t("settings.chatgptDescription")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />
                    <ToggleField
                      label={t("settings.chatgptSection")}
                      description={t("settings.chatgptPanelEnable")}
                      checked={chatgpt.usagePanelEnabled}
                      onChange={(usagePanelEnabled) => updateChatgpt({ usagePanelEnabled })}
                    />
                    <ToggleField
                      label={t("settings.chatgptAutoRefresh")}
                      description={t("settings.chatgptAutoRefreshHint")}
                      checked={chatgpt.autoRefreshEnabled}
                      onChange={(autoRefreshEnabled) => updateChatgpt({ autoRefreshEnabled })}
                    />
                    <div className="settings-grid">
                      <Field label={t("settings.cycleInterval")} description={t("settings.cycleIntervalHint")}>
                        <SettingsInput type="number" min={300} step={60} value={chatgpt.refreshCycleIntervalSeconds} onChange={(e) => updateChatgpt({ refreshCycleIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.accountInterval")} description={t("settings.accountIntervalHint")}>
                        <SettingsInput type="number" min={5} step={1} value={chatgpt.refreshAccountIntervalSeconds} onChange={(e) => updateChatgpt({ refreshAccountIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <div className="settings-grid">
                      <Field label={t("settings.cycleSaltMin")} description={t("settings.cycleSaltMinHint")}>
                        <SettingsInput type="number" min={0} step={1} value={chatgpt.refreshCycleSaltMinSeconds} onChange={(e) => updateChatgpt({ refreshCycleSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.cycleSaltMax")} description={t("settings.cycleSaltMaxHint")}>
                        <SettingsInput type="number" min={0} step={1} value={chatgpt.refreshCycleSaltMaxSeconds} onChange={(e) => updateChatgpt({ refreshCycleSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <div className="settings-grid">
                      <Field label={t("settings.accountSaltMin")} description={t("settings.accountSaltMinHint")}>
                        <SettingsInput type="number" min={0} step={1} value={chatgpt.refreshAccountSaltMinSeconds} onChange={(e) => updateChatgpt({ refreshAccountSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.accountSaltMax")} description={t("settings.accountSaltMaxHint")}>
                        <SettingsInput type="number" min={0} step={1} value={chatgpt.refreshAccountSaltMaxSeconds} onChange={(e) => updateChatgpt({ refreshAccountSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <SettingsNotice>{t("settings.chatgptLockInfo")}</SettingsNotice>

                    <SettingsSectionHeader
                      title="Grok"
                      description={<>{t("settings.grokDescription")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />
                    <ToggleField
                      label={t("settings.grokUsagePanel")}
                      description={t("settings.grokPanelEnable")}
                      checked={grok?.usagePanelEnabled ?? false}
                      onChange={(usagePanelEnabled) => updateGrok({ usagePanelEnabled })}
                    />
                    <ToggleField
                      label={t("settings.grokAutoRefresh")}
                      description={t("settings.grokAutoRefreshHint")}
                      checked={grok?.autoRefreshEnabled ?? false}
                      onChange={(autoRefreshEnabled) => updateGrok({ autoRefreshEnabled })}
                    />
                    <div className="settings-grid">
                      <Field label={t("settings.cycleInterval")} description={t("settings.cycleIntervalHint")}>
                        <SettingsInput type="number" min={300} step={60} value={grok?.refreshCycleIntervalSeconds ?? 1800} onChange={(e) => updateGrok({ refreshCycleIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.accountInterval")} description={t("settings.accountIntervalHint")}>
                        <SettingsInput type="number" min={5} step={1} value={grok?.refreshAccountIntervalSeconds ?? 20} onChange={(e) => updateGrok({ refreshAccountIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <div className="settings-grid">
                      <Field label={t("settings.cycleSaltMin")} description={t("settings.cycleSaltMinHint")}>
                        <SettingsInput type="number" min={0} step={1} value={grok?.refreshCycleSaltMinSeconds ?? 0} onChange={(e) => updateGrok({ refreshCycleSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.cycleSaltMax")} description={t("settings.cycleSaltMaxHint")}>
                        <SettingsInput type="number" min={0} step={1} value={grok?.refreshCycleSaltMaxSeconds ?? 120} onChange={(e) => updateGrok({ refreshCycleSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <div className="settings-grid">
                      <Field label={t("settings.accountSaltMin")} description={t("settings.accountSaltMinHint")}>
                        <SettingsInput type="number" min={0} step={1} value={grok?.refreshAccountSaltMinSeconds ?? 0} onChange={(e) => updateGrok({ refreshAccountSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                      <Field label={t("settings.accountSaltMax")} description={t("settings.accountSaltMaxHint")}>
                        <SettingsInput type="number" min={0} step={1} value={grok?.refreshAccountSaltMaxSeconds ?? 15} onChange={(e) => updateGrok({ refreshAccountSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} />
                      </Field>
                    </div>
                    <SettingsNotice>{t("settings.grokLockInfo")}</SettingsNotice>
                  </div>
                ) : section === "terminal" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.terminalSection")}
                      description={<>{t("settings.terminalDescription")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />
                    <ToggleField
                      label={t("settings.enableTerminal")}
                      description={t("settings.enableTerminalHint")}
                      checked={terminal.enabled}
                      onChange={(enabled) => updateTerminal({ enabled })}
                    />
                    <div className="settings-grid">
                      <Field label={t("settings.shellType")} description={t("settings.windowsShellHint")}>
                        <SettingsSelect
                          value={terminal.shell}
                          onChange={(e) => updateTerminal({ shell: e.target.value as PiWebTerminalConfig["shell"] })}
                        >
                          <option value="zsh">zsh</option>
                          <option value="bash">bash</option>
                          <option value="sh">sh</option>
                          <option value="cmd">cmd</option>
                          <option value="powershell">Windows PowerShell</option>
                          <option value="pwsh">PowerShell 7</option>
                          <option value="custom">custom path</option>
                        </SettingsSelect>
                      </Field>
                      <Field label={t("settings.customShellPath")} description={t("settings.customShellPathHint")}>
                        <TextInput
                          value={terminal.customShellPath}
                          onChange={(customShellPath) => updateTerminal({ customShellPath })}
                          placeholder="/absolute/path/to/shell or C:\\path\\to\\shell.exe"
                          disabled={terminal.shell !== "custom"}
                        />
                      </Field>
                    </div>
                    <div className="settings-surface">
                      <div>
                        <div className="settings-surface-title">{t("settings.envVariables")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.envVariablesHint")}
                        </div>
                      </div>
                      <div className="settings-grid settings-env-grid" style={{ gridTemplateColumns: "minmax(120px, 0.45fr) minmax(160px, 1fr) 70px", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>{t("settings.envName")}</span>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>{t("settings.envValue")}</span>
                        <span />
                        {Object.entries(terminal.env).map(([key, value]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <TextInput value={key} onChange={(nextKey) => updateTerminalEnv(key, nextKey.trim(), value)} placeholder="HTTP_PROXY" />
                            <TextInput value={value} onChange={(nextValue) => updateTerminalEnv(key, key, nextValue)} placeholder="value" />
                            <SettingsButton size="sm" onClick={() => deleteTerminalEnv(key)}>
                              {t("common.delete")}
                            </SettingsButton>
                          </div>
                        ))}
                      </div>
                      <SettingsButton
                        size="sm"
                        className="settings-align-start"
                        onClick={() => {
                          let index = Object.keys(terminal.env).length + 1;
                          let key = `TERMINAL_ENV_${index}`;
                          while (Object.prototype.hasOwnProperty.call(terminal.env, key)) {
                            index += 1;
                            key = `TERMINAL_ENV_${index}`;
                          }
                          updateTerminal({ env: { ...terminal.env, [key]: "" } });
                        }}
                      >
                        {t("settings.addVariable")}
                      </SettingsButton>
                      <Field label={t("settings.rawEnvImport")} description={t("settings.rawEnvHint")}>
                        <SettingsTextarea
                          value={rawEnvImport}
                          onChange={(e) => setRawEnvImport(e.target.value)}
                          placeholder={'export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897\nNODE_OPTIONS="--max-old-space-size=4096"'}
                          rows={4}
                          spellCheck={false}
                          className="settings-control-mono"
                        />
                      </Field>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <SettingsButton size="sm" onClick={importRawEnv} disabled={!rawEnvImport.trim()}>
                          {t("settings.parseToTable")}
                        </SettingsButton>
                        <SettingsButton
                          size="sm"
                          onClick={() => void importRawEnvWithAi()}
                          disabled={!cwd || !rawEnvImport.trim() || terminalEnvAssistLoading}
                          busy={terminalEnvAssistLoading}
                          title={cwd ? t("settings.aiParseEnvHint") : t("settings.selectWorkspaceShort")}
                        >
                          {terminalEnvAssistLoading ? t("settings.aiParsing") : t("settings.aiParse")}
                        </SettingsButton>
                      </div>
                    </div>
                    <div className="settings-surface">
                      <div>
                        <div className="settings-surface-title">{t("settings.envAssistantTitle")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.envAssistantDesc")}
                        </div>
                      </div>
                      {modelsError && <SettingsNotice tone="danger">{modelsError}</SettingsNotice>}
                      <div className="settings-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
                        <Field label={t("settings.aiParseModel")} description={t("settings.piDefaultHint")}>
                          <ModelPolicySelect value={terminal.envAssistant.model} onChange={(model) => updateTerminalEnvAssistantPolicy({ model })} models={modelList} />
                        </Field>
                        <Field label={t("settings.thinkingLevel")} description={t("settings.suggestMinimalLow")}>
                          <ThinkingSelect value={terminal.envAssistant.thinking} onChange={(thinking) => updateTerminalEnvAssistantPolicy({ thinking })} />
                        </Field>
                      </div>
                      <div className="settings-grid" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
                        <Field label={t("settings.fallbackModel")} description={t("settings.mainFailFallback")}>
                          <ModelPolicySelect value={terminal.envAssistantFallback.model} onChange={(model) => updateTerminalEnvAssistantFallbackPolicy({ model })} models={modelList} />
                        </Field>
                        <Field label={t("settings.fallbackThinking")} description={t("settings.keepMinimal")}>
                          <ThinkingSelect value={terminal.envAssistantFallback.thinking} onChange={(thinking) => updateTerminalEnvAssistantFallbackPolicy({ thinking })} />
                        </Field>
                      </div>
                    </div>
                  </div>
                ) : section === "editor" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.editorSection")}
                      description={<>{t("settings.editorDescription")} <code className="settings-inline-code">{configPath}</code>{exists ? "" : t("settings.autoCreateOnSave")}</>}
                    />
                    <Field label={t("settings.editorImpl")} description={t("settings.editorImplHint")}>
                      <SettingsSelect
                        value={editor.kind}
                        onChange={(e) => updateEditor({ kind: e.target.value as PiWebEditorConfig["kind"] })}
                      >
                        <option value="monaco">Monaco Editor</option>
                      </SettingsSelect>
                    </Field>
                    <div className="settings-surface">
                      <div>
                        <div className="settings-surface-title">{t("settings.customShortcutsTitle")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.customShortcutsHint")}
                        </div>
                      </div>
                      <ToggleField
                        label={t("settings.saveFileShortcut")}
                        description={t("settings.saveFileHint")}
                        checked={editor.shortcuts.saveFile}
                        onChange={(saveFile) => updateEditorShortcuts({ saveFile })}
                      />
                      <ToggleField
                        label={t("settings.addToChatShortcut")}
                        description={t("settings.addToChatHint")}
                        checked={editor.shortcuts.addSelectionToChat}
                        onChange={(addSelectionToChat) => updateEditorShortcuts({ addSelectionToChat })}
                      />
                      <ToggleField
                        label={t("settings.findRefsShortcut")}
                        description={t("settings.findRefsHint")}
                        checked={editor.shortcuts.findReferences}
                        onChange={(findReferences) => updateEditorShortcuts({ findReferences })}
                      />
                      <ToggleField
                        label={t("settings.findJavaImplShortcut")}
                        description={t("settings.findJavaImplHint")}
                        checked={editor.shortcuts.findJavaImplementations}
                        onChange={(findJavaImplementations) => updateEditorShortcuts({ findJavaImplementations })}
                      />
                      <ToggleField
                        label={t("settings.cmdClick")}
                        description={t("settings.cmdClickHint")}
                        checked={editor.shortcuts.cmdClickDrillDown}
                        onChange={(cmdClickDrillDown) => updateEditorShortcuts({ cmdClickDrillDown })}
                      />
                      <ToggleField
                        label={t("settings.shiftClick")}
                        description={t("settings.shiftClickHint")}
                        checked={editor.shortcuts.shiftClickHierarchy}
                        onChange={(shiftClickHierarchy) => updateEditorShortcuts({ shiftClickHierarchy })}
                      />
                    </div>
                    <div className="settings-surface settings-surface-muted">
                      <div className="settings-surface-title">{t("settings.builtinShortcutsTitle")}</div>
                      <div className="settings-grid" style={{ gridTemplateColumns: "150px 1fr", gap: "6px 12px", alignItems: "baseline" }}>
                        {[
                          ["Cmd/Ctrl+F", t("settings.currentFind")],
                          ["Cmd/Ctrl+H", t("settings.currentReplace")],
                          ["Cmd/Ctrl+/", t("settings.toggleComment")],
                          ["Cmd/Ctrl+Space", t("settings.triggerSuggest")],
                          ["Alt+↑ / Alt+↓", t("settings.moveLine")],
                          ["Shift+Alt+↑ / ↓", t("settings.copyLine")],
                          ["F12", t("settings.jumpDefinition")],
                          ["Shift+F12", t("settings.monacoFindRefs")],
                        ].map(([key, desc]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 6px" }}>{key}</code>
                            <span>{desc}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 8 }}>{t("settings.monacoDisclaimer")}</div>
                    </div>
                  </div>
                ) : section === "extensions" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.bundledExtensionsTitle")}
                      description={t("settings.bundledExtensionsHint")}
                    />
                    {BUNDLED_PI_EXTENSIONS.map((extension) => (
                      <ToggleField
                        key={extension.id}
                        label={`${extension.displayName} · ${extension.id}`}
                        description={extension.description}
                        checked={bundledExtensions[extension.id]}
                        onChange={(enabled) => {
                          setBundledExtensions((current) => current ? { ...current, [extension.id]: enabled } : current);
                          setNotice(null);
                        }}
                      />
                    ))}
                    <SettingsNotice tone="warning">{t("settings.bundledExtensionsReloadHint")}</SettingsNotice>
                    <ExtensionsConfig cwd={cwd} onClose={() => {}} embed />
                  </div>
                ) : section === "agents" ? (
                  <AgentsConfig cwd={cwd} />
                ) : section === "mcp" ? (
                  <McpConfig cwd={cwd} />
                ) : section === "skills" ? (
                  cwd ? (
                    <SkillsConfig cwd={cwd} onClose={() => {}} embed />
                  ) : (
                    <SettingsState title={t("settings.selectWorkspaceFirst")} />
                  )
                ) : section === "webtools" ? (
                  <WebToolsConfig />
                ) : section === "workflow" ? (
                  <div className="settings-section">
                    <SettingsSectionHeader
                      title={t("settings.workflowSection")}
                      description={t("settings.workflowDescription")}
                      meta={<>{t("settings.currentWorkspace")}{cwd ? <code className="settings-inline-code">{cwd}</code> : t("settings.notSelected")}</>}
                    />
                    <div className="settings-grid">
                      <ToggleField
                        label={t("settings.workflowIncludeArchived")}
                        description={t("settings.workflowIncludeArchivedHint")}
                        checked={workflow.includeArchived}
                        onChange={(includeArchived) => updateWorkflow({ includeArchived })}
                      />
                      <ToggleField
                        label={t("settings.workflowTrackInGit")}
                        description={t("settings.workflowTrackInGitHint")}
                        checked={workflow.trackInGit}
                        onChange={(trackInGit) => updateWorkflow({ trackInGit })}
                      />
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
                      {t("settings.workflowTrackInGitApplyHint")}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                      {t("settings.workflowNativeModelsHint")}
                    </div>

                    <div className="settings-surface">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.workflowInspectionTitle")}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3 }}>
                            {workflowStatus
                              ? formatWorkflowRecommendedAction(workflowStatus, t)
                              : (cwd ? t("settings.checking") : t("settings.selectWorkspaceToInitWorkflow"))}
                          </div>
                        </div>
                        <SettingsButton
                          size="sm"
                          onClick={() => void loadWorkflowStatus()}
                          disabled={!cwd || workflowStatusLoading || workflowBusy}
                          busy={workflowStatusLoading}
                        >
                          {workflowStatusLoading ? t("settings.checkingShort") : t("settings.recheck")}
                        </SettingsButton>
                      </div>

                      {workflowStatusError && <SettingsNotice tone="danger">{workflowStatusError}</SettingsNotice>}
                      {workflowStatus && (
                        <div>
                          <StatusRow
                            label={t("settings.workflowProjectRoot")}
                            value={workflowStatus.initialized
                              ? (workflowStatus.projectVersion
                                ? t("settings.projectExistsVersion", { version: workflowStatus.projectVersion })
                                : t("settings.projectExists"))
                              : t("settings.notInitialized")}
                            ok={workflowStatus.initialized}
                            detail={workflowStatus.pathLabel}
                          />
                          <StatusRow
                            label={t("settings.workflowVersion")}
                            value={workflowStatus.projectVersion
                              ? (workflowStatus.updateAvailable
                                ? `${workflowStatus.projectVersion} → ${workflowStatus.bundledVersion}`
                                : workflowStatus.projectVersion)
                              : (workflowStatus.initialized
                                ? t("settings.workflowVersionMissing", { bundled: workflowStatus.bundledVersion })
                                : t("settings.notInitialized"))}
                            ok={workflowStatus.initialized && !workflowStatus.updateAvailable}
                            detail={t("settings.workflowBundledVersion", { version: workflowStatus.bundledVersion })}
                          />
                          <StatusRow
                            label={t("settings.workflowExtension")}
                            value={workflowStatus.hasExtension ? t("settings.installed") : t("settings.notInstalledShort")}
                            ok={workflowStatus.hasExtension}
                            detail=".pi/extensions/snflow/"
                          />
                          <StatusRow
                            label={t("settings.workflowSkill")}
                            value={workflowStatus.hasSkill ? t("settings.installed") : t("settings.notInstalledShort")}
                            ok={workflowStatus.hasSkill}
                            detail=".pi/skills/snflow-dev/"
                          />
                          <StatusRow
                            label={t("settings.workflowAgents")}
                            value={workflowStatus.hasAgents ? t("settings.installed") : t("settings.notInstalledShort")}
                            ok={workflowStatus.hasAgents}
                            detail=".pi/agents/snflow-*"
                          />
                          <StatusRow
                            label={t("settings.workflowScript")}
                            value={workflowStatus.hasScript ? t("settings.installed") : t("settings.notInstalledShort")}
                            ok={workflowStatus.hasScript}
                            detail="scripts/snflow-task.ts"
                          />
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <SettingsButton
                        variant="primary"
                        onClick={() => void runWorkflowSetupAction("init")}
                        disabled={!canInitializeWorkflow}
                        busy={workflowAction === "init"}
                        title={canInitializeWorkflow ? t("settings.initializeWorkflow") : workflowBlockingReason ?? t("settings.workflowAlreadyInitUseUpdate")}
                      >
                        {workflowAction === "init" ? t("settings.initializing") : t("settings.initializeWorkflow")}
                      </SettingsButton>
                      <SettingsButton
                        onClick={() => void runWorkflowSetupAction("update")}
                        disabled={!canUpdateWorkflow}
                        busy={workflowAction === "update"}
                        title={canUpdateWorkflow ? t("settings.updateWorkflow") : (workflowStatus && !workflowStatus.updateAvailable ? t("settings.workflowUpToDate") : workflowBlockingReason ?? t("settings.noWorkflowInitFirst"))}
                      >
                        {workflowAction === "update"
                          ? t("settings.updating")
                          : (workflowStatus && workflowStatus.initialized && !workflowStatus.updateAvailable
                            ? t("settings.workflowUpToDate")
                            : t("settings.updateWorkflow"))}
                      </SettingsButton>
                      {!canInitializeWorkflow && !canUpdateWorkflow && workflowBlockingReason && (
                        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{workflowBlockingReason}</span>
                      )}
                    </div>

                    {workflowOutput && (
                      <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {workflowOutput}
                      </pre>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <SettingsState kind="error" title={error ?? t("settings.loadFailed")} />
            )}
          </div>
        </div>

        <div className="pi-modal-footer settings-modal-footer">
          {section === "agents" || section === "mcp" || section === "skills" || section === "webtools" ? (
            <>
              <span className="settings-modal-footer-note">
                {section === "mcp" ? t("settings.mcpPanelNote") : section === "skills" ? t("settings.skillsPanelNote") : section === "webtools" ? t("settings.webTools.panelNote") : t("settings.agentsPanelNote")}
              </span>
              <SettingsButton onClick={onClose}>{t("common.close")}</SettingsButton>
            </>
          ) : (
            <>
              <SettingsButton onClick={resetToDefaults} disabled={!defaults || loading || saving}>
                {t("settings.resetDefaults")}
              </SettingsButton>
              <div className="settings-modal-footer-actions">
                {dirty && <span className="settings-dirty-note">{t("settings.unsavedChanges")}</span>}
                <SettingsButton onClick={onClose}>{t("common.cancel")}</SettingsButton>
                <SettingsButton
                  variant="primary"
                  onClick={() => void handleSave()}
                  disabled={!worktree || !workflow || !usage || !terminal || !chatgpt || !grok || !editor || !bundledExtensions || loading || saving || !dirty}
                  busy={saving}
                >
                  {saving ? t("settings.saving") : t("settings.save")}
                </SettingsButton>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
