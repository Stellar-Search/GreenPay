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

export function I18nProvider({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale && LOCALES.includes(initialLocale)) {
      return initialLocale;
    }

    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
        if (saved && LOCALES.includes(saved)) {
          return saved;
        }
      } catch (err) {
        console.warn("Failed to load locale from localStorage:", err);
      }
    }

    return "en";
  });

  const dir = useMemo(() => getDir(locale), [locale]);

  // The provider computes `dir` for context consumers, but the document itself
  // also has to carry it: logical CSS properties (start/end) and the browser's
  // own bidi algorithm key off the element's dir attribute, not off React
  // context. Without this an RTL locale renders left-to-right.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dir = dir;
    document.documentElement.lang = LOCALE_TAGS[locale];
  }, [dir, locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);

    try {
      localStorage.setItem(STORAGE_KEY, newLocale);
    } catch (err) {
      console.warn("Failed to save locale to localStorage:", err);
    }

    if (typeof window !== "undefined") {
      const expirationDate = new Date();
      expirationDate.setFullYear(expirationDate.getFullYear() + 1);
      document.cookie = `NEXT_LOCALE=${newLocale}; path=/; expires=${expirationDate.toUTCString()}; SameSite=Strict`;
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
