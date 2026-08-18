/**
 * utils/stellarNetwork.ts
 * Resolves which Stellar network the app expects to operate on.
 *
 * Delegates to the shared @greenpay/stellar-client factory so that
 * network-passphrase resolution is identical across backend, frontend,
 * mobile, and extension.
 */
import { resolveNetworkLabel, resolveNetworkPassphrase } from '@greenpay/stellar-client';

export type StellarNetworkLabel = 'testnet' | 'public';

/**
 * Returns the network label ('testnet' | 'public') this app build expects,
 * read from EXPO_PUBLIC_STELLAR_NETWORK. Accepts 'mainnet' as an alias for
 * 'public'. Defaults to 'testnet' when unset.
 */
export function getExpectedNetworkLabel(): StellarNetworkLabel {
  const label = resolveNetworkLabel(process.env.EXPO_PUBLIC_STELLAR_NETWORK);
  return label === 'mainnet' ? 'public' : label;
}

/** Returns the Stellar network passphrase this app build expects. */
export function getExpectedNetworkPassphrase(): string {
  return resolveNetworkPassphrase(resolveNetworkLabel(process.env.EXPO_PUBLIC_STELLAR_NETWORK));
}
