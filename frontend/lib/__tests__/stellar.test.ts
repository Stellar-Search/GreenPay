import { Networks, StrKey } from "@stellar/stellar-sdk";
import { getNativeAssetContractId, formatSimulationFailure } from "@/lib/stellar";

describe("getNativeAssetContractId", () => {
  it("derives the known testnet native XLM SAC address", () => {
    // This is the exact literal that was previously hardcoded in
    // DonateForm.tsx regardless of NETWORK — pinning it here proves the
    // derived value still matches the known-correct testnet address.
    expect(getNativeAssetContractId(Networks.TESTNET)).toBe(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    );
  });

  it("derives a different, validly-formed address for mainnet", () => {
    const mainnetId = getNativeAssetContractId(Networks.PUBLIC);
    const testnetId = getNativeAssetContractId(Networks.TESTNET);
    expect(mainnetId).not.toBe(testnetId);
    expect(StrKey.isValidContract(mainnetId)).toBe(true);
  });
});

describe("formatSimulationFailure", () => {
  it("flags a likely network mismatch when the contract instance is missing", () => {
    const simulated = {
      error:
        'HostError: Error(Storage, MissingValue)\ncontract instance not found for CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    };
    const err = formatSimulationFailure(simulated, {
      contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    });
    expect(err.message).toMatch(/was not found on/i);
    expect(err.message).toMatch(/NEXT_PUBLIC_STELLAR_NETWORK/);
  });

  it("falls back to the generic host error message for other host errors", () => {
    const simulated = { error: "HostError: Error(Contract, InvalidAction)" };
    const err = formatSimulationFailure(simulated);
    expect(err.message).toMatch(/check network \(testnet\/mainnet\) and contract id/i);
  });
});
