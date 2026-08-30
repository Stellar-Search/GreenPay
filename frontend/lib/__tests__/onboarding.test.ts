/**
 * lib/__tests__/onboarding.test.ts
 *
 * Path selection. The behaviour that matters most is the one that does
 * nothing: a donor who can already donate must never be routed into an
 * onboarding flow.
 */
import { assessDonorSituation } from "@/lib/onboarding";
import * as stellar from "@/lib/stellar";

jest.mock("@/lib/stellar", () => ({
  ...jest.requireActual("@/lib/stellar"),
  getReserveStatus: jest.fn(),
}));

const getReserveStatus = stellar.getReserveStatus as jest.MockedFunction<typeof stellar.getReserveStatus>;

const ADDRESS = "G" + "A".repeat(55);

function status(overrides: Partial<stellar.ReserveStatus>): stellar.ReserveStatus {
  return {
    readiness: "ready",
    exists: true,
    balanceStroops: BigInt(0),
    minimumBalanceStroops: BigInt(0),
    spendableStroops: BigInt(0),
    spendableXlm: "0.0000000",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("assessDonorSituation", () => {
  it("leaves a funded donor on the existing wallet flow", async () => {
    // The fastest path for them is the one that existed before any of this was
    // built, so nothing new is offered.
    getReserveStatus.mockResolvedValue(status({ readiness: "ready", spendableXlm: "48.9999900" }));
    const result = await assessDonorSituation({ walletDetected: true, address: ADDRESS });
    expect(result.recommendedPath).toBe("connected_wallet");
    expect(result.reason).toMatch(/funded and ready/i);
  });

  it("recommends sponsorship when the address is not an account yet", async () => {
    getReserveStatus.mockResolvedValue(status({ readiness: "missing", exists: false }));
    const result = await assessDonorSituation({ walletDetected: false, address: ADDRESS });
    expect(result.recommendedPath).toBe("sponsored_account");
    expect(result.reason).toMatch(/minimum balance/i);
  });

  it("recommends an on-ramp when the account exists but its balance is locked", async () => {
    // Sponsorship cannot help here — the account already exists. Recommending
    // it anyway would send the donor into a flow that would refuse them.
    getReserveStatus.mockResolvedValue(status({ readiness: "reserve_locked", spendableXlm: "0.0000000" }));
    const result = await assessDonorSituation({ walletDetected: true, address: ADDRESS });
    expect(result.recommendedPath).toBe("onramp");
    expect(result.reason).toMatch(/locked as Stellar's minimum reserve/i);
  });

  it("says how much a partially-locked account can still send", async () => {
    getReserveStatus.mockResolvedValue(status({ readiness: "reserve_locked", spendableXlm: "0.4000000" }));
    const result = await assessDonorSituation({ walletDetected: true, address: ADDRESS, amountXlm: "10" });
    expect(result.reason).toContain("0.4000000 XLM");
  });

  it("never guesses when the network did not answer", async () => {
    // Offering sponsorship here could lock reserve for an account that already
    // exists; claiming the donor is broke would simply be false.
    getReserveStatus.mockResolvedValue(status({ readiness: "unknown", exists: false }));
    const result = await assessDonorSituation({ walletDetected: true, address: ADDRESS });
    expect(result.readiness).toBe("unknown");
    expect(result.reason).toMatch(/couldn't reach the Stellar network/i);
  });

  it("sends a donor with a wallet but no address to connect it", async () => {
    const result = await assessDonorSituation({ walletDetected: true, address: null });
    expect(result.recommendedPath).toBe("connected_wallet");
    expect(getReserveStatus).not.toHaveBeenCalled();
  });

  it("sends a donor with neither wallet nor address to the on-ramp", async () => {
    const result = await assessDonorSituation({ walletDetected: false, address: null });
    expect(result.recommendedPath).toBe("onramp");
    expect(result.reason).toMatch(/no wallet yet/i);
  });

  it("passes the requested amount through so the check is about this donation", async () => {
    getReserveStatus.mockResolvedValue(status({ readiness: "ready" }));
    await assessDonorSituation({ walletDetected: true, address: ADDRESS, amountXlm: "25" });
    expect(getReserveStatus).toHaveBeenCalledWith(ADDRESS, "25");
  });
});
