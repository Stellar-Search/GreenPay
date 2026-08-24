import { NetworkManifest, getConnectSrcUrls } from './schema';
import testnetManifest from './testnet.json';
import mainnetManifest from './mainnet.json';

const manifests: Record<string, NetworkManifest> = {
  testnet: testnetManifest as NetworkManifest,
  mainnet: mainnetManifest as NetworkManifest,
};

/**
 * Validates a manifest for internal consistency.
 * Throws with a descriptive message naming the mismatch.
 */
export function validateManifest(manifest: NetworkManifest): void {
  const errors: string[] = [];

  // Validate passphrase matches network
  const expectedPassphrases: Record<string, string> = {
    testnet: 'Test SDF Network ; September 2015',
    mainnet: 'Public Global Stellar Network ; September 2015',
  };

  if (expectedPassphrases[manifest.network] && 
      manifest.networkPassphrase !== expectedPassphrases[manifest.network]) {
    errors.push(
      `networkPassphrase mismatch for network "${manifest.network}": ` +
      `expected "${expectedPassphrases[manifest.network]}", ` +
      `got "${manifest.networkPassphrase}"`
    );
  }

  // Validate all contract IDs are valid Stellar addresses (C... 56 chars) or empty
  for (const [name, id] of Object.entries(manifest.contracts)) {
    if (id && !/^C[A-Z2-7]{55}$/.test(id)) {
      errors.push(
        `contracts.${name} is not a valid Stellar contract address: "${id}"`
      );
    }
  }

  // Validate URLs are valid
  for (const [key, url] of [
    ['horizonUrl', manifest.horizonUrl],
    ['sorobanRpcUrl', manifest.sorobanRpcUrl],
  ] as const) {
    try {
      new URL(url);
    } catch {
      errors.push(`${key} is not a valid URL: "${url}"`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Network manifest validation failed for "${manifest.network}":\n` +
      errors.map(e => `  - ${e}`).join('\n')
    );
  }
}

/**
 * Loads and validates the manifest for the given network.
 * Throws immediately and legibly on any inconsistency.
 */
export function getManifest(network: string): NetworkManifest {
  const manifest = manifests[network];
  if (!manifest) {
    throw new Error(
      `No manifest found for network "${network}". ` +
      `Supported networks: ${Object.keys(manifests).join(', ')}`
    );
  }

  validateManifest(manifest);
  return manifest;
}

/**
 * Loads the manifest for the current environment.
 * Uses NEXT_PUBLIC_NETWORK or NETWORK env var.
 * Throws at boot time if misconfigured.
 */
export function getActiveManifest(): NetworkManifest {
  const network = 
    process.env.NEXT_PUBLIC_NETWORK ??
    process.env.NETWORK ??
    'testnet';
  return getManifest(network);
}

export { getConnectSrcUrls };
export type { NetworkManifest };
