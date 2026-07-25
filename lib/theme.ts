export const THEME_PREFERENCES = [
  "system",
  "light",
  "dark",
  "paper",
  "graphite",
  "ocean",
  "forest",
] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_META: Record<ThemePreference, { mode: ResolvedTheme }> = {
  system: { mode: "light" },
  light: { mode: "light" },
  dark: { mode: "dark" },
  paper: { mode: "light" },
  graphite: { mode: "dark" },
  ocean: { mode: "light" },
  forest: { mode: "dark" },
};

export function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value != null && (THEME_PREFERENCES as readonly string[]).includes(value);
}

export function resolveThemePreference(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === "system") return systemIsDark ? "dark" : "light";
  return THEME_META[preference].mode;
}
