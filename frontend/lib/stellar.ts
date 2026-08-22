/**
 * lib/stellar.ts — Stellar SDK helpers for GreenPay
 */
import { Horizon, Networks, Asset, Operation, TransactionBuilder, Transaction, Memo, rpc, Contract, scValToNative, Address, nativeToScVal, Account, xdr } from "@stellar/stellar-sdk";
import { parseToStroops } from "@/utils/amount";

export const NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet") as "testnet" | "mainnet";
const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";
const RPC_URL     = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

export const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
export const server = new Horizon.Server(HORIZON_URL);
export const rpcServer = new rpc.Server(RPC_URL);
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID || "";

/** Soroban escrow contract (deploy `contracts/escrow-contract`). */
export const ESCROW_CONTRACT_ID = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID || "";

export async function getXLMBalance(publicKey: string): Promise<string> {
  try {
    const account = await server.loadAccount(publicKey);
    const xlm = account.balances.find((b) => b.asset_type === "native");
    return xlm ? xlm.balance : "0";
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

/**
 * Funds a testnet account via Stellar Friendbot.
 * Returns the credited XLM balance after funding.
 * Only works on testnet — throws on mainnet.
 */
export async function getFriendBotFunding(publicKey: string): Promise<string> {
  if (NETWORK === "mainnet") {
    throw new Error("Friendbot is only available on testnet.");
  }
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // A 400 with "createAccountAlreadyExist" means it was already funded
    if (response.status === 400 && body.includes("createAccountAlreadyExist")) {
      throw new Error("Account is already funded.");
    }
    throw new Error(`Friendbot request failed (${response.status}).`);
  }
  // Wait briefly for Horizon to process the account creation
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return getXLMBalance(publicKey);
}

export async function getAssetBalance(publicKey: string, assetCode: string, assetIssuer: string): Promise<string | null> {
  try {
    const account = await server.loadAccount(publicKey);
    const asset = account.balances.find((b: any) => b.asset_code === assetCode && b.asset_issuer === assetIssuer);
    // If the asset is not present on the account, the user likely doesn't have the trustline.
    if (!asset) return null;
    return asset.balance;
  } catch {
    throw new Error("Account not found or not funded.");
  }
}

/**
 * Builds a changeTrust transaction to add (or remove) a trustline for a
 * Stellar asset.  Used by DonateForm to let donors add a USDC trustline
 * in-app instead of forcing them to leave the app.
 *
 * Passing `limit = "0"` removes the trustline (standard Stellar behaviour).
 * Omitting `limit` sets the default (max) trust limit.
 */
export async function buildChangeTrustTransaction({
  publicKey,
  assetCode,
  assetIssuer,
  limit,
}: {
  publicKey: string;
  assetCode: string;
  assetIssuer: string;
  limit?: string;
}) {
  const source = await server.loadAccount(publicKey);
  const asset = new Asset(assetCode, assetIssuer);

  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset,
        ...(limit !== undefined ? { limit } : {}),
      }),
    )
    .setTimeout(60);

  return builder.build();
}

export async function buildDonationTransaction({
  fromPublicKey, toPublicKey, amount, memo, asset,
}: { fromPublicKey: string; toPublicKey: string; amount: string; memo?: string; asset?: { code: string; issuer?: string } }) {
  const source = await server.loadAccount(fromPublicKey);
  const paymentAsset = asset && asset.code && asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native();

  const builder = new TransactionBuilder(source, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: toPublicKey, asset: paymentAsset, amount }))
    .setTimeout(60);
  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));
  return builder.build();
}

/**
 * Builds a Soroban contract donation transaction.
 * Invokes the contract's donate() function which transfers XLM and records the donation on-chain.
 */
