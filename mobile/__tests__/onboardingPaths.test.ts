/**
 * __tests__/onboardingPaths.test.ts
 *
 * The base-reserve boundary and path selection on mobile. The arithmetic has
 * to agree with the backend exactly: a UI that says "you can send this" while
 * the network says otherwise is worse than no check at all.
 */
import {
  BASE_RESERVE_STROOPS,
  STROOPS_PER_XLM,
  assessDonorSituation,
  evaluateReserve,
  getReserveStatus,
  stroopsToXlmString,
  xlmStringToStroops,
} from '../utils/onboarding';

const XLM = (n: string) => xlmStringToStroops(n);
const ADDRESS = `G${'A'.repeat(55)}`;

function horizonAccount({
  balance = '0',
  subentries = 0,
  sponsoring = 0,
  sponsored = 0,
}: { balance?: string; subentries?: number; sponsoring?: number; sponsored?: number }) {
  return {
    balances: [{ asset_type: 'native', balance }],
    subentry_count: subentries,
    num_sponsoring: sponsoring,
    num_sponsored: sponsored,
  };
}

function serverReturning(account: unknown) {
  return { loadAccount: jest.fn().mockResolvedValue(account) };
}

function serverFailing(error: unknown) {
  return { loadAccount: jest.fn().mockRejectedValue(error) };
}

describe('stroop conversion', () => {
  it('matches the network fixed-point representation', () => {
    expect(xlmStringToStroops('1')).toBe(STROOPS_PER_XLM);
    expect(BASE_RESERVE_STROOPS).toBe(BigInt(5_000_000));
  });

  it('round-trips without floating-point drift', () => {
    for (const value of ['0.0000000', '0.5000000', '1234.5678901']) {
      expect(stroopsToXlmString(xlmStringToStroops(value))).toBe(value);
    }
  });

  it('truncates rather than rounding up past seven decimals', () => {
    expect(xlmStringToStroops('0.99999999')).toBe(BigInt(9_999_999));
  });

  it('refuses a value that is not a decimal amount', () => {
    expect(() => xlmStringToStroops('lots')).toThrow(/decimal XLM amount/);
  });
});

describe('evaluateReserve — the base-reserve boundary', () => {
  it('gives a plain account a 1 XLM minimum balance', () => {
    expect(evaluateReserve({ balanceStroops: XLM('5') }).minimumBalanceStroops).toBe(XLM('1'));
  });

  it('refuses a payment one stroop over the boundary', () => {
    const spendable = XLM('2') - XLM('1') - BigInt(100);
    const check = evaluateReserve({
      balanceStroops: XLM('2'),
      amountStroops: spendable + BigInt(1),
    });
    expect(check.readiness).toBe('reserve_locked');
    expect(check.shortfallXlm).toBe('0.0000001');
  });

  it('allows a payment of exactly the spendable amount', () => {
    const spendable = XLM('2') - XLM('1') - BigInt(100);
    expect(evaluateReserve({ balanceStroops: XLM('2'), amountStroops: spendable }).readiness).toBe(
      'ready',
    );
  });

  it('counts a trustline as a subentry, which is the case that surprises donors', () => {
    // 1.4 XLM with a USDC trustline looks funded and can send nothing.
    const check = evaluateReserve({
      balanceStroops: XLM('1.4'),
      numSubEntries: 1,
      amountStroops: XLM('0.1'),
    });
    expect(check.minimumBalanceStroops).toBe(XLM('1.5'));
    expect(check.spendableStroops).toBe(BigInt(0));
  });

  it('gives a fully sponsored account a zero minimum balance', () => {
    // The point of the sponsored path: the donor can spend everything they
    // receive, because the platform carries the reserve.
    const check = evaluateReserve({
      balanceStroops: XLM('10'),
      numSponsored: 2,
      amountStroops: XLM('10') - BigInt(100),
    });
    expect(check.minimumBalanceStroops).toBe(BigInt(0));
    expect(check.readiness).toBe('ready');
  });

  it('never reports a negative spendable balance', () => {
    expect(evaluateReserve({ balanceStroops: XLM('0.2') }).spendableStroops).toBe(BigInt(0));
  });

  it('charges the transaction fee on top of the reserve', () => {
    const noFee = evaluateReserve({ balanceStroops: XLM('2'), feeStroops: BigInt(0) });
    const withFee = evaluateReserve({ balanceStroops: XLM('2'), feeStroops: BigInt(100) });
    expect(noFee.spendableStroops - withFee.spendableStroops).toBe(BigInt(100));
  });
});

