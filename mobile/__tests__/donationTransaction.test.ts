/**
 * __tests__/donationTransaction.test.ts
 * Tests for fee derivation (issue #512): a donation's network fee must come
 * from live Horizon fee stats, not a fixed constant, so congested networks
 * don't silently drop payments paying the historical floor.
 */
import { derivePaymentFee } from '../utils/donationTransaction';

describe('derivePaymentFee', () => {
  it('falls back to the minimum fee when fee stats are unavailable', () => {
    expect(derivePaymentFee(null)).toBe('100');
    expect(derivePaymentFee(undefined)).toBe('100');
    expect(derivePaymentFee({} as never)).toBe('100');
  });

  it('derives a fee with headroom from the network mode', () => {
    expect(derivePaymentFee({ fee_charged: { mode: '100' } })).toBe('200');
    expect(derivePaymentFee({ fee_charged: { mode: '1000' } })).toBe('2000');
    expect(derivePaymentFee({ fee_charged: { mode: 175 } })).toBe('350');
  });

  it('never goes below the minimum fee', () => {
    expect(derivePaymentFee({ fee_charged: { mode: '25' } })).toBe('100');
  });

  it('honors a custom multiplier and minimum', () => {
    expect(
      derivePaymentFee({ fee_charged: { mode: '100' } }, { multiplier: 3, minFee: 500 }),
    ).toBe('500');
    expect(
      derivePaymentFee({ fee_charged: { mode: '400' } }, { multiplier: 3, minFee: 100 }),
    ).toBe('1200');
  });

  it('falls back when the mode is missing or unparseable', () => {
    expect(derivePaymentFee({ fee_charged: {} as never })).toBe('100');
    expect(derivePaymentFee({ fee_charged: { mode: 'abc' } })).toBe('100');
    expect(derivePaymentFee({ fee_charged: { mode: '' } })).toBe('100');
  });
});