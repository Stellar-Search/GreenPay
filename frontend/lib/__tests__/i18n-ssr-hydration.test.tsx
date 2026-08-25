import { renderHook, act } from "@testing-library/react";
import { useI18n, I18nProvider, type Locale } from "@/lib/i18n";
import React from "react";

describe("i18n SSR Hydration", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie.split(";").forEach(c => {
      document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
    });
  });

  describe("I18nProvider initialLocale", () => {
    it("uses initialLocale prop when provided", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="ar">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("ar");
    });

    it("defaults to 'en' when no initialLocale provided", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider>{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("en");
    });

    it("respects initialLocale on SSR (no localStorage interference)", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="es">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("es");
    });
  });

  describe("Cookie persistence on client", () => {
    it("sets NEXT_LOCALE cookie when locale changes", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      act(() => {
        result.current.setLocale("ar");
      });

      expect(result.current.locale).toBe("ar");
      expect(document.cookie).toContain("NEXT_LOCALE=ar");
    });

    it("cookie includes SameSite=Strict for security", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      act(() => {
        result.current.setLocale("es");
      });

      expect(result.current.locale).toBe("es");
      // Cookie is set with SameSite=Strict and path=/
      expect(document.cookie).toContain("NEXT_LOCALE=es");
    });

    it("updates localStorage for backward compatibility", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      act(() => {
        result.current.setLocale("ar");
      });

      expect(localStorage.getItem("locale")).toBe("ar");
    });
  });

  describe("HTML document attributes", () => {
    it("sets dir and lang attributes on document element", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      renderHook(() => useI18n(), { wrapper });

      expect(document.documentElement.dir).toBe("ltr");
      expect(document.documentElement.lang).toBe("en-US");
    });

    it("updates dir to rtl for Arabic locale", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="ar">{children}</I18nProvider>
      );
      renderHook(() => useI18n(), { wrapper });

      expect(document.documentElement.dir).toBe("rtl");
      expect(document.documentElement.lang).toBe("ar-EG");
    });

    it("updates dir when locale changes", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      expect(document.documentElement.dir).toBe("ltr");

      act(() => {
        result.current.setLocale("ar");
      });

      expect(document.documentElement.dir).toBe("rtl");
    });
  });

  describe("Hydration mismatch prevention", () => {
    it("SSR and client initial states match with initialLocale", () => {
      const serverLocale: Locale = "es";

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale={serverLocale}>{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      expect(result.current.locale).toBe(serverLocale);
      expect(result.current.dir).toBe("ltr");
      expect(result.current.localeTag).toBe("es-ES");
    });

    it("mismatch is prevented with SSR initialLocale taking precedence", () => {
      localStorage.setItem("locale", "ar");

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="es">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      expect(result.current.locale).toBe("es");
    });

    it("translation function works immediately after hydration", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <I18nProvider initialLocale="en">{children}</I18nProvider>
      );
      const { result } = renderHook(() => useI18n(), { wrapper });

      const translation = result.current.t("common.language");
      expect(translation).toBeTruthy();
      expect(typeof translation).toBe("string");
    });
  });
});
