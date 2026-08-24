/**
 * GreenPay Network Deployment Manifest Schema
 *
 * Single source of truth for all network configuration.
 * Emitted by the deploy workflow, consumed by all clients.
 * Never hardcode values that belong here.
 */

export interface NetworkManifest {
  /** Network identifier: "testnet" | "mainnet" | "futurenet" */
  network: 'testnet' | 'mainnet' | 'futurenet';

  /** Stellar network passphrase — used for transaction signing */
  networkPassphrase: string;

  /** Horizon REST API endpoint */
  horizonUrl: string;

  /** Soroban RPC endpoint */
  sorobanRpcUrl: string;

  /** Contract identifiers deployed to this network */
  contracts: {
    /** GreenPay core contract */
    greenPay: string;
    /** Escrow contract */
    escrow: string;
    /** DAO governance contract */
    daoGovernance: string;
    [key: string]: string;
  };

  /** Manifest version for forward compatibility */
  manifestVersion: string;

  /** ISO timestamp when this manifest was generated */
  generatedAt: string;
}

/** All URLs that must appear in extension connect-src */
export function getConnectSrcUrls(manifest: NetworkManifest): string[] {
  return [
    manifest.horizonUrl,
    manifest.sorobanRpcUrl,
  ].map(url => new URL(url).origin);
}
