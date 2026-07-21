"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TrellisWorkflowVisualizer } from "./TrellisWorkflowVisualizer";
import { AgentsConfig } from "./AgentsConfig";
import { ExtensionsConfig } from "./ExtensionsConfig";
import type {
  PiWebChatGptConfig,
  PiWebConfig,
  PiWebEditorConfig,
  PiWebSubagentAgentConfig,
  PiWebSubagentDifficultyTier,
  PiWebSubagentModelRef,
  PiWebSubagentModality,
  PiWebSubagentRunPolicy,
  PiWebTerminalConfig,
  PiWebTrellisConfig,
  PiWebUsageConfig,
  PiWebWorkflowConfig,
  PiWebWorktreeConfig,
} from "@/lib/pi-web-config";
import type { TrellisCommandResponse, TrellisSetupStatus } from "@/lib/trellis-setup-types";
import { useI18n } from "@/components/I18nProvider";
import type { Locale } from "@/lib/i18n";

interface WebConfigResponse {
  config: PiWebConfig;
  defaults: PiWebConfig;
  path: string;
  exists: boolean;
  parseError?: string;
  error?: string;
}

interface TrellisStatusResponse {
  status?: TrellisSetupStatus;
  error?: string;
}

interface TrellisActionResponse extends TrellisCommandResponse {
  config?: PiWebConfig;
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

const inputStyle: React.CSSProperties = {
  padding: "7px 9px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const TEMPLATE_VARIABLES = [
  { token: "{repoRoot}", descriptionKey: "settings.pathVarsRepoAbs" },
  { token: "{repoParent}", descriptionKey: "settings.pathVarsRepoParent" },
  { token: "{repoName}", descriptionKey: "settings.pathVarsRepoName" },
  { token: "{baseDir}", descriptionKey: "settings.pathVarsBaseDir" },
  { token: "{branchName}", descriptionKey: "settings.pathVarsBranch" },
  { token: "{branchSlug}", descriptionKey: "settings.pathVarsBranchSlug" },
  { token: "{yyyyMMdd-HHmmss}", descriptionKey: "settings.pathVarsTimestamp" },
];

type SettingsSection = "language" | "worktree" | "usage" | "terminal" | "chatgpt" | "grok" | "editor" | "agents" | "workflow" | "trellis" | "extensions";
type SubagentThinkingOption = PiWebSubagentRunPolicy["thinking"];

const SUBAGENT_AGENT_NAMES = ["trellis-implement", "trellis-check", "trellis-research"];
const SUBAGENT_THINKING_OPTIONS: SubagentThinkingOption[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
const SUBAGENT_MODALITIES: PiWebSubagentModality[] = ["text", "multimodal"];
const SUBAGENT_TIERS: PiWebSubagentDifficultyTier[] = ["simple", "standard", "complex", "critical"];
const SUBAGENT_MODALITY_LABEL_KEYS: Record<PiWebSubagentModality, string> = {
  text: "settings.textTask",
  multimodal: "settings.multimodalTask",
};
const SUBAGENT_TIER_LABEL_KEYS: Record<PiWebSubagentDifficultyTier, string> = {
  simple: "settings.tierSimple",
  standard: "settings.tierStandard",
  complex: "settings.tierComplex",
  critical: "settings.tierCritical",
};

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

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600 }}>{label}</span>
      {children}
      {description && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{description}</span>}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      style={{ ...inputStyle, fontFamily: "var(--font-mono)", opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "text" }}
    />
  );
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
    <select
      value={formatModelValue(value)}
      onChange={(e) => onChange(parseModelValue(e.target.value))}
      disabled={disabled}
      style={{ ...inputStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
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
    </select>
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
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SubagentThinkingOption)}
      disabled={disabled}
      style={{ ...inputStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
    >
      {SUBAGENT_THINKING_OPTIONS.map((option) => (
        <option key={option} value={option}>{option === "inherit" ? t("settings.followMainThinking") : option === "off" ? t("settings.thinkingOff") : option}</option>
      ))}
    </select>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: 12,
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        color: "var(--text)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{description}</span>
      </span>
      <span
        aria-hidden
        style={{
          width: 40,
          height: 22,
          borderRadius: 999,
          background: checked ? "var(--accent)" : "var(--border)",
          position: "relative",
          flexShrink: 0,
          transition: "background 0.12s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 21 : 3,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "white",
            transition: "left 0.12s",
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
          }}
        />
      </span>
    </button>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  const { t } = useI18n();
  return (
    <span style={{ padding: "2px 7px", borderRadius: 999, background: ok ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)", color: ok ? "#22c55e" : "#f87171", fontSize: 11, fontWeight: 700 }}>
      {label ?? (ok ? t("settings.passed") : t("settings.needsAttention"))}
    </span>
  );
}

function StatusRow({ label, value, ok, detail }: { label: string; value: string; ok: boolean; detail?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "120px 1fr max-content", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{label}</span>
      <span title={detail} style={{ color: "var(--text)", fontSize: 12, overflowWrap: "anywhere" }}>{value}</span>
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

function formatRecommendedAction(status: TrellisSetupStatus, t: (key: string) => string): string {
  if (status.recommendedAction === "fix-prerequisites") return t("settings.finishPrereqs");
  if (status.recommendedAction === "initialize") return t("settings.noTrellisYet");
  if (status.recommendedAction === "update") return t("settings.hasTrellisUpdate");
  if (status.recommendedAction === "ready") return t("settings.trellisReady");
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

function trellisConfigsEqual(a: PiWebTrellisConfig | null, b: PiWebTrellisConfig | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function workflowConfigsEqual(a: PiWebWorkflowConfig | null, b: PiWebWorkflowConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.includeArchived === b.includeArchived;
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
  const [trellis, setTrellis] = useState<PiWebTrellisConfig | null>(null);
  const [savedTrellis, setSavedTrellis] = useState<PiWebTrellisConfig | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trellisStatus, setTrellisStatus] = useState<TrellisSetupStatus | null>(null);
  const [trellisStatusLoading, setTrellisStatusLoading] = useState(false);
  const [trellisStatusError, setTrellisStatusError] = useState<string | null>(null);
  const [trellisAction, setTrellisAction] = useState<"init" | "update" | null>(null);
  const [trellisOutput, setTrellisOutput] = useState<string | null>(null);
  const [trellisWorkflowOpen, setTrellisWorkflowOpen] = useState(false);
  const [modelList, setModelList] = useState<ModelListItem[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [developerName, setDeveloperName] = useState("");
  const [developerNameTouched, setDeveloperNameTouched] = useState(false);

  const dirty = useMemo(
    () => !worktreeConfigsEqual(worktree, savedWorktree) || !trellisConfigsEqual(trellis, savedTrellis) || !workflowConfigsEqual(workflow, savedWorkflow) || !usageConfigsEqual(usage, savedUsage) || !terminalConfigsEqual(terminal, savedTerminal) || !chatGptConfigsEqual(chatgpt, savedChatgpt) || JSON.stringify(grok) !== JSON.stringify(savedGrok) || !editorConfigsEqual(editor, savedEditor),
    [worktree, savedWorktree, trellis, savedTrellis, workflow, savedWorkflow, usage, savedUsage, terminal, savedTerminal, chatgpt, savedChatgpt, grok, savedGrok, editor, savedEditor],
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
      setTrellis(data.config.trellis);
      setSavedTrellis(data.config.trellis);
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

  const loadTrellisStatus = useCallback(async (signal?: AbortSignal) => {
    if (!cwd) {
      setTrellisStatus(null);
      setTrellisStatusError(null);
      setTrellisStatusLoading(false);
      return;
    }
    setTrellisStatusLoading(true);
    setTrellisStatusError(null);
    try {
      const res = await fetch(`/api/trellis/setup/status?cwd=${encodeURIComponent(cwd)}`, { signal });
      const data = await res.json() as TrellisStatusResponse;
      if (!res.ok || data.error || !data.status) throw new Error(data.error ?? `HTTP ${res.status}`);
      const status = data.status;
      setTrellisStatus(status);
      setDeveloperName((prev) => (!developerNameTouched || !prev.trim()) ? status.suggestedDeveloperName : prev);
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      setTrellisStatus(null);
      setTrellisStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrellisStatusLoading(false);
    }
  }, [cwd, developerNameTouched]);

  useEffect(() => {
    const controller = new AbortController();
    void loadConfig(controller.signal);
    return () => controller.abort();
  }, [loadConfig]);

  useEffect(() => {
    setDeveloperName("");
    setDeveloperNameTouched(false);
    setTrellisOutput(null);
  }, [cwd]);

  useEffect(() => {
    if (section !== "trellis" && section !== "terminal") return;
    const controller = new AbortController();
    if (section === "trellis") void loadTrellisStatus(controller.signal);
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [section, loadModels, loadTrellisStatus]);

  const updateWorktree = useCallback((patch: Partial<PiWebWorktreeConfig>) => {
    setWorktree((prev) => prev ? { ...prev, ...patch } : prev);
    setNotice(null);
  }, []);

  const updateTrellis = useCallback((patch: Partial<PiWebTrellisConfig>) => {
    setTrellis((prev) => prev ? { ...prev, ...patch } : prev);
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

  const updateDefaultSubagentPolicy = useCallback((patch: Partial<PiWebSubagentRunPolicy>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      subagents: {
        ...prev.subagents,
        defaultPolicy: { ...prev.subagents.defaultPolicy, ...patch },
      },
    } : prev);
    setNotice(null);
  }, []);

  const updateWorkflowAssistantPolicy = useCallback((patch: Partial<PiWebSubagentRunPolicy>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      workflowAssistant: { ...prev.workflowAssistant, ...patch },
    } : prev);
    setNotice(null);
  }, []);

  const updateWorkflowAssistantFallbackPolicy = useCallback((patch: Partial<PiWebSubagentRunPolicy>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      workflowAssistantFallback: { ...prev.workflowAssistantFallback, ...patch },
    } : prev);
    setNotice(null);
  }, []);

  const updateSubagentConfig = useCallback((patch: Partial<PiWebTrellisConfig["subagents"]>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      subagents: { ...prev.subagents, ...patch },
    } : prev);
    setNotice(null);
  }, []);

  const updateSubagentAgent = useCallback((agent: string, patch: Partial<PiWebSubagentAgentConfig>) => {
    setTrellis((prev) => {
      if (!prev) return prev;
      const current = prev.subagents.agents[agent] ?? { strategy: "default" as const };
      return {
        ...prev,
        subagents: {
          ...prev.subagents,
          agents: {
            ...prev.subagents.agents,
            [agent]: { ...current, ...patch },
          },
        },
      };
    });
    setNotice(null);
  }, []);

  const updateRouter = useCallback((patch: Partial<PiWebTrellisConfig["subagents"]["router"]>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      subagents: {
        ...prev.subagents,
        router: { ...prev.subagents.router, ...patch },
      },
    } : prev);
    setNotice(null);
  }, []);

  const updateRoutePolicy = useCallback((modality: PiWebSubagentModality, tier: PiWebSubagentDifficultyTier, patch: Partial<PiWebSubagentRunPolicy>) => {
    setTrellis((prev) => prev ? {
      ...prev,
      subagents: {
        ...prev.subagents,
        routes: {
          ...prev.subagents.routes,
          [modality]: {
            ...prev.subagents.routes[modality],
            [tier]: { ...prev.subagents.routes[modality][tier], ...patch },
          },
        },
      },
    } : prev);
    setNotice(null);
  }, []);

  const applyLoadedConfig = useCallback((config: PiWebConfig, path: string, configExists: boolean, nextDefaults?: PiWebConfig) => {
    if (nextDefaults) setDefaults(nextDefaults);
    setWorktree(config.worktree);
    setSavedWorktree(config.worktree);
    setTrellis(config.trellis);
    setSavedTrellis(config.trellis);
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
    setConfigPath(path);
    setExists(configExists);
    onConfigChange?.();
  }, [onConfigChange]);

  const saveConfig = useCallback(async (successNotice?: string): Promise<boolean> => {
    if (!worktree || !trellis || !workflow || !usage || !terminal || !chatgpt || !grok || !editor) return false;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/web-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktree, trellis, workflow, usage, terminal, chatgpt, grok, editor }),
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
  }, [applyLoadedConfig, worktree, trellis, workflow, usage, terminal, chatgpt, grok, editor]);

  const handleSave = useCallback(async () => {
    await saveConfig(t("settings.savedToast"));
  }, [saveConfig, t]);

  const resetToDefaults = useCallback(() => {
    if (!defaults) return;
    setWorktree(defaults.worktree);
    setTrellis(defaults.trellis);
    setWorkflow(defaults.workflow);
    setUsage(defaults.usage);
    setTerminal(defaults.terminal);
    setChatgpt(defaults.chatgpt);
    setGrok(defaults.grok);
    setEditor(defaults.editor);
    setNotice(t("settings.restoredDefaults"));
  }, [defaults, t]);

  const runTrellisSetupAction = useCallback(async (action: "init" | "update") => {
    if (!cwd || !trellis) return;
    if (dirty) {
      const saved = await saveConfig();
      if (!saved) return;
    }
    setTrellisAction(action);
    setError(null);
    setNotice(null);
    setTrellisOutput(null);
    try {
      const res = await fetch(`/api/trellis/setup/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "init" ? { cwd, developerName: developerName.trim() } : { cwd }),
      });
      const data = await res.json() as TrellisActionResponse;
      if (!res.ok || data.error || !data.status) throw new Error(data.error ?? `HTTP ${res.status}`);
      setTrellisStatus(data.status);
      setTrellisOutput(data.output || t("settings.operationDone"));
      if (data.config) {
        setWorktree(data.config.worktree);
        setSavedWorktree(data.config.worktree);
        setTrellis(data.config.trellis);
        setSavedTrellis(data.config.trellis);
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
        onConfigChange?.();
      }
      setNotice(action === "init" ? t("settings.trellisInitialized") : t("settings.trellisUpdated"));
      void loadTrellisStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTrellisAction(null);
    }
  }, [cwd, developerName, dirty, loadTrellisStatus, onConfigChange, saveConfig, trellis, t]);

  const renderSectionButton = (id: SettingsSection, label: string, description: string) => {
    const active = section === id;
    return (
      <button
        key={id}
        onClick={() => setSection(id)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "8px 10px",
          borderRadius: 8,
          border: active ? "1px solid rgba(37,99,235,0.25)" : "1px solid transparent",
          background: active ? "var(--bg-selected)" : "transparent",
          color: active ? "var(--accent)" : "var(--text-muted)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
        title={description}
      >
        {label}
      </button>
    );
  };

  const trellisBusy = !!trellisAction || saving;
  const trellisBlockingReason = !cwd
    ? t("settings.selectWorkspaceFirst")
    : trellisStatusError
      ? trellisStatusError
      : !developerName.trim()
        ? t("settings.enterDeveloperName")
        : trellisStatus?.blockingReasons[0] ?? null;
  const canInitializeTrellis = !!cwd && !!trellisStatus?.canInitialize && !!developerName.trim() && !trellisBusy && !trellisStatusLoading;
  const canUpdateTrellis = !!cwd && !!trellisStatus?.canUpdate && !trellisBusy && !trellisStatusLoading;

  return (
    <>
    <div
      className="pi-modal-overlay"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="pi-modal-panel settings-modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, calc(100vw - 40px))",
          maxHeight: "calc(100vh - 40px)",
          overflow: "hidden",
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, color: "var(--text)" }}>{t("settings.title")}</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{t("settings.languageHint")}</p>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 24, lineHeight: 1, padding: 4 }}
            title={t("settings.close")}
          >
            ×
          </button>
        </div>

        <div className="settings-modal-body" style={{ display: "flex", minHeight: 0 }}>
          <div style={{ width: 150, borderRight: "1px solid var(--border)", padding: 10, background: "var(--bg-subtle)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {renderSectionButton("language", t("common.language"), t("settings.languageSection"))}
            {renderSectionButton("worktree", t("settings.sectionWorktree"), t("settings.worktreeSection"))}
            {renderSectionButton("usage", t("settings.sectionUsage"), t("settings.usageSection"))}
            {renderSectionButton("terminal", t("settings.sectionTerminal"), t("settings.terminalSection"))}
            {renderSectionButton("chatgpt", "ChatGPT", t("settings.chatgptSection"))}
            {renderSectionButton("grok", "Grok", t("settings.grokSection"))}
            {renderSectionButton("editor", t("settings.sectionEditor"), t("settings.editorSection"))}
            {renderSectionButton("agents", t("settings.sectionAgents"), t("settings.agentsSection"))}
            {renderSectionButton("workflow", "Workflow", t("settings.workflowSection"))}
            {renderSectionButton("extensions", "Extensions", t("settings.extensionsSection"))}
            {renderSectionButton("trellis", "Trellis", t("settings.trellisSection"))}
          </div>

          <div style={{ padding: 18, overflow: "auto", flex: 1 }}>
            {loading ? (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{t("settings.loadingSettings")}</div>
            ) : worktree && trellis && workflow && usage && terminal && chatgpt && editor ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {error && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div>}
                {notice && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(37,99,235,0.12)", color: "var(--accent)", fontSize: 12, overflowWrap: "anywhere" }}>{notice}</div>}

                {section === "language" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.languageSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.languageHint")}
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {(["zh", "en"] as Locale[]).map((item) => {
                        const active = locale === item;
                        return (
                          <button
                            key={item}
                            type="button"
                            onClick={() => setLocale(item)}
                            style={{
                              padding: "8px 14px",
                              borderRadius: 8,
                              border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                              background: active ? "color-mix(in srgb, var(--accent) 14%, var(--bg))" : "var(--bg)",
                              color: active ? "var(--accent)" : "var(--text)",
                              cursor: "pointer",
                              fontSize: 13,
                              fontWeight: active ? 700 : 500,
                            }}
                          >
                            {item === "zh" ? t("common.chinese") : t("common.english")}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : section === "worktree" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.worktreeSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.saveTo")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                      <Field label={t("settings.baseRef")} description={t("settings.baseRefHint")}>
                        <TextInput value={worktree.baseRef} onChange={(baseRef) => updateWorktree({ baseRef })} placeholder="HEAD" />
                      </Field>
                      <Field label={t("settings.sessionDisplay")} description={t("settings.sessionDisplayHint")}>
                        <select
                          value={worktree.sessionDisplay}
                          onChange={(e) => updateWorktree({ sessionDisplay: e.target.value as PiWebWorktreeConfig["sessionDisplay"] })}
                          style={inputStyle}
                        >
                          <option value="separate">{t("settings.sessionDisplaySeparate")}</option>
                          <option value="tag">{t("settings.sessionDisplayTag")}</option>
                        </select>
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

                    <div style={{ padding: 12, borderRadius: 8, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, marginBottom: 8 }}>{t("settings.templateVariables")}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(150px, max-content) 1fr", gap: "7px 12px", alignItems: "baseline" }}>
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
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.usageSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.usageDescription")} {t("settings.saveTo")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>
                    <ToggleField
                      label={t("settings.includeArchivedSessions")}
                      description={t("settings.includeArchivedSessionsHint")}
                      checked={usage.includeArchived}
                      onChange={(includeArchived) => updateUsage({ includeArchived })}
                    />
                  </div>
                ) : section === "terminal" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.terminalSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.terminalDescription")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>
                    <ToggleField
                      label={t("settings.enableTerminal")}
                      description={t("settings.enableTerminalHint")}
                      checked={terminal.enabled}
                      onChange={(enabled) => updateTerminal({ enabled })}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label={t("settings.shellType")} description={t("settings.windowsShellHint")}>
                        <select
                          value={terminal.shell}
                          onChange={(e) => updateTerminal({ shell: e.target.value as PiWebTerminalConfig["shell"] })}
                          style={inputStyle}
                        >
                          <option value="zsh">zsh</option>
                          <option value="bash">bash</option>
                          <option value="sh">sh</option>
                          <option value="cmd">cmd</option>
                          <option value="powershell">Windows PowerShell</option>
                          <option value="pwsh">PowerShell 7</option>
                          <option value="custom">custom path</option>
                        </select>
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
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.envVariables")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.envVariablesHint")}
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 0.45fr) minmax(160px, 1fr) 70px", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>{t("settings.envName")}</span>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 700 }}>{t("settings.envValue")}</span>
                        <span />
                        {Object.entries(terminal.env).map(([key, value]) => (
                          <div key={key} style={{ display: "contents" }}>
                            <TextInput value={key} onChange={(nextKey) => updateTerminalEnv(key, nextKey.trim(), value)} placeholder="HTTP_PROXY" />
                            <TextInput value={value} onChange={(nextValue) => updateTerminalEnv(key, key, nextValue)} placeholder="value" />
                            <button
                              type="button"
                              onClick={() => deleteTerminalEnv(key)}
                              style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
                            >
                              {t("common.delete")}
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          let index = Object.keys(terminal.env).length + 1;
                          let key = `TERMINAL_ENV_${index}`;
                          while (Object.prototype.hasOwnProperty.call(terminal.env, key)) {
                            index += 1;
                            key = `TERMINAL_ENV_${index}`;
                          }
                          updateTerminal({ env: { ...terminal.env, [key]: "" } });
                        }}
                        style={{ alignSelf: "flex-start", padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}
                      >
                        {t("settings.addVariable")}
                      </button>
                      <Field label={t("settings.rawEnvImport")} description={t("settings.rawEnvHint")}>
                        <textarea
                          value={rawEnvImport}
                          onChange={(e) => setRawEnvImport(e.target.value)}
                          placeholder={'export https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 all_proxy=socks5://127.0.0.1:7897\nNODE_OPTIONS="--max-old-space-size=4096"'}
                          rows={4}
                          spellCheck={false}
                          style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)", lineHeight: 1.45 }}
                        />
                      </Field>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={importRawEnv}
                          disabled={!rawEnvImport.trim()}
                          style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: rawEnvImport.trim() ? "var(--bg)" : "var(--border)", color: rawEnvImport.trim() ? "var(--text)" : "var(--text-dim)", cursor: rawEnvImport.trim() ? "pointer" : "not-allowed", fontSize: 12 }}
                        >
                          {t("settings.parseToTable")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void importRawEnvWithAi()}
                          disabled={!cwd || !rawEnvImport.trim() || terminalEnvAssistLoading}
                          title={cwd ? t("settings.aiParseEnvHint") : t("settings.selectWorkspaceShort")}
                          style={{ padding: "7px 10px", borderRadius: 7, border: "1px solid var(--border)", background: cwd && rawEnvImport.trim() && !terminalEnvAssistLoading ? "var(--bg)" : "var(--border)", color: cwd && rawEnvImport.trim() && !terminalEnvAssistLoading ? "var(--text)" : "var(--text-dim)", cursor: cwd && rawEnvImport.trim() && !terminalEnvAssistLoading ? "pointer" : "not-allowed", fontSize: 12 }}
                        >
                          {terminalEnvAssistLoading ? t("settings.aiParsing") : t("settings.aiParse")}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.envAssistantTitle")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.envAssistantDesc")}
                        </div>
                      </div>
                      {modelsError && <div style={{ padding: "7px 9px", borderRadius: 7, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 11 }}>{modelsError}</div>}
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                        <Field label={t("settings.aiParseModel")} description={t("settings.piDefaultHint")}>
                          <ModelPolicySelect value={terminal.envAssistant.model} onChange={(model) => updateTerminalEnvAssistantPolicy({ model })} models={modelList} />
                        </Field>
                        <Field label={t("settings.thinkingLevel")} description={t("settings.suggestMinimalLow")}>
                          <ThinkingSelect value={terminal.envAssistant.thinking} onChange={(thinking) => updateTerminalEnvAssistantPolicy({ thinking })} />
                        </Field>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                        <Field label={t("settings.fallbackModel")} description={t("settings.mainFailFallback")}>
                          <ModelPolicySelect value={terminal.envAssistantFallback.model} onChange={(model) => updateTerminalEnvAssistantFallbackPolicy({ model })} models={modelList} />
                        </Field>
                        <Field label={t("settings.fallbackThinking")} description={t("settings.keepMinimal")}>
                          <ThinkingSelect value={terminal.envAssistantFallback.thinking} onChange={(thinking) => updateTerminalEnvAssistantFallbackPolicy({ thinking })} />
                        </Field>
                      </div>
                    </div>
                  </div>
                ) : section === "chatgpt" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>ChatGPT</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.chatgptDescription")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>
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
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label={t("settings.cycleInterval")} description={t("settings.cycleIntervalHint")}>
                        <input type="number" min={300} step={60} value={chatgpt.refreshCycleIntervalSeconds} onChange={(e) => updateChatgpt({ refreshCycleIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                      <Field label={t("settings.accountInterval")} description={t("settings.accountIntervalHint")}>
                        <input type="number" min={5} step={1} value={chatgpt.refreshAccountIntervalSeconds} onChange={(e) => updateChatgpt({ refreshAccountIntervalSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label={t("settings.cycleSaltMin")} description={t("settings.cycleSaltMinHint")}>
                        <input type="number" min={0} step={1} value={chatgpt.refreshCycleSaltMinSeconds} onChange={(e) => updateChatgpt({ refreshCycleSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                      <Field label={t("settings.cycleSaltMax")} description={t("settings.cycleSaltMaxHint")}>
                        <input type="number" min={0} step={1} value={chatgpt.refreshCycleSaltMaxSeconds} onChange={(e) => updateChatgpt({ refreshCycleSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <Field label={t("settings.accountSaltMin")} description={t("settings.accountSaltMinHint")}>
                        <input type="number" min={0} step={1} value={chatgpt.refreshAccountSaltMinSeconds} onChange={(e) => updateChatgpt({ refreshAccountSaltMinSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                      <Field label={t("settings.accountSaltMax")} description={t("settings.accountSaltMaxHint")}>
                        <input type="number" min={0} step={1} value={chatgpt.refreshAccountSaltMaxSeconds} onChange={(e) => updateChatgpt({ refreshAccountSaltMaxSeconds: Number.parseInt(e.target.value || "0", 10) })} style={inputStyle} />
                      </Field>
                    </div>
                    <div style={{ padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-subtle)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                      {t("settings.chatgptLockInfo")}
                    </div>
                  </div>
                ) : section === "editor" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.editorSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.editorDescription")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>
                    <Field label={t("settings.editorImpl")} description={t("settings.editorImplHint")}>
                      <select
                        value={editor.kind}
                        onChange={(e) => updateEditor({ kind: e.target.value as PiWebEditorConfig["kind"] })}
                        style={inputStyle}
                      >
                        <option value="monaco">Monaco Editor</option>
                      </select>
                    </Field>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.customShortcutsTitle")}</div>
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
                    <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
                      <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800, marginBottom: 8 }}>{t("settings.builtinShortcutsTitle")}</div>
                      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "6px 12px", alignItems: "baseline" }}>
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
                ) : section === "grok" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>Grok</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.grokDescription")} <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", overflowWrap: "anywhere" }}>{configPath}</code>
                        {exists ? "" : t("settings.autoCreateOnSave")}
                      </p>
                    </div>
                    <ToggleField
                      label={t("settings.grokUsagePanel")}
                      description={t("settings.grokPanelEnable")}
                      checked={grok?.usagePanelEnabled ?? false}
                      onChange={(usagePanelEnabled) => updateGrok({ usagePanelEnabled })}
                    />
                  </div>
                ) : section === "extensions" ? (
                  <ExtensionsConfig cwd={cwd} onClose={() => {}} embed />
                ) : section === "agents" ? (
                  <AgentsConfig cwd={cwd} />
                ) : section === "workflow" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.workflowSection")}</h3>
                      <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                        {t("settings.workflowDescription")}
                      </p>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <ToggleField
                        label={t("settings.enableWorkflow")}
                        description={t("settings.enableWorkflowHint")}
                        checked={workflow.enabled}
                        onChange={(enabled) => updateWorkflow({ enabled })}
                      />
                      <ToggleField
                        label={t("settings.workflowIncludeArchived")}
                        description={t("settings.workflowIncludeArchivedHint")}
                        checked={workflow.includeArchived}
                        onChange={(includeArchived) => updateWorkflow({ includeArchived })}
                      />
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                      {t("settings.workflowNativeModelsHint")}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div>
                        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.trellisSection")}</h3>
                        <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
                          {t("settings.trellisDescription")}
                        </p>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <a href="https://docs.trytrellis.app/" target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontSize: 12, fontWeight: 700, textDecoration: "none" }}>
                          {t("settings.openDocs")}
                        </a>
                        <button
                          type="button"
                          onClick={() => setTrellisWorkflowOpen(true)}
                          disabled={!cwd}
                          title={cwd ? t("settings.viewWorkflow") : t("settings.selectWorkspaceShort")}
                          style={{ background: "none", border: "none", padding: 0, color: cwd ? "var(--accent)" : "var(--text-dim)", fontSize: 12, fontWeight: 700, cursor: cwd ? "pointer" : "not-allowed" }}
                        >
                          {t("settings.workflowDesign")}
                        </button>
                      </div>
                      <div style={{ color: "var(--text-dim)", fontSize: 11, overflowWrap: "anywhere" }}>
                        {t("settings.currentWorkspace")}{cwd ? <code style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{cwd}</code> : t("settings.notSelected")}
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <ToggleField
                        label={t("settings.enableTrellis")}
                        description={t("settings.enableTrellisHint")}
                        checked={trellis.enabled}
                        onChange={(enabled) => updateTrellis({ enabled })}
                      />
                      <ToggleField
                        label={t("settings.defaultIncludeArchivedTasks")}
                        description={t("settings.defaultIncludeArchivedTasksHint")}
                        checked={trellis.includeArchived}
                        onChange={(includeArchived) => updateTrellis({ includeArchived })}
                      />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <ToggleField
                        label={t("settings.proxyEnable")}
                        description={t("settings.proxyHint")}
                        checked={trellis.proxyEnabled}
                        onChange={(proxyEnabled) => updateTrellis({ proxyEnabled })}
                      />
                      <Field label={t("settings.proxyUrl")} description={t("settings.proxyExample")}>
                        <TextInput value={trellis.proxyUrl} onChange={(proxyUrl) => updateTrellis({ proxyUrl })} placeholder="http://127.0.0.1:7890" disabled={!trellis.proxyEnabled} />
                      </Field>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.workflowAssistantTitle")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.workflowAssistantDesc")}
                        </div>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                        <Field label={t("settings.assistModel")} description={t("settings.followMainFallbackHint")}>
                          <ModelPolicySelect
                            value={trellis.workflowAssistant.model}
                            onChange={(model) => updateWorkflowAssistantPolicy({ model })}
                            models={modelList}
                          />
                        </Field>
                        <Field label={t("settings.thinkingLevel")} description={t("settings.assistModelHint")}>
                          <ThinkingSelect
                            value={trellis.workflowAssistant.thinking}
                            onChange={(thinking) => updateWorkflowAssistantPolicy({ thinking })}
                          />
                        </Field>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                        <Field label={t("settings.fallbackModel")} description={t("settings.assistFallbackHint")}>
                          <ModelPolicySelect
                            value={trellis.workflowAssistantFallback.model}
                            onChange={(model) => updateWorkflowAssistantFallbackPolicy({ model })}
                            models={modelList}
                          />
                        </Field>
                        <Field label={t("settings.fallbackThinking")} description={t("settings.keepMinimalLow")}>
                          <ThinkingSelect
                            value={trellis.workflowAssistantFallback.thinking}
                            onChange={(thinking) => updateWorkflowAssistantFallbackPolicy({ thinking })}
                          />
                        </Field>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.subagentRoutingTitle")}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
                          {t("settings.subagentRoutingDesc")}
                        </div>
                      </div>
                      {modelsError && <div style={{ padding: "7px 9px", borderRadius: 7, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 11 }}>{modelsError}</div>}
                      <ToggleField
                        label={t("settings.enableSubagentModels")}
                        description={t("settings.enableSubagentModelsHint")}
                        checked={trellis.subagents.enabled}
                        onChange={(enabled) => updateSubagentConfig({ enabled })}
                      />
                      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                        <Field label={t("settings.defaultSubagentModel")} description={t("settings.defaultPolicyHint")}>
                          <ModelPolicySelect
                            value={trellis.subagents.defaultPolicy.model}
                            onChange={(model) => updateDefaultSubagentPolicy({ model })}
                            models={modelList}
                            disabled={!trellis.subagents.enabled}
                          />
                        </Field>
                        <Field label={t("settings.defaultThinking")} description={t("settings.thinkingFollowHint")}>
                          <ThinkingSelect
                            value={trellis.subagents.defaultPolicy.thinking}
                            onChange={(thinking) => updateDefaultSubagentPolicy({ thinking })}
                            disabled={!trellis.subagents.enabled}
                          />
                        </Field>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                        <ToggleField
                          label={t("settings.enableAutoRoute")}
                          description={t("settings.enableAutoRouteHint")}
                          checked={trellis.subagents.router.enabled}
                          onChange={(enabled) => updateRouter({ enabled })}
                          disabled={!trellis.subagents.enabled}
                        />
                        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
                          <Field label={t("settings.routerModel")} description={t("settings.routerModelHint")}>
                            <ModelPolicySelect
                              value={trellis.subagents.router.model}
                              onChange={(model) => updateRouter({ model })}
                              models={modelList}
                              disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                            />
                          </Field>
                          <Field label={t("settings.routerThinking")} description={t("settings.routerThinkingHint")}>
                            <ThinkingSelect
                              value={trellis.subagents.router.thinking}
                              onChange={(thinking) => updateRouter({ thinking })}
                              disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                            />
                          </Field>
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                          <Field label={t("settings.routerFallbackType")} description={t("settings.routerFailFallback")}>
                            <select
                              value={trellis.subagents.router.fallbackOnError.modality}
                              onChange={(e) => updateRouter({ fallbackOnError: { ...trellis.subagents.router.fallbackOnError, modality: e.target.value as PiWebSubagentModality } })}
                              disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                              style={inputStyle}
                            >
                              <option value="text">{t("settings.textTask")}</option>
                              <option value="multimodal">{t("settings.multimodalTask")}</option>
                            </select>
                          </Field>
                          <Field label={t("settings.routerFallbackTier")} description={t("settings.routerFallbackHint")}>
                            <select
                              value={trellis.subagents.router.fallbackOnError.tier}
                              onChange={(e) => updateRouter({ fallbackOnError: { ...trellis.subagents.router.fallbackOnError, tier: e.target.value as PiWebSubagentDifficultyTier } })}
                              disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                              style={inputStyle}
                            >
                              {SUBAGENT_TIERS.map((tier) => <option key={tier} value={tier}>{t(SUBAGENT_TIER_LABEL_KEYS[tier])}</option>)}
                            </select>
                          </Field>
                        </div>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                        <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>{t("settings.routingTableTitle")}</div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("settings.routingTableDesc")}</div>
                        {SUBAGENT_MODALITIES.map((modality) => (
                          <div key={modality} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>{t(SUBAGENT_MODALITY_LABEL_KEYS[modality])}</div>
                            {SUBAGENT_TIERS.map((tier) => {
                              const policy = trellis.subagents.routes[modality][tier];
                              return (
                                <div key={`${modality}-${tier}`} style={{ display: "grid", gridTemplateColumns: "90px minmax(180px, 1fr) 120px", gap: 8, alignItems: "center" }}>
                                  <span title={tier} style={{ fontSize: 11, color: "var(--text-dim)" }}>{t(SUBAGENT_TIER_LABEL_KEYS[tier])}</span>
                                  <ModelPolicySelect
                                    value={policy.model}
                                    onChange={(model) => updateRoutePolicy(modality, tier, { model })}
                                    models={modelList}
                                    disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                                  />
                                  <ThinkingSelect
                                    value={policy.thinking}
                                    onChange={(thinking) => updateRoutePolicy(modality, tier, { thinking })}
                                    disabled={!trellis.subagents.enabled || !trellis.subagents.router.enabled}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 700 }}>{t("settings.perAgentOverrideTitle")}</div>
                        {SUBAGENT_AGENT_NAMES.map((agent) => {
                          const agentConfig = trellis.subagents.agents[agent] ?? { strategy: "default" as const };
                          const fixed = agentConfig.fixed ?? trellis.subagents.defaultPolicy;
                          const fixedDisabled = !trellis.subagents.enabled || agentConfig.strategy !== "fixed";
                          return (
                            <div key={agent} style={{ display: "grid", gridTemplateColumns: "150px 120px minmax(180px, 1fr) 120px", gap: 8, alignItems: "center" }}>
                              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{agent}</code>
                              <select
                                value={agentConfig.strategy}
                                onChange={(e) => updateSubagentAgent(agent, { strategy: e.target.value as PiWebSubagentAgentConfig["strategy"] })}
                                disabled={!trellis.subagents.enabled}
                                style={{ ...inputStyle, opacity: trellis.subagents.enabled ? 1 : 0.6 }}
                              >
                                <option value="default">{t("settings.strategyDefault")}</option>
                                <option value="route">{t("settings.strategyRoute")}</option>
                                <option value="fixed">{t("settings.strategyFixed")}</option>
                                <option value="disabled">{t("settings.disableHere")}</option>
                              </select>
                              <ModelPolicySelect
                                value={fixed.model}
                                onChange={(model) => updateSubagentAgent(agent, { fixed: { ...fixed, model } })}
                                models={modelList}
                                disabled={fixedDisabled}
                              />
                              <ThinkingSelect
                                value={fixed.thinking}
                                onChange={(thinking) => updateSubagentAgent(agent, { fixed: { ...fixed, thinking } })}
                                disabled={fixedDisabled}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div>
                          <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.trellisInspectionTitle")}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3 }}>{trellisStatus ? formatRecommendedAction(trellisStatus, t) : (cwd ? t("settings.checking") : t("settings.selectWorkspaceToInit"))}</div>
                        </div>
                        <button
                          onClick={() => void loadTrellisStatus()}
                          disabled={!cwd || trellisStatusLoading || trellisBusy}
                          style={{ padding: "6px 10px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: !cwd || trellisStatusLoading || trellisBusy ? "not-allowed" : "pointer", fontSize: 12 }}
                        >
                          {trellisStatusLoading ? t("settings.checkingShort") : t("settings.recheck")}
                        </button>
                      </div>

                      {trellisStatusError && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>{trellisStatusError}</div>}
                      {trellisStatus && (
                        <div>
                          <StatusRow label={t("settings.osLabel")} value={`${trellisStatus.platform}${trellisStatus.supportedOs ? "" : t("settings.unsupportedSuffix")}`} ok={trellisStatus.supportedOs} />
                          <StatusRow label="Node.js" value={trellisStatus.node.version ?? t("settings.notDetected")} ok={trellisStatus.node.ok} detail={trellisStatus.node.required} />
                          <StatusRow label="Python" value={trellisStatus.python.version ? `${trellisStatus.python.version} (${trellisStatus.python.command ?? "python"})` : (trellisStatus.python.error ?? t("settings.notDetected"))} ok={trellisStatus.python.ok} detail={trellisStatus.python.required} />
                          <StatusRow label="Trellis CLI" value={trellisStatus.cli.installed ? (trellisStatus.cli.version ?? t("settings.installed")) : t("settings.notInstalled")} ok={trellisStatus.cli.installed} detail={trellisStatus.cli.error} />
                          <StatusRow label={t("settings.projectTrellis")} value={trellisStatus.project.hasTrellisDir ? (trellisStatus.project.version ? t("settings.projectExistsVersion", { version: trellisStatus.project.version }) : t("settings.projectExists")) : t("settings.notInitialized")} ok={trellisStatus.project.hasTrellisDir} />
                          <StatusRow label={t("settings.taskDir")} value={trellisStatus.project.hasTasksDir ? t("settings.tasksExist") : t("settings.notCreated")} ok={trellisStatus.project.hasTasksDir} />
                          <StatusRow label={t("settings.developerIdentity")} value={trellisStatus.project.developerName ?? t("settings.notWrittenDeveloper")} ok={trellisStatus.project.hasDeveloperIdentity} />
                        </div>
                      )}
                    </div>

                    <Field label={t("settings.developerName")} description={t("settings.developerHint")}>
                      <TextInput
                        value={developerName}
                        onChange={(value) => {
                          setDeveloperNameTouched(true);
                          setDeveloperName(value);
                        }}
                        placeholder="your-name"
                      />
                    </Field>

                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <button
                        onClick={() => void runTrellisSetupAction("init")}
                        disabled={!canInitializeTrellis}
                        title={canInitializeTrellis ? t("settings.installInit") : trellisBlockingReason ?? t("settings.trellisInstalledUseUpdate")}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: canInitializeTrellis ? "var(--accent)" : "var(--border)", color: "white", cursor: canInitializeTrellis ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}
                      >
                        {trellisAction === "init" ? t("settings.initializing") : t("settings.installInit")}
                      </button>
                      <button
                        onClick={() => void runTrellisSetupAction("update")}
                        disabled={!canUpdateTrellis}
                        title={canUpdateTrellis ? t("settings.updateTrellis") : trellisBlockingReason ?? t("settings.noTrellisInitFirst")}
                        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: canUpdateTrellis ? "var(--text)" : "var(--text-dim)", cursor: canUpdateTrellis ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 700 }}
                      >
                        {trellisAction === "update" ? t("settings.updating") : t("settings.updateTrellis")}
                      </button>
                      {!canInitializeTrellis && !canUpdateTrellis && trellisBlockingReason && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{trellisBlockingReason}</span>}
                    </div>

                    {trellisOutput && (
                      <pre style={{ margin: 0, maxHeight: 180, overflow: "auto", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", fontSize: 11, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                        {trellisOutput}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "#f87171", fontSize: 13 }}>{error ?? t("settings.loadFailed")}</div>
            )}
          </div>
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", gap: 10 }}>
          {section === "agents" ? (
            <>
              <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("settings.agentsPanelNote")}</span>
              <button
                onClick={onClose}
                style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
              >
                {t("common.close")}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={resetToDefaults}
                disabled={!defaults || loading || saving}
                style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: !defaults || loading || saving ? "not-allowed" : "pointer", fontSize: 12 }}
              >
                {t("settings.resetDefaults")}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {dirty && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("settings.unsavedChanges")}</span>}
                <button
                  onClick={onClose}
                  style={{ padding: "7px 12px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={!worktree || !trellis || !usage || !terminal || !chatgpt || !grok || !editor || loading || saving || !dirty}
                  style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: !worktree || !trellis || !usage || !terminal || !chatgpt || !grok || !editor || loading || saving || !dirty ? "var(--border)" : "var(--accent)", color: "white", cursor: !worktree || !trellis || !usage || !terminal || !chatgpt || !grok || !editor || loading || saving || !dirty ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600 }}
                >
                  {saving ? t("settings.saving") : t("settings.save")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
    {trellisWorkflowOpen && <TrellisWorkflowVisualizer cwd={cwd} onClose={() => setTrellisWorkflowOpen(false)} />}
    </>
  );
}
