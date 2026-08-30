"use strict";

const { ndcgAtK, evaluateRanking, LABELLED_QUERIES } = require("./projectSearchEval");

describe("projectSearchEval", () => {
  describe("ndcgAtK", () => {
    it("returns 1 for perfect ranking", () => {
      const expected = ["a", "b", "c"];
      expect(ndcgAtK(["a", "b", "c"], expected, 3)).toBe(1);
    });

    it("returns lower score when order is wrong", () => {
      const expected = ["a", "b"];
      const perfect = ndcgAtK(["a", "b"], expected, 2);
      const swapped = ndcgAtK(["b", "a"], expected, 2);
      expect(swapped).toBeLessThan(perfect);
    });
  });

  describe("evaluateRanking", () => {
    it("reports pass/fail per labelled query", async () => {
      const searchFn = async (query) => {
        if (query === "reforestation") {
          return [{ id: "reforest-delta" }, { id: "general-green" }];
        }
        return [];
      };

      const report = await evaluateRanking(searchFn, { minNdcg: 0.5 });
      expect(report.cases.length).toBe(LABELLED_QUERIES.length);
      expect(report.cases[0].pass).toBe(true);
      expect(report.meanNdcg).toBeGreaterThan(0);
    });
  });
});
