/**
 * utils/donationTransaction.ts
 * Builds the Stellar payment transaction used by the donate screen, always
 * signing against the network passphrase from stellarNetwork config (never a
 * hardcoded Networks.TESTNET constant).
 */
import {
  Asset,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { getExpectedNetworkPassphrase } from './stellarNetwork';

export type BuildDonationPaymentParams = {
  /** Account / AccountResponse from Horizon `loadAccount`. */
  sourceAccount: ConstructorParameters<typeof TransactionBuilder>[0];
  destination: string;
  amount: string;
  projectId: string;
  fee?: string;
};

/** Build an unsigned native-XLM donation payment for the configured network. */
export function buildDonationPaymentTransaction(
  params: BuildDonationPaymentParams,
): Transaction {
  const { sourceAccount, destination, amount, projectId, fee = '100' } = params;

  return new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: getExpectedNetworkPassphrase(),
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
