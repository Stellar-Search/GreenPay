import { describe, expect, it } from 'vitest';
import { isBadSequenceError } from '../horizon-errors';

function makeHorizonError(transactionCode: string) {
  return {
    response: {
      status: 400,
      data: {
        title: 'Transaction Failed',
        extras: {
          result_codes: {
            transaction: transactionCode,
          },
        },
      },
    },
  };
}

describe('isBadSequenceError', () => {
  it('returns true for a Horizon tx_bad_seq error', () => {
    expect(isBadSequenceError(makeHorizonError('tx_bad_seq'))).toBe(true);
  });

  it('returns false for a non-sequence Horizon error', () => {
    expect(isBadSequenceError(makeHorizonError('tx_failed'))).toBe(false);
    expect(isBadSequenceError(makeHorizonError('tx_insufficient_fee'))).toBe(false);
  });

  it('returns false for plain Error objects', () => {
    expect(isBadSequenceError(new Error('network error'))).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isBadSequenceError(null)).toBe(false);
    expect(isBadSequenceError(undefined)).toBe(false);
  });

  it('returns false for objects missing the nested response structure', () => {
    expect(isBadSequenceError({})).toBe(false);
    expect(isBadSequenceError({ response: {} })).toBe(false);
    expect(isBadSequenceError({ response: { data: {} } })).toBe(false);
    expect(isBadSequenceError({ response: { data: { extras: {} } } })).toBe(false);
  });

  it('returns false for primitive values', () => {
    expect(isBadSequenceError('tx_bad_seq')).toBe(false);
    expect(isBadSequenceError(42)).toBe(false);
    expect(isBadSequenceError(true)).toBe(false);
  });
});
