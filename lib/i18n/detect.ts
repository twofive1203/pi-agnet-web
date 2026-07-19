import { DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, type Locale } from "./types";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as string[]).includes(value);
}

/** Map browser / Accept-Language tags onto supported locales. */
export function normalizeLocaleTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (!lower) return null;
  if (lower === "zh" || lower.startsWith("zh-") || lower.startsWith("zh_")) return "zh";
  if (lower === "en" || lower.startsWith("en-") || lower.startsWith("en_")) return "en";
  return null;
}

export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ];
  for (const tag of candidates) {
    const locale = normalizeLocaleTag(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore private mode / quota
  }
}

/** Preferred client locale: explicit storage → browser → default. */
export function resolveInitialLocale(): Locale {
  return readStoredLocale() ?? detectBrowserLocale() ?? DEFAULT_LOCALE;
}
