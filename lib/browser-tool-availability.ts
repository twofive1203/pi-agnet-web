/**
 * Model-facing browser tool activation.
 * All eight tools stay registered; only this filter decides what the model sees.
 */

export const BROWSER_TAB_TOOL_NAME = "browser_tabs";

export const BROWSER_DOM_TOOL_NAMES = [
  "browser_snapshot",
  "browser_find",
  "browser_act",
  "browser_wait",
  "browser_screenshot",
] as const;

export const BROWSER_DEBUG_TOOL_NAMES = [
  "browser_console",
  "browser_network",
] as const;

export const BROWSER_TOOL_NAMES = [
  BROWSER_TAB_TOOL_NAME,
  ...BROWSER_DOM_TOOL_NAMES,
  ...BROWSER_DEBUG_TOOL_NAMES,
] as const;

export type BrowserToolName = typeof BROWSER_TOOL_NAMES[number];

export type BrowserToolAvailability = {
  featureEnabled: boolean;
  extensionConnected: boolean;
  hasUsableBinding: boolean;
  hasDebugCapability: boolean;
};

export const EMPTY_BROWSER_TOOL_AVAILABILITY: BrowserToolAvailability = {
  featureEnabled: false,
  extensionConnected: false,
  hasUsableBinding: false,
  hasDebugCapability: false,
};

const BROWSER_TOOL_NAME_SET = new Set<string>(BROWSER_TOOL_NAMES);

export function isBrowserToolName(name: string): name is BrowserToolName {
  return BROWSER_TOOL_NAME_SET.has(name);
}

export function bindingStateIsUsableForTools(state: string): boolean {
  return state === "active_dom" || state === "active_debug" || state === "suspended";
}

export function allowedBrowserToolNames(availability: BrowserToolAvailability): BrowserToolName[] {
  if (!availability.featureEnabled || !availability.extensionConnected) return [];
  if (!availability.hasUsableBinding) return [BROWSER_TAB_TOOL_NAME];
  if (!availability.hasDebugCapability) {
    return [BROWSER_TAB_TOOL_NAME, ...BROWSER_DOM_TOOL_NAMES];
  }
  return [...BROWSER_TOOL_NAMES];
}

export function filterActiveToolsForBrowserAvailability(
  names: readonly string[],
  availability: BrowserToolAvailability,
): string[] {
  const allowed = new Set<string>(allowedBrowserToolNames(availability));
  return names.filter((name) => !isBrowserToolName(name) || allowed.has(name));
}
