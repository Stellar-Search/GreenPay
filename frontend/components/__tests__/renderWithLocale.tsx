/**
 * components/__tests__/renderWithLocale.tsx
 *
 * Shared test helper: renders a component inside `I18nProvider` seeded with
 * a specific starting locale. `I18nProvider` reads its initial locale from
 * `localStorage` on mount, so we stash the desired locale there first.
 *
 * Used by the visual-regression / snapshot suites that assert both:
 *  - ICU plural output changes correctly across locales (e.g. Arabic's
 *    six plural categories vs. English's two), and
 *  - `document.documentElement.dir` flips to "rtl" for RTL locales, with
 *    logical CSS classes (start/end) rendering identically regardless of
 *    direction (since they're direction-relative, not physical left/right).
 */
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { I18nProvider, STORAGE_KEY, type Locale } from "@/lib/i18n";

export function renderWithLocale(ui: ReactElement, locale: Locale = "en"): RenderResult {
  window.localStorage.setItem(STORAGE_KEY, locale);
  return render(<I18nProvider>{ui}</I18nProvider>);
}
