"use client";

import { useI18n } from "@/components/I18nProvider";

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

const SOURCE_BADGE_COLORS: Record<string, string> = {
  builtin: "rgba(37,99,235,0.14)",
  package: "rgba(147,51,234,0.14)",
  user: "rgba(34,197,94,0.14)",
  project: "rgba(249,115,22,0.14)",
  "settings-only": "rgba(107,114,128,0.14)",
};

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
// Field Component
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AgentsConfig Component
// ---------------------------------------------------------------------------

export function AgentsConfig({ cwd }: { cwd: string | null }) {
  const { t, locale } = useI18n();
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
    return <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 12 }}>{t("settings.agents.loading")}</div>;
  }

  const effectiveAgentList = agents;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div>
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>{t("settings.agents.title")}</h3>
        <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
          {t("settings.agents.titleHint")}
        </p>
      </div>

      {/* Native vs Trellis banner */}
      <div style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid rgba(37,99,235,0.25)",
        background: "rgba(37,99,235,0.08)",
        color: "var(--text)",
        fontSize: 11,
        lineHeight: 1.5,
      }}>
        {t("settings.agents.vsTrellis")}
      </div>

      {/* Error / Notice */}
      {error && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div>}
      {notice && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(37,99,235,0.12)", color: "var(--accent)", fontSize: 12, overflowWrap: "anywhere" }}>{notice}</div>}

      {/* Parse/validation error banner */}
      {parseError && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>
          {t("settings.agents.parseError", { error: parseError })}
          <button onClick={handleReload} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
            {t("settings.agents.reload")}
          </button>
        </div>
      )}
      {validationError && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>
          {t("settings.agents.validationError", { error: validationError })}
          <button onClick={handleReload} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
            {t("settings.agents.reload")}
          </button>
        </div>
      )}
      {scope === "project" && (userParseError || userValidationError) && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.2)", color: "var(--text-dim)", fontSize: 12, overflowWrap: "anywhere" }}>
          {t("settings.agents.userInheritWarn", { error: userParseError ?? userValidationError })}
        </div>
      )}

      {/* Scope selector */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>{t("settings.agents.scope")}</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "user" | "project")}
          style={{ ...inputStyle, width: "auto", minWidth: 140, cursor: "pointer" }}
        >
          <option value="user">{t("settings.agents.userGlobal")}</option>
          <option value="project" disabled={!cwd}>{cwd ? t("settings.agents.currentProject") : t("settings.agents.currentProjectNeedWorkspace")}</option>
        </select>
      </div>

      {/* Path and precedence info */}
      <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg-subtle)", border: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <div><strong>{t("settings.agents.targetFile")}</strong><code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{configPath}</code>{configExists ? "" : t("settings.autoCreateOnSaveLong")}</div>
        {scope === "project" && (
          <div style={{ marginTop: 4 }}>{t("settings.agents.precedence")}</div>
        )}
      </div>

      {/* Extension status */}
      {discoveryDiagnostic && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.2)", fontSize: 11, color: "var(--text-dim)" }}>
          {discoveryDiagnostic}
        </div>
      )}

      {/* Default model */}
      <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.defaultSubagentModel")}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
              {t("settings.agents.defaultSubagentHint")}
              {scope === "project" && userManaged?.defaultModel ? t("settings.agents.userGlobalValue", { value: userManaged.defaultModel }) : ""}
            </div>
          </div>
          <button
            onClick={clearDefaultModel}
            disabled={!draftManaged.defaultModel}
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: draftManaged.defaultModel ? "var(--text)" : "var(--text-dim)",
              cursor: draftManaged.defaultModel ? "pointer" : "not-allowed",
              fontSize: 11,
              whiteSpace: "nowrap",
            }}
          >
            {t("settings.agents.clear")}
          </button>
        </div>
        {modelsError && <div style={{ padding: "6px 8px", borderRadius: 6, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 11 }}>{modelsError}</div>}
        <select
          value={draftManaged.defaultModel ?? ""}
          onChange={(e) => updateDefaultModel(e.target.value)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="">{t("settings.agents.inheritOption")}</option>
          {modelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Agent overrides */}
      <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>{t("settings.agents.agentOverrides")}</div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
              {locale === "zh" ? "为特定 Agent 指定模型、思考强度或回退模型。留空表示继承上级设置。" : "Override model, thinking, or fallbacks for a specific agent. Leave empty to inherit."}
            </div>
          </div>
          {revision && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>rev:{revision.slice(0, 8)}</span>}
        </div>

        {effectiveAgentList.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "8px 0" }}>{t("settings.agents.noAgents")}{extensionAvailable ? "" : t("settings.agents.installExtension")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {effectiveAgentList.map((agent) => {
              const draft = draftManaged.agentOverrides[agent.name];
              const userVal = scope === "project" ? userManaged?.agentOverrides[agent.name] : undefined;
              const inheritedModel = formatInheritedValue(userVal?.model, t);
              const inheritedThinking = formatInheritedValue(userVal?.thinking, t);
              const inheritedFallbacks = formatInheritedValue(userVal?.fallbackModels, t);

              return (
                <div
                  key={agent.name}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {/* Agent identity row */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", fontWeight: 700 }}>
                      {agent.name}
                    </code>
                    <span style={{
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: SOURCE_BADGE_COLORS[agent.source] ?? "rgba(107,114,128,0.14)",
                      color: "var(--text)",
                      fontSize: 10,
                      fontWeight: 600,
                    }}>
                      {SOURCE_LABEL_KEYS[agent.source] ? t(SOURCE_LABEL_KEYS[agent.source]) : agent.source}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>{agent.description}</span>
                  </div>

                  {/* Model row */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label={inheritedModel ? t("settings.agents.modelWithGlobal", { value: inheritedModel }) : t("settings.agents.model")} description={draft?.model === false ? t("settings.agents.legacyFalseModel") : undefined}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={ov(draft?.model)}
                          onChange={(e) => updateAgentModel(agent.name, e.target.value)}
                          style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                        >
                          <option value="">{t("settings.agents.inheritOption")}</option>
                          {modelOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {hasConfiguredField(draft?.model) && (
                          <button
                            onClick={() => clearAgentModel(agent.name)}
                            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}
                          >
                            {t("settings.agents.clear")}
                          </button>
                        )}
                      </div>
                    </Field>

                    <Field label={inheritedThinking ? t("settings.agents.thinkingWithGlobal", { value: inheritedThinking }) : t("settings.thinkingLevel")} description={draft?.thinking === false ? t("settings.agents.legacyFalseThinking") : undefined}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={ov(draft?.thinking)}
                          onChange={(e) => updateAgentThinking(agent.name, e.target.value)}
                          style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                        >
                          {THINKING_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.labelKey.startsWith("settings.") ? t(opt.labelKey) : opt.labelKey}</option>
                          ))}
                        </select>
                        {hasConfiguredField(draft?.thinking) && (
                          <button
                            onClick={() => clearAgentThinking(agent.name)}
                            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}
                          >
                            {t("settings.agents.clear")}
                          </button>
                        )}
                      </div>
                    </Field>
                  </div>

                  {/* Fallback models */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        {t("settings.fallbackModel")}{inheritedFallbacks ? t("settings.agents.fallbackWithGlobal", { value: inheritedFallbacks }) : ""}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => addFallbackModel(agent.name)}
                          style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}
                        >
                          {t("settings.agents.add")}
                        </button>
                        {hasConfiguredField(draft?.fallbackModels) && (
                          <button
                            onClick={() => clearAgentFallbacks(agent.name)}
                            style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
                          >
                            {t("settings.agents.clearAll")}
                          </button>
                        )}
                      </div>
                    </div>

                    {draft?.fallbackModels === false && (
                      <div style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("settings.agents.fallbackLegacyFalse")}</div>
                    )}
                    {Array.isArray(draft?.fallbackModels) && (draft.fallbackModels as string[]).length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
                        {(draft.fallbackModels as string[]).map((fb, i) => {
                          const fbArr = draft!.fallbackModels as string[];
                          return (
                          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ fontSize: 10, color: "var(--text-dim)", minWidth: 16 }}>{i + 1}.</span>
                            <select
                              value={fb}
                              onChange={(e) => updateFallbackModel(agent.name, i, e.target.value)}
                              style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                            >
                              <option value="">{t("settings.agents.selectModel")}</option>
                              {modelOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => moveFallbackModel(agent.name, i, Math.max(0, i - 1))}
                              disabled={i === 0}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: i === 0 ? "var(--text-dim)" : "var(--text)", cursor: i === 0 ? "not-allowed" : "pointer", fontSize: 10 }}
                              title={t("settings.agents.moveUp")}
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => moveFallbackModel(agent.name, i, Math.min(fbArr.length - 1, i + 1))}
                              disabled={i === fbArr.length - 1}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: i === fbArr.length - 1 ? "var(--text-dim)" : "var(--text)", cursor: i === fbArr.length - 1 ? "not-allowed" : "pointer", fontSize: 10 }}
                              title={t("settings.agents.moveDown")}
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => removeFallbackModel(agent.name, i)}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
                              title={t("settings.agents.delete")}
                            >
                              ×
                            </button>
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Save button */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          onClick={handleReload}
          disabled={saving || loading}
          style={{
            padding: "7px 12px",
            borderRadius: 7,
            border: "1px solid var(--border)",
            background: "var(--bg)",
            color: "var(--text-muted)",
            cursor: saving || loading ? "not-allowed" : "pointer",
            fontSize: 12,
          }}
        >
          {t("settings.agents.reload")}
        </button>
        <button
          onClick={() => void handleSave()}
          disabled={!dirty || saving || loading || !!parseError || !!validationError || !revision}
          style={{
            padding: "7px 14px",
            borderRadius: 7,
            border: "none",
            background: dirty && !saving && !parseError && !validationError ? "var(--accent)" : "var(--border)",
            color: "white",
            cursor: dirty && !saving && !parseError && !validationError && revision ? "pointer" : "not-allowed",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {saving ? t("settings.saving") : dirty ? t("settings.saveSettings") : t("settings.saved")}
        </button>
      </div>

      {/* Persistence note */}
      <div style={{ padding: 8, borderRadius: 6, background: "var(--bg-subtle)", border: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.45 }}>
        {t("settings.agents.persistNote")}
      </div>
    </div>
  );
}
