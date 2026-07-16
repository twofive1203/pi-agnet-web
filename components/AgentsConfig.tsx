"use client";

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
  { value: "", label: "继承/不指定" },
  { value: "off", label: "关闭思考" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
] as const;

const SOURCE_LABELS: Record<string, string> = {
  builtin: "内置",
  package: "包",
  user: "用户",
  project: "项目",
  "settings-only": "设置残留",
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

function formatInheritedValue(value: string | false | string[] | undefined): string | null {
  if (value === false) return "显式 false";
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
      setError("没有可用的 Pi 模型，无法添加回退模型。");
      return;
    }

    const currentFallbacks = draftManaged.agentOverrides[name]?.fallbackModels;
    const visibleExisting = new Set(Array.isArray(currentFallbacks) ? currentFallbacks : []);
    if (!available.some((model) => !visibleExisting.has(model))) {
      setError("所有可用模型都已在该 Agent 的回退列表中。");
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
  }, [draftManaged.agentOverrides, modelList]);

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
      if (!registryModelIds.has(value)) return `${label} 不在 Pi 可用模型列表中：${value}`;
      return null;
    };

    const defaultError = checkModel(patch.defaultModel, "默认模型");
    if (defaultError) return defaultError;

    for (const [agent, override] of Object.entries(patch.agentOverrides ?? {})) {
      const modelError = checkModel(override.model, `${agent} 模型`);
      if (modelError) return modelError;
      if (override.fallbackModels) {
        const seen = new Set<string>();
        for (const model of override.fallbackModels) {
          if (seen.has(model)) return `${agent} 回退模型重复：${model}`;
          seen.add(model);
          const fallbackError = checkModel(model, `${agent} 回退模型`);
          if (fallbackError) return fallbackError;
        }
      }
    }

    return null;
  }, [registryModelIds]);

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
      setNotice("设置已保存。持续化已完成，Pi 会话按正常生命周期加载新设置。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [revision, scope, cwd, computePatch, validatePatchModels]);

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
    return <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 12 }}>正在加载子代理设置…</div>;
  }

  const effectiveAgentList = agents;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div>
        <h3 style={{ margin: 0, color: "var(--text)", fontSize: 15 }}>Pi Subagent 模型设置</h3>
        <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
          配置 pi-subagents 的原生模型设置，独立于 Trellis 路由策略。保存到 Pi settings.json，不修改 pi-web.json。
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
        <strong>与 Trellis 路由的区别：</strong>本页面直接管理 pi-subagents 的原生配置（settings.json → subagents），影响所有使用 pi-subagents
        的场景。下方的「Trellis」区域只控制蜗牛派 Web UI 的 Trellis 工作流路由策略（pi-web.json → trellis.subagents）。
        两者互不干扰，可同时使用。
      </div>

      {/* Error / Notice */}
      {error && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>{error}</div>}
      {notice && <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(37,99,235,0.12)", color: "var(--accent)", fontSize: 12, overflowWrap: "anywhere" }}>{notice}</div>}

      {/* Parse/validation error banner */}
      {parseError && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>
          settings.json 解析错误：{parseError}。保存操作被禁用，请先手动修复该文件。
          <button onClick={handleReload} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
            重新加载
          </button>
        </div>
      )}
      {validationError && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 12, overflowWrap: "anywhere" }}>
          settings.json 内容无效：{validationError}。保存操作被禁用，请先手动修复。
          <button onClick={handleReload} style={{ marginLeft: 8, background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
            重新加载
          </button>
        </div>
      )}
      {scope === "project" && (userParseError || userValidationError) && (
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(234,179,8,0.1)", border: "1px solid rgba(234,179,8,0.2)", color: "var(--text-dim)", fontSize: 12, overflowWrap: "anywhere" }}>
          用户全局 settings.json 无法作为继承提示读取：{userParseError ?? userValidationError}
        </div>
      )}

      {/* Scope selector */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 600 }}>作用域：</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as "user" | "project")}
          style={{ ...inputStyle, width: "auto", minWidth: 140, cursor: "pointer" }}
        >
          <option value="user">用户全局</option>
          <option value="project" disabled={!cwd}>{cwd ? "当前项目" : "当前项目（请先选择工作区）"}</option>
        </select>
      </div>

      {/* Path and precedence info */}
      <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg-subtle)", border: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <div><strong>目标文件：</strong><code style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{configPath}</code>{configExists ? "" : "（尚未创建，保存时自动创建）"}</div>
        {scope === "project" && (
          <div style={{ marginTop: 4 }}><strong>优先级说明：</strong>项目设置覆盖用户全局设置。未在项目作用域中指定的字段会继承用户全局值。实际运行时还会受 Agent frontmatter、工具调用参数影响。</div>
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
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>默认子代理模型</div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
              所有未单独指定模型的子代理默认使用的模型。设为「继承/不指定」则从上一级继承。
              {scope === "project" && userManaged?.defaultModel ? ` 用户全局值：${userManaged.defaultModel}。` : ""}
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
            清除
          </button>
        </div>
        {modelsError && <div style={{ padding: "6px 8px", borderRadius: 6, background: "rgba(239,68,68,0.12)", color: "#f87171", fontSize: 11 }}>{modelsError}</div>}
        <select
          value={draftManaged.defaultModel ?? ""}
          onChange={(e) => updateDefaultModel(e.target.value)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="">— 继承/不指定 —</option>
          {modelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Agent overrides */}
      <div style={{ padding: 12, borderRadius: 10, background: "var(--bg-subtle)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 800 }}>Agent 单独覆盖</div>
            <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3, lineHeight: 1.45 }}>
              为特定 Agent 指定模型、思考强度或回退模型。留空表示继承上级设置。
            </div>
          </div>
          {revision && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>rev:{revision.slice(0, 8)}</span>}
        </div>

        {effectiveAgentList.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "8px 0" }}>暂无已发现的 Agent。{extensionAvailable ? "" : "请安装 pi-subagents 扩展。"}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {effectiveAgentList.map((agent) => {
              const draft = draftManaged.agentOverrides[agent.name];
              const userVal = scope === "project" ? userManaged?.agentOverrides[agent.name] : undefined;
              const inheritedModel = formatInheritedValue(userVal?.model);
              const inheritedThinking = formatInheritedValue(userVal?.thinking);
              const inheritedFallbacks = formatInheritedValue(userVal?.fallbackModels);

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
                      {SOURCE_LABELS[agent.source] ?? agent.source}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1 }}>{agent.description}</span>
                  </div>

                  {/* Model row */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <Field label={`模型${inheritedModel ? "（用户全局：" + inheritedModel + "）" : ""}`} description={draft?.model === false ? "当前作用域保存了 legacy false 值；选择模型会替换，清除会删除该字段并恢复继承。" : undefined}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={ov(draft?.model)}
                          onChange={(e) => updateAgentModel(agent.name, e.target.value)}
                          style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                        >
                          <option value="">— 继承/不指定 —</option>
                          {modelOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {hasConfiguredField(draft?.model) && (
                          <button
                            onClick={() => clearAgentModel(agent.name)}
                            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}
                          >
                            清除
                          </button>
                        )}
                      </div>
                    </Field>

                    <Field label={`思考强度${inheritedThinking ? "（用户全局：" + inheritedThinking + "）" : ""}`} description={draft?.thinking === false ? "当前作用域保存了 legacy false 值；选择强度会替换，清除会删除该字段并恢复继承。" : undefined}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <select
                          value={ov(draft?.thinking)}
                          onChange={(e) => updateAgentThinking(agent.name, e.target.value)}
                          style={{ ...inputStyle, cursor: "pointer", flex: 1 }}
                        >
                          {THINKING_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        {hasConfiguredField(draft?.thinking) && (
                          <button
                            onClick={() => clearAgentThinking(agent.name)}
                            style={{ padding: "5px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10, whiteSpace: "nowrap" }}
                          >
                            清除
                          </button>
                        )}
                      </div>
                    </Field>
                  </div>

                  {/* Fallback models */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                        回退模型{inheritedFallbacks ? `（用户全局：${inheritedFallbacks}）` : ""}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => addFallbackModel(agent.name)}
                          style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}
                        >
                          + 添加
                        </button>
                        {hasConfiguredField(draft?.fallbackModels) && (
                          <button
                            onClick={() => clearAgentFallbacks(agent.name)}
                            style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
                          >
                            全部清除
                          </button>
                        )}
                      </div>
                    </div>

                    {draft?.fallbackModels === false && (
                      <div style={{ color: "var(--text-dim)", fontSize: 10 }}>当前作用域保存了 legacy false 值；添加模型会替换，全部清除会删除该字段并恢复继承。</div>
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
                              <option value="">— 选择模型 —</option>
                              {modelOptions.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                            <button
                              onClick={() => moveFallbackModel(agent.name, i, Math.max(0, i - 1))}
                              disabled={i === 0}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: i === 0 ? "var(--text-dim)" : "var(--text)", cursor: i === 0 ? "not-allowed" : "pointer", fontSize: 10 }}
                              title="上移"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => moveFallbackModel(agent.name, i, Math.min(fbArr.length - 1, i + 1))}
                              disabled={i === fbArr.length - 1}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: i === fbArr.length - 1 ? "var(--text-dim)" : "var(--text)", cursor: i === fbArr.length - 1 ? "not-allowed" : "pointer", fontSize: 10 }}
                              title="下移"
                            >
                              ↓
                            </button>
                            <button
                              onClick={() => removeFallbackModel(agent.name, i)}
                              style={{ padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-dim)", cursor: "pointer", fontSize: 10 }}
                              title="删除"
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
          重新加载
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
          {saving ? "正在保存…" : dirty ? "保存设置" : "已保存"}
        </button>
      </div>

      {/* Persistence note */}
      <div style={{ padding: 8, borderRadius: 6, background: "var(--bg-subtle)", border: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.45 }}>
        设置已持久化到磁盘。正在运行的 Pi 会话在下次重启或重新加载扩展配置前可能不会应用新的设置，新创建的子代理会使用最新配置。
      </div>
    </div>
  );
}
