import fc from "fast-check";
import {
  parseToStroops,
  stroopsToXLM,
  isEqual,
  compare,
  add,
  subtract,
  multiply,
  isValidAmount,
  isValidDonationAmount,
  hasSufficientBalance,
  STROOPS_PER_XLM,
  MAX_DECIMALS,
} from "@/utils/amount";

describe("amount utility", () => {
  describe("parseToStroops", () => {
    it("should parse integer amounts correctly", () => {
      expect(parseToStroops("0")).toBe(0);
      expect(parseToStroops("1")).toBe(STROOPS_PER_XLM);
      expect(parseToStroops("10")).toBe(10 * STROOPS_PER_XLM);
      expect(parseToStroops("100")).toBe(100 * STROOPS_PER_XLM);
    });

    it("should parse decimal amounts correctly", () => {
      expect(parseToStroops("0.0000001")).toBe(1);
      expect(parseToStroops("0.1")).toBe(1000000);
      expect(parseToStroops("1.2345678")).toBe(12345678);
    });

    it("should handle negative amounts", () => {
      expect(parseToStroops("-1")).toBe(-STROOPS_PER_XLM);
      expect(parseToStroops("-0.1")).toBe(-1000000);
    });

    it("should return NaN for invalid inputs", () => {
      expect(parseToStroops("")).toBeNaN();
      expect(parseToStroops("abc")).toBeNaN();
      expect(parseToStroops("1.2.3")).toBeNaN();
      expect(parseToStroops("1,234")).toBeNaN();
    });

    it("should handle numbers as input", () => {
      expect(parseToStroops(0)).toBe(0);
      expect(parseToStroops(1)).toBe(STROOPS_PER_XLM);
      expect(parseToStroops(0.1)).toBe(1000000);
    });

    it("should truncate to 7 decimal places", () => {
      // 1.123456789 XLM = 11234567.89 stroops, truncated to 11234567
      expect(parseToStroops("1.123456789")).toBe(11234567);
    });

    it("should pad to 7 decimal places", () => {
      expect(parseToStroops("1.1")).toBe(11000000);
    });
  });

  describe("stroopsToXLM", () => {
    it("should convert stroops to XLM string", () => {
      expect(stroopsToXLM(0)).toBe("0.0000000");
      expect(stroopsToXLM(STROOPS_PER_XLM)).toBe("1.0000000");
      expect(stroopsToXLM(12345678)).toBe("1.2345678");
    });

    it("should handle negative stroops", () => {
      expect(stroopsToXLM(-STROOPS_PER_XLM)).toBe("-1.0000000");
    });

    it("should return 0.0000000 for NaN", () => {
      expect(stroopsToXLM(NaN)).toBe("0.0000000");
      expect(stroopsToXLM(Infinity)).toBe("0.0000000");
    });
  });

  describe("isEqual", () => {
    it("should return true for equal amounts", () => {
      expect(isEqual("1.0", "1.0000000")).toBe(true);
      expect(isEqual("0.1", "0.1000000")).toBe(true);
      expect(isEqual("100", "100.0")).toBe(true);
    });

    it("should return false for unequal amounts", () => {
      expect(isEqual("1.0", "2.0")).toBe(false);
      expect(isEqual("0.1", "0.2")).toBe(false);
    });
  });

  describe("compare", () => {
    it("should return -1 when a < b", () => {
      expect(compare("1.0", "2.0")).toBe(-1);
      expect(compare("0.1", "0.2")).toBe(-1);
    });

    it("should return 0 when a === b", () => {
      expect(compare("1.0", "1.0")).toBe(0);
      expect(compare("0.1", "0.1000000")).toBe(0);
    });

    it("should return 1 when a > b", () => {
      expect(compare("2.0", "1.0")).toBe(1);
      expect(compare("0.2", "0.1")).toBe(1);
    });
  });

  describe("add", () => {
    it("should add two amounts correctly", () => {
      expect(add("1.0", "2.0")).toBe("3.0000000");
      expect(add("0.1", "0.2")).toBe("0.3000000");
      expect(add("0.1", "0.1")).toBe("0.2000000");
    });

    it("should handle negative amounts", () => {
      expect(add("1.0", "-0.5")).toBe("0.5000000");
    });
  });

  describe("subtract", () => {
    it("should subtract two amounts correctly", () => {
      expect(subtract("3.0", "1.0")).toBe("2.0000000");
      expect(subtract("0.3", "0.1")).toBe("0.2000000");
    });

    it("should handle negative results", () => {
      expect(subtract("1.0", "2.0")).toBe("-1.0000000");
    });
  });

  describe("multiply", () => {
    it("should multiply amount by scalar", () => {
      expect(multiply("2.0", 3)).toBe("6.0000000");
      expect(multiply("1.5", 2)).toBe("3.0000000");
      expect(multiply("0.1", 10)).toBe("1.0000000");
    });

    it("should handle zero multiplier", () => {
      expect(multiply("100.0", 0)).toBe("0.0000000");
    });
  });

  describe("isValidAmount", () => {
    it("should return true for valid amounts", () => {
      expect(isValidAmount("1.0")).toBe(true);
      expect(isValidAmount("0.0000001")).toBe(true);
      expect(isValidAmount("100")).toBe(true);
      expect(isValidAmount("0")).toBe(true);
    });

    it("should return false for invalid amounts", () => {
      expect(isValidAmount("-1.0")).toBe(false);
      expect(isValidAmount("abc")).toBe(false);
      expect(isValidAmount("")).toBe(false);
    });
  });

  describe("isValidDonationAmount", () => {
    it("should return true for valid positive amounts", () => {
      expect(isValidDonationAmount("1.0")).toBe(true);
      expect(isValidDonationAmount("0.0000001")).toBe(true);
      expect(isValidDonationAmount("100")).toBe(true);
    });

    it("should return false for zero or negative amounts", () => {
      expect(isValidDonationAmount("0")).toBe(false);
      expect(isValidDonationAmount("-1.0")).toBe(false);
    });
  });

  describe("hasSufficientBalance", () => {
    it("should return true when balance >= donation", () => {
      expect(hasSufficientBalance("100.0", "50.0")).toBe(true);
      expect(hasSufficientBalance("100.0", "100.0")).toBe(true);
    });

    it("should return false when balance < donation", () => {
      expect(hasSufficientBalance("50.0", "100.0")).toBe(false);
    });
  });

  describe("roundtrip property: parseToStroops -> stroopsToXLM", () => {
    it("should preserve values through roundtrip conversion", () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1000, noNaN: true }),
          (num) => {
            const stroops = parseToStroops(num);
            if (isNaN(stroops)) return true;
            const xlm = stroopsToXLM(stroops);
            const roundtrip = parseToStroops(xlm);
            return isEqual(stroops, roundtrip);
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe("precision boundary tests", () => {
    it("should handle 7 decimal places correctly", () => {
      expect(parseToStroops("0.0000001")).toBe(1);
      expect(stroopsToXLM(1)).toBe("0.0000001");
    });

    it("should handle 8 decimal places by truncating", () => {
      expect(parseToStroops("0.00000001")).toBe(0);
      expect(parseToStroops("0.12345678")).toBe(1234567);
    });

    it("should handle large amounts correctly", () => {
      expect(parseToStroops("1000000.0000000")).toBe(1000000 * STROOPS_PER_XLM);
      expect(stroopsToXLM(1000000 * STROOPS_PER_XLM)).toBe("1000000.0000000");
    });

    it("should handle very small amounts correctly", () => {
      expect(parseToStroops("0.0000001")).toBe(1);
      expect(parseToStroops("0.0000002")).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("should handle amounts with leading zeros", () => {
      expect(parseToStroops("001.0")).toBe(STROOPS_PER_XLM);
      expect(parseToStroops("000.1")).toBe(1000000);
    });

    it("should handle amounts with trailing zeros", () => {
      expect(parseToStroops("1.0")).toBe(STROOPS_PER_XLM);
      expect(parseToStroops("1.0000000")).toBe(STROOPS_PER_XLM);
    });

    it("should handle amounts with no integer part", () => {
      expect(parseToStroops(".5")).toBe(5000000);
      expect(parseToStroops(".0000001")).toBe(1);
    });

    it("should handle whitespace in amounts", () => {
      expect(parseToStroops(" 1.0 ")).toBe(STROOPS_PER_XLM);
      expect(parseToStroops("  0.5  ")).toBe(5000000);
    });
  });

  describe("consistency with parseFloat/toFixed", () => {
    it("should match parseFloat behavior for simple cases", () => {
      const testCases = ["0", "1", "10", "100", "1000"];
      for (const tc of testCases) {
        const amountNum = parseFloat(tc);
        const stroops = parseToStroops(tc);
        expect(stroops).toBe(amountNum * STROOPS_PER_XLM);
      }
    });

    it("should handle precision boundaries better than parseFloat", () => {
      // Test case where parseFloat might have precision issues
      const amount = "0.1";
      const amountNum = parseFloat(amount);
      const stroops = parseToStroops(amount);
      
      // Our implementation should be exact
      expect(stroops).toBe(1000000);
      
      // parseFloat might have precision issues
      expect(amountNum * STROOPS_PER_XLM).toBeCloseTo(1000000, 0);
    });
  });
});