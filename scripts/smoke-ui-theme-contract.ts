import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isThemePreference,
  resolveThemePreference,
  THEME_META,
  THEME_MODE_BY_PREFERENCE,
  THEME_PREFERENCES,
  THEME_SKIN_PREFERENCES,
  THEME_STORAGE_KEY,
  type ThemeMetadata,
} from "../lib/theme";
import {
  buildWorkbenchSkinBootFragment,
  clampWorkbenchGlass,
  isWorkbenchGradientId,
  isWorkbenchWallpaperDataUrl,
  parseWorkbenchGlass,
  resolveWorkbenchAtmosphereTokens,
  resolveWorkbenchGlassTokens,
  WORKBENCH_GRADIENT_IDS,
  WORKBENCH_GRADIENT_META,
  WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY,
  WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY,
  WORKBENCH_SKIN_GLASS_STORAGE_KEY,
  WORKBENCH_SKIN_GRADIENT_STORAGE_KEY,
  WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY,
  WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY,
} from "../lib/theme-skin";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_THEME_COUNT = 14;

const REQUIRED_SEMANTIC_TOKENS = [
  "surface-app",
  "surface-panel",
  "surface-raised",
  "surface-subtle",
  "surface-hover",
  "surface-selected",
  "surface-overlay",
  "border-default",
  "border-subtle",
  "border-strong",
  "border-focus",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "text-inverse",
  "text-accent",
  "accent-primary",
  "accent-hover",
  "accent-soft",
  "accent-border",
  "status-success-foreground",
  "status-success-soft",
  "status-success-border",
  "status-warning-foreground",
  "status-warning-soft",
  "status-warning-border",
  "status-danger-foreground",
  "status-danger-soft",
  "status-danger-border",
  "status-info-foreground",
  "status-info-soft",
  "status-info-border",
  "radius-sm",
  "radius-control",
  "radius-panel",
  "radius-popover",
  "radius-pill",
  "control-height-sm",
  "control-height-md",
  "control-height-lg",
  "shadow-sm",
  "shadow-panel",
  "shadow-popover",
  "focus-ring-color",
  "focus-ring-width",
  "focus-ring-offset",
  "motion-duration-fast",
  "motion-duration-base",
  "motion-duration-slow",
  "motion-duration-theme",
  "motion-ease-standard",
  "motion-ease-emphasized",
] as const;

const REQUIRED_LAYER_TOKENS = [
  "z-workbench-card",
  "z-sidebar-backdrop",
  "z-sidebar-drawer",
  "z-inspector-drawer",
  "z-automation-drawer",
  "z-top-portal",
  "z-terminal-fullscreen",
  "z-context-menu",
  "z-dialog",
] as const;

const REQUIRED_STABLE_CLASSES = [
  ".app-shell-root",
  ".top-context",
  ".app-resource-cluster",
  ".app-resource-tps",
  ".session-resource-popover",
  ".assistant-tps-badge",
  ".app-top-more-portal",
  ".top-more-menu",
  ".insp-tabs",
  ".chat-input-dropdown-panel",
  ".pi-modal-overlay",
  ".extension-toast-stack",
  ".usage-modal-panel",
  ".usage-token-chart",
  ".usage-token-bucket",
  ".usage-token-tooltip",
  ".usage-token-legend",
] as const;

const REQUIRED_MODAL_WIDTH_CONTRACTS = [
  ".pi-modal-panel.resource-split-panel {",
  ".pi-modal-panel.models-config-panel {",
  ".pi-modal-panel.settings-modal-panel {",
] as const;

