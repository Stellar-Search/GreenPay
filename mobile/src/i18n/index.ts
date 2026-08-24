/**
 * Mobile i18n setup for React Native / Expo.
 *
 * Uses the shared i18n system and stores the user's locale preference
 * in AsyncStorage.
 */

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import type { Locale, I18nContextValue, InterpolationValues } from "@greenpay/i18n";
import {
  createT,
  getDir,
  LOCALE_TAGS,
  LOCALES,
  RTL_LOCALES,
} from "@greenpay/i18n";

export type { Locale, InterpolationValues };

const STORAGE_KEY = "@greenpay/locale";

// Check if we're in a React Native environment with AsyncStorage
const getAsyncStorage = () => {
  try {
    const { default: AsyncStorage } = require("@react-native-async-storage/async-storage");
    return AsyncStorage;
  } catch {
    return null;
  }
};

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [isLoading, setIsLoading] = useState(true);

  // Load saved locale on mount
  useEffect(() => {
    async function loadLocale() {
      try {
        const AsyncStorage = getAsyncStorage();
        if (AsyncStorage) {
          const saved = await AsyncStorage.getItem(STORAGE_KEY);
          if (saved && LOCALES.includes(saved as Locale)) {
            setLocaleState(saved as Locale);
          }
        }
      } catch (err) {
        console.warn("Failed to load locale from storage:", err);
      } finally {
        setIsLoading(false);
      }
    }
    loadLocale();
  }, []);

  const setLocale = useCallback(async (newLocale: Locale) => {
    setLocaleState(newLocale);
    try {
      const AsyncStorage = getAsyncStorage();
      if (AsyncStorage) {
        await AsyncStorage.setItem(STORAGE_KEY, newLocale);
      }
    } catch (err) {
      console.warn("Failed to save locale to storage:", err);
    }
  }, []);

  const t = useMemo(() => createT(locale), [locale]);

  const value: I18nContextValue = {
    locale,
    setLocale,
    localeTag: LOCALE_TAGS[locale],
    dir: getDir(locale),
    t,
    isRtl: RTL_LOCALES.has(locale),
  };

  return { value, isLoading };
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { value, isLoading } = useLocale();

  if (isLoading) {
    // Return null or a loading component
    return null;
  }

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useTranslation() {
  const { t, locale } = useI18n();
  return { t, locale };
}
