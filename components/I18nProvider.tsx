"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  messagesByLocale,
  resolveInitialLocale,
  translate,
  writeStoredLocale,
  type Locale,
  type MessageParams,
} from "@/lib/i18n";

type TranslateFn = (key: string, params?: MessageParams) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  try {
    document.title = translate(messagesByLocale[locale], messagesByLocale.en, "app.title");
  } catch {
    // ignore
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const initial = resolveInitialLocale();
    setLocaleState(initial);
    applyDocumentLocale(initial);
    setReady(true);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeStoredLocale(next);
    applyDocumentLocale(next);
  }, []);

  const t = useCallback<TranslateFn>(
    (key, params) => {
      const active = messagesByLocale[locale] ?? messagesByLocale[DEFAULT_LOCALE];
      return translate(active, messagesByLocale.en, key, params);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  // Avoid flashing the wrong language on first client paint after hydration.
  if (!ready) {
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
  }

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}

/** Convenience hook when only the translator is needed. */
export function useT(): TranslateFn {
  return useI18n().t;
}
