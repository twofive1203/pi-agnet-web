import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createEventBus,
  DefaultPackageManager,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBundledPiResourceLoader } from "./bundled-pi-extensions";

const SETTINGS_FILE_NAME = "settings-extensions.json";

export type ExtensionSettingsFile = Record<string, Record<string, string>>;

export type ExtensionSettingOption = {
  id: string;
  label: string;
};

export type ExtensionSettingDefinition = {
  id: string;
  label: string;
  description?: string;
  defaultValue: string;
  values?: string[];
  options?: ExtensionSettingOption[];
};

export type ExtensionSettingsGroup = {
  name: string;
  settings: ExtensionSettingDefinition[];
};

export type ExtensionSettingValueRow = {
  extensionName: string;
  settingId: string;
  value: string;
  source: "stored" | "default" | "orphan";
};

export type ConfiguredPackageInfo = {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
};

function getSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, SETTINGS_FILE_NAME);
}

/**
 * Load the global extension settings JSON file.
 */
export function readExtensionSettingsFile(agentDir = getAgentDir()): ExtensionSettingsFile {
  const path = getSettingsPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ExtensionSettingsFile = {};
    for (const [extName, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "string") row[key] = value;
        else if (value != null) row[key] = String(value);
      }
      out[extName] = row;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Atomically-ish write the global extension settings JSON file (tab-indented, matching the package).
 */
export function writeExtensionSettingsFile(settings: ExtensionSettingsFile, agentDir = getAgentDir()): void {
  const path = getSettingsPath(agentDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

function isSettingDefinition(value: unknown): value is ExtensionSettingDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.defaultValue === "string";
}

function normalizeRegistration(data: unknown): ExtensionSettingsGroup | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as { name?: unknown; settings?: unknown };
  if (typeof payload.name !== "string" || !payload.name.trim()) return null;
  if (!Array.isArray(payload.settings)) return null;
  const settings: ExtensionSettingDefinition[] = [];
  for (const raw of payload.settings) {
    if (!isSettingDefinition(raw)) continue;
    const options = Array.isArray(raw.options)
      ? raw.options
          .filter((option): option is ExtensionSettingOption => (
            !!option
            && typeof option === "object"
            && typeof (option as ExtensionSettingOption).id === "string"
            && typeof (option as ExtensionSettingOption).label === "string"
          ))
          .map((option) => ({ id: option.id, label: option.label }))
      : undefined;
    const values = Array.isArray(raw.values)
      ? raw.values.filter((value): value is string => typeof value === "string")
      : undefined;
    settings.push({
      id: raw.id,
      label: raw.label,
      description: typeof raw.description === "string" ? raw.description : undefined,
      defaultValue: raw.defaultValue,
      values: values && values.length > 0 ? values : undefined,
      options: options && options.length > 0 ? options : undefined,
    });
  }
  if (settings.length === 0) return null;
  return { name: payload.name.trim(), settings };
}

/**
 * Discover extension-settings registrations by loading enabled packages with a shared event bus.
 */
export async function discoverRegisteredExtensionSettings(cwd: string, agentDir = getAgentDir()): Promise<{
  groups: ExtensionSettingsGroup[];
  packages: ConfiguredPackageInfo[];
  diagnostics: Array<{ type: string; message: string; path?: string }>;
}> {
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const packages = packageManager.listConfiguredPackages().map((item) => ({
    source: item.source,
    scope: item.scope,
    filtered: item.filtered,
    installedPath: item.installedPath,
  }));

  const diagnostics: Array<{ type: string; message: string; path?: string }> = [];
  let extensionPaths: string[] = [];

  // Use the same effective extension set as interactive Web sessions, including
  // bundled defaults and bundled-wins duplicate filtering.
  try {
    const loader = createBundledPiResourceLoader(DefaultResourceLoader, { cwd, agentDir });
    await loader.reload();
    const loaded = loader.getExtensions();
    for (const error of loaded.errors) {
      diagnostics.push({ type: "error", message: error.error, path: error.path });
    }
    extensionPaths = loaded.extensions
      .map((extension) => extension.resolvedPath || extension.path)
      .filter((path): path is string => !!path);
  } catch (error) {
    diagnostics.push({ type: "warning", message: `Resource loader diagnostics unavailable: ${String(error)}` });
  }

  const bus = createEventBus();
  const registry = new Map<string, ExtensionSettingDefinition[]>();
  bus.on("pi-extension-settings:register", (data) => {
    const group = normalizeRegistration(data);
    if (!group) return;
    registry.set(group.name, group.settings);
  });

  try {
    const result = await discoverAndLoadExtensions(extensionPaths, cwd, agentDir, bus);
    for (const error of result.errors) {
      diagnostics.push({ type: "error", message: error.error, path: error.path });
    }
  } catch (error) {
    diagnostics.push({ type: "error", message: `Failed to load extensions for settings discovery: ${String(error)}` });
  } finally {
    bus.clear();
  }

  const groups = Array.from(registry.entries())
    .map(([name, settings]) => ({ name, settings }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { groups, packages, diagnostics };
}

/**
 * Build effective setting rows from registered definitions + stored file values.
 */
export function buildExtensionSettingRows(
  groups: ExtensionSettingsGroup[],
  stored: ExtensionSettingsFile,
): ExtensionSettingValueRow[] {
  const rows: ExtensionSettingValueRow[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const setting of group.settings) {
      const key = `${group.name}::${setting.id}`;
      seen.add(key);
      const storedValue = stored[group.name]?.[setting.id];
      rows.push({
        extensionName: group.name,
        settingId: setting.id,
        value: storedValue ?? setting.defaultValue,
        source: storedValue !== undefined ? "stored" : "default",
      });
    }
  }

  for (const [extensionName, settings] of Object.entries(stored)) {
    for (const [settingId, value] of Object.entries(settings)) {
      const key = `${extensionName}::${settingId}`;
      if (seen.has(key)) continue;
      rows.push({
        extensionName,
        settingId,
        value,
        source: "orphan",
      });
    }
  }

  return rows.sort((a, b) => {
    const ext = a.extensionName.localeCompare(b.extensionName);
    if (ext !== 0) return ext;
    return a.settingId.localeCompare(b.settingId);
  });
}

/**
 * Apply a partial patch of extension settings. Empty string values clear the stored key when `clear` is true.
 */
export function applyExtensionSettingsPatch(
  current: ExtensionSettingsFile,
  patch: Array<{ extensionName: string; settingId: string; value?: string; clear?: boolean }>,
): ExtensionSettingsFile {
  const next: ExtensionSettingsFile = {};
  for (const [extName, settings] of Object.entries(current)) {
    next[extName] = { ...settings };
  }

  for (const item of patch) {
    const extensionName = item.extensionName?.trim();
    const settingId = item.settingId?.trim();
    if (!extensionName || !settingId) continue;

    if (item.clear || item.value === undefined) {
      if (next[extensionName]) {
        delete next[extensionName][settingId];
        if (Object.keys(next[extensionName]).length === 0) delete next[extensionName];
      }
      continue;
    }

    if (!next[extensionName]) next[extensionName] = {};
    next[extensionName][settingId] = item.value;
  }

  return next;
}
