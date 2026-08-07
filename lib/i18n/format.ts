import type { Locale } from "./types";

/** BCP 47 tag used by Intl APIs for the app locale. */
export function localeTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}

export function formatDateTime(
  value: Date | number | string,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(localeTag(locale), options);
}

export function formatDate(
  value: Date | number | string,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(localeTag(locale), options);
}

export function formatTime(
  value: Date | number | string,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(localeTag(locale), options);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString(localeTag(locale), options);
}

export function collator(locale: Locale, options?: Intl.CollatorOptions): Intl.Collator {
  return new Intl.Collator(localeTag(locale), { numeric: true, sensitivity: "base", ...options });
}
