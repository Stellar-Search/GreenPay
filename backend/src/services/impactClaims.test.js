"use strict";

const { Keypair } = require("@stellar/stellar-sdk");
const {
  buildAttestationPayload,
  canonicalJson,
  claimSummary,
  hashAttestationPayload,
  mapClaimRow,
} = require("./impactClaims");

const ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  project_id: "11111111-1111-4111-8111-111111111111",
  project_name: "Measured forest",
  category: "Reforestation",
  claim_type: "sequestration",
  quantity: "105.000000",
  uncertainty_low: "80.000000",
  uncertainty_high: "130.000000",
  confidence_percent: "90.00",
  unit: "kg_co2e",
  methodology_id: "33333333-3333-4333-8333-333333333333",
  methodology_code: "forest-v1",
  methodology_name: "Forest measurement",
  methodology_version: "1.0",
  methodology_description: "Measured biomass change.",
  accounting_approach: "Plots and conservative expansion factors.",
  methodology_limitations: "Sampling and permanence uncertainty.",
  comparison_scope: "forest-v1-sequestration",
  registry_url: null,
  measurement_period_start: "2025-01-01",
  measurement_period_end: "2025-12-31",
  vintage_start: "2025-01-01",
  vintage_end: "2025-12-31",
  baseline_description: "Matched untreated plots.",
  asserting_party: "Project operator",
  asserting_party_type: "project_operator",
  claim_status: "operator_stated",
  asserted_at: "2026-01-15T00:00:00.000Z",
  expires_at: null,
  revoked_at: null,
  migrated_from_legacy: false,
  evidence: [{
    id: "44444444-4444-4444-8444-444444444444",
    evidenceType: "measurement",
    sourceUri: "https://example.test/report",
    contentHash: "a".repeat(64),
    description: "Monitoring report",
    measurementDate: "2025-12-31",
    submittedBy: "Project operator",
    createdAt: "2026-01-15T00:00:00.000Z",
  }],
};

describe("impact claim provenance", () => {
  it("keeps uncertainty, methodology, period, baseline and assertion together", () => {
    const claim = mapClaimRow(ROW, new Date("2026-02-01T00:00:00Z").getTime());
    expect(claim.quantity).toEqual({
      value: "105.000000",
      lowerBound: "80.000000",
      upperBound: "130.000000",
      unit: "kg_co2e",
    });
    expect(claim.provenance.status).toBe("operator_stated");
    expect(claim.methodology.code).toBe("forest-v1");
    expect(claim.baseline).toBe("Matched untreated plots.");
  });

  it("promotes only a current anchored attestation to verified", () => {
    const claim = mapClaimRow({
      ...ROW,
      attestation_id: "55555555-5555-4555-8555-555555555555",
      attestation_status: "verified",
      attestation_expires_at: "2027-01-01T00:00:00.000Z",
      attestation_hash: "b".repeat(64),
      verifier_name: "Independent verifier",
      verifier_address: Keypair.random().publicKey(),
    }, new Date("2026-02-01T00:00:00Z").getTime());
    expect(claim.provenance.status).toBe("verified");
    expect(claimSummary([claim]).verified).toBe(1);
  });

  it("keeps a revoked attestation visibly withdrawn instead of hiding the old claim", () => {
    const claim = mapClaimRow({
      ...ROW,
      attestation_id: "55555555-5555-4555-8555-555555555555",
      attestation_status: "revoked",
      attestation_expires_at: "2027-01-01T00:00:00.000Z",
      attestation_revoked_at: "2026-02-01T00:00:00.000Z",
      attestation_revocation_reason: "Measurement error",
      attestation_hash: "b".repeat(64),
      verifier_name: "Independent verifier",
      verifier_address: Keypair.random().publicKey(),
    }, new Date("2026-03-01T00:00:00Z").getTime());

    expect(claim.provenance.status).toBe("revoked");
    expect(claim.provenance.attestation.revocationReason).toBe("Measurement error");
    expect(claimSummary([claim]).revoked).toBe(1);
  });

  it("hashes a stable canonical payload that includes the evidence digest inputs", () => {
    const claim = mapClaimRow(ROW);
    const payload = buildAttestationPayload(claim);
    expect(payload.evidence).toEqual([{ contentHash: "a".repeat(64), evidenceType: "measurement" }]);
    expect(hashAttestationPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ z: 1, a: 2 })).toBe("{\"a\":2,\"z\":1}");
  });
});