describe('getReserveStatus', () => {
  it('reports a 404 as a missing account', async () => {
    const status = await getReserveStatus(ADDRESS, undefined, serverFailing({ response: { status: 404 } }));
    expect(status.readiness).toBe('missing');
    expect(status.exists).toBe(false);
  });

  it('reports a network failure as unknown rather than as a missing account', async () => {
    // Reading a 503 as "missing" would offer to sponsor an account that
    // already exists and lock the platform's reserve for nothing.
    const status = await getReserveStatus(ADDRESS, undefined, serverFailing({ response: { status: 503 } }));
    expect(status.readiness).toBe('unknown');
  });

  it('treats an unreachable Horizon as unknown too', async () => {
    const status = await getReserveStatus(ADDRESS, undefined, serverFailing(new Error('offline')));
    expect(status.readiness).toBe('unknown');
  });

  it('reads a funded account as ready', async () => {
    const status = await getReserveStatus(ADDRESS, '10', serverReturning(horizonAccount({ balance: '50' })));
    expect(status.readiness).toBe('ready');
  });

  it('handles an account with no native balance entry', async () => {
    const status = await getReserveStatus(ADDRESS, undefined, serverReturning({ balances: [] }));
    expect(status.spendableStroops).toBe(BigInt(0));
  });
});

describe('assessDonorSituation', () => {
  it('leaves a funded donor on the existing flow', async () => {
    // The fastest path for them is the one that existed before any of this was
    // built, so nothing new is offered.
    const result = await assessDonorSituation({
      address: ADDRESS,
      server: serverReturning(horizonAccount({ balance: '50' })),
    });
    expect(result.recommendedPath).toBe('connected_wallet');
    expect(result.reason).toMatch(/funded and ready/i);
  });

  it('recommends sponsorship when the address is not an account yet', async () => {
    const result = await assessDonorSituation({
      address: ADDRESS,
      server: serverFailing({ response: { status: 404 } }),
    });
    expect(result.recommendedPath).toBe('sponsored_account');
    expect(result.reason).toMatch(/minimum balance/i);
  });

  it('recommends an on-ramp when the account exists but its balance is locked', async () => {
    // Sponsorship cannot help here — the account already exists. Recommending
    // it anyway would send the donor into a flow that would refuse them.
    const result = await assessDonorSituation({
      address: ADDRESS,
      server: serverReturning(horizonAccount({ balance: '1' })),
    });
    expect(result.recommendedPath).toBe('onramp');
    expect(result.reason).toMatch(/locked as Stellar’s minimum reserve/i);
  });

  it('says how much a partially-locked account can still send', async () => {
    const result = await assessDonorSituation({
      address: ADDRESS,
      amountXlm: '10',
      server: serverReturning(horizonAccount({ balance: '1.5' })),
    });
    expect(result.reason).toContain('0.4999900 XLM');
  });

  it('never guesses when the network did not answer', async () => {
    const result = await assessDonorSituation({
      address: ADDRESS,
      server: serverFailing(new Error('down')),
    });
    expect(result.readiness).toBe('unknown');
    expect(result.reason).toMatch(/couldn’t reach the Stellar network/i);
  });

  it('offers to set an account up for a donor with no address at all', async () => {
    const result = await assessDonorSituation({ address: null });
    expect(result.recommendedPath).toBe('sponsored_account');
  });
});
