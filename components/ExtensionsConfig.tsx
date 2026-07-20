"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ConfiguredPackageInfo,
  ExtensionSettingDefinition,
  ExtensionSettingsGroup,
  ExtensionSettingValueRow,
} from "@/lib/extension-settings";

type TabId = "resources" | "settings";

type ResourceDiagnostic = { type: string; message: string; path?: string };

type ResourcesPayload = {
  cwd?: string;
  agentDir?: string;
  packages?: ConfiguredPackageInfo[];
  extensions?: Array<{ path: string; resolvedPath?: string; sourceInfo?: { scope?: string; source?: string } }>;
  tools?: Array<{ name: string; description?: string }>;
  commands?: Array<{ name: string; description?: string }>;
  skills?: Array<{ name: string; description?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
  diagnostics?: ResourceDiagnostic[];
  error?: string;
};

type SettingsPayload = {
  groups?: ExtensionSettingsGroup[];
  packages?: ConfiguredPackageInfo[];
  values?: ExtensionSettingValueRow[];
  settingsPath?: string;
  diagnostics?: ResourceDiagnostic[];
  error?: string;
};

type DraftMap = Record<string, string>;

function draftKey(extensionName: string, settingId: string): string {
  return `${extensionName}::${settingId}`;
}

function shortenPath(path: string): string {
  return path
    .replace(/^[/\\]?Users[/\\][^/\\]+/i, "~")
    .replace(/^[/\\]?home[/\\][^/\\]+/i, "~")
    .replace(/^C:\\Users\\[^\\]+/i, "~");
}

function cycleValue(current: string, values: string[]): string {
  if (values.length === 0) return current;
  const index = values.indexOf(current);
  if (index < 0) return values[0];
  return values[(index + 1) % values.length];
}

function CountPill({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        minWidth: 72,
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      <span style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
    </div>
  );
}

function Section({
  title,
  count,
  children,
  empty,
}: {
  title: string;
  count: number;
  children: ReactNode;
  empty?: string;
}) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{title}</h3>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{count}</span>
      </div>
      {count === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 0" }}>{empty ?? "None"}</div>
      ) : (
        children
      )}
    </section>
  );
}

