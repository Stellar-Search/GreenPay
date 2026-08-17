import { Horizon, TransactionBuilder, Networks, Asset, BASE_FEE, Account } from "@stellar/stellar-sdk";
import { showStatus, getActiveProject, getActiveJob, getActiveDonation, setActiveDonation, getFreighterPublicKey, getFreighterNetwork, signTransaction, isFreighterAvailable } from "./utils";
import { submitDonation, submitJobPayment, fetchProject, fetchJob, fetchDonation } from "./api";

const STALE_SEQUENCE_ERRORS = [
  "tx_bad_seq",
  "The transaction sequence number is incorrect",
  "sequence number",
  "bad sequence",
];

function isStaleSequenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STALE_SEQUENCE_ERRORS.some((needle) => message.toLowerCase().includes(needle.toLowerCase()));
}

async function buildDonationTransaction(server: Horizon.Server, source: string, destination: string, amount: string, memo: string) {
  const account = await server.loadAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(TransactionBuilder.operation.payment({
      destination,
      asset: Asset.native(),
      amount,
    }))
    .addMemo(TransactionBuilder.memo.text(memo))
    .setTimeout(30)
    .build();
  return transaction;
}

export async function donate(projectId: string, amountXlm: string, memo: string) {
  try {
    const publicKey = await getFreighterPublicKey();
    if (!publicKey) {
      showStatus("Please connect Freighter first.", "error");
      return;
    }

    const network = await getFreighterNetwork();
    if (network !== "PUBLIC") {
      showStatus("Please switch Freighter to the public network.", "error");
      return;
    }

    const server = new Horizon.Server("https://horizon.stellar.org");
    const project = await fetchProject(projectId);
    if (!project) {
      showStatus("Project not found.", "error");
      return;
    }

    const destination = project.walletAddress;
    const source = publicKey;

    let transaction = await buildDonationTransaction(server, source, destination, amountXlm, memo);

    // Sign and submit with stale-sequence recovery
    let signedTransaction = await signTransaction(transaction.toXDR(), network);
    try {
      await server.submitTransaction(signedTransaction);
    } catch (submitError) {
      if (isStaleSequenceError(submitError)) {
        showStatus("Your account sequence number changed while waiting for approval. Rebuilding transaction with the latest sequence...", "info");
        // Reload account and rebuild transaction with fresh sequence
        transaction = await buildDonationTransaction(server, source, destination, amountXlm, memo);
        signedTransaction = await signTransaction(transaction.toXDR(), network);
        await server.submitTransaction(signedTransaction);
      } else {
        throw submitError;
      }
    }

    // Record donation in backend
    await submitDonation({
      projectId,
      amountXlm: parseFloat(amountXlm),
      donorAddress: source,
      txHash: signedTransaction.hash().toString("hex"),
    });

    showStatus("Donation successful!", "success");
  } catch (error) {
    console.error("Donation failed:", error);
    showStatus(`Donation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export async function payJob(jobId: string, amountXlm: string) {
  try {
    const publicKey = await getFreighterPublicKey();
    if (!publicKey) {
      showStatus("Please connect Freighter first.", "error");
      return;
    }

    const network = await getFreighterNetwork();
    if (network !== "PUBLIC") {
      showStatus("Please switch Freighter to the public network.", "error");
      return;
    }

    const server = new Horizon.Server("https://horizon.stellar.org");
    const job = await fetchJob(jobId);
    if (!job) {
      showStatus("Job not found.", "error");
      return;
    }

    const destination = job.escrowAddress;
    const source = publicKey;

    let transaction = await buildDonationTransaction(server, source, destination, amountXlm, `job-${jobId}`);

    let signedTransaction = await signTransaction(transaction.toXDR(), network);
    try {
      await server.submitTransaction(signedTransaction);
    } catch (submitError) {
      if (isStaleSequenceError(submitError)) {
        showStatus("Your account sequence number changed while waiting for approval. Rebuilding transaction with the latest sequence...", "info");
        transaction = await buildDonationTransaction(server, source, destination, amountXlm, `job-${jobId}`);
        signedTransaction = await signTransaction(transaction.toXDR(), network);
        await server.submitTransaction(signedTransaction);
      } else {
        throw submitError;
      }
    }

    await submitJobPayment({
      jobId,
      amountXlm: parseFloat(amountXlm),
      payerAddress: source,
      txHash: signedTransaction.hash().toString("hex"),
    });

    showStatus("Job payment successful!", "success");
  } catch (error) {
    console.error("Job payment failed:", error);
    showStatus(`Job payment failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export async function checkDonationStatus(donationId: string) {
  try {
    const donation = await fetchDonation(donationId);
    if (!donation) {
      showStatus("Donation not found.", "error");
      return;
    }
    showStatus(`Donation status: ${donation.status}`, "info");
  } catch (error) {
    console.error("Failed to check donation status:", error);
    showStatus(`Failed to check donation status: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
