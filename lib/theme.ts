export const THEME_STORAGE_KEY = "pi-theme";

export const THEME_PREFERENCES = [
  "system",
  "light",
  "dark",
  "paper",
  "graphite",
  "ocean",
  "forest",
  "warm-paper",
  "sage",
  "mist-blue",
  "twilight",
  "night",
  "daisy-dark",
  "dracula",
] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ThemeSkinPreference = Exclude<ThemePreference, "system" | "light" | "dark">;
export type ResolvedTheme = "light" | "dark";
export type ThemePreview = readonly [string, string, string];

export interface ThemeMetadata {
  mode: ResolvedTheme;
  skin: boolean;
  labelKey: `app.${string}`;
  preview: ThemePreview;
}

export const THEME_META = {
  system: {
    mode: "light",
    skin: false,
    labelKey: "app.themeSystem",
    preview: ["#f5f5f5", "#242424", "#60a5fa"],
  },
  light: {
    mode: "light",
    skin: false,
    labelKey: "app.themeLight",
    preview: ["#f4f5f8", "#ffffff", "#6358e6"],
  },
  dark: {
    mode: "dark",
    skin: false,
    labelKey: "app.themeDark",
    preview: ["#0e0f13", "#14161d", "#7c6af5"],
  },
  paper: {
    mode: "light",
    skin: true,
    labelKey: "app.themePaper",
    preview: ["#f7f6f2", "#ddd9cf", "#306b5b"],
  },
  graphite: {
    mode: "dark",
    skin: true,
    labelKey: "app.themeGraphite",
    preview: ["#171918", "#333834", "#a8c7b5"],
  },
  ocean: {
    mode: "light",
    skin: true,
    labelKey: "app.themeOcean",
    preview: ["#f3f8f9", "#d3e2e6", "#146c7c"],
  },
  forest: {
    mode: "dark",
    skin: true,
    labelKey: "app.themeForest",
    preview: ["#17201b", "#334239", "#9bc5a2"],
  },
  "warm-paper": {
    mode: "light",
    skin: true,
    labelKey: "app.themeWarmPaper",
    preview: ["#f0eadc", "#f8f3e7", "#b45309"],
  },
  sage: {
    mode: "light",
    skin: true,
    labelKey: "app.themeSage",
    preview: ["#e6ede2", "#f0f5ec", "#2f7d5b"],
  },
  "mist-blue": {
    mode: "light",
    skin: true,
    labelKey: "app.themeMistBlue",
    preview: ["#e9eef4", "#f2f6fa", "#3a6ea5"],
  },
  twilight: {
    mode: "dark",
    skin: true,
    labelKey: "app.themeTwilight",
    preview: ["#17212b", "#303d4b", "#f08a67"],
  },
  night: {
    mode: "dark",
    skin: true,
    labelKey: "app.themeNight",
    preview: [
      "oklch(20.768% 0.039 265.754)",
      "oklch(27.949% 0.036 260.03)",
      "oklch(75.351% 0.138 232.661)",
    ],
  },
  "daisy-dark": {
    mode: "dark",
    skin: true,
    labelKey: "app.themeDaisyDark",
    preview: [
      "oklch(25.33% 0.016 252.42)",
      "oklch(21.15% 0.012 254.09)",
      "oklch(58% 0.233 277.117)",
    ],
  },
  dracula: {
    mode: "dark",
    skin: true,
    labelKey: "app.themeDracula",
    preview: [
      "oklch(28.822% 0.022 277.508)",
      "oklch(39.445% 0.032 275.524)",
      "oklch(75.461% 0.183 346.812)",
    ],
  },
} as const satisfies Record<ThemePreference, ThemeMetadata>;

export function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value != null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function isThemeSkinPreference(preference: ThemePreference): preference is ThemeSkinPreference {
  return THEME_META[preference].skin;
}

export const THEME_SKIN_PREFERENCES = THEME_PREFERENCES.filter(isThemeSkinPreference);

export const THEME_MODE_BY_PREFERENCE: Record<ThemePreference, ResolvedTheme> = Object.fromEntries(
  THEME_PREFERENCES.map((preference) => [preference, THEME_META[preference].mode]),
) as Record<ThemePreference, ResolvedTheme>;

export function resolveThemePreference(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === "system") return systemIsDark ? "dark" : "light";
  return THEME_META[preference].mode;
}
