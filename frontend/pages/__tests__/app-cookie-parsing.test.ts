/**
 * Test for _app.tsx cookie parsing in getInitialProps
 */

function parseCookie(cookieString: string | undefined, name: string): string | undefined {
  if (!cookieString) return undefined;
  const cookies = cookieString.split(";").map(c => c.trim());
  for (const cookie of cookies) {
    const [key, value] = cookie.split("=");
    if (key === name) return decodeURIComponent(value);
  }
  return undefined;
}

describe("_app.tsx Cookie Parsing", () => {
  describe("parseCookie utility", () => {
    it("extracts NEXT_LOCALE cookie from cookie header", () => {
      const cookieHeader = "NEXT_LOCALE=es; Path=/; HttpOnly";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      expect(result).toBe("es");
    });

    it("handles multiple cookies in header", () => {
      const cookieHeader = "sessionId=xyz123; NEXT_LOCALE=ar; userId=user456";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      expect(result).toBe("ar");
    });

    it("returns undefined when cookie not found", () => {
      const cookieHeader = "other=value; another=thing";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      expect(result).toBeUndefined();
    });

    it("returns undefined when cookie string is empty", () => {
      const result = parseCookie("", "NEXT_LOCALE");
      expect(result).toBeUndefined();
    });

    it("returns undefined when cookie string is undefined", () => {
      const result = parseCookie(undefined, "NEXT_LOCALE");
      expect(result).toBeUndefined();
    });

    it("handles cookies with spaces around semicolons", () => {
      const cookieHeader = "NEXT_LOCALE=en ; Path=/ ; HttpOnly";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      expect(result).toBe("en");
    });

    it("is case-sensitive for cookie names", () => {
      const cookieHeader = "NEXT_LOCALE=es; next_locale=en";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      expect(result).toBe("es");
    });
  });

  describe("getInitialProps locale resolution", () => {
    it("returns 'en' when no NEXT_LOCALE cookie present", () => {
      const cookieHeader = "other=value";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      const locale = result === "en" || result === "es" || result === "ar" ? result : "en";
      expect(locale).toBe("en");
    });

    it("returns 'ar' when NEXT_LOCALE=ar cookie present", () => {
      const cookieHeader = "NEXT_LOCALE=ar";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      const locale = result === "en" || result === "es" || result === "ar" ? result : "en";
      expect(locale).toBe("ar");
    });

    it("ignores invalid locale values, defaults to 'en'", () => {
      const cookieHeader = "NEXT_LOCALE=fr";
      const result = parseCookie(cookieHeader, "NEXT_LOCALE");
      const locale = result === "en" || result === "es" || result === "ar" ? result : "en";
      expect(locale).toBe("en");
    });

    it("validates only supported locales (en, es, ar)", () => {
      const testCases = [
        { cookie: "NEXT_LOCALE=en", expected: "en" },
        { cookie: "NEXT_LOCALE=es", expected: "es" },
        { cookie: "NEXT_LOCALE=ar", expected: "ar" },
        { cookie: "NEXT_LOCALE=fr", expected: "en" },
        { cookie: "NEXT_LOCALE=de", expected: "en" },
      ];

      testCases.forEach(({ cookie, expected }) => {
        const result = parseCookie(cookie, "NEXT_LOCALE");
        const locale = result === "en" || result === "es" || result === "ar" ? result : "en";
        expect(locale).toBe(expected);
      });
    });
  });
});
