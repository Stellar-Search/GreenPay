"use strict";

const { xlmToStroops, stroopsToXlm } = require("./xlm");

describe("XLM amount conversion", () => {
  test("round-trips an amount at stroop precision", () => {
    expect(xlmToStroops("12.3456789")).toBe(123456789n);
    expect(stroopsToXlm(123456789n)).toBe("12.3456789");
  });

  test("rejects precision below one stroop", () => {
    expect(() => xlmToStroops("0.00000001")).toThrow("at most 7 decimal places");
  });
});