const REQUIRED_COMPATIBILITY_ALIASES = {
  bg: "surface-app",
  "bg-panel": "surface-panel",
  "bg-hover": "surface-hover",
  "bg-selected": "surface-selected",
  "bg-subtle": "surface-subtle",
  border: "border-default",
  text: "text-primary",
  "text-muted": "text-secondary",
  "text-dim": "text-tertiary",
  accent: "accent-primary",
  "user-bg": "surface-user-message",
  "assistant-bg": "surface-assistant-message",
  "tool-bg": "surface-tool-message",
  "bg-soft": "surface-app",
  "bg-card": "surface-panel",
  line: "border-default",
  "line-soft": "border-subtle",
  "text-2": "text-secondary",
  "text-3": "text-tertiary",
  ok: "status-success-foreground",
  warn: "status-warning-foreground",
  danger: "status-danger-foreground",
  info: "status-info-foreground",
  radius: "radius-popover",
  "radius-lg": "radius-panel",
} as const;

interface ThemeSources {
  css: string;
  layout: string;
  picker: string;
  hook: string;
  workbenchSkinHook: string;
  workbenchSkinLib: string;
  shell: string;
  sessionResource: string;
  messageView: string;
  chatInput: string;
  appDialog: string;
  extensionDialog: string;
  directoryPicker: string;
}

type RuntimeThemeMetadata = Partial<ThemeMetadata>;
type RuntimeThemeMeta = Record<string, RuntimeThemeMetadata | undefined>;

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function hasTokenDeclaration(css: string, token: string): boolean {
  return css.includes(`--${token}:`);
}

