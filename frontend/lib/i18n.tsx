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
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale !== undefined) return initialLocale;

    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("locale");
      if (stored && LOCALES.includes(stored as Locale)) return stored as Locale;
    }

    return "en";
  });

  const handleSetLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, l);
      localStorage.setItem("locale", l);
      const expirationDate = new Date();
      expirationDate.setFullYear(expirationDate.getFullYear() + 1);
      document.cookie = `NEXT_LOCALE=${l}; path=/; expires=${expirationDate.toUTCString()}; SameSite=Strict`;
    }
  }, []);

  useEffect(() => {
    const dir = getDir(locale);
    if (typeof document === "undefined") return;
    document.documentElement.dir = dir;
    document.documentElement.lang = LOCALE_TAGS[locale];
  }, [locale]);

  const t = useMemo(() => createT(locale), [locale]);

  const value: I18nContextValue = {
    locale,
    setLocale: handleSetLocale,
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
