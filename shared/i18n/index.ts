/**
 * Shared i18n system for GreenPay
 */

import IntlMessageFormat from "intl-messageformat";

// Import locale files directly
import en from "../locales/en.json";
import es from "../locales/es.json";
import ar from "../locales/ar.json";

export type Locale = "en" | "es" | "ar";

export const LOCALES: Locale[] = ["en", "es", "ar"];

export const localeData: Record<Locale, any> = {
  en,
  es,
  ar,
};

export const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es-ES",
  ar: "ar-EG",
};

export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(["ar"]);

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

export function getDir(locale: Locale): "ltr" | "rtl" {
  return isRtl(locale) ? "rtl" : "ltr";
}

export type InterpolationValues = Record<string, string | number | Date>;

export function getMessage(
  locale: Locale,
  key: string,
  values?: InterpolationValues
): string {
  const data = localeData[locale];
  if (!data) {
    console.warn(`Missing locale data for: ${locale}`);
    return key;
  }

  const parts = key.split(".");
  let result: any = data;
  for (const part of parts) {
    if (result && typeof result === "object" && part in result) {
      result = result[part];
    } else {
      console.warn(`Missing translation key: ${key} for locale: ${locale}`);
      return key;
    }
  }

  if (typeof result !== "string") {
    console.warn(`Translation key "${key}" is not a string`);
    return key;
  }

  if (!values || Object.keys(values).length === 0) {
    return result;
  }

  try {
    const formatter = new IntlMessageFormat(result, LOCALE_TAGS[locale]);
    return formatter.format(values) as string;
  } catch (err) {
    console.warn(`Failed to format message for key: ${key}`, err);
    return result;
  }
}

export function createT(locale: Locale) {
  return (key: string, values?: InterpolationValues): string => {
    return getMessage(locale, key, values);
  };
}

export function getAvailableLanguages() {
  return [
    { code: "en" as Locale, name: "English", nativeName: "English" },
    { code: "es" as Locale, name: "Spanish", nativeName: "Español" },
    { code: "ar" as Locale, name: "Arabic", nativeName: "العربية" },
  ];
}
