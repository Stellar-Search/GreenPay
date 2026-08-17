import { Horizon, TransactionBuilder, Networks, Asset, BASE_FEE, Account } from "@stellar/stellar-sdk";
import { showStatus } from "./status";
import { getProjectById } from "./api";
import { signTransaction } from "@stellar/freighter-api";

const server = new Horizon.Server("https://horizon-testnet.stellar.org");

interface DonationParams {
  projectId: string;
  amountXlm: string;
  donorPublicKey: string;
}

async function buildDonationTransaction(
  projectId: string,
  amountXlm: string,
  donorPublicKey: string
): Promise<{ tx: string; sequence: string }> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error("Project not found");
  }

  const account = await server.loadAccount(donorPublicKey);
  const sequence = account.sequenceNumber();

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Asset.native().operation({
        type: "payment",
        destination: project.walletAddress,
        amount: amountXlm,
      })
    )
    .setTimeout(30)
    .build();

  return { tx: tx.toXDR(), sequence };
}

function isBadSequenceError(err: unknown): boolean {
  if (err && typeof err === "object" && "response" in err) {
    const response = (err as { response?: { data?: { status?: number; title?: string; detail?: string } } }).response;
    if (response?.data?.status === 400 && response.data.title === "Transaction Failed") {
      const detail = response.data.detail || "";
      return detail.includes("bad sequence number") || detail.includes("tx_bad_seq");
    }
  }
  return false;
}

export async function donate({ projectId, amountXlm, donorPublicKey }: DonationParams): Promise<void> {
  try {
    const { tx, sequence } = await buildDonationTransaction(projectId, amountXlm, donorPublicKey);

    showStatus("Please approve the transaction in Freighter...");
    const signedTx = await signTransaction(tx, {
      networkPassphrase: Networks.TESTNET,
      accountToSign: donorPublicKey,
    });

    try {
      await server.submitTransaction(signedTx);
      showStatus("Donation submitted successfully!");
    } catch (submitErr) {
      if (isBadSequenceError(submitErr)) {
        showStatus(
          "Your account sequence number changed while waiting for approval. " +
            "Please review and re-sign the transaction with the updated sequence."
        );
        const { tx: rebuiltTx } = await buildDonationTransaction(projectId, amountXlm, donorPublicKey);
        showStatus("Please approve the rebuilt transaction in Freighter...");
        const reSignedTx = await signTransaction(rebuiltTx, {
          networkPassphrase: Networks.TESTNET,
          accountToSign: donorPublicKey,
        });
        await server.submitTransaction(reSignedTx);
        showStatus("Donation submitted successfully after rebuilding!");
      } else {
        throw submitErr;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showStatus(`Donation failed: ${message}`);
  }
}
