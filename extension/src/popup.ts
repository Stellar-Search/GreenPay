import { Horizon, TransactionBuilder, Networks, Asset, Operation, Keypair, BASE_FEE } from '@stellar/stellar-sdk';
import { server, loadAccount } from './stellar';
import { showStatus } from './ui';
import { signTransaction } from './freighter';
import { getProject, getDonor } from './api';

const STALE_SEQUENCE_ERRORS = ['tx_bad_seq', 'tx_too_early', 'tx_too_late'];

function isStaleSequenceError(err: any): boolean {
  if (!err) return false;
  const data = err.response?.data;
  const code = data?.extras?.result_codes?.transaction || data?.extras?.result_codes?.operations?.[0] || data?.code || err.code;
  return STALE_SEQUENCE_ERRORS.includes(code);
}

export async function donate(projectId: string, amountXlm: number): Promise<void> {
  const project = await getProject(projectId);
  const donor = await getDonor();
  const source = donor.publicKey;

  try {
    const tx = await buildDonationTransaction(project, source, amountXlm);
    const signed = await signTransaction(tx);
    await server.submitTransaction(signed);
    showStatus('Donation submitted successfully!', 'success');
  } catch (err: any) {
    if (isStaleSequenceError(err)) {
      showStatus('Your account sequence number changed while waiting for approval. Rebuilding transaction...', 'warning');
      try {
        const freshTx = await buildDonationTransaction(project, source, amountXlm);
        const freshSigned = await signTransaction(freshTx);
        await server.submitTransaction(freshSigned);
        showStatus('Donation submitted successfully after retry!', 'success');
      } catch (retryErr: any) {
        if (isStaleSequenceError(retryErr)) {
          showStatus('Your account sequence number changed again. Please try again.', 'error');
        } else {
          showStatus(`Donation failed: ${retryErr.message}`, 'error');
        }
      }
    } else {
      showStatus(`Donation failed: ${err.message}`, 'error');
    }
  }
}

async function buildDonationTransaction(project: any, source: string, amountXlm: number): Promise<any> {
  const account = await loadAccount(source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: project.walletAddress,
        asset: Asset.native(),
        amount: amountXlm.toString(),
      })
    )
    .setTimeout(180)
    .build();
  return tx;
}
