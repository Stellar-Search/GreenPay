"use strict";

const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const {
  Account,
  Address,
  Asset,
  Contract,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} = require("@stellar/stellar-sdk");

const RUN_LOCAL_CHAIN_TESTS = process.env.RUN_LOCAL_CHAIN_TESTS === "true";
const describeLocalChain = RUN_LOCAL_CHAIN_TESTS ? describe : describe.skip;

const NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
const HORIZON_URL = process.env.LOCAL_STELLAR_HORIZON_URL || "http://127.0.0.1:8000";
const RPC_URL = process.env.LOCAL_STELLAR_RPC_URL || "http://127.0.0.1:8000/rpc";
const WASM_PATH = process.env.GREENPAY_WASM_PATH || path.join(
  __dirname,
  "../../../contracts/target/wasm32-unknown-unknown/release/greenpay_contract.wasm"
);
const PROJECT_ID = "0d38c1aa-7316-4ea0-a1c6-c03e97a101aa";
const AMOUNT_STROOPS = 123456789n;
const AMOUNT_XLM = "12.3456789";

jest.setTimeout(120_000);

async function converge(layer, observe, matches, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      lastObservation = await observe();
      if (matches(lastObservation)) return lastObservation;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const detail = lastError
    ? lastError.stack || lastError.message
    : JSON.stringify(lastObservation, (_, value) => typeof value === "bigint" ? value.toString() : value);
  throw new Error(`[${layer}] did not converge within ${timeoutMs}ms. Last observation: ${detail}`);
}

