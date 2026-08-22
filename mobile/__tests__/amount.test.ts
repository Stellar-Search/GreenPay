/**
 * __tests__/amount.test.ts
 * Unit tests and property-based fast-check fuzzing tests for fixed-point Stellar amount utility.
 */

import fc from 'fast-check';
import {
  parseAmountToStroops,
  formatStroopsToXLM,
  formatStroopsToDisplay,
  compareStroops,
  isBalanceSufficient,
  FEE_BUFFER_STROOPS,
  STROOPS_PER_XLM,
} from '../utils/amount';

describe('Stellar amount utility — unit tests', () => {
  describe('parseAmountToStroops', () => {
    it('parses whole XLM amounts correctly', () => {
      expect(parseAmountToStroops('1')).toBe(10_000_000n);
      expect(parseAmountToStroops('10')).toBe(100_000_000n);
      expect(parseAmountToStroops('100')).toBe(1_000_000_000n);
    });

    it('parses fractional XLM amounts up to 7 decimal places', () => {
      expect(parseAmountToStroops('0.5')).toBe(5_000_000n);
      expect(parseAmountToStroops('0.0000001')).toBe(1n); // 1 stroop
      expect(parseAmountToStroops('9.5000007')).toBe(95_000_007n);
      expect(parseAmountToStroops('10.0000007')).toBe(100_000_007n);
    });

    it('parses number inputs', () => {
      expect(parseAmountToStroops(1)).toBe(10_000_000n);
      expect(parseAmountToStroops(0.5)).toBe(5_000_000n);
    });

    it('rejects invalid inputs', () => {
      expect(parseAmountToStroops('')).toBeNull();
      expect(parseAmountToStroops('   ')).toBeNull();
      expect(parseAmountToStroops('abc')).toBeNull();
      expect(parseAmountToStroops('-1')).toBeNull();
      expect(parseAmountToStroops('-0.5')).toBeNull();
      expect(parseAmountToStroops('1.2.3')).toBeNull();
      expect(parseAmountToStroops('1.12345678')).toBeNull(); // 8 decimal places > 7
      expect(parseAmountToStroops(null)).toBeNull();
      expect(parseAmountToStroops(undefined)).toBeNull();
    });
  });

  describe('formatStroopsToXLM', () => {
    it('formats stroops into exact 7-decimal string', () => {
      expect(formatStroopsToXLM(10_000_000n)).toBe('1.0000000');
      expect(formatStroopsToXLM(5_000_000n)).toBe('0.5000000');
      expect(formatStroopsToXLM(1n)).toBe('0.0000001');
      expect(formatStroopsToXLM(0n)).toBe('0.0000000');
      expect(formatStroopsToXLM(100_000_007n)).toBe('10.0000007');
    });
  });

  describe('formatStroopsToDisplay', () => {
    it('formats stroops for UI display with requested decimals', () => {
      expect(formatStroopsToDisplay(105_000_000n, 2)).toBe('10.50');
      expect(formatStroopsToDisplay(20_000_000n, 2)).toBe('2.00');
      expect(formatStroopsToDisplay(1n, 2)).toBe('0.00');
      expect(formatStroopsToDisplay(10_000_000n, 0)).toBe('1');
      expect(formatStroopsToDisplay(10_000_000n, 7)).toBe('1.0000000');
    });
  });

  describe('Precision boundary balance comparison', () => {
    it('accurately compares balance near 7-decimal boundary where IEEE-754 fails', () => {
      // Problematic IEEE-754 case: 9.5000007 + 0.5 = 10.000000700000001 in double float
      const availableStr = '10.0000007';
      const donationStr = '9.5000007';

      const availableStroops = parseAmountToStroops(availableStr)!;
      const donationStroops = parseAmountToStroops(donationStr)!;
      const requiredStroops = donationStroops + FEE_BUFFER_STROOPS;

      expect(donationStroops).toBe(95_000_007n);
      expect(FEE_BUFFER_STROOPS).toBe(5_000_000n);
      expect(requiredStroops).toBe(100_000_007n);
      expect(availableStroops).toBe(100_000_007n);

      // Fixed-point comparison must pass (balance is sufficient)
      expect(isBalanceSufficient(availableStroops, requiredStroops)).toBe(true);
      expect(compareStroops(availableStroops, requiredStroops)).toBe(0);
    });

    it('detects a single stroop deficit correctly at precision boundary', () => {
      const availableStroops = 100_000_006n; // 1 stroop less than required 100_000_007n
      const requiredStroops = 100_000_007n;

      expect(isBalanceSufficient(availableStroops, requiredStroops)).toBe(false);
      expect(compareStroops(availableStroops, requiredStroops)).toBe(-1);
    });
  });
});

describe('Stellar amount utility — property-based fuzzing tests', () => {
  it('parseAmountToStroops never throws on arbitrary string inputs', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        expect(() => {
          parseAmountToStroops(input);
        }).not.toThrow();
      }),
      { numRuns: 1000 }
    );
  });

  it('parseAmountToStroops never throws on non-string inputs of any type', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => {
          parseAmountToStroops(input as any);
        }).not.toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it('round-trip property: parse -> format -> parse yields identical BigInt stroops', () => {
    // Generate valid BigInt stroops from 0 to 50 billion XLM (50_000_000_000 * 10^7 stroops)
    const maxStroops = 50_000_000_000n * STROOPS_PER_XLM;

    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: maxStroops }),
        (stroops) => {
          const formattedStr = formatStroopsToXLM(stroops);
          const parsedBack = parseAmountToStroops(formattedStr);

          expect(parsedBack).not.toBeNull();
          expect(parsedBack).toBe(stroops);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('formatting property: formatStroopsToXLM always yields valid 7-decimal string', () => {
    const maxStroops = 100_000_000_000n * STROOPS_PER_XLM;

    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: maxStroops }),
        (stroops) => {
          const formatted = formatStroopsToXLM(stroops);
          expect(formatted).toMatch(/^\d+\.\d{7}$/);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('comparison property: compareStroops matches BigInt native order', () => {
    const maxStroops = 1_000_000_000n * STROOPS_PER_XLM;

    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: maxStroops }),
        fc.bigInt({ min: 0n, max: maxStroops }),
        (a, b) => {
          const comp = compareStroops(a, b);
          if (a < b) {
            expect(comp).toBe(-1);
            expect(isBalanceSufficient(a, b)).toBe(false);
          } else if (a > b) {
            expect(comp).toBe(1);
            expect(isBalanceSufficient(a, b)).toBe(true);
          } else {
            expect(comp).toBe(0);
            expect(isBalanceSufficient(a, b)).toBe(true);
          }
        }
      ),
      { numRuns: 1000 }
    );
  });
});
