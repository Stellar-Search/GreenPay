/**
 * lib/__tests__/starterAccount.test.ts
 *
 * The browser-held key is the part of this design that trades safety for
 * reach, so the tests are mostly about the properties that keep the trade
 * honest: the key never leaves, the disclosure is unavoidable, and a browser
 * that silently refuses to store it says so.
 */
import {
  STARTER_ACCOUNT_TRADEOFFS,
  createStarterAccount,
  loadStarterAccount,
  importStarterAccount,
  forgetStarterAccount,
  isPersisted,
  markExported,
  markUpgraded,
  signWithStarterAccount,
  signUpgradeWithStarterAccount,
  shouldPromptExport,
} from "@/lib/starterAccount";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

beforeEach(() => {
  window.localStorage.clear();
  // The module keeps an in-memory copy so a private-mode browser can still
  // sign; clearing storage alone would leak an account between tests.
  forgetStarterAccount();
});

describe("STARTER_ACCOUNT_TRADEOFFS", () => {
  it("says GreenPay cannot recover the key", () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.giveUp.join(" ")).toMatch(/does not have a copy of your key/i);
    expect(STARTER_ACCOUNT_TRADEOFFS.giveUp.join(" ")).toMatch(/no password reset/i);
  });

  it("warns that clearing browser data loses the key", () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.giveUp.join(" ")).toMatch(/clear your browser data/i);
  });

  it("promises history is portable, which is what makes the trade acceptable", () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.keep.join(" ")).toMatch(/move your donation history/i);
  });

  it("offers a mitigation rather than only a warning", () => {
    expect(STARTER_ACCOUNT_TRADEOFFS.mitigation.join(" ")).toMatch(/export your key/i);
  });
});

describe("createStarterAccount", () => {
  it("creates a real, usable Stellar keypair", () => {
    const account = createStarterAccount(true);
    expect(account.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(Keypair.fromSecret(account.secret).publicKey()).toBe(account.publicKey);
  });

  it("persists it so a reload keeps the donor's account", () => {
    const account = createStarterAccount(true);
    expect(loadStarterAccount()?.publicKey).toBe(account.publicKey);
  });

  it("never writes the secret anywhere the backend could read it", () => {
    // The one storage key it owns is the only place a secret exists. Anything
    // else holding one would be a leak by definition.
    const account = createStarterAccount(true);
    const keys = Object.keys(window.localStorage);
    const holders = keys.filter((key) => window.localStorage.getItem(key)?.includes(account.secret));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatch(/^greenpay_starter_account_/);
  });

  it("refuses to create a key without an acknowledgement", () => {
    // Typed as `true` so this is normally a compile error; the runtime guard
    // covers the JavaScript caller the type system cannot reach.
    expect(() => createStarterAccount(false as unknown as true)).toThrow(/acknowledged/i);
  });

  it("namespaces storage by network so a testnet key can't be used on mainnet", () => {
    createStarterAccount(true);
    expect(Object.keys(window.localStorage)[0]).toContain("testnet");
  });
});

describe("loadStarterAccount", () => {
  it("returns null when nothing is stored", () => {
    expect(loadStarterAccount()).toBeNull();
  });

  it("returns null for corrupt JSON rather than throwing during a render", () => {
    window.localStorage.setItem("greenpay_starter_account_testnet", "{not json");
    expect(loadStarterAccount()).toBeNull();
  });

  it("returns null for a stored value that is not a usable key", () => {
    // Worse than nothing: it would let the UI offer a donate button that can
    // never sign.
    window.localStorage.setItem(
      "greenpay_starter_account_testnet",
      JSON.stringify({ publicKey: "G".repeat(56), secret: "not-a-secret" }),
    );
    expect(loadStarterAccount()).toBeNull();
  });
});

describe("importStarterAccount", () => {
  it("recovers an account from its secret", () => {
    const keypair = Keypair.random();
    const imported = importStarterAccount(keypair.secret());
    expect(imported.publicKey).toBe(keypair.publicKey());
  });

  it("treats an imported key as already backed up", () => {
    expect(importStarterAccount(Keypair.random().secret()).exportedAt).toBeDefined();
  });

  it("rejects something that is not a secret key", () => {
    expect(() => importStarterAccount("hello")).toThrow(/valid Stellar secret key/i);
  });
});

describe("isPersisted", () => {
  it("is true after a successful write", () => {
    createStarterAccount(true);
    expect(isPersisted()).toBe(true);
  });

  it("is false when storage silently drops the write", () => {
    // A private-mode browser can accept setItem and discard it, leaving the
    // donor with an account they will not have tomorrow.
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
    createStarterAccount(true);
    expect(isPersisted()).toBe(false);
    setItem.mockRestore();
  });

  it("is false when storage throws outright", () => {
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => createStarterAccount(true)).not.toThrow();
    expect(isPersisted()).toBe(false);
    setItem.mockRestore();
  });
});

