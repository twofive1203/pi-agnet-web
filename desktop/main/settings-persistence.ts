/**
 * Desktop settings file IO helpers (U7).
 *
 * Injectable fs for tests. Never persists tokens/PIDs/prompts.
 */

import {
  assertDesktopSettingsSafe,
  createDefaultDesktopSettings,
  normalizeDesktopSettings,
  parseDesktopSettingsJson,
  serializeDesktopSettings,
  type DesktopPetSettings,
} from "./settings-store";

export type SettingsFs = {
  readFile(path: string, encoding: "utf8"): string;
  writeFile(path: string, data: string, encoding: "utf8"): void;
  mkdirp(dir: string): void;
  exists(path: string): boolean;
};

export const DESKTOP_SETTINGS_FILENAME = "desktop-pet-settings.json";

export function settingsFilePath(userDataDir: string): string {
  const base = userDataDir.replace(/[\\/]+$/, "");
  return `${base}/${DESKTOP_SETTINGS_FILENAME}`.replace(/\\/g, "/");
}

export function loadDesktopSettingsFile(
  userDataDir: string,
  fs: SettingsFs,
): DesktopPetSettings {
  const filePath = settingsFilePath(userDataDir);
  try {
    if (!fs.exists(filePath)) return createDefaultDesktopSettings();
    const text = fs.readFile(filePath, "utf8");
    const settings = parseDesktopSettingsJson(text);
    assertDesktopSettingsSafe(settings);
    return settings;
  } catch {
    return createDefaultDesktopSettings();
  }
}

export function saveDesktopSettingsFile(
  userDataDir: string,
  settings: DesktopPetSettings,
  fs: SettingsFs,
): void {
  const normalized = normalizeDesktopSettings(settings);
  assertDesktopSettingsSafe(normalized);
  const filePath = settingsFilePath(userDataDir);
  const dir = filePath.replace(/\/[^/]+$/, "");
  fs.mkdirp(dir);
  fs.writeFile(filePath, serializeDesktopSettings(normalized), "utf8");
}
