/**
 * @greenpay/stellar-client
 *
 * Single source of truth for Stellar network-passphrase resolution,
 * Horizon client construction, Soroban/RPC client construction, and
 * contract-ID resolution.
 *
 * Every GreenPay sub-project (backend, frontend, mobile, extension)
 * should import from this package instead of constructing clients
 * independently — this eliminates the class of bugs where different
 * codebases silently disagree on which Stellar network they target.
 */
import { Horizon, Networks, rpc } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NetworkLabel = "testnet" | "mainnet";

export interface StellarClientConfig {
  /**
   * The raw value from the environment variable that names the target
   * network.  Accepts "testnet", "mainnet", or "public" (alias for
   * mainnet).  Falls back to "testnet" when undefined or empty.
   */
  network?: string;

  /**
   * Horizon server URL.  Defaults to the Stellar testnet Horizon endpoint.
   */
  horizonUrl?: string;

  /**
   * Soroban RPC server URL.  Defaults to the Stellar testnet Soroban
   * endpoint.  If your sub-project does not use Soroban, you can omit
   * this and simply not call `createRpcServer`.
   */
  rpcUrl?: string;

  /**
   * Primary smart-contract ID.  Empty string when unconfigured.
   */
  contractId?: string;

  /**
   * Optional secondary contract ID (e.g. escrow contract).
   */
  escrowContractId?: string;
}

export interface StellarClients {
  /** Canonical network label — "testnet" or "mainnet". */
  network: NetworkLabel;
  /** Resolved Stellar network passphrase string (e.g. Networks.TESTNET). */
  networkPassphrase: string;
  /** Constructed Horizon.Server instance. */
  horizonServer: Horizon.Server;
  /** Constructed rpc.Server instance (Soroban). */
  rpcServer: rpc.Server;
  /** Primary contract ID (may be empty string). */
  contractId: string;
  /** Escrow contract ID (may be empty string). */
  escrowContractId: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_HORIZON_URL = "https://horizon-testnet.stellar.org";
const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a raw network string to a canonical label.
 *
 * Truth table:
 *   "mainnet" | "public" → "mainnet"
 *   "testnet" | "" | undefined | anything else → "testnet"
 */
export function resolveNetworkLabel(raw?: string): NetworkLabel {
  const normalised = (raw ?? "").trim().toLowerCase();
  return normalised === "mainnet" || normalised === "public"
    ? "mainnet"
    : "testnet";
}

/**
 * Maps a canonical network label to the Stellar SDK passphrase constant.
 */
export function resolveNetworkPassphrase(label: NetworkLabel): string {
  return label === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/**
 * Convenience: resolve a raw env-var value directly to a passphrase.
 */
export function resolvePassphrase(raw?: string): string {
  return resolveNetworkPassphrase(resolveNetworkLabel(raw));
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Creates all Stellar clients from a single, unified configuration object.
 *
 * Typical usage per platform:
 *
 * ```ts
 * // Backend  (STELLAR_NETWORK, HORIZON_URL, SOROBAN_RPC_URL, CONTRACT_ID)
 * import { createStellarClients } from "@greenpay/stellar-client";
 * const clients = createStellarClients({
 *   network:   process.env.STELLAR_NETWORK,
 *   horizonUrl: process.env.HORIZON_URL,
 *   rpcUrl:    process.env.SOROBAN_RPC_URL,
 *   contractId: process.env.CONTRACT_ID,
 * });
 *
 * // Frontend (NEXT_PUBLIC_STELLAR_NETWORK, etc.)
 * // Mobile   (EXPO_PUBLIC_STELLAR_NETWORK, etc.)
 * // Extension (hardcoded defaults — just call with no args)
 * ```
 */
export function createStellarClients(config: StellarClientConfig = {}): StellarClients {
  const network = resolveNetworkLabel(config.network);
  const networkPassphrase = resolveNetworkPassphrase(network);
  const horizonServer = new Horizon.Server(config.horizonUrl || DEFAULT_HORIZON_URL);
  const rpcServer = new rpc.Server(config.rpcUrl || DEFAULT_RPC_URL);

  return {
    network,
    networkPassphrase,
    horizonServer,
    rpcServer,
    contractId: config.contractId ?? "",
    escrowContractId: config.escrowContractId ?? "",
  };
}

/**
 * Creates only the Horizon server (for sub-projects that don't use
 * Soroban, e.g. the mobile donation screen or the browser extension).
 */
export function createHorizonClient(horizonUrl?: string): Horizon.Server {
  return new Horizon.Server(horizonUrl || DEFAULT_HORIZON_URL);
}

/**
 * Creates only the Soroban/RPC server.
 */
export function createRpcClient(rpcUrl?: string): rpc.Server {
  return new rpc.Server(rpcUrl || DEFAULT_RPC_URL);
}

// ---------------------------------------------------------------------------
// Re-export commonly-used SDK types so consumers can import from this
// package instead of depending on @stellar/stellar-sdk directly for
// basic operations.
// ---------------------------------------------------------------------------
export {
  Horizon,
  Networks,
  rpc,
  Contract,
  TransactionBuilder,
  scValToNative,
  Account,
  Asset,
  Operation,
  Memo,
  Transaction,
  Address,
  nativeToScVal,
  xdr,
  StrKey,
} from "@stellar/stellar-sdk";
