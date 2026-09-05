import { screen } from "@testing-library/react";
import ImpactCertificate from "../ImpactCertificate";
import { renderWithLocale } from "./renderWithLocale";
import type { ImpactClaim } from "@/lib/api";

const impactClaim: ImpactClaim = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  projectName: "Amazon Reforestation",
  category: "Reforestation",
  claimType: "sequestration",
  quantity: { value: "105", lowerBound: "80", upperBound: "130", unit: "kg_co2e" },
  uncertainty: { lowerBound: "80", upperBound: "130", confidencePercent: 90 },
  methodology: {
    id: "33333333-3333-4333-8333-333333333333",
    code: "forest-v1",
    name: "Forest plots",
    version: "1.0",
    description: "Measured biomass change",
    accountingApproach: "Plots",
    limitations: "Sampling and permanence uncertainty",
    comparisonScope: "forest-v1",
    registryUrl: null,
  },
  measurementPeriod: { start: "2025-01-01", end: "2025-12-31" },
  vintage: { start: "2025-01-01", end: "2025-12-31" },
  baseline: "Matched untreated plots",
  evidence: [],
  provenance: {
    status: "operator_stated",
    label: "Operator-stated",
    assertedBy: "Project operator",
    assertingPartyType: "project_operator",
    assertedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    migratedFromLegacy: false,
    migrationNote: null,
    attestation: null,
  },
};

const baseProps = {
  donorAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  donorName: "Jane Doe",
  totalDonatedXLM: "1500",
  badgeTier: "forest" as const,
  projectsSupported: [
    { id: "p1", name: "Amazon Reforestation" },
    { id: "p2", name: "Solar for Schools" },
  ],
  impactClaims: [impactClaim],
  attributionNotice: "Project-level outcomes are not allocated to this donor.",
};

describe("ImpactCertificate", () => {
  // Pin the clock so the "Issued on …" date stays deterministic in snapshots.
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-15T00:00:00.000Z"));
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it("renders the uncertainty range and operator-stated provenance", () => {
    renderWithLocale(<ImpactCertificate {...baseProps} />);
    expect(screen.getByText("80–130 kg CO₂e")).toBeInTheDocument();
    expect(screen.getByText("Operator-stated")).toBeInTheDocument();
    expect(screen.getByText(/No donor-level outcome attribution/)).toBeInTheDocument();
  });

  it("renders the donor name and key impact stats", () => {
    renderWithLocale(<ImpactCertificate {...baseProps} />);
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("1,500 XLM")).toBeInTheDocument();
    expect(screen.getByText("Forest")).toBeInTheDocument();
    expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
  });

  it("matches snapshot", () => {
    const { container } = renderWithLocale(<ImpactCertificate {...baseProps} />);
    expect(container).toMatchSnapshot();
  });

  describe("RTL (Arabic locale)", () => {
    it("formats the XLM amount and outcome range with Arabic-Indic numerals via Intl.NumberFormat", () => {
      renderWithLocale(<ImpactCertificate {...baseProps} />, "ar");
      expect(document.documentElement.dir).toBe("rtl");
      // formatXLM("1500", 2, "ar-EG") groups digits using Arabic-Indic
      // numerals rather than the "1,500" Western-Arabic default.
      expect(screen.getByText("١٬٥٠٠ XLM")).toBeInTheDocument();
      expect(screen.getByText("٨٠–١٣٠ kg CO₂e")).toBeInTheDocument();
    });

    it("matches snapshot under RTL", () => {
      const { container } = renderWithLocale(<ImpactCertificate {...baseProps} />, "ar");
      expect(container).toMatchSnapshot();
    });
  });
});