export async function buildContractDonationTransaction({
  contractId,
  tokenAddress,
  donor,
  projectId,
  amount,
  msgHash,
}: {
  contractId: string;
  tokenAddress: string;
  donor: string;
  projectId: string;
  amount: string;
  msgHash: number;
}) {
  const source = await server.loadAccount(donor);
  const contract = new Contract(contractId);

  // Convert parameters to Soroban types
  const donorAddress = new Address(donor);
  const tokenAddr = new Address(tokenAddress);
  const amountInStroops = parseToStroops(amount);

  // Build the contract invocation transaction
  const builder = new TransactionBuilder(source, {
    fee: "1000000", // Higher fee for contract calls
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "donate",
        tokenAddr.toScVal(),
        donorAddress.toScVal(),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(amountInStroops, { type: "i128" }),
        nativeToScVal(msgHash, { type: "u32" })
      )
    )
    .setTimeout(60);

  const tx = builder.build();

  // Simulate to get the resource fees
  const simulated = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(simulated)) {
    // Prepare the transaction with simulation results
    return rpc.assembleTransaction(tx, simulated).build();
  } else {
    throw formatSimulationFailure(simulated);
  }
}

/**
 * Builds a Soroban transaction that calls `release_escrow(client, job_id)` on the escrow contract.
 * The client account must match the job’s client and must have funded this job via `create_job` on-chain.
 */
export async function buildReleaseEscrowTransaction({
  contractId,
  jobId,
  clientAddress,
}: {
  contractId: string;
  jobId: string;
  clientAddress: string;
}) {
  if (!contractId.trim()) {
    throw new Error("Escrow contract is not configured (set NEXT_PUBLIC_ESCROW_CONTRACT_ID).");
  }
  const source = await server.loadAccount(clientAddress);
  const contract = new Contract(contractId);
  const clientAddr = new Address(clientAddress);
  const tx = new TransactionBuilder(source, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "release_escrow",
        clientAddr.toScVal(),
        nativeToScVal(jobId, { type: "string" }),
      ),
    )
    .setTimeout(60)
    .build();

  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationSuccess(simulated)) {
    return rpc.assembleTransaction(tx, simulated).build();
  }
  throw formatSimulationFailure(simulated);
}

/**
 * Builds a small memo transaction to record a milestone on-chain.
 * Sends a tiny amount (0.00001 XLM) to the source account itself (circular payment).
 */
export async function buildMilestoneTransaction({
  publicKey,
  milestoneTitle,
}: {
  publicKey: string;
  milestoneTitle: string;
}) {
  const source = await server.loadAccount(publicKey);
  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: publicKey,
        asset: Asset.native(),
        amount: "0.00001",
      }),
    )
    .addMemo(Memo.text(`Milestone: ${milestoneTitle.slice(0, 17)}`))
    .setTimeout(60);

  return builder.build();
}

/** Maps Soroban simulation errors to short, user-facing messages. */
export function formatSimulationFailure(simulated: unknown): Error {
  const raw = JSON.stringify(simulated);
  if (/underfunded|insufficient/i.test(raw) && /balance|fee|Fund/i.test(raw)) {
    return new Error(
      "Insufficient XLM to pay Soroban fees or complete the release. Add test XLM to this account.",
    );
  }
  if (raw.includes("Job not found")) {
    return new Error(
      "This job ID is not on the escrow contract. Fund it first with create_job using the same job ID.",
    );
  }
  if (raw.includes("Only the client can release")) {
    return new Error("Connect the client wallet — only the client can release escrow.");
  }
  if (raw.includes("Already released")) {
    return new Error("This escrow was already released on-chain.");
  }
  if (raw.includes("HostError") || raw.includes("VmValidation")) {
    return new Error(
      "The contract rejected this call. Check network (testnet/mainnet) and contract ID.",
    );
  }
  return new Error(
    "Could not simulate release_escrow. Verify NEXT_PUBLIC_ESCROW_CONTRACT_ID and that the job exists on-chain.",
  );
}

/** Maps Horizon submission errors to user-friendly text. */
export function formatTransactionError(err: unknown): string {
  const e = err as {
    response?: {
      data?: {
        extras?: { result_codes?: { transaction?: string; operations?: string[] } };
        detail?: string;
      };
    };
    message?: string;
  };
  const codes = e?.response?.data?.extras?.result_codes;
  const ops = (codes?.operations ?? []).join(" ");
  const txc = codes?.transaction ?? "";
  const blob = `${txc} ${ops}`.toLowerCase();
  if (blob.includes("underfunded") || blob.includes("op_underfunded")) {
    return "Insufficient XLM balance for network fees or the payment.";
  }
  if (blob.includes("insufficient_fee") || blob.includes("tx_insufficient_fee")) {
    return "Network fee too low. Wait and try again, or use a higher fee.";
  }
  if (blob.includes("bad_auth") || blob.includes("op_bad_auth")) {
    return "Transaction was not authorized. Use Freighter with the client account.";
  }
  if (e?.response?.data?.detail && typeof e.response.data.detail === "string") {
    return e.response.data.detail;
  }
  const msg = e?.message || String(err);
  return msg.length > 280 ? `${msg.slice(0, 280)}…` : msg;
}

