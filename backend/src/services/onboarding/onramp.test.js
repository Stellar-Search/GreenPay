/**
 * src/services/onboarding/onramp.test.js
 *
 * The compliance matrix is only worth encoding if something enforces its
 * completeness — otherwise it is a wiki page in a .js file.
 */
"use strict";

const {
  OBLIGATIONS,
  NON_DELEGABLE,
  PROVIDERS,
  OnrampConfigError,
  validateProvider,
  validateRegistry,
  availableProviders,
  handoffDisclosure,
  complianceMatrix,
} = require("./onramp");

function completeProvider(overrides = {}) {
  const obligations = {};
  for (const o of OBLIGATIONS) obligations[o] = "provider";
  for (const o of NON_DELEGABLE) obligations[o] = "platform";
  return {
    id: "fixture",
    name: "Fixture anchor",
    kind: "sep24",
    enabled: false,
    custodiesDonorKeys: false,
    obligations,
    notes: [],
    ...overrides,
  };
}

describe("the registry as committed", () => {
  it("validates", () => {
    expect(validateRegistry()).toBe(true);
  });

  it("assigns every obligation for every provider", () => {
    for (const provider of PROVIDERS) {
      for (const obligation of OBLIGATIONS) {
        expect(provider.obligations[obligation]).toBeDefined();
      }
    }
  });

  it("never lets a provider custody donor keys", () => {
    // A provider holding keys would contradict the guarantee the whole
    // platform rests on (ADR-002), whatever else it did well.
    for (const provider of PROVIDERS) {
      expect(provider.custodiesDonorKeys).toBe(false);
    }
  });

  it("ships every provider disabled until its compliance split is reviewed", () => {
    for (const provider of PROVIDERS) {
      expect(provider.enabled).toBe(false);
    }
  });

  it("keeps fiat custody with the provider, never the platform", () => {
    for (const provider of PROVIDERS) {
      expect(provider.obligations.fiat_custody).toBe("provider");
    }
  });

  it("keeps identity verification away from the platform", () => {
    for (const provider of PROVIDERS) {
      expect(["provider", "not_applicable"]).toContain(provider.obligations.kyc_identity_verification);
    }
  });
});

describe("validateProvider", () => {
  it("accepts a complete matrix", () => {
    expect(validateProvider(completeProvider())).toBe(true);
  });

  it("rejects an unassigned obligation", () => {
    const provider = completeProvider();
    delete provider.obligations.travel_rule;
    expect(() => validateProvider(provider)).toThrow(OnrampConfigError);
    expect(() => validateProvider(provider)).toThrow(/travel_rule.*unassigned/);
  });

  it("rejects an unknown owner", () => {
    const provider = completeProvider();
    provider.obligations.sanctions_screening = "somebody_else";
    expect(() => validateProvider(provider)).toThrow(/unknown owner/);
  });

  it("rejects an unknown obligation key, which usually means a typo hid a real gap", () => {
    const provider = completeProvider();
    provider.obligations.kyc = "provider";
    expect(() => validateProvider(provider)).toThrow(/unknown obligation/);
  });

  it("refuses to delegate what cannot be delegated", () => {
    for (const obligation of NON_DELEGABLE) {
      const provider = completeProvider();
      provider.obligations[obligation] = "provider";
      expect(() => validateProvider(provider)).toThrow(/cannot be delegated/);
    }
  });

  it("refuses a provider that would custody donor keys", () => {
    expect(() => validateProvider(completeProvider({ custodiesDonorKeys: true }))).toThrow(
      /non-custodial guarantee/,
    );
  });
});

describe("availableProviders", () => {
  it("offers nothing when no provider has been reviewed and enabled", () => {
    expect(availableProviders({ anchorUrl: "https://anchor.example" })).toEqual([]);
  });
});

describe("handoffDisclosure", () => {
  const disclosure = handoffDisclosure(completeProvider({ name: "Fixture anchor" }));

  it("says who takes the payment before the donor clicks through", () => {
    expect(disclosure.statements[0]).toMatch(/They take the payment, not GreenPay/);
  });

  it("says identity documents go to the provider, not the platform", () => {
    expect(disclosure.statements.join(" ")).toMatch(/GreenPay never sees/);
  });

  it("says plainly that a lost key cannot be recovered", () => {
    expect(disclosure.statements.join(" ")).toMatch(/cannot get it back for you if you lose the key/);
  });

  it("says who handles a card dispute", () => {
    expect(disclosure.statements.join(" ")).toMatch(/between you and the provider/);
  });
});

describe("complianceMatrix", () => {
  it("groups obligations by owner so 'what do we own' has a one-line answer", () => {
    const matrix = complianceMatrix(PROVIDERS[0]);
    expect(matrix.byOwner.provider).toContain("fiat_custody");
    expect(matrix.byOwner.platform).toContain("consumer_disclosures");
    expect(matrix.byOwner.shared).toContain("donor_support");
  });

  it("accounts for every obligation exactly once", () => {
    const matrix = complianceMatrix(PROVIDERS[0]);
    const all = Object.values(matrix.byOwner).flat();
    expect(all.sort()).toEqual([...OBLIGATIONS].sort());
  });
});
