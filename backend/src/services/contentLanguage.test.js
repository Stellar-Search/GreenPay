"use strict";

const {
  normalizeContentLanguage,
  requireContentLanguage,
  contentDirection,
  translationMetadata,
} = require("./contentLanguage");

describe("content language helpers", () => {
  test("normalizes supported BCP-47 language tags", () => {
    expect(normalizeContentLanguage("es-MX")).toBe("es");
    expect(normalizeContentLanguage("AR_eg")).toBe("ar");
  });

  test("rejects unsupported languages", () => {
    expect(() => requireContentLanguage("fr")).toThrow(/en, es, ar/);
  });

  test("marks Arabic content as right-to-left", () => {
    expect(contentDirection("ar")).toBe("rtl");
    expect(contentDirection("es")).toBe("ltr");
  });

  test("labels a requested-language fallback without changing the source", () => {
    expect(translationMetadata({ source_language: "en", requested_language: "es" })).toEqual({
      sourceLanguage: "en",
      contentLanguage: "en",
      contentDirection: "ltr",
      requestedLanguage: "es",
      usedFallback: true,
      machineTranslated: false,
    });
  });

  test("labels selected machine translations", () => {
    expect(translationMetadata({
      source_language: "en",
      requested_language: "ar",
      localized_language: "ar",
      localized_machine_translated: true,
    })).toMatchObject({
      contentLanguage: "ar",
      contentDirection: "rtl",
      usedFallback: false,
      machineTranslated: true,
    });
  });
});
