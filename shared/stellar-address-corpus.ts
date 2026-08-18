/**
 * shared/stellar-address-corpus.ts
 * Canonical address corpus shared by the three GreenPay clients.
 *
 * Consumed by `extension/src/__tests__/stellar-address-cross-validation.test.ts`,
 * which proves that the frontend, mobile, and extension validators accept and
 * reject exactly the same set of addresses. Extend this corpus when a new edge
 * case needs to be enforced everywhere at once.
 */

/** Real, checksum-valid Stellar Ed25519 public keys (G…). */
export const VALID_G_ADDRESSES = [
  // From Stellar's own documentation examples.
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
  // Freshly generated, checksum-valid keypairs (verified via StrKey).
  'GD5WWAXRHZKGWMCV5KCT7GCTFDVHB4VP7WWHT5XXEM6HYV5FBM43DGZF',
  'GAABPIID5VBQ2TW7ACBC7LSWJV2ZDC3STOJJDZ7UC2DWVE6SGE23C5KP',
  // The all-zero (null) account id, checksum-valid.
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
] as const;

/**
 * Shape-valid Stellar-looking strings (G + 55 base32 chars) that are NOT
 * checksum-valid. This is exactly the class of value a `/^G[A-Z0-9]{55}$/`
 * regex wrongly accepts and a StrKey check correctly rejects.
 */
export const CHECKSUM_INVALID_ADDRESSES = [
  `G${'A'.repeat(55)}`,
  `G${'B'.repeat(55)}`,
  'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW',
  'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
] as const;

/**
 * Single-character mutations of the valid addresses above. Changing any
 * character of a StrKey breaks its checksum, so each of these must be rejected.
 */
export const MUTATED_VALID_ADDRESSES: string[] = VALID_G_ADDRESSES.flatMap((address) => [
  `${address.slice(0, -1)}X`,
  `${address.slice(0, -1)}2`,
]);

/** Wrong prefix / length / charset — rejected by both regex and StrKey. */
export const SHAPE_INVALID_ADDRESSES = [
  `G${'A'.repeat(54)}`,
  `G${'A'.repeat(56)}`,
  `S${'A'.repeat(55)}`,
  `X${'A'.repeat(55)}`,
  `G${'a'.repeat(55)}`,
  `G${' '.repeat(55)}`,
  '',
  'not-an-address',
] as const;