/**
 * lib/i18n.tsx — Lightweight i18n context with JSON locale files.
 */
import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { createT, getDir, LOCALE_TAGS, RTL_LOCALES } from "@greenpay/i18n";
import type { Locale, InterpolationValues } from "@greenpay/i18n";

export type { Locale, InterpolationValues };

export const LOCALES: Locale[] = ["en", "es", "ar"];

export const RTL_LOCALES_SET = RTL_LOCALES;

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

export function getLocaleDir(locale: Locale): "ltr" | "rtl" {
  return getDir(locale);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  localeTag: string;
  dir: "ltr" | "rtl";
  t: (key: string, values?: InterpolationValues) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export const STORAGE_KEY = "greenpay-locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (saved && LOCALES.includes(saved)) {
        setLocaleState(saved);
      }
    } catch (err) {
      console.warn("Failed to load locale from localStorage:", err);
    }
  }, []);

  // The provider computes `dir` for context consumers, but the document itself
  // also has to carry it: logical CSS properties (start/end) and the browser's
  // own bidi algorithm key off the element's dir attribute, not off React
  // context. Without this an RTL locale renders left-to-right.
  useEffect(() => {
    document.documentElement.dir = getDir(locale);
    document.documentElement.lang = LOCALE_TAGS[locale];
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch (err) {
      console.warn("Failed to save locale to localStorage:", err);
    }
  }, []);

  const t = useMemo(() => createT(locale), [locale]);

  const value: I18nContextValue = {
    locale,
    setLocale,
    localeTag: LOCALE_TAGS[locale],
    dir: getDir(locale),
    t,
  };

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (context === undefined) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}

export function useTranslation() {
  const { t, locale } = useI18n();
  return { t, locale };
}
