import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import {
  isValidStellarAddress as frontendIsValid,
  isValidStellarMuxedAddress as frontendIsMuxed,
  isValidStellarDestination as frontendIsDestination,
} from '../../../frontend/lib/stellar-address';
import {
  isValidStellarAddress as mobileIsValid,
  isValidStellarMuxedAddress as mobileIsMuxed,
  isValidStellarDestination as mobileIsDestination,
} from '../../../mobile/utils/stellarValidation';
import {
  isValidStellarAddress as extensionIsValid,
  isValidStellarMuxedAddress as extensionIsMuxed,
  isValidStellarDestination as extensionIsDestination,
} from '../stellar-address';
import {
  CHECKSUM_INVALID_ADDRESSES,
  MUTATED_VALID_ADDRESSES,
  SHAPE_INVALID_ADDRESSES,
  VALID_G_ADDRESSES,
} from '../../../shared/stellar-address-corpus';

/**
 * Cross-validation of the three GreenPay Stellar-address validators
 * (frontend, mobile, extension). Each client keeps a verbatim mirror of the
 * same canonical StrKey-backed implementation; this test proves they agree on
 * exactly the same corpus — in particular that every codebase rejects the same
 * set of checksum-invalid addresses that a shape-only regex would accept.
 */
const VALIDATORS = {
  frontend: { isValid: frontendIsValid, isMuxed: frontendIsMuxed, isDestination: frontendIsDestination },
  mobile: { isValid: mobileIsValid, isMuxed: mobileIsMuxed, isDestination: mobileIsDestination },
  extension: { isValid: extensionIsValid, isMuxed: extensionIsMuxed, isDestination: extensionIsDestination },
} as const;

function buildMuxedAddress(ed25519PublicKey: string, id: number): string {
  const raw = StrKey.decodeEd25519PublicKey(ed25519PublicKey);
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64BE(BigInt(id));
  return StrKey.encodeMed25519PublicKey(Buffer.concat([raw, idBuf]));
}

describe('cross-codebase Stellar address validation', () => {
  it('all three validators accept the same valid G-addresses', () => {
    for (const [name, validator] of Object.entries(VALIDATORS)) {
      for (const address of VALID_G_ADDRESSES) {
        expect(validator.isValid(address), `${name} should accept ${address}`).toBe(true);
      }
    }
  });

  it('all three validators reject the same set of checksum-invalid addresses', () => {
    for (const [name, validator] of Object.entries(VALIDATORS)) {
      for (const address of [...CHECKSUM_INVALID_ADDRESSES, ...MUTATED_VALID_ADDRESSES]) {
        expect(validator.isValid(address), `${name} should reject ${address}`).toBe(false);
      }
    }
  });

  it('all three validators reject the same shape-invalid addresses', () => {
    for (const [name, validator] of Object.entries(VALIDATORS)) {
      for (const address of SHAPE_INVALID_ADDRESSES) {
        expect(validator.isValid(address), `${name} should reject ${address}`).toBe(false);
      }
    }
  });

  it('all three validators handle muxed (M…) addresses identically', () => {
    const muxed = buildMuxedAddress(VALID_G_ADDRESSES[0], 12345);
    for (const [name, validator] of Object.entries(VALIDATORS)) {
      expect(validator.isValid(muxed), `${name} should not treat a muxed address as a G-address`).toBe(false);
      expect(validator.isMuxed(muxed), `${name} should accept a valid muxed address`).toBe(true);
      expect(validator.isDestination(muxed), `${name} should treat a muxed address as a destination`).toBe(true);
    }
  });
});