async function fundAccount(publicKey) {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(`${HORIZON_URL}/friendbot?addr=${encodeURIComponent(publicKey)}`);
    if (response.ok) return;

    const body = await response.text();
    if (response.status === 400 && /already (?:funded|exist)/i.test(body)) return;
    if (response.status < 500 || response.status >= 600 || attempt === maxAttempts - 1) {
      throw new Error(`[local network funding] Friendbot returned ${response.status}: ${body}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

// Errors that indicate the Soroban RPC container is still warming up rather
// than a genuine contract-logic failure.  These are safe to retry.
function isTransientRpcError(err) {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|503|502|network error|socket hang up|failed to fetch/i.test(
    String(err?.message || err)
  );
}

// beforeAll submits several operations back-to-back from the same `admin`
// keypair. Reloading the account from Horizon before every operation used to
// race Horizon's own ledger ingestion: RPC (core) confirms a transaction as
// final well before Horizon's separate ingestion pipeline reflects the
// bumped sequence number in its account endpoint, so the very next
// loadAccount() call could still return the *pre-submission* sequence and
// build a transaction the network then rejects with txBadSeq. Tracking the
// sequence locally per account — loaded from Horizon once, advanced only
// after the network confirms each submission — sidesteps that lag entirely.
const trackedAccounts = new Map();

async function getTrackedAccount(source, horizon) {
  const publicKey = source.publicKey();
  if (!trackedAccounts.has(publicKey)) {
    trackedAccounts.set(publicKey, await horizon.loadAccount(publicKey));
  }
  return trackedAccounts.get(publicKey);
}

async function submitContractOperation({ source, operation, horizon, rpcServer }, { maxAttempts = 5 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const trackedAccount = await getTrackedAccount(source, horizon);
      // Build from a snapshot of the tracked sequence rather than the
      // tracked Account itself: TransactionBuilder.build() advances
      // whatever account it's given, and a failed/retried attempt must not
      // advance the persistent tracker — only a confirmed submission does,
      // via trackedAccount.incrementSequenceNumber() below.
      const attemptAccount = new Account(trackedAccount.accountId(), trackedAccount.sequenceNumber());
      const transaction = new TransactionBuilder(attemptAccount, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const prepared = await rpcServer.prepareTransaction(transaction);
      prepared.sign(source);
      const submission = await rpcServer.sendTransaction(prepared);
      if (submission.status === "ERROR") {
        // errorResult is a parsed xdr.TransactionResult — decode its result
        // code (e.g. "txBadSeq") rather than surfacing opaque base64, both
        // for readable failures and so the retry check below can act on it.
        const code = submission.errorResult?.result().switch().name;
        const detail = code || submission.errorResult?.toXDR("base64") || "unknown error";
        throw new Error(`[contract submission] RPC rejected ${submission.hash}: ${detail}`);
      }

      const result = await converge(
        "chain finality",
        () => rpcServer.getTransaction(submission.hash),
        (r) => r.status === rpc.Api.GetTransactionStatus.SUCCESS,
        { timeoutMs: 20_000, intervalMs: 100 }
      );
      result.txHash = submission.hash;
      trackedAccount.incrementSequenceNumber();
      return result;
    } catch (err) {
      lastError = err;
      const badSeq = /txBadSeq/i.test(err.message);
      // A bad-sequence rejection means the tracked sequence itself has
      // drifted from the network's view (e.g. an account was funded/used
      // outside this helper) — the only way back in sync is to drop the
      // cached account and reload it from Horizon on the next attempt.
      if (badSeq) trackedAccounts.delete(source.publicKey());

      // Only retry on transient connectivity/availability errors, or a bad
      // sequence (self-correcting via the reload above) — never on genuine
      // contract-logic rejections, which fail identically on every retry.
      const retryable = isTransientRpcError(err) || badSeq;
      if (!retryable || attempt === maxAttempts - 1) throw err;
      const delayMs = 1_000 * 2 ** attempt; // 1 s, 2 s, 4 s, 8 s
      console.warn(`[contract submission] ${badSeq ? "bad-seq" : "transient"} error on attempt ${attempt + 1}/${maxAttempts}, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function deployGreenPay({ admin, horizon, rpcServer }) {
  // The path is intentionally configurable because CI downloads the build artifact.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const wasm = fs.readFileSync(WASM_PATH);
  const uploaded = await submitContractOperation({
    source: admin,
    operation: Operation.uploadContractWasm({ wasm }),
    horizon,
    rpcServer,
  });
  const wasmHash = scValToNative(uploaded.returnValue);

  const deployed = await submitContractOperation({
    source: admin,
    operation: Operation.createCustomContract({
      address: new Address(admin.publicKey()),
      wasmHash,
      salt: randomBytes(32),
    }),
    horizon,
    rpcServer,
  });
  return scValToNative(deployed.returnValue).toString();
}

async function ensureNativeAssetContract({ admin, horizon, rpcServer }) {
  try {
    await submitContractOperation({
      source: admin,
      operation: Operation.createStellarAssetContract({ asset: Asset.native() }),
      horizon,
      rpcServer,
    });
  } catch (err) {
    if (/ExistingValue|already exists|existing value/i.test(err.message)) return;
    throw new Error(`[native asset contract] ${err.message}`);
  }
}

async function invoke({ contractId, functionName, args, source, horizon, rpcServer }) {
  return submitContractOperation({
    source,
    operation: new Contract(contractId).call(functionName, ...args),
    horizon,
    rpcServer,
  });
}

async function readContract({ contractId, functionName, args, source, horizon, rpcServer }) {
  const account = await horizon.loadAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(new Contract(contractId).call(functionName, ...args))
    .setTimeout(30)
    .build();
  const simulation = await rpcServer.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(`[contract read] ${functionName} simulation failed: ${JSON.stringify(simulation)}`);
  }
  return scValToNative(simulation.result.retval);
}

describeLocalChain("local-chain donation convergence", () => {
  let pool;
  let eventStore;
  let chainIndexer;
  let donor;
  let projectWallet;
  let transactionHash;
  let databaseReady = false;

  beforeAll(async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(WASM_PATH)) {
      throw new Error(`[contract build] GreenPay WASM not found at ${WASM_PATH}`);
    }

    pool = require("../db/pool");
    const schemaSql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
    await pool.query(schemaSql);
    databaseReady = true;

    const horizon = new Horizon.Server(HORIZON_URL, { allowHttp: true });
    const rpcServer = new rpc.Server(RPC_URL, { allowHttp: true });
    const admin = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
    donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
    projectWallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
    await Promise.all([
      fundAccount(admin.publicKey()),
      fundAccount(donor.publicKey()),
      fundAccount(projectWallet.publicKey()),
    ]);
    await ensureNativeAssetContract({ admin, horizon, rpcServer });

    const contractId = await deployGreenPay({ admin, horizon, rpcServer });
    const tokenId = Asset.native().contractId(NETWORK_PASSPHRASE);
    const address = (value) => new Address(value).toScVal();
    await invoke({
      contractId,
      functionName: "initialize",
      args: [address(admin.publicKey())],
      source: admin,
      horizon,
      rpcServer,
    });
    await invoke({
      contractId,
      functionName: "allow_token",
      args: [address(admin.publicKey()), address(tokenId)],
      source: admin,
      horizon,
      rpcServer,
    });
    await invoke({
      contractId,
      functionName: "register_project",
      args: [
        address(admin.publicKey()),
        nativeToScVal(PROJECT_ID, { type: "string" }),
        nativeToScVal("Local Chain Project", { type: "string" }),
        address(projectWallet.publicKey()),
        nativeToScVal(8500, { type: "u32" }),
      ],
      source: admin,
      horizon,
      rpcServer,
    });

    await pool.query("DELETE FROM event_stream WHERE payload->'data'->>'projectId' = $1", [PROJECT_ID]);
    await pool.query("DELETE FROM donor_stats WHERE public_key = $1", [donor.publicKey()]);
    await pool.query("DELETE FROM profiles WHERE public_key = $1", [donor.publicKey()]);
    await pool.query("DELETE FROM projects WHERE id = $1", [PROJECT_ID]);
    await pool.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, status)
       VALUES ($1, 'Local Chain Project', 'Real contract integration fixture', 'environment', 'local', $2, 1000, 0, 0, 'active')`,
      [PROJECT_ID, projectWallet.publicKey()]
    );

    const { eventStore: sharedEventStore } = require("../eventSourcing/eventStore");
    const { handleDonation } = require("./indexerService");
    const { SorobanEventIndexer } = require("./sorobanEventIndexer");
    eventStore = sharedEventStore;
    await eventStore.startScheduler();
    chainIndexer = new SorobanEventIndexer({
      rpcServer,
      contractId,
      db: pool,
      handleDonation,
      pollIntervalMs: 100,
    });
    await chainIndexer.start();

    const donation = await invoke({
      contractId,
      functionName: "donate",
      args: [
        address(tokenId),
        address(donor.publicKey()),
        nativeToScVal(PROJECT_ID, { type: "string" }),
        nativeToScVal(AMOUNT_STROOPS, { type: "i128" }),
        nativeToScVal(1, { type: "u32" }),
      ],
      source: donor,
      horizon,
      rpcServer,
    });
    transactionHash = donation.txHash;

    await converge(
      "contract state",
      () => readContract({
        contractId,
        functionName: "get_project",
        args: [nativeToScVal(PROJECT_ID, { type: "string" })],
        source: donor,
        horizon,
        rpcServer,
      }),
      (project) => BigInt(project.total_raised) === AMOUNT_STROOPS
    );
  });

  afterAll(async () => {
    if (chainIndexer) await chainIndexer.stop();
    if (eventStore) await eventStore.stopScheduler();
    if (pool && databaseReady) {
      await pool.query("DELETE FROM event_stream WHERE payload->'data'->>'projectId' = $1", [PROJECT_ID]);
      if (donor) {
        await pool.query("DELETE FROM donor_stats WHERE public_key = $1", [donor.publicKey()]);
        await pool.query("DELETE FROM profiles WHERE public_key = $1", [donor.publicKey()]);
      }
      await pool.query("DELETE FROM projects WHERE id = $1", [PROJECT_ID]);
    }
    if (pool) {
      await pool.end();
    }
  });

  test("projects a real donated event at exact stroop precision", async () => {
    const eventRow = await converge(
      "Soroban event -> backend event store",
      async () => {
        const indexerStatus = chainIndexer.getStatus();
        if (indexerStatus.lastError) {
          throw new Error(`[Soroban event indexer] ${indexerStatus.lastError}`);
        }
        const result = await pool.query(
          `SELECT payload, processed
           FROM event_stream
           WHERE event_type = 'DonationRecorded'
             AND payload->'data'->>'transactionHash' = $1`,
          [transactionHash]
        );
        return result.rows[0] || null;
      },
      (row) => row?.payload?.data?.amountStroops === AMOUNT_STROOPS.toString()
    );

    if (eventRow.payload.data.amountXlm !== AMOUNT_XLM) {
      throw new Error(
        `[event decoding] expected ${AMOUNT_STROOPS} stroops to remain ${AMOUNT_XLM} XLM, ` +
        `received ${eventRow.payload.data.amountXlm}`
      );
    }

    const projectTotal = await converge(
      "event store -> project read model",
      async () => {
        const result = await pool.query(
          "SELECT raised_xlm::text AS total FROM projects WHERE id = $1",
          [PROJECT_ID]
        );
        return result.rows[0]?.total || null;
      },
      (total) => total === AMOUNT_XLM
    );

    const donorTotal = await converge(
      "event store -> donor read model",
      async () => {
        const result = await pool.query(
          "SELECT total_donated_xlm::text AS total FROM donor_stats WHERE public_key = $1",
          [donor.publicKey()]
        );
        return result.rows[0]?.total || null;
      },
      (total) => total === AMOUNT_XLM
    );

    expect({ projectTotal, donorTotal }).toEqual({
      projectTotal: AMOUNT_XLM,
      donorTotal: AMOUNT_XLM,
    });
  });
});
