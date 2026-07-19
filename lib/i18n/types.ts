export type Locale = "zh" | "en";

export const LOCALES: Locale[] = ["zh", "en"];
export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALE_STORAGE_KEY = "pi-locale";

export type MessageParams = Record<string, string | number | boolean | null | undefined>;

/** Nested dictionary; leaves are template strings with optional `{name}` placeholders. */
export type MessageTree = {
  [key: string]: string | MessageTree;
};