function ListRow({
  title,
  subtitle,
  badge,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "8px 10px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", wordBreak: "break-word" }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {subtitle}
          </div>
        )}
      </div>
      {badge && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            color: "var(--text-dim)",
            background: "var(--bg)",
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

function SettingEditor({
  groupName,
  definition,
  value,
  source,
  onChange,
}: {
  groupName: string;
  definition?: ExtensionSettingDefinition;
  value: string;
  source: ExtensionSettingValueRow["source"];
  onChange: (next: string) => void;
}) {
  const label = definition?.label ?? definition?.id ?? value;
  const description = definition?.description;
  const values = definition?.values;
  const options = definition?.options;

  return (
    <div
      style={{
        padding: "12px 12px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
            {label}
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontWeight: 500 }}>
              {groupName}.{definition?.id ?? "?"}
            </span>
          </div>
          {description && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
              {description}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10, color: source === "orphan" ? "#eab308" : "var(--text-dim)", flexShrink: 0 }}>
          {source}
        </span>
      </div>

      {values && values.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {values.map((item) => {
            const active = item === value;
            return (
              <button
                key={item}
                type="button"
                onClick={() => onChange(item)}
                style={{
                  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  borderRadius: 7,
                  padding: "5px 9px",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {JSON.stringify(item).slice(1, -1) || "(empty)"}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => onChange(cycleValue(value, values))}
            style={{
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              borderRadius: 7,
              padding: "5px 9px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Cycle
          </button>
        </div>
      ) : options && options.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Ordered multi-select (comma-separated ids). Toggle items below; order is left-to-right in the value.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {options.map((option) => {
              const selected = value.split(",").map((part) => part.trim()).filter(Boolean);
              const active = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    const next = active
                      ? selected.filter((id) => id !== option.id)
                      : [...selected, option.id];
                    onChange(next.join(","));
                  }}
                  style={{
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    borderRadius: 7,
                    padding: "5px 9px",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                  title={option.id}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              border: "1px solid var(--border)",
              borderRadius: 7,
              padding: "7px 9px",
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
            }}
          />
        </div>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            border: "1px solid var(--border)",
            borderRadius: 7,
            padding: "7px 9px",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal for inspecting loaded Pi packages/resources and editing extension settings.
 */
export function ExtensionsConfig({ cwd, onClose, embed }: { cwd: string | null; onClose: () => void; embed?: boolean }) {
  const [tab, setTab] = useState<TabId>("resources");
  const [resources, setResources] = useState<ResourcesPayload | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<DraftMap>({});
  const [baseline, setBaseline] = useState<DraftMap>({});
  const [loadingResources, setLoadingResources] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const effectiveCwd = cwd || ".";

  const loadResources = useCallback(async (signal?: AbortSignal) => {
    setLoadingResources(true);
    setError(null);
    try {
      const res = await fetch(`/api/pi/resources?cwd=${encodeURIComponent(effectiveCwd)}`, { signal });
      const data = (await res.json()) as ResourcesPayload;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResources(data);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoadingResources(false);
    }
  }, [effectiveCwd]);

  const applySettingsPayload = useCallback((data: SettingsPayload) => {
    setSettings(data);
    const nextDraft: DraftMap = {};
    for (const row of data.values ?? []) {
      nextDraft[draftKey(row.extensionName, row.settingId)] = row.value;
    }
    setDraft(nextDraft);
    setBaseline(nextDraft);
  }, []);

  const loadSettings = useCallback(async (signal?: AbortSignal) => {
    setLoadingSettings(true);
    setError(null);
    setSaveMessage(null);
    try {
      const res = await fetch(`/api/pi/extension-settings?cwd=${encodeURIComponent(effectiveCwd)}`, { signal });
      const data = (await res.json()) as SettingsPayload;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      applySettingsPayload(data);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal?.aborted) setLoadingSettings(false);
    }
  }, [applySettingsPayload, effectiveCwd]);

  useEffect(() => {
    const controller = new AbortController();
    void loadResources(controller.signal);
    return () => controller.abort();
  }, [loadResources]);

  useEffect(() => {
    if (tab !== "settings") return;
    const controller = new AbortController();
    void loadSettings(controller.signal);
    return () => controller.abort();
  }, [loadSettings, tab]);

  useEffect(() => {
    if (embed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, embed]);

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(baseline)]);
    return Array.from(keys).filter((key) => (draft[key] ?? "") !== (baseline[key] ?? ""));
  }, [baseline, draft]);

  const definitionMap = useMemo(() => {
    const map = new Map<string, ExtensionSettingDefinition>();
    for (const group of settings?.groups ?? []) {
      for (const setting of group.settings) {
        map.set(draftKey(group.name, setting.id), setting);
      }
    }
    return map;
  }, [settings?.groups]);

  const filteredValues = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = settings?.values ?? [];
    if (!q) return rows;
    return rows.filter((row) => {
      const def = definitionMap.get(draftKey(row.extensionName, row.settingId));
      const hay = [
        row.extensionName,
        row.settingId,
        row.value,
        def?.label,
        def?.description,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [definitionMap, filter, settings?.values]);

  const groupedFiltered = useMemo(() => {
    const map = new Map<string, ExtensionSettingValueRow[]>();
    for (const row of filteredValues) {
      const list = map.get(row.extensionName) ?? [];
      list.push(row);
      map.set(row.extensionName, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredValues]);

  const saveSettings = useCallback(async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const patch = dirtyKeys.map((key) => {
        const [extensionName, settingId] = key.split("::");
        return {
          extensionName,
          settingId,
          value: draft[key] ?? "",
        };
      });
      const res = await fetch("/api/pi/extension-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: effectiveCwd, patch }),
      });
      const data = (await res.json()) as SettingsPayload & { ok?: boolean };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      applySettingsPayload(data);
      setSaveMessage(`Saved ${patch.length} setting${patch.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [applySettingsPayload, dirtyKeys, draft, effectiveCwd]);

  const loading = tab === "resources" ? loadingResources : loadingSettings;

  const panelContent = (
    <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Extensions</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              cwd: {shortenPath(effectiveCwd)}
            </div>
          </div>
          <div style={{ display: "flex", height: 28, border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
            {([
              ["resources", "Resources"],
              ["settings", "Settings"],
            ] as const).map(([id, label]) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  style={{
                    padding: "0 12px",
                    border: "none",
                    borderLeft: id === "settings" ? "1px solid var(--border)" : "none",
                    background: active ? "var(--bg-selected)" : "transparent",
                    color: active ? "var(--text)" : "var(--text-muted)",
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              if (tab === "resources") void loadResources();
              else void loadSettings();
            }}
            disabled={loading}
            style={{
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              borderRadius: 7,
              padding: "6px 10px",
              fontSize: 12,
              cursor: loading ? "wait" : "pointer",
            }}
          >
            Refresh
          </button>
          {!embed && (
            <button
              type="button"
              onClick={onClose}
              style={{
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text-muted)",
                borderRadius: 7,
                padding: "6px 10px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Close
            </button>
          )}
        </div>

        {(error || saveMessage) && (
          <div
            style={{
              padding: "8px 14px",
              borderBottom: "1px solid var(--border)",
              fontSize: 12,
              color: error ? "#ef4444" : "var(--accent)",
              background: error ? "rgba(239,68,68,0.06)" : "rgba(37,99,235,0.06)",
            }}
          >
            {error ?? saveMessage}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 14 }}>
          {loading && !resources && tab === "resources" && (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading resources…</div>
          )}
          {loading && !settings && tab === "settings" && (
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Discovering extension settings…</div>
          )}

          {tab === "resources" && resources && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                <CountPill label="Packages" count={resources.packages?.length ?? 0} />
                <CountPill label="Extensions" count={resources.extensions?.length ?? 0} />
                <CountPill label="Tools" count={resources.tools?.length ?? 0} />
                <CountPill label="Commands" count={resources.commands?.length ?? 0} />
                <CountPill label="Skills" count={resources.skills?.length ?? 0} />
                <CountPill label="Prompts" count={resources.prompts?.length ?? 0} />
                <CountPill label="Diagnostics" count={resources.diagnostics?.length ?? 0} />
              </div>
              {resources.agentDir && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 14, fontFamily: "var(--font-mono)" }}>
                  agentDir: {shortenPath(resources.agentDir)}
                </div>
              )}

              <Section title="Packages" count={resources.packages?.length ?? 0} empty="No packages configured in settings.json.">
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.packages ?? []).map((pkg) => (
                    <ListRow
                      key={`${pkg.scope}:${pkg.source}`}
                      title={pkg.source}
                      subtitle={pkg.installedPath ? shortenPath(pkg.installedPath) : undefined}
                      badge={`${pkg.scope}${pkg.filtered ? " · filtered" : ""}`}
                    />
                  ))}
                </div>
              </Section>

              <Section title="Loaded extensions" count={resources.extensions?.length ?? 0}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.extensions ?? []).map((extension) => (
                    <ListRow
                      key={extension.resolvedPath || extension.path}
                      title={shortenPath(extension.resolvedPath || extension.path)}
                      subtitle={extension.path !== extension.resolvedPath ? extension.path : undefined}
                      badge={extension.sourceInfo?.scope || extension.sourceInfo?.source || "ext"}
                    />
                  ))}
                </div>
              </Section>

              <Section title="Tools" count={resources.tools?.length ?? 0}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.tools ?? []).map((tool) => (
                    <ListRow key={tool.name} title={tool.name} subtitle={tool.description} />
                  ))}
                </div>
              </Section>

              <Section title="Extension commands" count={resources.commands?.length ?? 0}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.commands ?? []).map((command) => (
                    <ListRow key={command.name} title={`/${command.name}`} subtitle={command.description} />
                  ))}
                </div>
              </Section>

              <Section title="Skills" count={resources.skills?.length ?? 0}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.skills ?? []).map((skill) => (
                    <ListRow key={skill.name} title={skill.name} subtitle={skill.description} />
                  ))}
                </div>
              </Section>

              <Section title="Prompts" count={resources.prompts?.length ?? 0}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.prompts ?? []).map((prompt) => (
                    <ListRow key={prompt.name} title={`/${prompt.name}`} subtitle={prompt.description} />
                  ))}
                </div>
              </Section>

              <Section title="Diagnostics" count={resources.diagnostics?.length ?? 0} empty="No load diagnostics.">
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {(resources.diagnostics ?? []).map((item, index) => (
                    <ListRow
                      key={`${item.type}-${index}-${item.message.slice(0, 24)}`}
                      title={item.message}
                      subtitle={item.path}
                      badge={item.type}
                    />
                  ))}
                </div>
              </Section>
            </>
          )}

          {tab === "settings" && settings && (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter settings…"
                  style={{
                    flex: 1,
                    minWidth: 180,
                    boxSizing: "border-box",
                    border: "1px solid var(--border)",
                    borderRadius: 7,
                    padding: "7px 10px",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    fontSize: 12,
                  }}
                />
                <button
                  type="button"
                  onClick={() => void saveSettings()}
                  disabled={saving || dirtyKeys.length === 0}
                  style={{
                    border: "1px solid var(--accent)",
                    background: dirtyKeys.length === 0 ? "var(--bg-panel)" : "var(--accent)",
                    color: dirtyKeys.length === 0 ? "var(--text-muted)" : "#fff",
                    borderRadius: 7,
                    padding: "7px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: dirtyKeys.length === 0 || saving ? "not-allowed" : "pointer",
                    opacity: saving ? 0.7 : 1,
                  }}
                >
                  {saving ? "Saving…" : dirtyKeys.length > 0 ? `Save ${dirtyKeys.length}` : "Saved"}
                </button>
              </div>

              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
                {settings.settingsPath ? shortenPath(settings.settingsPath) : "settings-extensions.json"}
                {" · "}
                {(settings.groups?.length ?? 0)} registered group{(settings.groups?.length ?? 0) === 1 ? "" : "s"}
                {" · "}
                {(settings.values?.length ?? 0)} setting{(settings.values?.length ?? 0) === 1 ? "" : "s"}
              </div>

              {(settings.diagnostics?.length ?? 0) > 0 && (
                <Section title="Discovery diagnostics" count={settings.diagnostics?.length ?? 0}>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 12 }}>
                    {(settings.diagnostics ?? []).map((item, index) => (
                      <ListRow
                        key={`diag-${index}`}
                        title={item.message}
                        subtitle={item.path}
                        badge={item.type}
                      />
                    ))}
                  </div>
                </Section>
              )}

              {(settings.values?.length ?? 0) === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  No extension settings registered and no stored values found.
                  {" "}
                  Ensure <code>pi-extension-settings</code> loads before consumer extensions in <code>settings.json</code> packages.
                </div>
              ) : (
                groupedFiltered.map(([extensionName, rows]) => (
                  <section key={extensionName} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                      {extensionName}
                    </div>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--bg)" }}>
                      {rows.map((row) => {
                        const key = draftKey(row.extensionName, row.settingId);
                        return (
                          <SettingEditor
                            key={key}
                            groupName={row.extensionName}
                            definition={definitionMap.get(key)}
                            value={draft[key] ?? row.value}
                            source={row.source}
                            onChange={(next) => {
                              setDraft((prev) => ({ ...prev, [key]: next }));
                              setSaveMessage(null);
                            }}
                          />
                        );
                      })}
                    </div>
                  </section>
                ))
              )}
            </>
          )}
        </div>
    </>
      );
  if (embed) {
    return panelContent;
  }

  return (
    <div
      className="pi-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Pi extensions"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 900,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        background: "rgba(0,0,0,0.44)",
      }}
    >
      <div
        className="pi-modal-panel pi-modal-panel-large"
        style={{
          width: "min(980px, 100%)",
          maxHeight: "min(820px, calc(100dvh - 36px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 22px 70px rgba(0,0,0,0.34)",
          overflow: "hidden",
        }}
      >
        {panelContent}
      </div>
    </div>
  );
}
