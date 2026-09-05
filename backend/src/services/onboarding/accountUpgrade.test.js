/**
 * src/services/onboarding/accountUpgrade.test.js
 */
"use strict";

const { Account, Keypair, Networks, Operation, TransactionBuilder } = require("@stellar/stellar-sdk");
const {
  STARTER_ACCOUNT_DISCLOSURES,
  UPGRADE_LIMITATIONS,
  UpgradeError,
  challengeMessage,
  createUpgradeChallenge,
  verifySignature,
  verifyChallengeEnvelope,
  CHALLENGE_DATA_NAME,
  completeUpgrade,
  resolveCanonicalAddress,
  addressesFor,
} = require("./accountUpgrade");

const STARTER = Keypair.random();
const WALLET = Keypair.random();

function sign(keypair, message) {
  return keypair.sign(Buffer.from(message, "utf8")).toString("base64");
}

/**
 * Builds the unsubmittable challenge envelope a wallet would sign, mirroring
 * frontend/lib/challenge.ts. Options let each test break exactly one property
 * so the guards are proved individually rather than in a lump.
 */
function challengeEnvelope(keypair, nonce, overrides = {}) {
  const {
    sequence = "-1",
    name = CHALLENGE_DATA_NAME,
    value = nonce,
    source,
    sign: shouldSign = true,
    signWith = keypair,
    extraOperation = false,
  } = overrides;

  const address = keypair.publicKey();
  const builder = new TransactionBuilder(new Account(source || address, sequence), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).addOperation(Operation.manageData({ name, value, source: source || address }));

  if (extraOperation) {
    builder.addOperation(Operation.manageData({ name: "extra", value: "x", source: source || address }));
  }

  const tx = builder.setTimeout(300).build();
  if (shouldSign) tx.sign(signWith);
  return tx.toXDR();
}

describe("STARTER_ACCOUNT_DISCLOSURES", () => {
  it("states the unrecoverable-key limitation in plain words", () => {
    const text = STARTER_ACCOUNT_DISCLOSURES.giveUp.join(" ");
    expect(text).toMatch(/does not have a copy of your key/i);
    expect(text).toMatch(/no password reset/i);
  });

  it("warns that clearing browser data loses the key", () => {
    expect(STARTER_ACCOUNT_DISCLOSURES.giveUp.join(" ")).toMatch(/clear your browser data/i);
  });

  it("promises the history is portable, which is the thing that makes the trade acceptable", () => {
    expect(STARTER_ACCOUNT_DISCLOSURES.keep.join(" ")).toMatch(/move your donation history/i);
  });

  it("offers a mitigation rather than only a warning", () => {
    expect(STARTER_ACCOUNT_DISCLOSURES.mitigation.join(" ")).toMatch(/export your key/i);
  });
});

describe("UPGRADE_LIMITATIONS", () => {
  it("says the donations themselves stay on the original address", () => {
    expect(UPGRADE_LIMITATIONS.doesNotMove.join(" ")).toMatch(/stay recorded on Stellar/i);
  });

  it("states the leaderboard limitation up front rather than letting it be discovered", () => {
    expect(UPGRADE_LIMITATIONS.doesNotMove.join(" ")).toMatch(/leaderboard position/i);
  });

  it("reminds the donor to move any leftover XLM themselves", () => {
    expect(UPGRADE_LIMITATIONS.doesNotMove.join(" ")).toMatch(/still sitting in the starter account/i);
  });
});

describe("challengeMessage", () => {
  it("binds the nonce to both addresses so a proof cannot be reused elsewhere", () => {
    const message = challengeMessage({ nonce: "abc", fromAddress: "GA", toAddress: "GB" });
    expect(message).toContain("from:GA");
    expect(message).toContain("to:GB");
    expect(message).toContain("nonce:abc");
  });
});

describe("createUpgradeChallenge", () => {
  it("issues a single-use nonce with an expiry", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const result = await createUpgradeChallenge(
      { fromAddress: STARTER.publicKey(), toAddress: WALLET.publicKey() },
      pool,
    );
    expect(result.nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(result.expiresInMs).toBeGreaterThan(0);
    expect(pool.query.mock.calls[0][0]).toMatch(/INSERT INTO account_upgrades/);
  });

  it("refuses a migration to the same address", async () => {
    await expect(
      createUpgradeChallenge({ fromAddress: STARTER.publicKey(), toAddress: STARTER.publicKey() }, { query: jest.fn() }),
    ).rejects.toMatchObject({ code: "SAME_ADDRESS" });
  });

  it("refuses a malformed address", async () => {
    await expect(
      createUpgradeChallenge({ fromAddress: "nope", toAddress: WALLET.publicKey() }, { query: jest.fn() }),
    ).rejects.toBeInstanceOf(UpgradeError);
  });
});

