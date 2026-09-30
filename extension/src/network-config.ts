import {
  getActiveManifest,
  getConnectSrcUrls,
  type NetworkManifest,
} from '../../config/networks';

export const activeManifest = getActiveManifest();

export const NETWORK = activeManifest.network;
export const NETWORK_PASSPHRASE = activeManifest.networkPassphrase;
export const HORIZON_URL = activeManifest.horizonUrl;
export const SOROBAN_RPC_URL = activeManifest.sorobanRpcUrl;

export { getActiveManifest, getConnectSrcUrls, type NetworkManifest };
