/**
 * Extension i18n setup for browser extension.
 *
 * Uses the shared i18n system and stores the user's locale preference
 * in chrome.storage.local.
 */

import type { Locale, InterpolationValues } from "@greenpay/i18n";
import { createT, getDir, LOCALE_TAGS, LOCALES, RTL_LOCALES } from "@greenpay/i18n";

export type { Locale, InterpolationValues };

const STORAGE_KEY = "greenpay_locale";

export function getBrowserAPI() {
  if (typeof chrome !== "undefined" && chrome.storage) {
    return chrome;
  }
  if (typeof browser !== "undefined" && browser.storage) {
    return browser;
  }
  return null;
}

export async function loadLocale(): Promise<Locale> {
  try {
    const api = getBrowserAPI();
    if (!api) return "en";

    const result = await api.storage.local.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (saved && LOCALES.includes(saved as Locale)) {
      return saved as Locale;
    }
  } catch (err) {
    console.warn("Failed to load locale from storage:", err);
  }
  return "en";
}

export async function saveLocale(locale: Locale): Promise<void> {
  try {
    const api = getBrowserAPI();
    if (!api) return;

    await api.storage.local.set({ [STORAGE_KEY]: locale });
  } catch (err) {
    console.warn("Failed to save locale to storage:", err);
  }
}

export function getDirForLocale(locale: Locale): "ltr" | "rtl" {
  return getDir(locale);
}

export function getLocaleTag(locale: Locale): string {
  return LOCALE_TAGS[locale];
}

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.has(locale);
}

export function createTForLocale(locale: Locale) {
  return createT(locale);
}

export function getAvailableLocales() {
  return LOCALES;
}