export async function submitTransaction(signedXDR: string) {
  const tx = new Transaction(signedXDR, NETWORK_PASSPHRASE);
  try {
    return await server.submitTransaction(tx);
  } catch (err: unknown) {
    throw new Error(formatTransactionError(err));
  }
}

/**
 * Why this exists: Horizon's submitTransaction only tells us whether a transaction
 * *landed* in a ledger. For a Soroban `donate()` call, a successful simulation does
 * NOT guarantee successful execution — the contract can still panic on submission
 * (e.g. a checked-arithmetic overflow), and Horizon will happily report
 * `successful: false` while the caller has already moved on assuming success.
 *
 * The kind of failure a donation can hit, used to pick the right user-facing copy:
 *  - "submission_failed": the network refused the tx before it ever reached a
 *    ledger (bad sequence, insufficient fee, bad auth, etc.) — nothing happened
 *    on-chain, safe to treat like any other rejected submission.
 *  - "execution_failed": the tx landed on-chain but execution failed/panicked.
 *    Network fees may still have been charged, but the donate() call itself did
 *    not apply — any optimistic UI (badge, totals, leaderboard) must be reverted.
 *  - "unknown": we could not determine the final outcome (RPC/Horizon unreachable,
 *    or the transaction was still NOT_FOUND after the poll timeout). Must not be
 *    presented as either success or failure.
 */
export type DonationOutcome = "submission_failed" | "execution_failed" | "unknown";

export class DonationSubmissionError extends Error {
  outcome: DonationOutcome;
  hash?: string;
  panicReason?: string;

  constructor(message: string, outcome: DonationOutcome, hash?: string, panicReason?: string) {
    super(message);
    this.name = "DonationSubmissionError";
    this.outcome = outcome;
    this.hash = hash;
    this.panicReason = panicReason;
  }
}

/**
 * Polls Soroban RPC's getTransaction until it stops reporting NOT_FOUND (the tx
 * needs a moment to be ingested after Horizon reports it landed) or the timeout
 * elapses, in which case the caller should treat the outcome as unknown.
 */
