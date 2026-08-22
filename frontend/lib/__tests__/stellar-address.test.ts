/**
 * lib/__tests__/stellar-address.test.ts
 * Unit tests for the frontend's StrKey-backed Stellar address validation.
 */
import { StrKey } from '@stellar/stellar-sdk';
import {
  isValidStellarAddress,
  isValidStellarMuxedAddress,
  isValidStellarDestination,
} from '../stellar-address';

const KNOWN_VALID_ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const SHAPE_ONLY_ADDRESS = `G${'A'.repeat(55)}`;

function buildMuxedAddress(ed25519PublicKey: string, id: number): string {
  const raw = StrKey.decodeEd25519PublicKey(ed25519PublicKey);
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64BE(BigInt(id));
  return StrKey.encodeMed25519PublicKey(Buffer.concat([raw, idBuf]));
}

const VALID_MUXED_ADDRESS = buildMuxedAddress(KNOWN_VALID_ADDRESS, 12345);

describe('isValidStellarAddress', () => {
  it('accepts a checksum-valid G-address', () => {
    expect(isValidStellarAddress(KNOWN_VALID_ADDRESS)).toBe(true);
  });

  it('rejects a shape-only, checksum-invalid address', () => {
    expect(isValidStellarAddress(SHAPE_ONLY_ADDRESS)).toBe(false);
  });

  it('rejects wrong prefix, length, and charset', () => {
    expect(isValidStellarAddress(`S${'A'.repeat(55)}`)).toBe(false);
    expect(isValidStellarAddress(`G${'A'.repeat(54)}`)).toBe(false);
    expect(isValidStellarAddress(`G${'A'.repeat(56)}`)).toBe(false);
    expect(isValidStellarAddress(`G${'a'.repeat(55)}`)).toBe(false);
  });

  it('rejects a valid muxed (M…) address', () => {
    expect(isValidStellarAddress(VALID_MUXED_ADDRESS)).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress(null)).toBe(false);
    expect(isValidStellarAddress(undefined)).toBe(false);
    expect(isValidStellarAddress(12345)).toBe(false);
    expect(isValidStellarAddress({})).toBe(false);
  });
});

describe('isValidStellarMuxedAddress', () => {
  it('accepts a valid muxed (M…) address', () => {
    expect(isValidStellarMuxedAddress(VALID_MUXED_ADDRESS)).toBe(true);
  });

  it('rejects a plain G-address and checksum-invalid M-strings', () => {
    expect(isValidStellarMuxedAddress(KNOWN_VALID_ADDRESS)).toBe(false);
    expect(isValidStellarMuxedAddress(`M${'A'.repeat(68)}`)).toBe(false);
  });
});

describe('isValidStellarDestination', () => {
  it('accepts plain and muxed addresses', () => {
    expect(isValidStellarDestination(KNOWN_VALID_ADDRESS)).toBe(true);
    expect(isValidStellarDestination(VALID_MUXED_ADDRESS)).toBe(true);
  });

  it('rejects checksum-invalid and garbage strings', () => {
    expect(isValidStellarDestination(SHAPE_ONLY_ADDRESS)).toBe(false);
    expect(isValidStellarDestination('not-an-address')).toBe(false);
    expect(isValidStellarDestination('')).toBe(false);
  });
});