function collectContractProblems(
  sources: ThemeSources,
  themeMeta: RuntimeThemeMeta,
): string[] {
  const problems: string[] = [];
  const preferenceSet = new Set<string>(THEME_PREFERENCES);

  if (THEME_PREFERENCES.length !== EXPECTED_THEME_COUNT) {
    problems.push(`theme registry: expected ${EXPECTED_THEME_COUNT} preferences, found ${THEME_PREFERENCES.length}`);
  }
  if (preferenceSet.size !== THEME_PREFERENCES.length) {
    problems.push("theme registry: duplicate preference ids");
  }

  for (const preference of THEME_PREFERENCES) {
    const metadata = themeMeta[preference];
    if (!metadata) {
      problems.push(`theme metadata: missing ${preference}`);
      continue;
    }
    if (metadata.mode !== "light" && metadata.mode !== "dark") {
      problems.push(`theme metadata: ${preference} has invalid mode`);
    }
    if (typeof metadata.skin !== "boolean") {
      problems.push(`theme metadata: ${preference} has invalid skin flag`);
    }
    if (typeof metadata.labelKey !== "string" || !metadata.labelKey.startsWith("app.theme")) {
      problems.push(`theme metadata: ${preference} has invalid label key`);
    }
    if (!Array.isArray(metadata.preview) || metadata.preview.length !== 3) {
      problems.push(`theme metadata: ${preference} must define three preview colors`);
    }
  }

  for (const preference of Object.keys(themeMeta)) {
    if (!preferenceSet.has(preference)) {
      problems.push(`theme metadata: unregistered entry ${preference}`);
    }
  }

  const metadataSkins = THEME_PREFERENCES.filter((preference) => themeMeta[preference]?.skin);
  if (metadataSkins.join("|") !== THEME_SKIN_PREFERENCES.join("|")) {
    problems.push("theme registry: derived skin list does not match metadata");
  }

  for (const skin of THEME_SKIN_PREFERENCES) {
    if (!sources.css.includes(`[data-theme-skin="${skin}"]`)) {
      problems.push(`theme css: missing skin ${skin}`);
    }
  }

  for (const token of REQUIRED_SEMANTIC_TOKENS) {
    if (!hasTokenDeclaration(sources.css, token)) {
      problems.push(`theme css: missing semantic token --${token}`);
    }
  }

  for (const token of REQUIRED_LAYER_TOKENS) {
    if (!hasTokenDeclaration(sources.css, token)) {
      problems.push(`portal layers: missing --${token}`);
    }
  }

  for (const stableClass of REQUIRED_STABLE_CLASSES) {
    if (!sources.css.includes(stableClass)) {
      problems.push(`stable class: missing ${stableClass}`);
    }
  }

  // Usage Token chart contract: stacked series + reduced-motion, no legacy daily cost bar.
  if (sources.css.includes(".usage-daily-bar-fill")) {
    problems.push("usage chart: legacy .usage-daily-bar-fill must be removed");
  }
  if (!sources.css.includes("--usage-series-input")
    || !sources.css.includes("--usage-series-output")
    || !sources.css.includes("--usage-series-cache-read")
    || !sources.css.includes("--usage-series-cache-write")) {
    problems.push("usage chart: missing series color variables");
  }
  if (!sources.css.includes(".usage-token-bucket:focus-visible")
    || !sources.css.includes("@media (max-width: 640px)")
    || !sources.css.includes(".usage-token-seg")) {
    problems.push("usage chart: focus/responsive/segment contracts incomplete");
  }

  for (const modalWidthContract of REQUIRED_MODAL_WIDTH_CONTRACTS) {
    if (!sources.css.includes(modalWidthContract)) {
      problems.push(`modal width: missing higher-specificity contract ${modalWidthContract}`);
    }
  }

  for (const [legacy, semantic] of Object.entries(REQUIRED_COMPATIBILITY_ALIASES)) {
    if (!sources.css.includes(`--${legacy}: var(--${semantic});`)) {
      problems.push(`theme css: compatibility alias --${legacy} must map to --${semantic}`);
    }
  }

  if (!sources.layout.includes("THEME_MODE_BY_PREFERENCE") || !sources.layout.includes("THEME_SKIN_PREFERENCES")) {
    problems.push("theme boot: layout must derive modes and skins from the registry");
  }
  if (!sources.layout.includes("THEME_STORAGE_KEY") || !sources.layout.includes("delete r.dataset.themeSkin")) {
    problems.push("theme boot: storage key or stale skin cleanup is missing");
  }
  if (!sources.picker.includes("THEME_PREFERENCES.map") || !sources.picker.includes("THEME_META[id]")) {
    problems.push("theme picker: options must derive from the registry metadata");
  }
  if (!sources.hook.includes("THEME_STORAGE_KEY") || !sources.hook.includes("isThemeSkinPreference")) {
    problems.push("theme hook: storage key or skin derivation is not shared");
  }
  if (!sources.layout.includes("buildWorkbenchSkinBootFragment")) {
    problems.push("workbench skin boot: layout must restore wallpaper/glass before paint");
  }
  if (!sources.workbenchSkinLib.includes("WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_SKIN_GLASS_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_SKIN_GRADIENT_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY")
    || !sources.workbenchSkinLib.includes("WORKBENCH_GRADIENT_META")
    || !sources.workbenchSkinLib.includes("applyWorkbenchSkinToDocument")
    || !sources.workbenchSkinLib.includes("buildWorkbenchSkinBootFragment")) {
    problems.push("workbench skin lib: storage keys, gradients, or apply/boot helpers are missing");
  }
  if (!sources.workbenchSkinHook.includes("useWorkbenchSkin")
    || !sources.workbenchSkinHook.includes("setWallpaperFile")
    || !sources.workbenchSkinHook.includes("setGradientId")
    || !sources.workbenchSkinHook.includes("setBgBlur")
    || !sources.workbenchSkinHook.includes("setVignette")
    || !sources.workbenchSkinHook.includes("setFrostClarity")
    || !sources.workbenchSkinHook.includes("resetWorkbenchSkin")) {
    problems.push("workbench skin hook: wallpaper/gradient/atmosphere API surface is incomplete");
  }
  if (!sources.picker.includes("useWorkbenchSkin")
    || !sources.picker.includes("theme-picker-workbench")
    || !sources.picker.includes("theme-picker-gradient-grid")
    || !sources.picker.includes("theme-picker-glass-slider")
    || !sources.picker.includes("pickingFileRef")
    || !sources.picker.includes("setBgBlur")
    || !sources.picker.includes("setVignette")
    || !sources.picker.includes("setFrostClarity")) {
    problems.push("theme picker: workbench wallpaper/gradient/atmosphere controls are missing");
  }
  if (!sources.css.includes("--skin-wallpaper-image")
    || !sources.css.includes("--skin-bg-image")
    || !sources.css.includes("--skin-panel-alpha")
    || !sources.css.includes("--skin-bg-blur")
    || !sources.css.includes("--skin-vignette")
    || !sources.css.includes('data-wallpaper="image"')
    || !sources.css.includes('data-wallpaper="gradient"')
    || !sources.css.includes('html[data-glass="on"]')
    || !sources.css.includes("backdrop-filter: blur(var(--skin-panel-blur, var(--skin-blur)))")
    || !sources.css.includes("filter: blur(var(--skin-bg-blur))")) {
    problems.push("workbench skin css: wallpaper/gradient/atmosphere token layer is incomplete");
  }
  if (!sources.css.includes(".theme-picker-workbench")
    || !sources.css.includes(".theme-picker-gradient-grid")
    || !sources.css.includes(".theme-picker-glass-slider")) {
    problems.push("workbench skin css: Theme Picker workbench controls are missing");
  }
  for (const gradientId of WORKBENCH_GRADIENT_IDS) {
    const meta = WORKBENCH_GRADIENT_META[gradientId];
    if (!meta?.css.includes("gradient") || meta.preview.length !== 3) {
      problems.push(`workbench gradient: ${gradientId} metadata incomplete`);
    }
  }
  if (!sources.hook.includes("prefers-reduced-motion: reduce") || !sources.css.includes("@media (prefers-reduced-motion: reduce)")) {
    problems.push("theme motion: reduced-motion contract is missing");
  }
  if (!sources.css.includes("animation-duration: 0.001ms !important")
    || !sources.css.includes("transition-duration: 0.001ms !important")
    || !sources.css.includes("animation-iteration-count: 1 !important")) {
    problems.push("ui motion: global reduced-motion gate is missing");
  }
  if (!sources.css.includes("@media (hover: none), (pointer: coarse)")
    || !sources.css.includes(".theme-picker-option,")
    || !sources.css.includes(".pi-modal-close")) {
    problems.push("touch input: coarse-pointer target contract is missing");
  }
  for (const inset of ["top", "right", "bottom", "left"]) {
    if (!sources.css.includes(`env(safe-area-inset-${inset})`)) {
      problems.push(`mobile safe area: missing ${inset} inset`);
    }
  }

  const breakpointContracts = [
    "@media (min-width: 960px)",
    "@media (min-width: 641px) and (max-width: 959px)",
    "@media (max-width: 640px)",
  ];
  for (const contract of breakpointContracts) {
    if (!sources.css.includes(contract)) problems.push(`workbench layout: missing ${contract}`);
  }
  if (sources.css.includes("@media (max-width: 860px)")) {
    problems.push("workbench layout: retired 860px breakpoint must not return");
  }
  if (!sources.css.includes("--workbench-gutter: clamp(0px, calc((100vw - 960px) * 0.25), 12px)")) {
    problems.push("workbench layout: responsive inline gutter contract is missing");
  }
  if (!sources.shell.includes("DESKTOP_SIDEBAR_WIDTH + MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH")
    || !sources.shell.includes("getWorkbenchInlineChromeWidth")) {
    problems.push("workbench layout: TypeScript inline threshold or gutter clamp is missing");
  }
  if (!sources.shell.includes('const RIGHT_PANEL_WIDTH_STORAGE_KEY = "pi-web-right-panel-width-v2"')) {
    problems.push("workbench layout: right panel width persistence key changed");
  }
  if (!sources.shell.includes("function isMobileLayoutViewport")
    || !sources.shell.includes("if (!desktopMedia.matches) {")
    || !sources.shell.includes("if (isMobileLayoutViewport()) setSidebarOpen(false);")) {
    problems.push("workbench layout: mobile drawers must start closed and open mutually exclusively");
  }
  if (!sources.shell.includes('className={activeTopPanel === "more" ? "app-top-more-portal" : "app-top-aux-panel"}')) {
    problems.push("top portal: overflow menu shell must stay separate from themed auxiliary panels");
  }
  if (!/\.app-top-more-portal\s*\{[^}]*position:\s*fixed;[^}]*background:\s*transparent;/.test(sources.css)) {
    problems.push("top portal: overflow menu shell must remain fixed and transparent");
  }
  if (!sources.shell.includes("handleInspectorTabKeyDown")
    || !sources.shell.includes('event.key === "Home"')
    || !sources.shell.includes('role="tabpanel"')
    || !sources.shell.includes("tabIndex={rightPanelMode ===")
    || !sources.shell.includes("inert={!sidebarOpen}")
    || !sources.shell.includes("inert={!rightPanelOpen}")) {
    problems.push("keyboard navigation: Inspector roving-tab contract is missing");
  }
  if (!sources.picker.includes('document.addEventListener("focusin"')
    || !sources.picker.includes("window.visualViewport?.addEventListener")) {
    problems.push("portal focus: Theme Picker focus/viewport contract is missing");
  }
  if (!sources.sessionResource.includes('createPortal(')
    || !sources.sessionResource.includes('role="dialog"')
    || !sources.sessionResource.includes('event.key === "Escape"')
    || !sources.sessionResource.includes("triggerRef.current?.focus()")
    || !sources.sessionResource.includes("window.visualViewport?.addEventListener")) {
    problems.push("portal focus: Session Resource popover focus/viewport contract is missing");
  }
  if (!sources.messageView.includes("is-estimate")
    || !sources.messageView.includes("estimatedTps")
    || !sources.messageView.includes('is-${tier}')
    || !sources.css.includes(".assistant-tps-badge.is-fast")
    || !sources.css.includes(".assistant-tps-badge.is-steady")
    || !sources.css.includes(".assistant-tps-badge.is-moderate")
    || !sources.css.includes(".assistant-tps-badge.is-slow")) {
    problems.push("session performance: live TPS must keep estimate label and speed-tier classes");
  }
  if (!sources.shell.includes("SessionResourcePanel")
    || !sources.sessionResource.includes("sessionNoAccurateSamples")
    || !sources.sessionResource.includes("sessionMixedModelsNote")) {
    problems.push("session performance: resource panel empty/mixed-model contract is missing");
  }
  if (!sources.chatInput.includes('aria-haspopup="listbox"')
    || !sources.chatInput.includes('role="listbox"')
    || !sources.chatInput.includes('role="option"')
    || !sources.chatInput.includes("handleDropdownOptionKeyDown")
    || !sources.chatInput.includes('event.key !== "Escape"')) {
    problems.push("keyboard navigation: Composer dropdown contract is missing");
  }
  if (!sources.appDialog.includes('aria-modal="true"')
    || !sources.appDialog.includes("previouslyFocusedRef")
    || !sources.appDialog.includes("button:not(:disabled)")) {
    problems.push("dialog focus: application dialog trap/restore contract is missing");
  }
  if (!sources.extensionDialog.includes('aria-modal="true"')
    || !sources.extensionDialog.includes('role="listbox"')
    || !sources.extensionDialog.includes("previouslyFocusedRef")
    || !sources.extensionDialog.includes("button:not(:disabled)")) {
    problems.push("dialog focus: extension dialog keyboard contract is missing");
  }
  if (!sources.css.includes(".directory-picker-layout")
    || !sources.css.includes(".directory-picker-shortcuts")
    || !sources.css.includes(".directory-picker-breadcrumbs")
    || !sources.css.includes(".directory-picker-entry.is-selected")
    || !sources.css.includes(".directory-picker-footer-path")) {
    problems.push("directory picker: stable layout classes are missing");
  }
  if (!sources.directoryPicker.includes("createPortal")
    || !sources.directoryPicker.includes("previouslyFocusedRef")
    || !sources.directoryPicker.includes('role="listbox"')
    || !sources.directoryPicker.includes("aria-selected")
    || !sources.directoryPicker.includes('event.key === "Escape"')) {
    problems.push("directory picker: portal/focus contract is missing");
  }

  return problems;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertProblem(problems: string[], expected: string): void {
  assert(
    problems.some((problem) => problem.includes(expected)),
    `self-test expected a problem containing ${JSON.stringify(expected)}, got ${JSON.stringify(problems)}`,
  );
}