describe("verifySignature", () => {
  const message = "hello";

  it("accepts a genuine signature", () => {
    expect(verifySignature({ address: STARTER.publicKey(), message, signatureBase64: sign(STARTER, message) })).toBe(true);
  });

  it("rejects a signature by a different key", () => {
    expect(verifySignature({ address: WALLET.publicKey(), message, signatureBase64: sign(STARTER, message) })).toBe(false);
  });

  it("rejects a signature over different text", () => {
    expect(verifySignature({ address: STARTER.publicKey(), message: "goodbye", signatureBase64: sign(STARTER, message) })).toBe(false);
  });

  it("returns false rather than throwing on garbage, so a typo is not a 500", () => {
    expect(verifySignature({ address: STARTER.publicKey(), message, signatureBase64: "!!!" })).toBe(false);
    expect(verifySignature({ address: "nope", message, signatureBase64: sign(STARTER, message) })).toBe(false);
  });
});

describe("verifyChallengeEnvelope", () => {
  const NONCE = "a".repeat(48);

  it("accepts a correctly built, correctly signed challenge", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(true);
  });

  it("rejects an unsigned envelope", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE, { sign: false }),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects an envelope signed by a different key", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE, { signWith: STARTER }),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects a replayed envelope carrying a different nonce", () => {
    // Without the nonce check, a signature captured once would authorise every
    // future migration of the same address.
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, "b".repeat(48)),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects an envelope with a live sequence number, which could be submitted", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE, { sequence: "12345" }),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects an envelope carrying an extra operation", () => {
    // A second operation is how a real transfer would be smuggled alongside
    // the harmless one the donor believes they are signing.
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE, { extraOperation: true }),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects an envelope using a different data name", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE, { name: "Something else" }),
        address: WALLET.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("rejects an envelope sourced by a different account", () => {
    expect(
      verifyChallengeEnvelope({
        signedXdr: challengeEnvelope(WALLET, NONCE),
        address: STARTER.publicKey(),
        nonce: NONCE,
      }),
    ).toBe(false);
  });

  it("returns false rather than throwing on garbage", () => {
    expect(verifyChallengeEnvelope({ signedXdr: "not-xdr", address: WALLET.publicKey(), nonce: NONCE })).toBe(false);
  });
});

