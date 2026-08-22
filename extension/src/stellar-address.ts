/**
 * src/stellar-address.ts
 * Stellar address validation for the browser extension.
 *
 * Canonical StrKey-backed implementation, verified via `@stellar/stellar-sdk`'s
 * `StrKey` (checksum) rather than a shape-only regex. A string that merely
 * *looks* like a Stellar address (right prefix, right length) is not
 * guaranteed to be a real, checksum-valid account id.
 *
 * Mirrored verbatim across:
 *   - frontend/lib/stellar-address.ts
 *   - mobile/utils/stellarValidation.ts
 *   - extension/src/stellar-address.ts        (this file)
 * The cross-validation test in `src/__tests__/stellar-address-cross-validation.test.ts`
 * proves all three accept and reject exactly the same corpus. Keep them in sync.
 */
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Returns true when `address` is a valid Stellar Ed25519 public key (G…),
 * verified via StrKey's checksum check (not just a regex on shape).
 */
export function isValidStellarAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Returns true when `address` is a valid Stellar muxed account (M…), as
 * defined by SEP-23. Muxed accounts encode an ed25519 public key plus a
 * 64-bit sub-account id and are a legitimate payment destination distinct
 * from a plain G-address.
 */
export function isValidStellarMuxedAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  try {
    return StrKey.isValidMed25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Returns true when `address` is a valid Stellar payment destination —
 * either a plain ed25519 account (G…) or a SEP-23 muxed account (M…).
 */
export function isValidStellarDestination(address: unknown): address is string {
  return isValidStellarAddress(address) || isValidStellarMuxedAddress(address);
}