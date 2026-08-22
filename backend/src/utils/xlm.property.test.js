"use strict";

/**
 * Property-based tests for exact monetary arithmetic.
 *
 * The schema stores every monetary column as NUMERIC(20, 7) and Postgres
 * hands those values to Node as strings. These tests pin down the invariant
 * the rest of the codebase relies on: summing many donations in stroops
 * yields exactly the stored total — including amounts with all seven decimal
 * digits populated, which IEEE-754 doubles cannot represent.
 */

const fc = require("fast-check");
const { xlmToStroops, xlmToStroopsRounded, stroopsToXlm, normalizeXlm, compareXlm, sumXlm } = require("./xlm");

// Arbitrary 7-decimal XLM amount as a canonical string ("12.0000001").
function xlmAmountArbitrary(maxWhole = 1_000_000) {
  return fc.tuple(
    fc.integer({ min: 0, max: maxWhole }),
    fc.integer({ min: 0, max: 9_999_999 }),
  ).map(([whole, frac]) => `${whole}.${frac.toString().padStart(7, "0")}`);
}

describe("xlm utils (exact stroop arithmetic)", () => {
  test("xlmToStroops is exact for arbitrary 7-decimal amounts", () => {
    fc.assert(
      fc.property(xlmAmountArbitrary(), (amount) => {
        const stroops = xlmToStroops(amount);
        expect(stroopsToXlm(stroops)).toBe(amount);
      }),
    );
  });

  test("summing many donations yields exactly the stored total", () => {
    fc.assert(
      fc.property(fc.array(xlmAmountArbitrary(), { minLength: 0, maxLength: 500 }), (amounts) => {
        const expectedStroops = amounts.reduce((acc, a) => acc + xlmToStroops(a), 0n);
        expect(sumXlm(amounts)).toBe(stroopsToXlm(expectedStroops));
        // The canonical string must round-trip through NUMERIC(20, 7)
        // semantics without losing a stroop.
        expect(normalizeXlm(sumXlm(amounts))).toBe(stroopsToXlm(expectedStroops));
      }),
    );
  });

  test("compareXlm distinguishes one-stroop differences at any magnitude", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n - 1n }), (stroops) => {
        expect(compareXlm(stroopsToXlm(stroops), stroopsToXlm(stroops))).toBe(0);
        if (stroops < 10n ** 20n - 1n) {
          expect(compareXlm(stroopsToXlm(stroops), stroopsToXlm(stroops + 1n))).toBe(-1);
          expect(compareXlm(stroopsToXlm(stroops + 1n), stroopsToXlm(stroops))).toBe(1);
        }
      }),
    );
  });

  test("xlmToStroopsRounded repairs legacy double artifacts deterministically", () => {
    fc.assert(
      fc.property(xlmAmountArbitrary(), (amount) => {
        // Simulate an old payload that serialized the amount through a
        // double: the nearest-stroop repair must recover the original.
        const lossy = Number(amount);
        if (!Number.isFinite(lossy)) return;
        expect(xlmToStroopsRounded(lossy)).toBe(xlmToStroops(amount));
      }),
    );
  });
});
