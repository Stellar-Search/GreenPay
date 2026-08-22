/**
 * utils/stellarNetwork.ts
 * Resolves which Stellar network the app expects to operate on, mirroring
 * the web app's `NEXT_PUBLIC_STELLAR_NETWORK` pattern via
 * `EXPO_PUBLIC_STELLAR_NETWORK`.
 *
 * Used to reject SEP-7 payment requests (or any other payload that names a
 * network passphrase) that target a different Stellar network than the one
 * this build of the app is configured for, and to keep Horizon URL + network
 * label from silently diverging.
 */
import { Networks } from '@stellar/stellar-sdk';

export type StellarNetworkLabel = 'testnet' | 'public';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/**
 * Returns the network label ('testnet' | 'public') this app build expects,
 * read from EXPO_PUBLIC_STELLAR_NETWORK. Accepts 'mainnet' as an alias for
 * 'public'. Defaults to 'testnet' when unset.
 */
export function getExpectedNetworkLabel(): StellarNetworkLabel {
  const raw = (process.env.EXPO_PUBLIC_STELLAR_NETWORK || '').trim().toLowerCase();
  if (raw === 'public' || raw === 'mainnet') return 'public';
  return 'testnet';
}

/** Returns the Stellar network passphrase this app build expects. */
export function getExpectedNetworkPassphrase(): string {
  return getExpectedNetworkLabel() === 'public' ? Networks.PUBLIC : Networks.TESTNET;
}

/** User-facing network name for UI copy (never hardcodes a single network). */
export function getExpectedNetworkDisplayName(): string {
  return getExpectedNetworkLabel() === 'public' ? 'mainnet' : 'testnet';
}

/** Horizon URL this build submits against (mirrors donate / sync defaults). */
export function getConfiguredHorizonUrl(): string {
  const raw = (process.env.EXPO_PUBLIC_HORIZON_URL || '').trim();
  return raw || DEFAULT_HORIZON_URL;
}

/**
 * Infer testnet vs public from a Horizon URL when the host clearly names one.
 * Returns null for custom/local endpoints so we do not false-alarm on friendbot
 * or private Horizon deployments.
 */
export function inferNetworkLabelFromHorizonUrl(horizonUrl: string): StellarNetworkLabel | null {
  let host: string;
  try {
    host = new URL(horizonUrl).hostname.toLowerCase();
  } catch {
    host = horizonUrl.trim().toLowerCase();
  }

  if (host.includes('testnet') || host.includes('futurenet')) return 'testnet';
  // Official public Horizon: horizon.stellar.org (not horizon-testnet...)
  if (host === 'horizon.stellar.org' || host.includes('mainnet')) return 'public';
  return null;
}

/**
 * Fails fast when EXPO_PUBLIC_HORIZON_URL clearly targets a different Stellar
 * network than EXPO_PUBLIC_STELLAR_NETWORK. Ambiguous/custom URLs are allowed.
 */
export function assertStellarNetworkConfigConsistency(
  horizonUrl: string = getConfiguredHorizonUrl(),
): void {
  const fromUrl = inferNetworkLabelFromHorizonUrl(horizonUrl);
  if (!fromUrl) return;

  const expected = getExpectedNetworkLabel();
  if (fromUrl === expected) return;

  throw new Error(
    `Stellar network config mismatch: EXPO_PUBLIC_STELLAR_NETWORK resolves to ` +
      `'${expected}' but EXPO_PUBLIC_HORIZON_URL (${horizonUrl}) looks like '${fromUrl}'. ` +
      `Align both env vars so donations are signed for the same network they are submitted to.`,
  );
}
