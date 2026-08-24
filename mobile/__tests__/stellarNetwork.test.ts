/**
 * __tests__/stellarNetwork.test.ts
 * Network label / passphrase helpers and Horizon URL consistency checks.
 */
import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import {
  assertStellarNetworkConfigConsistency,
  displayNameForLabel,
  getExpectedNetworkDisplayName,
  getExpectedNetworkLabel,
  getExpectedNetworkPassphrase,
  inferNetworkLabelFromHorizonUrl,
  passphraseForLabel,
  resolveNetworkLabel,
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

  // babel-preset-expo inlines EXPO_PUBLIC_* at transform time, so assigning to
  // process.env here cannot change what the getters see. The rule itself is
  // exercised through its pure form.
  it('resolves mainnet / public spellings to the public network', () => {
    for (const raw of ['mainnet', 'public', 'MAINNET', '  Public  ']) {
      expect(resolveNetworkLabel(raw)).toBe('public');
      expect(passphraseForLabel(resolveNetworkLabel(raw))).toBe(Networks.PUBLIC);
      expect(displayNameForLabel(resolveNetworkLabel(raw))).toBe('mainnet');
    }
  });

  it('resolves anything else, including unset, to testnet', () => {
    for (const raw of [undefined, null, '', '   ', 'testnet', 'futurenet', 'nonsense']) {
      expect(resolveNetworkLabel(raw)).toBe('testnet');
      expect(passphraseForLabel(resolveNetworkLabel(raw))).toBe(Networks.TESTNET);
      expect(displayNameForLabel(resolveNetworkLabel(raw))).toBe('testnet');
    }
  });

  it('infers network from well-known Horizon hosts', () => {
    expect(inferNetworkLabelFromHorizonUrl('https://horizon-testnet.stellar.org')).toBe('testnet');
    expect(inferNetworkLabelFromHorizonUrl('https://horizon.stellar.org')).toBe('public');
    expect(inferNetworkLabelFromHorizonUrl('http://127.0.0.1:8000')).toBeNull();
  });

  it('throws when Horizon URL and the expected network disagree', () => {
    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon-testnet.stellar.org', 'public'),
    ).toThrow(/mismatch/i);

    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon.stellar.org', 'testnet'),
    ).toThrow(/mismatch/i);
  });

  it('allows matching and ambiguous Horizon URLs', () => {
    expect(() =>
      assertStellarNetworkConfigConsistency('https://horizon.stellar.org', 'public'),
    ).not.toThrow();
    expect(() =>
      assertStellarNetworkConfigConsistency('http://localhost:8000', 'public'),
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
    const source = Keypair.random();
    const destination = Keypair.random().publicKey();
    const account = new Account(source.publicKey(), '1');

    const tx = buildDonationPaymentTransaction({
      sourceAccount: account,
      destination,
      amount: '1.5',
      projectId: 'proj-mainnet-1',
      networkPassphrase: passphraseForLabel('public'),
    });

    expect(tx.networkPassphrase).toBe(Networks.PUBLIC);
    expect(tx.networkPassphrase).not.toBe(Networks.TESTNET);

    tx.sign(source);
    expect(tx.signatures.length).toBe(1);
  });
});