describe("completeUpgrade", () => {
  function record(overrides = {}) {
    return {
      id: "33333333-3333-4333-8333-333333333333",
      from_address: STARTER.publicKey(),
      to_address: WALLET.publicKey(),
      nonce: "n0nce",
      state: "challenged",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  function fixture(rec = record()) {
    const message = challengeMessage({
      nonce: rec.nonce,
      fromAddress: rec.from_address,
      toAddress: rec.to_address,
    });
    const writes = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        writes.push({ sql, params });
        if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: 4, total: "137.5000000" }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async (sql) => (/SELECT \* FROM account_upgrades/.test(sql) ? { rows: [rec] } : { rows: [] })),
      connect: jest.fn().mockResolvedValue(client),
    };
    return { message, writes, client, pool };
  }

  it("links the addresses and reports what moved", async () => {
    const rec = record();
    const { message, writes, pool } = fixture(rec);
    const result = await completeUpgrade(
      {
        upgradeId: "33333333-3333-4333-8333-333333333333",
        fromSignature: sign(STARTER, message),
        toChallengeXdr: challengeEnvelope(WALLET, rec.nonce),
      },
      { pool },
    );

    expect(result).toMatchObject({ state: "completed", migrated: 4, canonicalAddress: WALLET.publicKey() });
    expect(writes.some((w) => /INSERT INTO donor_address_links/.test(w.sql))).toBe(true);
    expect(writes.some((w) => /COMMIT/.test(w.sql))).toBe(true);
  });

  it("never rewrites the donations themselves", async () => {
    // The ledger says which address made them; the database must not disagree.
    const rec = record();
    const { message, writes, pool } = fixture(rec);
    await completeUpgrade(
      {
        upgradeId: "33333333-3333-4333-8333-333333333333",
        fromSignature: sign(STARTER, message),
        toChallengeXdr: challengeEnvelope(WALLET, rec.nonce),
      },
      { pool },
    );
    expect(writes.some((w) => /UPDATE donations/i.test(w.sql))).toBe(false);
  });

  it("rejects a claim on a stranger's history", async () => {
    // Only the destination signing would let anyone adopt any address's history.
    const rec = record();
    const { message, pool, client } = fixture(rec);
    const impostor = Keypair.random();
    await expect(
      completeUpgrade(
        {
          upgradeId: "33333333-3333-4333-8333-333333333333",
          fromSignature: sign(impostor, message),
          toChallengeXdr: challengeEnvelope(WALLET, rec.nonce),
        },
        { pool },
      ),
    ).rejects.toMatchObject({ code: "FROM_SIGNATURE_INVALID" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rejects dumping history onto an address the caller does not control", async () => {
    const rec = record();
    const { message, pool } = fixture(rec);
    const impostor = Keypair.random();
    await expect(
      completeUpgrade(
        {
          upgradeId: "33333333-3333-4333-8333-333333333333",
          fromSignature: sign(STARTER, message),
          toChallengeXdr: challengeEnvelope(impostor, rec.nonce),
        },
        { pool },
      ),
    ).rejects.toMatchObject({ code: "TO_SIGNATURE_INVALID" });
  });

  it("rejects an expired challenge, because a replayable proof is not a proof", async () => {
    const rec = record({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const { message, pool } = fixture(rec);
    await expect(
      completeUpgrade(
        {
          upgradeId: rec.id,
          fromSignature: sign(STARTER, message),
          toChallengeXdr: challengeEnvelope(WALLET, rec.nonce),
        },
        { pool },
      ),
    ).rejects.toMatchObject({ code: "UPGRADE_EXPIRED" });
  });

  it("is idempotent once completed", async () => {
    const rec = record({ state: "completed", migrated_donations: 4 });
    const { message, pool, client } = fixture(rec);
    const result = await completeUpgrade(
      { upgradeId: rec.id, fromSignature: sign(STARTER, message), toChallengeXdr: challengeEnvelope(WALLET, rec.nonce) },
      { pool },
    );
    expect(result.deduplicated).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("rolls back rather than leaving a half-migrated donor", async () => {
    const rec = record();
    const message = challengeMessage({
      nonce: rec.nonce,
      fromAddress: rec.from_address,
      toAddress: rec.to_address,
    });
    const seen = [];
    const client = {
      query: jest.fn(async (sql) => {
        seen.push(sql);
        if (/INSERT INTO donor_address_links/.test(sql)) throw new Error("constraint violation");
        return { rows: [{ count: 0, total: "0" }] };
      }),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async (sql) => (/SELECT \* FROM account_upgrades/.test(sql) ? { rows: [rec] } : { rows: [] })),
      connect: jest.fn().mockResolvedValue(client),
    };

    await expect(
      completeUpgrade(
        { upgradeId: rec.id, fromSignature: sign(STARTER, message), toChallengeXdr: challengeEnvelope(WALLET, rec.nonce) },
        { pool },
      ),
    ).rejects.toThrow("constraint violation");

    expect(seen).toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("reports a missing upgrade as 404 rather than a server error", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }), connect: jest.fn() };
    await expect(
      completeUpgrade({ upgradeId: "nope", fromSignature: "x", toChallengeXdr: "y" }, { pool }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("resolveCanonicalAddress", () => {
  it("follows a link to the wallet that owns the history", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ canonical_address: WALLET.publicKey() }] }) };
    await expect(resolveCanonicalAddress(STARTER.publicKey(), pool)).resolves.toBe(WALLET.publicKey());
  });

  it("returns the address unchanged when it was never linked", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(resolveCanonicalAddress(WALLET.publicKey(), pool)).resolves.toBe(WALLET.publicKey());
  });
});

describe("addressesFor", () => {
  it("returns every address whose history belongs to this donor", async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ linked_address: STARTER.publicKey() }] }),
    };
    await expect(addressesFor(WALLET.publicKey(), pool)).resolves.toEqual([
      WALLET.publicKey(),
      STARTER.publicKey(),
    ]);
  });

  it("returns just the address itself when nothing is linked", async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(addressesFor(WALLET.publicKey(), pool)).resolves.toEqual([WALLET.publicKey()]);
  });
});
