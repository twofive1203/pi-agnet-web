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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_THEME_COUNT = 11;

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
  ".observe-bar",
  ".insp-tabs",
  ".chat-input-dropdown-panel",
  ".pi-modal-overlay",
  ".extension-toast-stack",
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
  shell: string;
  chatInput: string;
  appDialog: string;
  extensionDialog: string;
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
  shell: readSource("components/AppShell.tsx"),
  chatInput: readSource("components/ChatInput.tsx"),
  appDialog: readSource("components/AppDialogProvider.tsx"),
  extensionDialog: readSource("components/ExtensionDialogHost.tsx"),
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
assert(!isThemePreference("retired-theme"), "invalid theme preference must be rejected");
assert(resolveThemePreference("system", false) === "light", "system light resolution");
assert(resolveThemePreference("system", true) === "dark", "system dark resolution");
for (const preference of THEME_PREFERENCES) {
  assert(
    THEME_MODE_BY_PREFERENCE[preference] === THEME_META[preference].mode,
    `mode map drift for ${preference}`,
  );
}
