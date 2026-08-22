import { Networks, StrKey } from "@stellar/stellar-sdk";
import { getNativeAssetContractId, formatSimulationFailure, server, streamProjectPayments } from "@/lib/stellar";

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

describe("streamProjectPayments", () => {
  function mockPaymentsBuilder() {
    const builder: any = {
      forAccount: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      stream: jest.fn().mockReturnValue(() => {}),
    };
    jest.spyOn(server, "payments").mockReturnValue(builder);
    return builder;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("defaults the Horizon cursor to 'now' when no paging token is known yet", () => {
    const builder = mockPaymentsBuilder();

    // No cursor argument — this is the state right after the initial
    // donation list loads from the backend, before any Horizon payment
    // record (and therefore any real paging token) has been seen.
    streamProjectPayments("GDONATIONWALLET", jest.fn());

    expect(builder.cursor).toHaveBeenCalledWith("now");
  });

  it("forwards a Horizon paging token — not a backend donation ID — as the cursor", () => {
    const builder = mockPaymentsBuilder();
    let observedPagingToken: string | undefined;

    streamProjectPayments("GDONATIONWALLET", (payment) => {
      observedPagingToken = payment.pagingToken;
    });
    const onmessage = builder.stream.mock.calls[0][0].onmessage;

    // A realistic Horizon payment record: `id` and `paging_token` happen to
    // look similar here, but the value the caller must reuse as the next
    // cursor is `paging_token`, never the backend donation's own `id` field.
    onmessage({
      type: "payment",
      id: "12884914593796097",
      paging_token: "12884914593796097-0",
      from: "GDONOR",
      amount: "10.0000000",
      asset_code: "XLM",
      created_at: "2026-01-01T00:00:00Z",
      transaction_hash: "tx-1",
    });

    expect(observedPagingToken).toBe("12884914593796097-0");

    streamProjectPayments("GDONATIONWALLET", jest.fn(), observedPagingToken as any);
    expect(builder.cursor).toHaveBeenLastCalledWith("12884914593796097-0");
  });

  it("surfaces stream errors to the caller instead of only logging them", () => {
    const builder = mockPaymentsBuilder();
    const onStreamError = jest.fn();
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

    streamProjectPayments("GDONATIONWALLET", jest.fn(), undefined, onStreamError);
    const onerror = builder.stream.mock.calls[0][0].onerror;
    const err = new Error("boom");
    onerror(err);

    expect(onStreamError).toHaveBeenCalledWith(err);
    consoleError.mockRestore();
  });
});
