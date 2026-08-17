import { Horizon, TransactionBuilder, Networks, Asset, BASE_FEE, Operation, Keypair, Memo } from "@stellar/stellar-sdk";
import { getPublicKey, signTransaction } from "@stellar/freighter-api";
import { showStatus, showError, showSuccess, showInfo, showConfirm } from "./ui";
import { getProject, getDonorStats, recordDonation, getBackendConfig } from "./api";
import { getNetworkPassphrase, getHorizonUrl, getNetworkConfig } from "./network";

const MAX_SEQUENCE_RETRIES = 3;

interface DonationResult {
  success: boolean;
  hash?: string;
  error?: string;
  staleSequence?: boolean;
}

function isBadSequenceError(err: any): boolean {
  if (!err) return false;
  const message = String(err.message || err.data?.message || "").toLowerCase();
  const code = err.response?.data?.extras?.result_codes?.txn_bad_seq ||
    err.response?.data?.extras?.result_codes?.transaction ||
    err.response?.data?.extras?.result_codes?.op;
  return (
    message.includes("bad sequence") ||
    message.includes("tx_bad_seq") ||
    message.includes("stale sequence") ||
    code === "tx_bad_seq" ||
    code === "txn_bad_seq"
  );
}

async function buildDonationTransaction(
  publicKey: string,
  projectId: string,
  amountXlm: number,
  memoText: string
) {
  const server = new Horizon.Server(getHorizonUrl());
  const account = await server.loadAccount(publicKey);
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination: project.walletAddress,
        asset: Asset.native(),
        amount: amountXlm.toString(),
      })
    )
    .addMemo(Memo.text(memoText))
    .setTimeout(180)
    .build();

  return { transaction, server };
}

async function submitWithRetry(
  publicKey: string,
  projectId: string,
  amountXlm: number,
  memoText: string,
  onRetry: (attempt: number) => void
): Promise<DonationResult> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_SEQUENCE_RETRIES; attempt++) {
    try {
      const { transaction, server } = await buildDonationTransaction(
        publicKey,
        projectId,
        amountXlm,
        memoText
      );

      const signedXDR = await signTransaction(transaction.toXDR(), {
        networkPassphrase: getNetworkPassphrase(),
        accountToSign: publicKey,
      });

      const result = await server.submitTransaction(signedXDR);
      return { success: true, hash: result.hash };
    } catch (err: any) {
      lastError = err;
      if (isBadSequenceError(err)) {
        if (attempt < MAX_SEQUENCE_RETRIES) {
          onRetry(attempt);
          continue;
        }
        return {
          success: false,
          staleSequence: true,
          error: "Your account sequence number changed while signing. Please try again.",
        };
      }
      throw err;
    }
  }

  return { success: false, error: lastError?.message || "Unknown error" };
}

export async function donate(
  projectId: string,
  amountXlm: number,
  memoText: string
): Promise<DonationResult> {
  try {
    const publicKey = await getPublicKey();
    if (!publicKey) {
      showError("Please connect your wallet first.");
      return { success: false, error: "No wallet connected" };
    }

    showStatus("Preparing donation...");

    const result = await submitWithRetry(
      publicKey,
      projectId,
      amountXlm,
      memoText,
      (attempt) => {
        showInfo(
          `Your account sequence changed while signing. Rebuilding transaction (attempt ${attempt + 1})...`
        );
      }
    );

    if (result.success && result.hash) {
      showSuccess(`Donation submitted! Hash: ${result.hash}`);
      await recordDonation(projectId, publicKey, amountXlm, memoText, result.hash);
      return result;
    }

    if (result.staleSequence) {
      const shouldRetry = await showConfirm(
        "Your account sequence number changed while signing. Would you like to rebuild and try again?"
      );
      if (shouldRetry) {
        return donate(projectId, amountXlm, memoText);
      }
      showError(result.error || "Donation failed due to a stale sequence number.");
      return result;
    }

    showError(result.error || "Donation failed.");
    return result;
  } catch (err: any) {
    showError(err.message || "Donation failed.");
    return { success: false, error: err.message };
  }
}
