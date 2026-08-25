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
  // babel-preset-expo replaces `process.env.EXPO_PUBLIC_*` with a literal at
  // transform time, so this reflects the value present when the bundle was
  // built and cannot be changed at runtime. Assigning to process.env in a test
  // has no effect here — exercise resolveNetworkLabel directly instead.
  return resolveNetworkLabel(process.env.EXPO_PUBLIC_STELLAR_NETWORK);
}

/** Pure form of the label rule, independent of how the value was obtained. */
export function resolveNetworkLabel(raw: string | null | undefined): StellarNetworkLabel {
  const value = (raw || '').trim().toLowerCase();
  if (value === 'public' || value === 'mainnet') return 'public';
  return 'testnet';
}

/** Passphrase for an explicit label. */
export function passphraseForLabel(label: StellarNetworkLabel): string {
  return label === 'public' ? Networks.PUBLIC : Networks.TESTNET;
}

/** User-facing network name for an explicit label. */
export function displayNameForLabel(label: StellarNetworkLabel): string {
  return label === 'public' ? 'mainnet' : 'testnet';
}

/** Returns the Stellar network passphrase this app build expects. */
export function getExpectedNetworkPassphrase(): string {
  return passphraseForLabel(getExpectedNetworkLabel());
}

/** User-facing network name for UI copy (never hardcodes a single network). */
export function getExpectedNetworkDisplayName(): string {
  return displayNameForLabel(getExpectedNetworkLabel());
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
  expected: StellarNetworkLabel = getExpectedNetworkLabel(),
): void {
  const fromUrl = inferNetworkLabelFromHorizonUrl(horizonUrl);
  if (!fromUrl) return;

  if (fromUrl === expected) return;

  throw new Error(
    `Stellar network config mismatch: EXPO_PUBLIC_STELLAR_NETWORK resolves to ` +
      `'${expected}' but EXPO_PUBLIC_HORIZON_URL (${horizonUrl}) looks like '${fromUrl}'. ` +
      `Align both env vars so donations are signed for the same network they are submitted to.`,
  );
}