describe("signing", () => {
  it("signs a transaction with the stored key", () => {
    const account = createStarterAccount(true);
    const unsigned = buildDummyTransaction(account.publicKey);
    const signed = signWithStarterAccount(unsigned);
    expect(signed).not.toBe(unsigned);
    expect(signed.length).toBeGreaterThan(unsigned.length);
  });

  it("refuses to sign when no key is stored", () => {
    expect(() => signWithStarterAccount("AAAA")).toThrow(/No starter account/i);
  });

  it("produces an upgrade signature that verifies against the stored address", () => {
    const account = createStarterAccount(true);
    const message = "GreenPay account upgrade\nnonce:abc";
    const signature = signUpgradeWithStarterAccount(message);
    const verified = Keypair.fromPublicKey(account.publicKey).verify(
      Buffer.from(message, "utf8"),
      Buffer.from(signature, "base64"),
    );
    expect(verified).toBe(true);
  });

  it("produces a signature that does not verify for different text", () => {
    const account = createStarterAccount(true);
    const signature = signUpgradeWithStarterAccount("one thing");
    const verified = Keypair.fromPublicKey(account.publicKey).verify(
      Buffer.from("another thing", "utf8"),
      Buffer.from(signature, "base64"),
    );
    expect(verified).toBe(false);
  });
});

describe("lifecycle markers", () => {
  it("records that the key was exported", () => {
    createStarterAccount(true);
    expect(markExported()?.exportedAt).toBeDefined();
  });

  it("records the wallet the history moved to", () => {
    createStarterAccount(true);
    const wallet = Keypair.random().publicKey();
    expect(markUpgraded(wallet)?.upgradedTo).toBe(wallet);
  });

  it("keeps the key after an upgrade, because it may still hold a balance", () => {
    // Silently discarding the only key to an account with funds in it would
    // destroy those funds.
    const account = createStarterAccount(true);
    markUpgraded(Keypair.random().publicKey());
    expect(loadStarterAccount()?.secret).toBe(account.secret);
  });

  it("forgets the key only when asked", () => {
    createStarterAccount(true);
    forgetStarterAccount();
    expect(loadStarterAccount()).toBeNull();
  });
});

describe("shouldPromptExport", () => {
  it("stays quiet until the donor has something to lose", () => {
    // Reminding someone with an empty account to back it up trains them to
    // ignore the warning that matters.
    const account = createStarterAccount(true);
    expect(shouldPromptExport(account, false)).toBe(false);
  });

  it("prompts once a donation has been made", () => {
    expect(shouldPromptExport(createStarterAccount(true), true)).toBe(true);
  });

  it("stops prompting once the key has been exported", () => {
    createStarterAccount(true);
    expect(shouldPromptExport(markExported(), true)).toBe(false);
  });

  it("never prompts when there is no account", () => {
    expect(shouldPromptExport(null, true)).toBe(false);
  });
});

function buildDummyTransaction(publicKey: string): string {
  return new TransactionBuilder(new Account(publicKey, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: publicKey, asset: Asset.native(), amount: "1" }))
    .setTimeout(60)
    .build()
    .toXDR();
}
