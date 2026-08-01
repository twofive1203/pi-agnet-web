"use client";

import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsField,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSelect,
  SettingsState,
} from "@/components/ui/SettingsPrimitives";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveredAgent {
  name: string;
  source: "builtin" | "package" | "user" | "project" | "settings-only";
  description: string;
  defaultContext?: "fresh" | "fork";
}

interface ManagedProjection {
  defaultModel?: string;
  agentOverrides: Record<string, {
    model?: string | false;
    thinking?: string | false;
    fallbackModels?: string[] | false;
  }>;
}

interface SubagentConfigResponse {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  revision?: string;
  managed: ManagedProjection;
  parseError?: string;
  validationError?: string;
  userManaged?: ManagedProjection;
  userParseError?: string;
  userValidationError?: string;
  agents: DiscoveredAgent[];
  agentDiscovery?: {
    extensionAvailable: boolean;
    diagnostic?: string;
  };
}

interface PutResponse {
  success?: boolean;
  error?: string;
  revision?: string;
  managed?: ManagedProjection;
}

interface ModelListItem {
  id: string;
  name: string;
  provider: string;
}

interface ModelsResponse {
  modelList?: ModelListItem[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THINKING_OPTIONS = [
  { value: "", labelKey: "settings.inheritUnset" },
  { value: "off", labelKey: "settings.thinkingOff" },
  { value: "minimal", labelKey: "minimal" },
  { value: "low", labelKey: "low" },
  { value: "medium", labelKey: "medium" },
  { value: "high", labelKey: "high" },
  { value: "xhigh", labelKey: "xhigh" },
] as const;

const SOURCE_LABEL_KEYS: Record<string, string> = {
  builtin: "settings.agents.builtin",
  package: "settings.agents.package",
  user: "settings.agents.user",
  project: "settings.agents.project",
  "settings-only": "settings.agents.settingsResidue",
};

const SOURCE_BADGE_TONES: Record<DiscoveredAgent["source"], "neutral" | "accent" | "success" | "warning"> = {
  builtin: "accent",
  package: "neutral",
  user: "success",
  project: "warning",
  "settings-only": "neutral",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert `string | false | undefined` to a select-friendly value */
function ov(value: string | false | undefined | null): string {
  return typeof value === "string" ? value : "";
}

function formatInheritedValue(value: string | false | string[] | undefined, translate?: (key: string) => string): string | null {
  if (value === false) return translate ? translate("settings.agents.explicitFalse") : "false";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/** Check whether a managed field exists, including readable legacy false values. */
function hasConfiguredField(value: string | false | string[] | undefined | null): boolean {
  return value !== undefined && value !== null;
}

function isThinkingValue(value: unknown): value is "off" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

// ---------------------------------------------------------------------------
// AgentsConfig Component
// ---------------------------------------------------------------------------

export function AgentsConfig({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [scope, setScope] = useState<"user" | "project">("user");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Settings data
  const [configPath, setConfigPath] = useState("");
  const [configExists, setConfigExists] = useState(false);
  const [revision, setRevision] = useState<string | undefined>();
  const [parseError, setParseError] = useState<string | undefined>();
  const [validationError, setValidationError] = useState<string | undefined>();

  // Managed state (saved vs. draft)
  const [savedManaged, setSavedManaged] = useState<ManagedProjection>({ agentOverrides: {} });
  const [draftManaged, setDraftManaged] = useState<ManagedProjection>({ agentOverrides: {} });

  // User-scope managed (for project scope inheritance display)
  const [userManaged, setUserManaged] = useState<ManagedProjection | undefined>();
  const [userParseError, setUserParseError] = useState<string | undefined>();
  const [userValidationError, setUserValidationError] = useState<string | undefined>();

  // Agent discovery
  const [agents, setAgents] = useState<DiscoveredAgent[]>([]);
  const [extensionAvailable, setExtensionAvailable] = useState(false);
  const [discoveryDiagnostic, setDiscoveryDiagnostic] = useState<string | undefined>();

  // Model registry
  const [modelList, setModelList] = useState<ModelListItem[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Track if we've loaded models for the current scope/cwd
  const loadedRef = useRef({ scope: "", cwd: "" });

  // Dirty state
  const dirty = useMemo(() => {
    return JSON.stringify(draftManaged) !== JSON.stringify(savedManaged);
  }, [draftManaged, savedManaged]);

  // -----------------------------------------------------------------------
  // Load models
  // -----------------------------------------------------------------------

  const loadModels = useCallback(async () => {
    setModelsError(null);
    try {
      const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const res = await fetch(`/api/models${params}`);
      const data = await res.json() as ModelsResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setModelList(data.modelList ?? []);
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
      setModelList([]);
    }
  }, [cwd]);

  // -----------------------------------------------------------------------
  // Load settings
  // -----------------------------------------------------------------------

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotice(null);
    setParseError(undefined);
    setValidationError(undefined);
    setUserParseError(undefined);
    setUserValidationError(undefined);

    try {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) {
        params.set("cwd", cwd);
      }
      const res = await fetch(`/api/subagents/config?${params}`);
      const data = await res.json() as SubagentConfigResponse & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

      setConfigPath(data.path);
      setConfigExists(data.exists);
      setRevision(data.revision);
      setParseError(data.parseError);
      setValidationError(data.validationError);

      const managed = data.managed;
      setSavedManaged(managed);
      setDraftManaged(JSON.parse(JSON.stringify(managed))); // deep clone

      setUserManaged(data.userManaged);
      setUserParseError(data.userParseError);
      setUserValidationError(data.userValidationError);
      setAgents(data.agents);
      setExtensionAvailable(data.agentDiscovery?.extensionAvailable ?? false);
      setDiscoveryDiagnostic(data.agentDiscovery?.diagnostic);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, cwd]);

  // -----------------------------------------------------------------------
  // Initial load
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (loadedRef.current.scope === scope && loadedRef.current.cwd === (cwd ?? "")) return;
    loadedRef.current = { scope, cwd: cwd ?? "" };
    void loadConfig();
    void loadModels();
  }, [scope, cwd, loadConfig, loadModels]);

  // -----------------------------------------------------------------------
  // Update cwd triggers reload
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!cwd && scope === "project") {
      setScope("user");
    }
  }, [cwd, scope]);

  // -----------------------------------------------------------------------
  // Draft mutation helpers
  // -----------------------------------------------------------------------

  const updateDefaultModel = useCallback((model: string) => {
    setDraftManaged((prev) => ({
      ...prev,
      defaultModel: model || undefined,
    }));
    setNotice(null);
  }, []);

  const clearDefaultModel = useCallback(() => {
    setDraftManaged((prev) => {
      const next = { ...prev };
      delete next.defaultModel;
      return next;
    });
    setNotice(null);
  }, []);

  const updateAgentModel = useCallback((name: string, model: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      if (model) {
        current.model = model;
      } else {
        delete current.model;
      }
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const clearAgentModel = useCallback((name: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      delete current.model;
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const updateAgentThinking = useCallback((name: string, thinking: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      if (thinking) {
        current.thinking = thinking;
      } else {
        delete current.thinking;
      }
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const clearAgentThinking = useCallback((name: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      delete current.thinking;
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const addFallbackModel = useCallback((name: string) => {
    const available = modelList.map((model) => `${model.provider}/${model.id}`);
    if (available.length === 0) {
      setError(t("settings.agents.noModelsForFallback"));
      return;
    }

    const currentFallbacks = draftManaged.agentOverrides[name]?.fallbackModels;
    const visibleExisting = new Set(Array.isArray(currentFallbacks) ? currentFallbacks : []);
    if (!available.some((model) => !visibleExisting.has(model))) {
      setError(t("settings.agents.allModelsInFallback"));
      return;
    }

    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      const fallbacks = Array.isArray(current.fallbackModels) ? [...current.fallbackModels] : [];
      const existing = new Set(fallbacks);
      const nextModel = available.find((model) => !existing.has(model));
      if (!nextModel) return prev;

      current.fallbackModels = [...fallbacks, nextModel];
      overrides[name] = current;
      return { ...prev, agentOverrides: overrides };
    });
    setError(null);
    setNotice(null);
  }, [draftManaged.agentOverrides, modelList, t]);

  const updateFallbackModel = useCallback((name: string, index: number, value: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      const fallbacks = Array.isArray(current.fallbackModels) ? [...current.fallbackModels] : [];
      if (value) {
        fallbacks[index] = value;
      } else {
        fallbacks.splice(index, 1);
      }
      if (fallbacks.length > 0) {
        current.fallbackModels = fallbacks;
      } else {
        delete current.fallbackModels;
      }
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const removeFallbackModel = useCallback((name: string, index: number) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      const fallbacks = Array.isArray(current.fallbackModels) ? [...current.fallbackModels] : [];
      fallbacks.splice(index, 1);
      if (fallbacks.length > 0) {
        current.fallbackModels = fallbacks;
      } else {
        delete current.fallbackModels;
      }
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const moveFallbackModel = useCallback((name: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      const fallbacks = Array.isArray(current.fallbackModels) ? [...current.fallbackModels] : [];
      const [item] = fallbacks.splice(fromIndex, 1);
      fallbacks.splice(toIndex, 0, item);
      current.fallbackModels = fallbacks;
      overrides[name] = current;
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  const clearAgentFallbacks = useCallback((name: string) => {
    setDraftManaged((prev) => {
      const overrides = { ...prev.agentOverrides };
      const current = overrides[name] ? { ...overrides[name] } : {};
      delete current.fallbackModels;
      if (Object.keys(current).length === 0) {
        delete overrides[name];
      } else {
        overrides[name] = current;
      }
      return { ...prev, agentOverrides: overrides };
    });
    setNotice(null);
  }, []);

  // -----------------------------------------------------------------------
  // Compute minimal patch
  // -----------------------------------------------------------------------

  const computePatch = useCallback(() => {
    const patch: {
      expectedRevision: string;
      defaultModel?: string | null;
      agentOverrides?: Record<string, {
        model?: string | null;
        thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
        fallbackModels?: string[] | null;
      }>;
    } = {
      expectedRevision: revision ?? "",
    };

    // defaultModel
    if (draftManaged.defaultModel !== savedManaged.defaultModel) {
      patch.defaultModel = draftManaged.defaultModel ?? null;
    }

    // agentOverrides
    const allOverrideNames = new Set([
      ...Object.keys(savedManaged.agentOverrides),
      ...Object.keys(draftManaged.agentOverrides),
    ]);

    const overrides: Record<string, {
      model?: string | null;
      thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
      fallbackModels?: string[] | null;
    }> = {};

    for (const name of allOverrideNames) {
      const saved = savedManaged.agentOverrides[name];
      const draft = draftManaged.agentOverrides[name];

      if (!draft && saved) {
        // Agent fully removed from draft
        overrides[name] = {
          model: null,
          thinking: null,
          fallbackModels: null,
        };
        continue;
      }

      if (!draft) continue;

      const entry: typeof overrides[string] = {};

      if (draft.model !== saved?.model) {
        entry.model = draft.model === false ? null : (draft.model ?? null);
      }
      if (draft.thinking !== saved?.thinking) {
        entry.thinking = isThinkingValue(draft.thinking) ? draft.thinking : null;
      }
      if (JSON.stringify(draft.fallbackModels) !== JSON.stringify(saved?.fallbackModels)) {
        entry.fallbackModels = draft.fallbackModels === false ? null : (draft.fallbackModels ?? null);
      }

      if (Object.keys(entry).length > 0) {
        overrides[name] = entry;
      }
    }

    if (Object.keys(overrides).length > 0) {
      patch.agentOverrides = overrides;
    }

    return patch;
  }, [draftManaged, savedManaged, revision]);

  const registryModelIds = useMemo(() => new Set(modelList.map((model) => `${model.provider}/${model.id}`)), [modelList]);

  const validatePatchModels = useCallback((patch: ReturnType<typeof computePatch>): string | null => {
    const checkModel = (value: string | null | undefined, label: string): string | null => {
      if (!value) return null;
      if (!registryModelIds.has(value)) return t("settings.agents.notInModelList", { label, value });
      return null;
    };

    const defaultError = checkModel(patch.defaultModel, t("settings.defaultModel"));
    if (defaultError) return defaultError;

    for (const [agent, override] of Object.entries(patch.agentOverrides ?? {})) {
      const modelError = checkModel(override.model, t("settings.agents.modelOf", { agent }));
      if (modelError) return modelError;
      if (override.fallbackModels) {
        const seen = new Set<string>();
        for (const model of override.fallbackModels) {
          if (seen.has(model)) return t("settings.agents.fallbackDup", { agent, model });
          seen.add(model);
          const fallbackError = checkModel(model, t("settings.agents.fallbackModelOf", { agent }));
          if (fallbackError) return fallbackError;
        }
      }
    }

    return null;
  }, [registryModelIds, t]);

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!revision) return;
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const params = new URLSearchParams({ scope });
      if (scope === "project" && cwd) {
        params.set("cwd", cwd);
      }

      const patch = computePatch();
      const validationError = validatePatchModels(patch);
      if (validationError) throw new Error(validationError);

      const res = await fetch(`/api/subagents/config?${params}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json() as PutResponse;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

      setRevision(data.revision);
      if (data.managed) {
        setSavedManaged(data.managed);
        setDraftManaged(JSON.parse(JSON.stringify(data.managed)));
      }
      setNotice(t("settings.agents.savedPersist"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [revision, scope, cwd, computePatch, validatePatchModels, t]);

  // -----------------------------------------------------------------------
  // Reload
  // -----------------------------------------------------------------------

  const handleReload = useCallback(() => {
    loadedRef.current = { scope: "", cwd: "" };
    void loadConfig();
  }, [loadConfig]);

  // -----------------------------------------------------------------------
  // Model selector option rows
  // -----------------------------------------------------------------------

  const modelOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    // Add existing configured models not in registry
    const registryIds = new Set(modelList.map((m) => `${m.provider}/${m.id}`));
    const addModel = (model: string | false | undefined | null) => {
      if (typeof model === "string" && model && !registryIds.has(model) && !opts.find((o) => o.value === model)) {
        opts.push({ value: model, label: `⚠ ${model}` });
        registryIds.add(model);
      }
    };

    addModel(draftManaged.defaultModel);
    for (const override of Object.values(draftManaged.agentOverrides)) {
      addModel(override.model);
      if (Array.isArray(override.fallbackModels)) {
        for (const fb of override.fallbackModels) {
          addModel(fb);
        }
      }
    }

    // Add registry models
    for (const m of modelList) {
      const key = `${m.provider}/${m.id}`;
      if (!opts.find((o) => o.value === key)) {
        opts.push({ value: key, label: `${m.name} · ${m.provider}/${m.id}` });
      }
    }

    return opts;
  }, [modelList, draftManaged]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return <SettingsState kind="loading" title={t("settings.agents.loading")} />;
  }

  return (
    <SettingsSection className="agents-config">
      <SettingsSectionHeader
        title={t("settings.agents.title")}
        description={t("settings.agents.titleHint")}
        meta={configPath ? <><span>{t("settings.agents.targetFile")}</span> <code className="settings-inline-code">{configPath}</code>{configExists ? null : t("settings.autoCreateOnSaveLong")}</> : undefined}
      />

      {error && <SettingsNotice tone="danger">{error}</SettingsNotice>}
      {notice && <SettingsNotice tone="success">{notice}</SettingsNotice>}
      {parseError && (
        <SettingsNotice tone="danger">
          <SettingsActionRow>
            <span>{t("settings.agents.parseError", { error: parseError })}</span>
            <SettingsButton size="sm" onClick={handleReload}>{t("settings.agents.reload")}</SettingsButton>
          </SettingsActionRow>
        </SettingsNotice>
      )}
      {validationError && (
        <SettingsNotice tone="danger">
          <SettingsActionRow>
            <span>{t("settings.agents.validationError", { error: validationError })}</span>
            <SettingsButton size="sm" onClick={handleReload}>{t("settings.agents.reload")}</SettingsButton>
          </SettingsActionRow>
        </SettingsNotice>
      )}
      {scope === "project" && (userParseError || userValidationError) && <SettingsNotice tone="warning">{t("settings.agents.userInheritWarn", { error: userParseError ?? userValidationError })}</SettingsNotice>}

      <div className="settings-surface">
        <div className="agents-scope-row">
          <span className="settings-field-label">{t("settings.agents.scope")}</span>
          <SettingsSelect value={scope} onChange={(event) => setScope(event.target.value as "user" | "project")}>
            <option value="user">{t("settings.agents.userGlobal")}</option>
            <option value="project" disabled={!cwd}>{cwd ? t("settings.agents.currentProject") : t("settings.agents.currentProjectNeedWorkspace")}</option>
          </SettingsSelect>
          <SettingsBadge tone={scope === "project" ? "warning" : "accent"}>{scope === "project" ? t("settings.agents.currentProject") : t("settings.agents.userGlobal")}</SettingsBadge>
        </div>
        {scope === "project" && <div className="agents-config-path">{t("settings.agents.precedence")}</div>}
      </div>

      {discoveryDiagnostic && <SettingsNotice tone="warning">{discoveryDiagnostic}</SettingsNotice>}

      <div className="settings-surface">
        <SettingsActionRow>
          <div>
            <div className="settings-surface-title">{t("settings.defaultSubagentModel")}</div>
            <div className="mcp-guidance-copy">
              {t("settings.agents.defaultSubagentHint")}
              {scope === "project" && userManaged?.defaultModel ? t("settings.agents.userGlobalValue", { value: userManaged.defaultModel }) : ""}
            </div>
          </div>
          <SettingsButton size="sm" disabled={!draftManaged.defaultModel} onClick={clearDefaultModel}>{t("settings.agents.clear")}</SettingsButton>
        </SettingsActionRow>
        {modelsError && <SettingsNotice tone="danger">{modelsError}</SettingsNotice>}
        <SettingsSelect value={draftManaged.defaultModel ?? ""} onChange={(event) => updateDefaultModel(event.target.value)}>
          <option value="">{t("settings.agents.inheritOption")}</option>
          {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </SettingsSelect>
      </div>

      <div className="settings-surface">
        <SettingsActionRow>
          <div>
            <div className="settings-surface-title">{t("settings.agents.agentOverrides")}</div>
            <div className="mcp-guidance-copy">{t("settings.agents.overrideHint")}</div>
          </div>
          {revision && <span className="agents-revision settings-control-mono">rev:{revision.slice(0, 8)}</span>}
        </SettingsActionRow>

        {agents.length === 0 ? (
          <SettingsState title={t("settings.agents.noAgents")} description={extensionAvailable ? undefined : t("settings.agents.installExtension")} />
        ) : (
          <div className="agents-agent-list">
            {agents.map((agent) => {
              const draft = draftManaged.agentOverrides[agent.name];
              const userValue = scope === "project" ? userManaged?.agentOverrides[agent.name] : undefined;
              const inheritedModel = formatInheritedValue(userValue?.model, t);
              const inheritedThinking = formatInheritedValue(userValue?.thinking, t);
              const inheritedFallbacks = formatInheritedValue(userValue?.fallbackModels, t);
              const fallbackModels = Array.isArray(draft?.fallbackModels) ? draft.fallbackModels : [];

              return (
                <div key={agent.name} className="agents-agent-card">
                  <div className="agents-agent-identity">
                    <code className="agents-agent-name settings-control-mono">{agent.name}</code>
                    <SettingsBadge tone={SOURCE_BADGE_TONES[agent.source]}>{SOURCE_LABEL_KEYS[agent.source] ? t(SOURCE_LABEL_KEYS[agent.source]) : agent.source}</SettingsBadge>
                    <span className="agents-agent-description">{agent.description}</span>
                  </div>

                  <div className="agents-agent-grid">
                    <SettingsField
                      label={inheritedModel ? t("settings.agents.modelWithGlobal", { value: inheritedModel }) : t("settings.agents.model")}
                      description={draft?.model === false ? t("settings.agents.legacyFalseModel") : undefined}
                    >
                      <div className="agents-control-row">
                        <SettingsSelect value={ov(draft?.model)} onChange={(event) => updateAgentModel(agent.name, event.target.value)}>
                          <option value="">{t("settings.agents.inheritOption")}</option>
                          {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </SettingsSelect>
                        {hasConfiguredField(draft?.model) && <SettingsButton size="sm" onClick={() => clearAgentModel(agent.name)}>{t("settings.agents.clear")}</SettingsButton>}
                      </div>
                    </SettingsField>

                    <SettingsField
                      label={inheritedThinking ? t("settings.agents.thinkingWithGlobal", { value: inheritedThinking }) : t("settings.thinkingLevel")}
                      description={draft?.thinking === false ? t("settings.agents.legacyFalseThinking") : undefined}
                    >
                      <div className="agents-control-row">
                        <SettingsSelect value={ov(draft?.thinking)} onChange={(event) => updateAgentThinking(agent.name, event.target.value)}>
                          {THINKING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.labelKey.startsWith("settings.") ? t(option.labelKey) : option.labelKey}</option>)}
                        </SettingsSelect>
                        {hasConfiguredField(draft?.thinking) && <SettingsButton size="sm" onClick={() => clearAgentThinking(agent.name)}>{t("settings.agents.clear")}</SettingsButton>}
                      </div>
                    </SettingsField>
                  </div>

                  <div className="agents-fallbacks">
                    <div className="agents-fallback-header">
                      <span className="agents-inherit-note">{t("settings.fallbackModel")}{inheritedFallbacks ? t("settings.agents.fallbackWithGlobal", { value: inheritedFallbacks }) : ""}</span>
                      <div className="agents-fallback-actions">
                        <SettingsButton size="sm" onClick={() => addFallbackModel(agent.name)}>{t("settings.agents.add")}</SettingsButton>
                        {hasConfiguredField(draft?.fallbackModels) && <SettingsButton size="sm" onClick={() => clearAgentFallbacks(agent.name)}>{t("settings.agents.clearAll")}</SettingsButton>}
                      </div>
                    </div>
                    {draft?.fallbackModels === false && <SettingsNotice tone="warning">{t("settings.agents.fallbackLegacyFalse")}</SettingsNotice>}
                    {fallbackModels.length > 0 && (
                      <div className="agents-fallback-list">
                        {fallbackModels.map((fallbackModel, index) => (
                          <div key={`${fallbackModel}-${index}`} className="agents-fallback-row">
                            <span className="agents-fallback-index">{index + 1}.</span>
                            <SettingsSelect value={fallbackModel} aria-label={t("settings.agents.fallbackModelOf", { agent: agent.name })} onChange={(event) => updateFallbackModel(agent.name, index, event.target.value)}>
                              <option value="">{t("settings.agents.selectModel")}</option>
                              {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </SettingsSelect>
                            <SettingsButton size="icon" variant="ghost" onClick={() => moveFallbackModel(agent.name, index, Math.max(0, index - 1))} disabled={index === 0} aria-label={t("settings.agents.moveUp")}>↑</SettingsButton>
                            <SettingsButton size="icon" variant="ghost" onClick={() => moveFallbackModel(agent.name, index, Math.min(fallbackModels.length - 1, index + 1))} disabled={index === fallbackModels.length - 1} aria-label={t("settings.agents.moveDown")}>↓</SettingsButton>
                            <SettingsButton size="icon" variant="ghost" onClick={() => removeFallbackModel(agent.name, index)} aria-label={t("settings.agents.delete")}>×</SettingsButton>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <SettingsActionRow>
        <SettingsButton onClick={handleReload} disabled={saving || loading}>{t("settings.agents.reload")}</SettingsButton>
        <div className="settings-action-group">
          {dirty && <span className="settings-dirty-note">{t("settings.unsavedChanges")}</span>}
          <SettingsButton
            variant="primary"
            busy={saving}
            disabled={!dirty || loading || Boolean(parseError) || Boolean(validationError) || !revision}
            onClick={() => void handleSave()}
          >
            {saving ? t("settings.saving") : dirty ? t("settings.saveSettings") : t("settings.saved")}
          </SettingsButton>
        </div>
      </SettingsActionRow>

      <SettingsNotice tone="info">{t("settings.agents.persistNote")}</SettingsNotice>
    </SettingsSection>
  );
}
