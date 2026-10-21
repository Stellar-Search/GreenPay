/**
 * lib/stellar.ts — Stellar SDK helpers for GreenPay
 */
import { Horizon, Networks, Asset, Operation, TransactionBuilder, Transaction, Memo, rpc, Contract, scValToNative, Address, nativeToScVal, Account, xdr, StrKey, Keypair, Claimant } from "@stellar/stellar-sdk";
import { parseToStroops, stroopsToXLM } from "@/utils/amount";
import { getActiveManifest } from "@greenpay/config/networks";

// Load manifest once at module init — throws if misconfigured
const manifest = getActiveManifest();

export const NETWORK = manifest.network as "testnet" | "mainnet";
export const NETWORK_PASSPHRASE = manifest.networkPassphrase;
export const server = new Horizon.Server(manifest.horizonUrl);
export const rpcServer = new rpc.Server(manifest.sorobanRpcUrl);

/** GreenPay core contract */
export const CONTRACT_ID = manifest.contracts.greenPay || "";

/** Soroban escrow contract (deploy `contracts/escrow-contract`). */
export const ESCROW_CONTRACT_ID = manifest.contracts.escrow || "";

/** DAO governance contract */
export const DAO_GOVERNANCE_CONTRACT_ID = manifest.contracts.daoGovernance || "";

/**
 * The Stellar Asset Contract (SAC) address for native XLM is deterministic —
 * it's derived from the asset and the network passphrase, not a fixed
 * literal. Deriving it here means a mainnet build automatically gets the
 * mainnet SAC address instead of silently reusing testnet's.
 */
export function getNativeAssetContractId(networkPassphrase: string): string {
  return Asset.native().contractId(networkPassphrase);
}

export const NATIVE_ASSET_CONTRACT_ID = getNativeAssetContractId(NETWORK_PASSPHRASE);

/**
 * Fails fast at import time (rather than at donation time, buried behind a
 * simulation error) if any configured contract ID isn't even a well-formed
 * contract address for the active network's passphrase.
 */
function assertContractIdsAreWellFormed() {
  const configured: Array<[string, string]> = [
    ["NATIVE_ASSET_CONTRACT_ID", NATIVE_ASSET_CONTRACT_ID],
    ["NEXT_PUBLIC_CONTRACT_ID", CONTRACT_ID],
    ["NEXT_PUBLIC_ESCROW_CONTRACT_ID", ESCROW_CONTRACT_ID],
  ];
  for (const [name, id] of configured) {
    if (!id) continue; // CONTRACT_ID / ESCROW_CONTRACT_ID are optional
    if (!StrKey.isValidContract(id)) {
      throw new Error(
        `${name} ("${id}") is not a valid contract address for NEXT_PUBLIC_STELLAR_NETWORK=${NETWORK}.`,
      );
    }
  }
}
assertContractIdsAreWellFormed();

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
    throw formatSimulationFailure(simulated, { contractId });
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
  throw formatSimulationFailure(simulated, { contractId });
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
export function formatSimulationFailure(
  simulated: unknown,
  context?: { contractId?: string },
): Error {
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
  // A "MissingValue" storage error while invoking a contract instance is what
  // Soroban raises when the contract ID has no instance on the currently
  // configured RPC's network — e.g. NEXT_PUBLIC_STELLAR_NETWORK points at
  // mainnet but a contract ID was only ever deployed on testnet (or vice
  // versa). Surface that distinctly from a generic host error.
  if (/MissingValue/i.test(raw) && /contract instance/i.test(raw)) {
    const id = context?.contractId ? ` (${context.contractId})` : "";
    return new Error(
      `Contract${id} was not found on ${NETWORK}. This usually means NEXT_PUBLIC_STELLAR_NETWORK ("${NETWORK}") doesn't match the network this contract was deployed to.`,
    );
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

export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") {
    return false;
  }
  // Full validation: checks format AND CRC16 checksum
  return StrKey.isValidEd25519PublicKey(address);
}

export function explorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/tx/${hash}`;
}
export function accountUrl(addr: string): string {
  return `https://stellar.expert/explorer/${NETWORK === "mainnet" ? "public" : "testnet"}/account/${addr}`;
}

/**
 * Queries Soroban for independently auditable donation metrics.
 */
