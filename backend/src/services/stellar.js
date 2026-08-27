/**
 * src/services/stellar.js
 * Backend Stellar/Soroban service.
 */
"use strict";

const { Horizon, Networks, rpc, Contract, TransactionBuilder, scValToNative } = require("@stellar/stellar-sdk");
const { env } = require("../config/env");
const { timeChainCall } = require("../utils/metrics");

const NETWORK = env.stellarNetwork;
const HORIZON_URL = env.horizonUrl;
const RPC_URL = env.sorobanRpcUrl;
const CONTRACT_ID = env.contractId;

const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const server = new Horizon.Server(HORIZON_URL);
const rpcServer = new rpc.Server(RPC_URL);

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
    result = await timeChainCall("rpc_simulate_transaction", () => rpcServer.simulateTransaction(tx));
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