const sources: ThemeSources = {
  css: readSource("app/globals.css"),
  layout: readSource("app/layout.tsx"),
  picker: readSource("components/ThemePicker.tsx"),
  hook: readSource("hooks/useTheme.ts"),
  workbenchSkinHook: readSource("hooks/useWorkbenchSkin.ts"),
  workbenchSkinLib: readSource("lib/theme-skin.ts"),
  shell: readSource("components/AppShell.tsx"),
  sessionResource: readSource("components/SessionResourcePanel.tsx"),
  messageView: readSource("components/MessageView.tsx"),
  chatInput: readSource("components/ChatInput.tsx"),
  appDialog: readSource("components/AppDialogProvider.tsx"),
  extensionDialog: readSource("components/ExtensionDialogHost.tsx"),
  directoryPicker: readSource("components/sidebar/DirectoryPickerDialog.tsx"),
};
const runtimeMeta = THEME_META as unknown as RuntimeThemeMeta;

const problems = collectContractProblems(sources, runtimeMeta);
if (problems.length > 0) {
  for (const problem of problems) console.error(`THEME_CONTRACT_FAIL ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`THEME_CONTRACT_OK themes=${THEME_PREFERENCES.length} skins=${THEME_SKIN_PREFERENCES.length} tokens=${REQUIRED_SEMANTIC_TOKENS.length}`);
}

// Negative checks keep diagnostics useful when the contract checker itself changes.
const metadataWithoutDracula = { ...runtimeMeta };
delete metadataWithoutDracula.dracula;
assertProblem(collectContractProblems(sources, metadataWithoutDracula), "theme metadata: missing dracula");

const cssWithoutPaper = sources.css.replaceAll(
  '[data-theme-skin="paper"]',
  '[data-theme-skin="missing-paper"]',
);
assertProblem(collectContractProblems({ ...sources, css: cssWithoutPaper }, runtimeMeta), "theme css: missing skin paper");

const cssWithoutSurfaceApp = sources.css.replace("--surface-app:", "--missing-surface-app:");
assertProblem(
  collectContractProblems({ ...sources, css: cssWithoutSurfaceApp }, runtimeMeta),
  "theme css: missing semantic token --surface-app",
);

const cssWithoutReducedMotionGate = sources.css.replaceAll(
  "animation-duration: 0.001ms !important",
  "animation-duration: var(--motion-duration-base)",
);
assertProblem(
  collectContractProblems({ ...sources, css: cssWithoutReducedMotionGate }, runtimeMeta),
  "ui motion: global reduced-motion gate is missing",
);

const chatInputWithoutListbox = sources.chatInput.replaceAll('role="listbox"', 'role="menu"');
assertProblem(
  collectContractProblems({ ...sources, chatInput: chatInputWithoutListbox }, runtimeMeta),
  "keyboard navigation: Composer dropdown contract is missing",
);

const shellWithoutInspectorKeyboard = sources.shell.replaceAll(
  "handleInspectorTabKeyDown",
  "missingInspectorTabKeyDown",
);
assertProblem(
  collectContractProblems({ ...sources, shell: shellWithoutInspectorKeyboard }, runtimeMeta),
  "keyboard navigation: Inspector roving-tab contract is missing",
);

const cssWithoutNarrowWorkbench = sources.css.replaceAll(
  "@media (min-width: 641px) and (max-width: 959px)",
  "@media (min-width: 700px) and (max-width: 900px)",
);
assertProblem(
  collectContractProblems({ ...sources, css: cssWithoutNarrowWorkbench }, runtimeMeta),
  "workbench layout: missing @media (min-width: 641px) and (max-width: 959px)",
);

assert(THEME_STORAGE_KEY === "pi-theme", "theme storage key must remain backward compatible");
assert(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY === "pi-theme-wallpaper", "wallpaper storage key drift");
assert(WORKBENCH_SKIN_GLASS_STORAGE_KEY === "pi-theme-glass", "glass storage key drift");
assert(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY === "pi-theme-gradient", "gradient storage key drift");
assert(WORKBENCH_SKIN_BG_BLUR_STORAGE_KEY === "pi-theme-bg-blur", "bg blur storage key drift");
assert(WORKBENCH_SKIN_VIGNETTE_STORAGE_KEY === "pi-theme-vignette", "vignette storage key drift");
assert(WORKBENCH_SKIN_FROST_CLARITY_STORAGE_KEY === "pi-theme-frost-clarity", "frost clarity storage key drift");
assert(!isThemePreference("retired-theme"), "invalid theme preference must be rejected");
assert(resolveThemePreference("system", false) === "light", "system light resolution");
assert(resolveThemePreference("system", true) === "dark", "system dark resolution");
assert(clampWorkbenchGlass(140) === 100, "glass clamp upper bound");
assert(clampWorkbenchGlass(-3) === 0, "glass clamp lower bound");
assert(parseWorkbenchGlass("52") === 52, "glass parse");
assert(parseWorkbenchGlass("nope") === 0, "invalid glass falls back");
assert(isWorkbenchWallpaperDataUrl("data:image/jpeg;base64,abc="), "valid wallpaper data url");
assert(!isWorkbenchWallpaperDataUrl("https://example.com/a.jpg"), "remote wallpaper must be rejected");
assert(isWorkbenchGradientId("dusk-aurora"), "known gradient id");
assert(!isWorkbenchGradientId("not-a-gradient"), "unknown gradient id rejected");
assert(resolveWorkbenchGlassTokens(0).panelAlpha === 1, "glass 0 keeps opaque panels");
assert(resolveWorkbenchGlassTokens(100).panelAlpha === 0, "glass 100 is fully transparent");
assert(resolveWorkbenchGlassTokens(50).panelAlpha === 0.5, "glass mid is half transparent");
assert(resolveWorkbenchGlassTokens(100).blurPx === 28, "glass 100 max panel blur");
assert(resolveWorkbenchGlassTokens(100, 50).blurPx === 14, "frost clarity 50 halves panel blur");
assert(resolveWorkbenchGlassTokens(100, 100).blurPx === 0, "frost clarity 100 removes panel blur");
assert(resolveWorkbenchGlassTokens(0, 100).blurPx === 0, "glass 0 stays blur-free regardless of clarity");
assert(resolveWorkbenchAtmosphereTokens(100, 0).bgBlurPx === 30, "bg blur max");
assert(resolveWorkbenchAtmosphereTokens(0, 100).vignette === 0.78, "vignette max");
assert(buildWorkbenchSkinBootFragment().includes(WORKBENCH_SKIN_WALLPAPER_STORAGE_KEY), "boot fragment must read wallpaper key");
assert(buildWorkbenchSkinBootFragment().includes(WORKBENCH_SKIN_GRADIENT_STORAGE_KEY), "boot fragment must read gradient key");
assert(buildWorkbenchSkinBootFragment().includes("--skin-bg-blur"), "boot fragment must set bg blur");
assert(buildWorkbenchSkinBootFragment().includes("--skin-vignette"), "boot fragment must set vignette");
for (const preference of THEME_PREFERENCES) {
  assert(
    THEME_MODE_BY_PREFERENCE[preference] === THEME_META[preference].mode,
    `mode map drift for ${preference}`,
  );
}