export async function waitForTransactionOutcome(
  hash: string,
  { timeoutMs = 20_000, intervalMs = 1500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<rpc.Api.GetTransactionResponse | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let res: rpc.Api.GetTransactionResponse;
    try {
      res = await rpcServer.getTransaction(hash);
    } catch {
      return null; // RPC unreachable — caller treats as unknown outcome.
    }
    if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return res;
    if (Date.now() >= deadline) return res; // still NOT_FOUND — caller treats as unknown.
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Best-effort extraction of a human-readable panic/error reason from a failed
 * Soroban RPC getTransaction result's diagnostic events. Falls back to `undefined`
 * (never throws) so it can be safely used just to enrich an already-failed state.
 * Mirrors formatSimulationFailure's convention of matching on stringified content
 * rather than requiring a fully-typed contract error registry.
 */
export function extractPanicReason(result: rpc.Api.GetTransactionResponse | null | undefined): string | undefined {
  if (!result) return undefined;
  try {
    const events = (result as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr;
    if (events && events.length) {
      for (const evt of events) {
        try {
          const body = evt.event().body().v0();
          const data = scValToNative(body.data());
          const flat = typeof data === "string" ? data : JSON.stringify(data);
          if (/overflow/i.test(flat)) return "arithmetic overflow while recording the donation";
          if (/underflow/i.test(flat)) return "arithmetic underflow while recording the donation";
          if (typeof data === "string" && /error|panic|host/i.test(flat)) return data;
        } catch {
          // Malformed/undecodable event — skip it and keep looking.
        }
      }
    }
  } catch {
    // Fall through to the generic message below.
  }
  return undefined;
}

/**
 * Submits a signed donation transaction and confirms its *final* on-chain outcome
 * before returning — callers should only commit optimistic UI (badge, totals,
 * leaderboard, backend recordDonation) once this resolves successfully.
 *
 * On any failure it throws a DonationSubmissionError carrying `.outcome` so the UI
 * can distinguish an on-chain contract panic from an ambiguous network failure.
 */
export async function submitAndConfirmDonation(signedXDR: string): Promise<{ hash: string }> {
  const tx = new Transaction(signedXDR, NETWORK_PASSPHRASE);

  let submitResult: Horizon.HorizonApi.SubmitTransactionResponse;
  try {
    submitResult = await server.submitTransaction(tx);
  } catch (err: unknown) {
    const e = err as { response?: { data?: { extras?: { result_codes?: unknown } } } };
    if (e?.response?.data?.extras?.result_codes) {
      // Horizon rejected the tx before it ever reached a ledger — nothing happened on-chain.
      throw new DonationSubmissionError(formatTransactionError(err), "submission_failed");
    }
    throw new DonationSubmissionError(
      "We couldn't confirm this donation — the network didn't respond. Please check your transaction history before retrying.",
      "unknown",
    );
  }

  if (submitResult.successful) {
    return { hash: submitResult.hash };
  }

  // Horizon confirmed the tx landed on-chain but failed — consult Soroban RPC to
  // try to surface the contract panic reason from diagnostic events.
  const rpcResult = await waitForTransactionOutcome(submitResult.hash);

  if (!rpcResult || rpcResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new DonationSubmissionError(
      "We couldn't confirm this donation's final status. Please check your transaction history.",
      "unknown",
      submitResult.hash,
    );
  }

  const panicReason = extractPanicReason(rpcResult);
  throw new DonationSubmissionError(
    panicReason
      ? `Your donation didn't go through — the contract rejected it (${panicReason}).`
      : "Your donation didn't go through — the transaction was submitted but failed during on-chain execution.",
    "execution_failed",
    submitResult.hash,
    panicReason,
  );
}

export function isValidStellarAddress(a: string): boolean { return /^G[A-Z0-9]{55}$/.test(a); }
export function explorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/tx/${hash}`;
}
export function accountUrl(addr: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/account/${addr}`;
}

/**
 * Queries the Soroban contract for global impact metrics.
 */
export async function getGlobalImpactStats() {
  if (!CONTRACT_ID) {
    console.warn("CONTRACT_ID not set, returning zero stats");
    return { totalRaisedXLM: "0", totalCO2OffsetGrams: "0", donationCount: 0 };
  }

  const contract = new Contract(CONTRACT_ID);
  
  try {
    const [totalRaised, totalCO2, donationCount] = await Promise.all([
      simulateCall(contract, "get_global_total"),
      simulateCall(contract, "get_global_co2"),
      simulateCall(contract, "get_donation_count")
    ]);

    // totalRaised is in stroops (i128), totalCO2 is in grams (i128)
    return {
      totalRaisedXLM: (Number(totalRaised) / 10_000_000).toLocaleString(undefined, { minimumFractionDigits: 2 }),
      totalCO2OffsetGrams: totalCO2.toString(),
      donationCount: Number(donationCount),
    };
  } catch (err) {
    console.error("Failed to fetch global impact stats:", err);
    return { totalRaisedXLM: "0", totalCO2OffsetGrams: "0", donationCount: 0 };
  }
}

/**
 * Queries the contract for donor statistics including badge tier.
 */
export async function getDonorStats(donorAddress: string) {
  if (!CONTRACT_ID) {
    return null;
  }

  const contract = new Contract(CONTRACT_ID);

  try {
    const donor = new Address(donorAddress);
    const stats = await simulateCall(contract, "get_donor_stats", [donor.toScVal()]);

    return {
      totalDonated: Number(stats.total_donated) / 10_000_000,
      donationCount: Number(stats.donation_count),
      badge: stats.badge,
      co2OffsetGrams: Number(stats.co2_offset_grams),
    };
  } catch (err) {
    console.error("Failed to fetch donor stats:", err);
    return null;
  }
}

/**
 * Simple djb2 hash function for donation messages.
 * Returns a 32-bit unsigned integer hash.
 */
export function hashMessage(message: string): number {
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = ((hash << 5) + hash) + message.charCodeAt(i);
    hash = hash >>> 0; // Convert to unsigned 32-bit integer
  }
  return hash;
}

/**
 * Stream real-time payments to a wallet address using Horizon SSE.
 * Returns a cleanup function to close the stream.
 */
export function streamProjectPayments(
  walletAddress: string,
  onPayment: (payment: {
    id: string;
    from: string;
    amount: string;
    asset: string;
    createdAt: string;
    transactionHash: string;
  }) => void,
  cursor?: string,
): () => void {
  const builder = server
    .payments()
    .forAccount(walletAddress)
    .order("asc")
    .cursor(cursor || "now");

  const closeStream = builder.stream({
    onmessage: (record: any) => {
      if (record.type !== "payment" && record.type !== "create_account") return;
      onPayment({
        id: record.id,
        from: record.from || record.funder || record.source_account,
        amount: record.amount || record.starting_balance || "0",
        asset: record.asset_code || "XLM",
        createdAt: record.created_at,
        transactionHash: record.transaction_hash,
      });
    },
    onerror: (err: any) => {
      console.error("Horizon SSE stream error:", err);
    },
  });

  return closeStream;
}

export interface ProjectDiscussionMessage {
  id: string;
  from: string;
  amount: string;
  memo: string;
  createdAt: string;
  transactionHash: string;
}

/**
 * Fetches recent donation memos for a project's wallet address by reading Horizon payment
 * history and joining it with the transaction memo.
 *
 * Notes:
 * - Only text memos are supported (memo_type === "text").
 * - Memo length on Stellar is limited; DonateForm caps to 100 chars for UX but on-chain
 *   the memo will be truncated by wallets/SDKs if too long.
 */
export async function fetchProjectDiscussion(
  walletAddress: string,
  limit = 50,
): Promise<ProjectDiscussionMessage[]> {
  const payments = await server
    .payments()
    .forAccount(walletAddress)
    .order("desc")
    .limit(limit)
    .call();

  const rows = (payments?.records ?? []) as any[];
  const donationPayments = rows.filter(
    (r) =>
      (r.type === "payment" || r.type === "create_account") &&
      typeof r.transaction_hash === "string" &&
      r.transaction_hash,
  );

  const txHashes = Array.from(
    new Set(donationPayments.map((p) => p.transaction_hash as string)),
  ).slice(0, limit);

  const txMemoByHash = new Map<string, string>();
  const txCreatedAtByHash = new Map<string, string>();

  const txResults = await Promise.allSettled(
    txHashes.map(async (h) => {
      const tx = await server.transactions().transaction(h).call();
      const memoType = (tx as any).memo_type as string | undefined;
      const memo = (tx as any).memo as string | undefined;
      const createdAt = (tx as any).created_at as string | undefined;
      if (memoType === "text" && memo && createdAt) {
        txMemoByHash.set(h, memo);
        txCreatedAtByHash.set(h, createdAt);
      }
    }),
  );
  // Avoid unused lint warnings in some configs
  void txResults;

  const messages: ProjectDiscussionMessage[] = donationPayments
    .map((p) => {
      const hash = p.transaction_hash as string;
      const memo = txMemoByHash.get(hash);
      const createdAt = txCreatedAtByHash.get(hash) || p.created_at;
      if (!memo || !createdAt) return null;
      return {
        id: `${p.id}`,
        from: p.from || p.funder || p.source_account,
        amount: p.amount || p.starting_balance || "0",
        memo,
        createdAt,
        transactionHash: hash,
      };
    })
    .filter(Boolean) as ProjectDiscussionMessage[];

  // Chronological feed (oldest → newest)
  messages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return messages;
}

async function simulateCall(contract: Contract, method: string, args: any[] = []) {
  // We use a dummy account for simulation
  const dummyAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "-1");
  const tx = new TransactionBuilder(dummyAccount, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result!.retval);
  }
  throw new Error(`Simulation failed for ${method}: ${JSON.stringify(result)}`);
}
