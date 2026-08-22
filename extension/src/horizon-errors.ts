/**
 * Detects Horizon bad-sequence errors (tx_bad_seq) thrown by
 * server.submitTransaction(). These occur when the account's on-chain
 * sequence number has advanced past the one used to build the transaction.
 */
export function isBadSequenceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  if (!response) return false;
  const data = response.data as Record<string, unknown> | undefined;
  if (!data) return false;
  const extras = data.extras as Record<string, unknown> | undefined;
  if (!extras) return false;
  const resultCodes = extras.result_codes as Record<string, unknown> | undefined;
  if (!resultCodes) return false;
  return resultCodes.transaction === 'tx_bad_seq';
}
