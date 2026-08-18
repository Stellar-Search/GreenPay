/**
 * src/services/stellar.js
 * Backend Stellar/Soroban service.
 *
 * Clients are constructed via the shared @greenpay/stellar-client
 * factory so that network-passphrase resolution, Horizon URL, and
 * Soroban/RPC URL are consistent with every other GreenPay sub-project.
 */
"use strict";

const { createStellarClients, Contract, TransactionBuilder, scValToNative, Horizon } = require("@greenpay/stellar-client");

const {
  networkPassphrase: NETWORK_PASSPHRASE,
  horizonServer: server,
  rpcServer,
  contractId: CONTRACT_ID,
} = createStellarClients({
  network:    process.env.STELLAR_NETWORK,
  horizonUrl: process.env.HORIZON_URL,
  rpcUrl:     process.env.SOROBAN_RPC_URL,
  contractId: process.env.CONTRACT_ID,
});

const NETWORK = process.env.STELLAR_NETWORK || "testnet";

async function getOnChainProject(projectId) {
  if (!CONTRACT_ID) return null;
  
  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "-1");
  
  const tx = new TransactionBuilder(dummyAccount, { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call("get_project", projectId))
    .setTimeout(30)
    .build();

  let result;
  try {
    result = await rpcServer.simulateTransaction(tx);
  } catch {
    return null;
  }

  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result.retval);
  }
  return null;
}

/**
 * Retrieve a project's on-chain representation from the Soroban contract.
 *
 * @param {string} projectId - The on-chain project identifier passed to the contract.
 * @returns {Promise<null|object>} Resolves to the native JS value returned by the contract, or `null` when
 * the contract is not configured or the call fails.
 * @throws {Error} When the RPC simulation fails with an unexpected error.
 */
// Exported below as `getOnChainProject`

module.exports = {
  server,
  rpcServer,
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  getOnChainProject
};
