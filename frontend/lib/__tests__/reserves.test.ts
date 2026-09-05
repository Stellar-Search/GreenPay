/**
 * lib/__tests__/reserves.test.ts
 *
 * The client-side half of the base-reserve boundary. It has to agree with the
 * backend's arithmetic exactly: a UI that says "you can send this" while the
 * network says otherwise is worse than no check at all.
 */
import {
  BASE_RESERVE_STROOPS,
  STROOPS_PER_XLM,
  stroopsToXlmString,
  xlmStringToStroops,
  getReserveStatus,
  isValidStellarSecret,
  publicKeyFromSecret,
  generateStarterKeypair,
  server,
} from "@/lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";

const XLM = (n: string) => xlmStringToStroops(n);

function horizonAccount({
  balance = "0",
  subentries = 0,
  sponsoring = 0,
  sponsored = 0,
}: { balance?: string; subentries?: number; sponsoring?: number; sponsored?: number }) {
  return {
    balances: [{ asset_type: "native", balance }],
    subentry_count: subentries,
    num_sponsoring: sponsoring,
    num_sponsored: sponsored,
  };
}

describe("stroop conversion", () => {
  it("matches the network's fixed-point representation", () => {
    expect(xlmStringToStroops("1")).toBe(STROOPS_PER_XLM);
    expect(BASE_RESERVE_STROOPS).toBe(BigInt(5_000_000));
  });

  it("round-trips without floating-point drift", () => {
    for (const value of ["0.0000000", "0.5000000", "1234.5678901"]) {
      expect(stroopsToXlmString(xlmStringToStroops(value))).toBe(value);
    }
  });

  it("truncates rather than rounding up past seven decimals", () => {
    expect(xlmStringToStroops("0.99999999")).toBe(BigInt(9_999_999));
  });

  it("refuses a value that is not a decimal amount", () => {
    expect(() => xlmStringToStroops("lots")).toThrow(/decimal XLM amount/);
  });
});

describe("getReserveStatus", () => {
  let loadAccount: jest.SpyInstance;

  afterEach(() => {
    loadAccount?.mockRestore();
  });

  function mockAccount(account: unknown) {
    loadAccount = jest.spyOn(server, "loadAccount").mockResolvedValue(account as never);
  }

  function mockFailure(error: unknown) {
    loadAccount = jest.spyOn(server, "loadAccount").mockRejectedValue(error);
  }

  it("reports a plain funded account as ready", async () => {
    mockAccount(horizonAccount({ balance: "50" }));
    const status = await getReserveStatus("GA", "10");
    expect(status.readiness).toBe("ready");
    expect(status.minimumBalanceStroops).toBe(XLM("1"));
  });

  it("reports an account whose whole balance is locked as reserve", async () => {
    // 1.4 XLM with a trustline looks funded and can send nothing: 1.5 XLM is
    // locked. This is the case that produces `tx_insufficient_balance` for a
    // donor who was told they had enough.
    mockAccount(horizonAccount({ balance: "1.4", subentries: 1 }));
    const status = await getReserveStatus("GA", "0.1");
    expect(status.readiness).toBe("reserve_locked");
    expect(status.spendableStroops).toBe(BigInt(0));
    expect(status.minimumBalanceStroops).toBe(XLM("1.5"));
  });

  it("refuses a payment one stroop over the boundary and allows it exactly at it", async () => {
    mockAccount(horizonAccount({ balance: "2" }));
    const spendable = XLM("2") - XLM("1") - BigInt(100);

    const exact = await getReserveStatus("GA", stroopsToXlmString(spendable));
    expect(exact.readiness).toBe("ready");

    loadAccount.mockRestore();
    mockAccount(horizonAccount({ balance: "2" }));
    const over = await getReserveStatus("GA", stroopsToXlmString(spendable + BigInt(1)));
    expect(over.readiness).toBe("reserve_locked");
    expect(over.shortfallXlm).toBe("0.0000001");
  });

  it("gives a fully sponsored account a zero minimum balance", async () => {
    // The point of the sponsored path: the donor can spend everything they
    // receive, because the platform carries the reserve.
    mockAccount(horizonAccount({ balance: "10", sponsored: 2 }));
    const status = await getReserveStatus("GA", "9.9");
    expect(status.minimumBalanceStroops).toBe(BigInt(0));
    expect(status.readiness).toBe("ready");
  });

  it("reports a 404 as a missing account", async () => {
    mockFailure({ response: { status: 404 } });
    const status = await getReserveStatus("GA");
    expect(status.readiness).toBe("missing");
    expect(status.exists).toBe(false);
  });

  it("reports a network failure as unknown rather than as a missing account", async () => {
    // Reading a 503 as "missing" would offer to sponsor an account that
    // already exists and lock the platform's reserve for nothing.
    mockFailure({ response: { status: 503 } });
    expect((await getReserveStatus("GA")).readiness).toBe("unknown");
  });

  it("treats an unreachable Horizon as unknown too", async () => {
    mockFailure(new Error("network down"));
    expect((await getReserveStatus("GA")).readiness).toBe("unknown");
  });

  it("handles an account with no native balance entry", async () => {
    mockAccount({ balances: [], subentry_count: 0 });
    const status = await getReserveStatus("GA");
    expect(status.spendableStroops).toBe(BigInt(0));
  });
});

describe("key helpers", () => {
  it("generates a keypair whose secret derives its public key", () => {
    const { publicKey, secret } = generateStarterKeypair();
    expect(publicKeyFromSecret(secret)).toBe(publicKey);
  });

  it("generates a different keypair every time", () => {
    expect(generateStarterKeypair().publicKey).not.toBe(generateStarterKeypair().publicKey);
  });

  it("recognises a valid secret and rejects anything else", () => {
    expect(isValidStellarSecret(Keypair.random().secret())).toBe(true);
    expect(isValidStellarSecret("SABC")).toBe(false);
    expect(isValidStellarSecret("")).toBe(false);
  });
});
