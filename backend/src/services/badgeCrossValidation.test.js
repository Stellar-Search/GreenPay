"use strict";

const fs = require("fs");
const path = require("path");
const { BADGE_THRESHOLDS, computeBadges } = require("./store");

/**
 * Helper to parse badge threshold constants from Rust smart contract source.
 *
 * @param {string} contractSource - Contents of contracts/greenpay-contract/src/lib.rs
 * @returns {Record<string, number>} Map of contract tier names (lowercase) to XLM threshold numbers.
 */
function parseContractBadgeThresholds(contractSource) {
  const thresholds = new Map();

  const pattern = /pub\s+const\s+BADGE_THRESHOLD_([A-Z_]+)_XLM\s*:\s*i128\s*=\s*(\d+)\s*;/g;
  let match;
  while ((match = pattern.exec(contractSource)) !== null) {
    const rawTier = match[1]; // e.g. SEEDLING, TREE, FOREST, EARTH_GUARDIAN
    const value = parseInt(match[2], 10);

    // Normalize contract tier constant name to backend tier name
    let backendTier;
    if (rawTier === "EARTH_GUARDIAN") {
      backendTier = "earth";
    } else {
      backendTier = rawTier.toLowerCase();
    }

    thresholds.set(backendTier, value);
  }

  return thresholds;
}

/**
 * Validates consistency between contract thresholds and backend BADGE_THRESHOLDS.
 *
 * @param {Map<string, number>|Record<string, number>} contractThresholds
 * @param {Array<{tier: string, min: number}>} backendThresholds
 * @throws {Error} if any drift or mismatch is detected.
 */
function validateBadgeParity(contractThresholds, backendThresholds) {
  const contractMap = contractThresholds instanceof Map
    ? contractThresholds
    : new Map(Object.entries(contractThresholds));

  const backendMap = new Map(
    backendThresholds.map((b) => [b.tier, b.min])
  );

  const contractTiers = Array.from(contractMap.keys());
  const backendTiers = Array.from(backendMap.keys());

  if (contractTiers.length === 0) {
    throw new Error("No badge threshold constants found in contract source");
  }

  if (contractTiers.length !== backendTiers.length) {
    throw new Error(
      `Tier count mismatch: contract has ${contractTiers.length} (${contractTiers.join(", ")}), backend has ${backendTiers.length} (${backendTiers.join(", ")})`
    );
  }

  for (const [tier, contractMin] of contractMap.entries()) {
    if (!backendMap.has(tier)) {
      throw new Error(`Tier '${tier}' defined in contract but missing in backend BADGE_THRESHOLDS`);
    }
    const backendMin = backendMap.get(tier);
    if (contractMin !== backendMin) {
      throw new Error(
        `Threshold drift for tier '${tier}': contract=${contractMin} XLM, backend=${backendMin} XLM`
      );
    }
  }

  // Validate backend list ordering (must be descending by min threshold)
  for (let i = 0; i < backendThresholds.length - 1; i++) {
    const current = backendThresholds.slice(i, i + 1)[0];
    const next = backendThresholds.slice(i + 1, i + 2)[0];
    if (current.min <= next.min) {
      throw new Error(
        `Backend BADGE_THRESHOLDS must be strictly descending by threshold amount: index ${i} (${current.min}) <= index ${i + 1} (${next.min})`
      );
    }
  }

  return true;
}

describe("Badge Threshold Cross-Validation (Contract <-> Backend)", () => {
  const contractPath = path.resolve(
    __dirname,
    "../../../contracts/greenpay-contract/src/lib.rs"
  );

  let contractSource;
  let contractThresholds;

  beforeAll(() => {
    expect(fs.existsSync(contractPath)).toBe(true);
    contractSource = fs.readFileSync(contractPath, "utf-8");
    contractThresholds = parseContractBadgeThresholds(contractSource);
  });

  test("contract defines all four expected badge threshold constants", () => {
    expect(Object.fromEntries(contractThresholds)).toEqual({
      seedling: 10,
      tree: 100,
      forest: 500,
      earth: 2000,
    });
  });

  test("backend BADGE_THRESHOLDS matches contract thresholds with zero drift", () => {
    expect(() => validateBadgeParity(contractThresholds, BADGE_THRESHOLDS)).not.toThrow();
  });

  test("drift detector fails if contract threshold is modified", () => {
    const driftingContract = new Map(contractThresholds);
    driftingContract.set("seedling", 15); // Drifted from 10 to 15
    expect(() => validateBadgeParity(driftingContract, BADGE_THRESHOLDS)).toThrow(
      /Threshold drift for tier 'seedling': contract=15 XLM, backend=10 XLM/
    );
  });

  test("drift detector fails if a tier is missing in backend or contract", () => {
    const missingContractTier = new Map([
      ["seedling", 10],
      ["tree", 100],
      ["forest", 500],
    ]);
    expect(() => validateBadgeParity(missingContractTier, BADGE_THRESHOLDS)).toThrow(
      /Tier count mismatch/
    );
  });

  test("drift detector fails if backend thresholds are not in descending order", () => {
    const unorderedBackend = [
      { tier: "seedling", min: 10 },
      { tier: "tree", min: 100 },
      { tier: "forest", min: 500 },
      { tier: "earth", min: 2000 },
    ];
    expect(() => validateBadgeParity(contractThresholds, unorderedBackend)).toThrow(
      /strictly descending/
    );
  });

  test("computeBadges produces correct tiers at boundary edges matching contract thresholds", () => {
    // Seedling boundary (10 XLM)
    expect(computeBadges(9)).toEqual([]);
    expect(computeBadges(9.9999999)).toEqual([]);
    expect(computeBadges(10)[0].tier).toBe("seedling");
    expect(computeBadges(99.9999999)[0].tier).toBe("seedling");

    // Tree boundary (100 XLM)
    expect(computeBadges(100)[0].tier).toBe("tree");
    expect(computeBadges(499.9999999)[0].tier).toBe("tree");

    // Forest boundary (500 XLM)
    expect(computeBadges(500)[0].tier).toBe("forest");
    expect(computeBadges(1999.9999999)[0].tier).toBe("forest");

    // Earth boundary (2000 XLM)
    expect(computeBadges(2000)[0].tier).toBe("earth");
    expect(computeBadges(100000)[0].tier).toBe("earth");
  });
});
