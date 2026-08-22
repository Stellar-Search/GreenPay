/**
 * __tests__/stellarNetwork.test.ts
 * Network label / passphrase helpers and Horizon URL consistency checks.
 */
import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import {
  assertStellarNetworkConfigConsistency,
  getExpectedNetworkDisplayName,
  getExpectedNetworkLabel,
  getExpectedNetworkPassphrase,
  inferNetworkLabelFromHorizonUrl,
} from '../utils/stellarNetwork';
import { buildDonationPaymentTransaction } from '../utils/donationTransaction';

describe('stellarNetwork', () => {
  const originalNetwork = process.env.EXPO_PUBLIC_STELLAR_NETWORK;
  const originalHorizon = process.env.EXPO_PUBLIC_HORIZON_URL;

  afterEach(() => {
    if (originalNetwork === undefined) delete process.env.EXPO_PUBLIC_STELLAR_NETWORK;
    else process.env.EXPO_PUBLIC_STELLAR_NETWORK = originalNetwork;
    if (originalHorizon === undefined) delete process.env.EXPO_PUBLIC_HORIZON_URL;
    else process.env.EXPO_PUBLIC_HORIZON_URL = originalHorizon;
  });

  it('defaults to testnet passphrase when STELLAR_NETWORK is unset', () => {
    delete process.env.EXPO_PUBLIC_STELLAR_NETWORK;
    expect(getExpectedNetworkLabel()).toBe('testnet');
    expect(getExpectedNetworkPassphrase()).toBe(Networks.TESTNET);
    expect(getExpectedNetworkDisplayName()).toBe('testnet');
  });

  it('returns the public passphrase for mainnet / public builds', () => {
    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'mainnet';
    expect(getExpectedNetworkLabel()).toBe('public');
    expect(getExpectedNetworkPassphrase()).toBe(Networks.PUBLIC);
    expect(getExpectedNetworkDisplayName()).toBe('mainnet');

    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'public';
    expect(getExpectedNetworkPassphrase()).toBe(Networks.PUBLIC);
  });

  it('infers network from well-known Horizon hosts', () => {
    expect(inferNetworkLabelFromHorizonUrl('https://horizon-testnet.stellar.org')).toBe('testnet');
    expect(inferNetworkLabelFromHorizonUrl('https://horizon.stellar.org')).toBe('public');
    expect(inferNetworkLabelFromHorizonUrl('http://127.0.0.1:8000')).toBeNull();
  });

  it('throws when Horizon URL and STELLAR_NETWORK disagree', () => {
    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'mainnet';
    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon-testnet.stellar.org'),
    ).toThrow(/mismatch/i);

    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'testnet';
    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon.stellar.org'),
    ).toThrow(/mismatch/i);
  });

  it('allows matching and ambiguous Horizon URLs', () => {
    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'mainnet';
    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon.stellar.org'),
    ).not.toThrow();
    expect(() =>
      assertStellarNetworkConfigConsistency('http://localhost:8000'),
    ).not.toThrow();
  });
});

describe('buildDonationPaymentTransaction', () => {
  const originalNetwork = process.env.EXPO_PUBLIC_STELLAR_NETWORK;

  afterEach(() => {
    if (originalNetwork === undefined) delete process.env.EXPO_PUBLIC_STELLAR_NETWORK;
    else process.env.EXPO_PUBLIC_STELLAR_NETWORK = originalNetwork;
  });

  it('signs against the public network passphrase for a mainnet-configured build', () => {
    process.env.EXPO_PUBLIC_STELLAR_NETWORK = 'mainnet';

    const source = Keypair.random();
    const destination = Keypair.random().publicKey();
    const account = new Account(source.publicKey(), '1');

    const tx = buildDonationPaymentTransaction({
      sourceAccount: account,
      destination,
      amount: '1.5',
      projectId: 'proj-mainnet-1',
    });

    expect(tx.networkPassphrase).toBe(Networks.PUBLIC);
    expect(tx.networkPassphrase).not.toBe(Networks.TESTNET);

    tx.sign(source);
    expect(tx.signatures.length).toBe(1);
  });
});