export async function getGlobalImpactStats() {
  if (!CONTRACT_ID) {
    console.warn("CONTRACT_ID not set, returning zero stats");
    return { totalRaisedXLM: "0", donationCount: 0 };
  }

  const contract = new Contract(CONTRACT_ID);
  
  try {
    const [totalRaised, donationCount] = await Promise.all([
      simulateCall(contract, "get_global_total"),
      simulateCall(contract, "get_donation_count")
    ]);

    // totalRaised is in stroops (i128).
    return {
      totalRaisedXLM: (Number(totalRaised) / 10_000_000).toLocaleString(undefined, { minimumFractionDigits: 2 }),
      donationCount: Number(donationCount),
    };
  } catch (err) {
    console.error("Failed to fetch global impact stats:", err);
    return { totalRaisedXLM: "0", donationCount: 0 };
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
 * Validates that a djb2 hash is a non-zero u32 correlation ID.
 * Rejects 0 (which the contract treats as a missing/invalid hash).
 */
export function validateHash(hash: number): boolean {
  return Number.isInteger(hash) && hash > 0 && hash <= 0xFFFFFFFF;
}

/**
 * A Horizon paging token (the opaque cursor Horizon's streaming endpoints
 * expect). Branded so it can't be confused with — or accidentally passed as
 * — an unrelated identifier such as a backend donation ID.
 */
declare const HORIZON_PAGING_TOKEN_BRAND: unique symbol;
export type HorizonPagingToken = string & { readonly [HORIZON_PAGING_TOKEN_BRAND]: true };

function toHorizonPagingToken(value: string): HorizonPagingToken {
  return value as HorizonPagingToken;
}

/**
 * Stream real-time payments to a wallet address using Horizon SSE.
 * Returns a cleanup function to close the stream.
 */
export function streamProjectPayments(
  walletAddress: string,
  onPayment: (payment: {
    id: string;
    pagingToken: HorizonPagingToken;
    from: string;
    amount: string;
    asset: string;
    createdAt: string;
    transactionHash: string;
  }) => void,
  cursor?: HorizonPagingToken,
  onStreamError?: (err: unknown) => void,
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
        pagingToken: toHorizonPagingToken(record.paging_token),
        from: record.from || record.funder || record.source_account,
        amount: record.amount || record.starting_balance || "0",
        asset: record.asset_code || "XLM",
        createdAt: record.created_at,
        transactionHash: record.transaction_hash,
      });
    },
    onerror: (err: any) => {
      console.error("Horizon SSE stream error:", err);
      onStreamError?.(err);
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

// ── Graduated donor onboarding ───────────────────────────────────────────────
// Helpers for donors who arrive without a wallet, without a funded account, or
// without both. Every function below keeps the donor's key in the donor's hands:
// nothing here sends a secret anywhere, and the sponsored-creation transaction
// is deliberately unsubmittable until the donor signs it themselves.
// See docs/adr/ADR-005-graduated-non-custodial-donor-onboarding.md.

/** 1 XLM in stroops, as a bigint so reserve arithmetic never touches floats. */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * The network base reserve — 0.5 XLM today, and changeable by validator vote,
 * which is why it is a named constant rather than a literal. An account's
 * minimum balance is (2 + subentries + sponsoring - sponsored) × this.
 */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/** Formats stroops as a 7-decimal XLM string without floating point. */
export function stroopsToXlmString(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parses a decimal XLM string into stroops, truncating past 7dp. */
export function xlmStringToStroops(xlm: string): bigint {
  const text = String(xlm).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Not a decimal XLM amount: "${xlm}"`);
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.slice(0, 7).padEnd(7, "0"));
  return negative ? -stroops : stroops;
}

/**
 * What kind of first-donation problem this donor actually has.
 *
 * These are deliberately about the *account*, not about the person. "No
 * wallet" is a UI state the caller already knows; what the network can tell us
 * is whether an account exists and whether it can afford to send anything.
 */
export type AccountReadiness =
  /** The address resolves and can fund the donation. Today's flow, untouched. */
  | "ready"
  /** The account exists but every spendable stroop is locked as reserve. */
  | "reserve_locked"
  /** The address has never been created on the network. */
  | "missing"
  /** Horizon could not be reached — must not be reported as either of the above. */
  | "unknown";

export interface ReserveStatus {
  readiness: AccountReadiness;
  exists: boolean;
  balanceStroops: bigint;
  minimumBalanceStroops: bigint;
  spendableStroops: bigint;
  spendableXlm: string;
  /** Present only when a specific amount was checked. */
  shortfallXlm?: string;
}

/**
 * Reads an account and answers the only question that matters before a
 * donation: can this account send this amount?
 *
 * Naive balance checks are why donors see `tx_insufficient_balance` after being
 * told they had enough. An account holding 1.4 XLM with a USDC trustline has
 * 1.5 XLM locked and can send precisely nothing.
 */
export async function getReserveStatus(
  publicKey: string,
  amountXlm?: string,
): Promise<ReserveStatus> {
  let account: Awaited<ReturnType<typeof server.loadAccount>>;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        readiness: "missing",
        exists: false,
        balanceStroops: 0n,
        minimumBalanceStroops: 0n,
        spendableStroops: 0n,
        spendableXlm: "0.0000000",
      };
    }
    // Anything else is a network problem, not an answer about the account.
    // Reporting it as "missing" would offer to sponsor an account that already
    // exists and lock the platform's reserve for nothing.
    return {
      readiness: "unknown",
      exists: false,
      balanceStroops: 0n,
      minimumBalanceStroops: 0n,
      spendableStroops: 0n,
      spendableXlm: "0.0000000",
    };
  }

  const native = account.balances.find((b) => b.asset_type === "native");
  const balanceStroops = xlmStringToStroops(native ? native.balance : "0");

  const raw = account as unknown as {
    subentry_count?: number;
    num_sponsoring?: number;
    num_sponsored?: number;
  };
  const entries =
    2n +
    BigInt(raw.subentry_count ?? 0) +
    BigInt(raw.num_sponsoring ?? 0) -
    BigInt(raw.num_sponsored ?? 0);
  const minimumBalanceStroops = (entries < 0n ? 0n : entries) * BASE_RESERVE_STROOPS;

  // The base fee is charged on top of the reserve, so it comes out of what the
  // donor can actually give.
  const rawSpendable = balanceStroops - minimumBalanceStroops - 100n;
  const spendableStroops = rawSpendable < 0n ? 0n : rawSpendable;

  const requested = amountXlm ? xlmStringToStroops(amountXlm) : 0n;
  const sufficient = requested > 0n ? spendableStroops >= requested : spendableStroops > 0n;

  return {
    readiness: sufficient ? "ready" : "reserve_locked",
    exists: true,
    balanceStroops,
    minimumBalanceStroops,
    spendableStroops,
    spendableXlm: stroopsToXlmString(spendableStroops),
    shortfallXlm:
      requested > 0n && !sufficient ? stroopsToXlmString(requested - spendableStroops) : undefined,
  };
}

/**
 * Generates the keypair for a starter account, in the browser.
 *
 * The secret never leaves this function's return value. It is not sent to the
 * backend, not logged, and not persisted anywhere by this module — where it is
 * kept is the caller's decision, made explicitly in lib/starterAccount.ts, so
 * that "who can see this key" has exactly one answer to audit.
 */
export function generateStarterKeypair(): { publicKey: string; secret: string } {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secret: keypair.secret() };
}

/**
 * Signs a transaction with a browser-held starter key.
 *
 * Used for exactly two things: co-signing the sponsored-creation transaction,
 * and signing the donor's own donations. It never signs anything the caller did
 * not build, and it verifies the network passphrase to make signing a
 * mainnet transaction with a testnet-scoped key impossible.
 */
export function signWithStarterKey(xdr: string, secret: string): string {
  const tx = new Transaction(xdr, NETWORK_PASSPHRASE);
  tx.sign(Keypair.fromSecret(secret));
  return tx.toXDR();
}

/** Derives the public key from a starter secret, for import/recovery flows. */
export function publicKeyFromSecret(secret: string): string {
  return Keypair.fromSecret(secret).publicKey();
}

/** True when a string is a well-formed Stellar secret key. */
export function isValidStellarSecret(secret: string): boolean {
  try {
    Keypair.fromSecret(secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a donation delivered as a claimable balance rather than a payment.
 *
 * Used when a straight payment cannot land — most often a project wallet with
 * no trustline for the asset. The project claims it unconditionally; the donor
 * keeps a claim that opens after `reclaimAfterSeconds`, so a project that never
 * adds the trustline does not silently absorb the funds.
 */
export async function buildClaimableDonationTransaction({
  donorPublicKey,
  projectWallet,
  amount,
  asset,
  memo,
  reclaimAfterSeconds = 14 * 24 * 60 * 60,
}: {
  donorPublicKey: string;
  projectWallet: string;
  amount: string;
  asset?: { code: string; issuer?: string };
  memo?: string;
  reclaimAfterSeconds?: number;
}) {
  const source = await server.loadAccount(donorPublicKey);
  const paymentAsset =
    asset && asset.code && asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native();

  const builder = new TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset: paymentAsset,
        amount,
        claimants: [
          new Claimant(projectWallet, Claimant.predicateUnconditional()),
          new Claimant(
            donorPublicKey,
            Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(String(reclaimAfterSeconds))),
          ),
        ],
      }),
    )
    .setTimeout(300);

  if (memo) builder.addMemo(Memo.text(memo.slice(0, 28)));
  return builder.build();
}

/** Claimable balances an address can claim right now. */
export async function listClaimableBalances(address: string) {
  const page = await server.claimableBalances().claimant(address).limit(50).call();
  return (page.records || []).map((record: { id: string; asset: string; amount: string; sponsor?: string }) => ({
    id: record.id,
    asset: record.asset,
    amount: record.amount,
    sponsor: record.sponsor,
  }));
}

/** Builds the transaction that claims one balance. */
export async function buildClaimBalanceTransaction({
  claimantPublicKey,
  balanceId,
}: {
  claimantPublicKey: string;
  balanceId: string;
}) {
  const source = await server.loadAccount(claimantPublicKey);
  return new TransactionBuilder(source, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(180)
    .build();
}

/**
 * Signs the account-upgrade challenge with a browser-held starter key.
 *
 * The backend verifies this against the starter address, proving the donor
 * controlled the account whose history they are asking to carry across.
 */
export function signUpgradeChallenge(message: string, secret: string): string {
  const keypair = Keypair.fromSecret(secret);
  const signature = keypair.sign(Buffer.from(message, "utf8"));
  return signature.toString("base64");
}
