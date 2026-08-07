"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "@/components/I18nProvider";
import {
  SettingsActionRow,
  SettingsBadge,
  SettingsButton,
  SettingsInput,
  SettingsNotice,
  SettingsSection,
  SettingsSectionHeader,
  SettingsState,
  SettingsSurface,
  SettingsTab,
  SettingsTabs,
} from "@/components/ui/SettingsPrimitives";
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
  return index < 0 ? values[0] : values[(index + 1) % values.length];
}

function CountPill({ label, count }: { label: string; count: number }) {
  return (
    <SettingsSurface className="resource-count-card">
      <span className="resource-count-label">{label}</span>
      <span className="resource-count-value">{count}</span>
    </SettingsSurface>
  );
}

function Section({ title, count, children, empty }: { title: string; count: number; children: ReactNode; empty?: string }) {
  const { t } = useI18n();
  return (
    <SettingsSection className="resource-section">
      <SettingsSectionHeader title={title} meta={`${count}`} />
      {count === 0 ? <SettingsState title={empty ?? t("panels.extensions.none")} /> : children}
    </SettingsSection>
  );
}

function ListRow({ title, subtitle, badge }: { title: string; subtitle?: string; badge?: string }) {
  return (
    <div className="resource-list-row">
      <div className="resource-list-copy">
        <div className="resource-list-title">{title}</div>
        {subtitle && <div className="resource-list-subtitle">{subtitle}</div>}
      </div>
      {badge && <SettingsBadge>{badge}</SettingsBadge>}
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
  const { t } = useI18n();
  const label = definition?.label ?? definition?.id ?? value;
  const values = definition?.values;
  const options = definition?.options;
  const selectedOptions = value.split(",").map((part) => part.trim()).filter(Boolean);

  return (
    <div className="extension-setting-row">
      <div className="extension-setting-header">
        <div className="resource-list-copy">
          <div className="extension-setting-title">
            {label}
            <code>{groupName}.{definition?.id ?? "?"}</code>
          </div>
          {definition?.description && <div className="resource-list-subtitle">{definition.description}</div>}
        </div>
        <SettingsBadge tone={source === "orphan" ? "warning" : "neutral"}>{source}</SettingsBadge>
      </div>

      {values && values.length > 0 ? (
        <div className="settings-chip-group">
          {values.map((item) => (
            <SettingsButton
              key={item}
              size="sm"
              variant={item === value ? "primary" : "secondary"}
              className="settings-button-mono"
              onClick={() => onChange(item)}
            >
              {JSON.stringify(item).slice(1, -1) || t("panels.extensions.emptyValue")}
            </SettingsButton>
          ))}
          <SettingsButton size="sm" variant="ghost" onClick={() => onChange(cycleValue(value, values))}>{t("panels.extensions.cycle")}</SettingsButton>
        </div>
      ) : options && options.length > 0 ? (
        <div className="extension-setting-options">
          <div className="settings-surface-muted">{t("panels.extensions.multiSelectHint")}</div>
          <div className="settings-chip-group">
            {options.map((option) => {
              const active = selectedOptions.includes(option.id);
              return (
                <SettingsButton
                  key={option.id}
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  onClick={() => onChange((active ? selectedOptions.filter((id) => id !== option.id) : [...selectedOptions, option.id]).join(","))}
                  title={option.id}
                >
                  {option.label}
                </SettingsButton>
              );
            })}
          </div>
          <SettingsInput value={value} onChange={(event) => onChange(event.target.value)} className="settings-control-mono" />
        </div>
      ) : (
        <SettingsInput value={value} onChange={(event) => onChange(event.target.value)} className="settings-control-mono" />
      )}
    </div>
  );
}

/** Modal for inspecting loaded Pi packages/resources and editing extension settings. */
export function ExtensionsConfig({ cwd, onClose, embed }: { cwd: string | null; onClose: () => void; embed?: boolean }) {
  const { t } = useI18n();
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
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!signal?.aborted) setLoadingResources(false);
    }
  }, [effectiveCwd]);

  const applySettingsPayload = useCallback((data: SettingsPayload) => {
    setSettings(data);
    const nextDraft: DraftMap = {};
    for (const row of data.values ?? []) nextDraft[draftKey(row.extensionName, row.settingId)] = row.value;
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
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason));
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
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [embed, onClose]);

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(baseline)]);
    return [...keys].filter((key) => (draft[key] ?? "") !== (baseline[key] ?? ""));
  }, [baseline, draft]);

  const definitionMap = useMemo(() => {
    const map = new Map<string, ExtensionSettingDefinition>();
    for (const group of settings?.groups ?? []) {
      for (const setting of group.settings) map.set(draftKey(group.name, setting.id), setting);
    }
    return map;
  }, [settings?.groups]);

  const filteredValues = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const rows = settings?.values ?? [];
    if (!query) return rows;
    return rows.filter((row) => {
      const definition = definitionMap.get(draftKey(row.extensionName, row.settingId));
      return [row.extensionName, row.settingId, row.value, definition?.label, definition?.description]
        .filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [definitionMap, filter, settings?.values]);

  const groupedFiltered = useMemo(() => {
    const map = new Map<string, ExtensionSettingValueRow[]>();
    for (const row of filteredValues) map.set(row.extensionName, [...(map.get(row.extensionName) ?? []), row]);
    return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [filteredValues]);

  const saveSettings = useCallback(async () => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);
    try {
      const patch = dirtyKeys.map((key) => {
        const [extensionName, settingId] = key.split("::");
        return { extensionName, settingId, value: draft[key] ?? "" };
      });
      const res = await fetch("/api/pi/extension-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: effectiveCwd, patch }),
      });
      const data = (await res.json()) as SettingsPayload & { ok?: boolean };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      applySettingsPayload(data);
      setSaveMessage(t("panels.extensions.savedCount", { count: patch.length }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [applySettingsPayload, dirtyKeys, draft, effectiveCwd, t]);

  const loading = tab === "resources" ? loadingResources : loadingSettings;
  const panelContent = (
    <div className="resource-config-shell">
      <div className="resource-config-header">
        <div className="pi-modal-header-copy">
          <div className="pi-modal-title">{t("panels.extensions.title")}</div>
          <div className="pi-modal-subtitle resource-path">cwd: {shortenPath(effectiveCwd)}</div>
        </div>
        <SettingsTabs aria-label={t("panels.extensions.panelAria")}>
          <SettingsTab active={tab === "resources"} onClick={() => setTab("resources")}>{t("panels.extensions.resources")}</SettingsTab>
          <SettingsTab active={tab === "settings"} onClick={() => setTab("settings")}>{t("panels.extensions.settings")}</SettingsTab>
        </SettingsTabs>
        <SettingsButton size="sm" onClick={() => void (tab === "resources" ? loadResources() : loadSettings())} busy={loading}>{t("panels.extensions.refresh")}</SettingsButton>
        {!embed && <SettingsButton size="sm" variant="ghost" onClick={onClose}>{t("panels.extensions.close")}</SettingsButton>}
      </div>

      {(error || saveMessage) && <SettingsNotice tone={error ? "danger" : "success"} className="resource-config-notice">{error ?? saveMessage}</SettingsNotice>}

      <div className="resource-config-content">
        {loading && tab === "resources" && !resources && <SettingsState kind="loading" title={t("panels.extensions.loadingResources")} />}
        {loading && tab === "settings" && !settings && <SettingsState kind="loading" title={t("panels.extensions.discoveringSettings")} />}

        {tab === "resources" && resources && (
          <>
            <div className="resource-count-grid">
              <CountPill label={t("panels.extensions.packages")} count={resources.packages?.length ?? 0} />
              <CountPill label={t("panels.extensions.title")} count={resources.extensions?.length ?? 0} />
              <CountPill label={t("panels.extensions.tools")} count={resources.tools?.length ?? 0} />
              <CountPill label={t("panels.extensions.commands")} count={resources.commands?.length ?? 0} />
              <CountPill label={t("panels.extensions.skills")} count={resources.skills?.length ?? 0} />
              <CountPill label={t("panels.extensions.prompts")} count={resources.prompts?.length ?? 0} />
              <CountPill label={t("panels.extensions.diagnostics")} count={resources.diagnostics?.length ?? 0} />
            </div>
            {resources.agentDir && <div className="resource-path">agentDir: {shortenPath(resources.agentDir)}</div>}

            <Section title={t("panels.extensions.packages")} count={resources.packages?.length ?? 0} empty={t("panels.extensions.noPackages")}>
              <div className="resource-list">{(resources.packages ?? []).map((pkg) => <ListRow key={`${pkg.scope}:${pkg.source}`} title={pkg.source} subtitle={pkg.installedPath ? shortenPath(pkg.installedPath) : undefined} badge={`${pkg.scope}${pkg.filtered ? ` · ${t("panels.extensions.filtered")}` : ""}`} />)}</div>
            </Section>
            <Section title={t("panels.extensions.loadedExtensions")} count={resources.extensions?.length ?? 0}>
              <div className="resource-list">{(resources.extensions ?? []).map((extension) => <ListRow key={extension.resolvedPath || extension.path} title={shortenPath(extension.resolvedPath || extension.path)} subtitle={extension.path !== extension.resolvedPath ? extension.path : undefined} badge={extension.sourceInfo?.scope || extension.sourceInfo?.source || "ext"} />)}</div>
            </Section>
            <Section title={t("panels.extensions.tools")} count={resources.tools?.length ?? 0}><div className="resource-list">{(resources.tools ?? []).map((tool) => <ListRow key={tool.name} title={tool.name} subtitle={tool.description} />)}</div></Section>
            <Section title={t("panels.extensions.extensionCommands")} count={resources.commands?.length ?? 0}><div className="resource-list">{(resources.commands ?? []).map((command) => <ListRow key={command.name} title={`/${command.name}`} subtitle={command.description} />)}</div></Section>
            <Section title={t("panels.extensions.skills")} count={resources.skills?.length ?? 0}><div className="resource-list">{(resources.skills ?? []).map((skill) => <ListRow key={skill.name} title={skill.name} subtitle={skill.description} />)}</div></Section>
            <Section title={t("panels.extensions.prompts")} count={resources.prompts?.length ?? 0}><div className="resource-list">{(resources.prompts ?? []).map((prompt) => <ListRow key={prompt.name} title={`/${prompt.name}`} subtitle={prompt.description} />)}</div></Section>
            <Section title={t("panels.extensions.diagnostics")} count={resources.diagnostics?.length ?? 0} empty={t("panels.extensions.noDiagnostics")}>
              <div className="resource-list">{(resources.diagnostics ?? []).map((item, index) => <ListRow key={`${item.type}-${index}-${item.message.slice(0, 24)}`} title={item.message} subtitle={item.path} badge={item.type} />)}</div>
            </Section>
          </>
        )}

        {tab === "settings" && settings && (
          <>
            <SettingsActionRow className="resource-filter-row">
              <SettingsInput type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("panels.extensions.filterPlaceholder")} />
              <SettingsButton variant="primary" onClick={() => void saveSettings()} disabled={dirtyKeys.length === 0} busy={saving}>
                {saving ? t("panels.extensions.saving") : dirtyKeys.length > 0 ? t("panels.extensions.saveCount", { count: dirtyKeys.length }) : t("panels.extensions.saved")}
              </SettingsButton>
            </SettingsActionRow>
            <div className="resource-path">{settings.settingsPath ? shortenPath(settings.settingsPath) : "settings-extensions.json"} · {t("panels.extensions.groupsSummary", { groups: settings.groups?.length ?? 0, settings: settings.values?.length ?? 0 })}</div>

            {(settings.diagnostics?.length ?? 0) > 0 && (
              <Section title={t("panels.extensions.discoveryDiagnostics")} count={settings.diagnostics?.length ?? 0}>
                <div className="resource-list">{(settings.diagnostics ?? []).map((item, index) => <ListRow key={`diag-${index}`} title={item.message} subtitle={item.path} badge={item.type} />)}</div>
              </Section>
            )}

            {(settings.values?.length ?? 0) === 0 ? (
              <SettingsState title={t("panels.extensions.noSettingsRegistered")} description={t("panels.extensions.noSettingsRegisteredHint")} />
            ) : groupedFiltered.length === 0 ? (
              <SettingsState title={t("panels.extensions.noSettingsMatch")} />
            ) : groupedFiltered.map(([extensionName, rows]) => (
              <SettingsSection key={extensionName} className="extension-settings-group">
                <SettingsSectionHeader title={extensionName} meta={t("panels.extensions.settingsCount", { count: rows.length })} />
                <div className="resource-list">
                  {rows.map((row) => {
                    const key = draftKey(row.extensionName, row.settingId);
                    return <SettingEditor key={key} groupName={row.extensionName} definition={definitionMap.get(key)} value={draft[key] ?? row.value} source={row.source} onChange={(next) => { setDraft((prev) => ({ ...prev, [key]: next })); setSaveMessage(null); }} />;
                  })}
                </div>
              </SettingsSection>
            ))}
          </>
        )}
      </div>
    </div>
  );

  if (embed) return panelContent;
  return (
    <div className="pi-modal-overlay" role="dialog" aria-modal="true" aria-label={t("panels.extensions.dialogAria")} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pi-modal-panel pi-modal-panel-large resource-config-panel">{panelContent}</div>
    </div>
  );
}
