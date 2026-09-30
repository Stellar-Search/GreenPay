/**
 * Type definitions for the shared i18n system.
 */

import type { Locale, InterpolationValues } from "./index";

export type { Locale, InterpolationValues };

/**
 * Type-safe translation function.
 */
export type TFunction = (key: string, values?: InterpolationValues) => string;

/**
 * Language metadata.
 */
export interface Language {
  code: Locale;
  name: string;
  nativeName: string;
}

/**
 * i18n context value used across platforms.
 */
export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  localeTag: string;
  dir: "ltr" | "rtl";
  t: TFunction;
  isRtl: boolean;
}
