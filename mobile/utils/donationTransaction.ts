/**
 * utils/donationTransaction.ts
 * Builds the Stellar payment transaction used by the donate screen, always
 * signing against the network passphrase from stellarNetwork config (never a
 * hardcoded Networks.TESTNET constant).
 */
import {
  Asset,
  Horizon,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { getExpectedNetworkPassphrase } from './stellarNetwork';

/**
 * Derive the network fee (stroops) for a classic payment from Horizon's live
 * fee statistics instead of a fixed constant (issue #512).
 *
 * A Soroban contract call's fee is derived from simulation; a classic payment
 * has no simulation, and the equivalent source of truth is the fee the network
 * is actually charging right now (`/fee_stats` → `fee_charged.mode`). A fixed
 * floor of `minFee` keeps the build correct on an uncongested network where the
 * mode is the 100-stroop base fee; multiplying by `multiplier` (2) gives
 * headroom so a donation submitted during a short fee spike is not dropped for
 * underpaying.
 *
 * Falls back to `minFee` whenever the stats are unavailable or unparseable so
 * the caller can keep building (never block a donation on a stats fetch).
 */
export function derivePaymentFee(
  feeStats: Pick<Horizon.ServerApi.FeeStatsResponse, 'fee_charged'> | null | undefined,
  options: { multiplier?: number; minFee?: number } = {},
): string {
  const { multiplier = 2, minFee = 100 } = options;
  const mode = Number(feeStats?.fee_charged?.mode);
  if (!Number.isFinite(mode) || mode <= 0) return String(minFee);
  return String(Math.max(minFee, Math.ceil(mode * multiplier)));
}

export type BuildDonationPaymentParams = {
  /** Account / AccountResponse from Horizon `loadAccount`. */
  sourceAccount: ConstructorParameters<typeof TransactionBuilder>[0];
  destination: string;
  amount: string;
  projectId: string;
  fee?: string;
  /**
   * Defaults to the network this build targets. Overridable because
   * babel-preset-expo inlines EXPO_PUBLIC_* at transform time, so a test
   * cannot select a network by assigning to process.env.
   */
  networkPassphrase?: string;
};

/** Build an unsigned native-XLM donation payment for the configured network. */
export function buildDonationPaymentTransaction(
  params: BuildDonationPaymentParams,
): Transaction {
  const {
    sourceAccount,
    destination,
    amount,
    projectId,
    fee = '100',
    networkPassphrase = getExpectedNetworkPassphrase(),
  } = params;

  return new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount,
      }),
    )
    .addMemo(Memo.text(`GreenPay:${projectId.slice(0, 16)}`))
    .setTimeout(60)
    .build();
}
