/**
 * lib/wallet.ts — Freighter wallet integration
 */
import { isConnected, getPublicKey, signTransaction, requestAccess, isAllowed } from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "./stellar";
import { extractBoolean, extractString } from "./freighterResult";

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const result: unknown = await isConnected();
    return extractBoolean("isConnected", result, "isConnected");
  }
  catch { return false; }
}

export async function connectWallet(): Promise<{ publicKey: string | null; error: string | null }> {
  const installed = await isFreighterInstalled();
  if (!installed) return { publicKey: null, error: "Freighter not installed. Visit https://freighter.app" };
  try {
    await requestAccess();
    const result: unknown = await getPublicKey();
    const publicKey = extractString("getPublicKey", result, ["publicKey", "address"]);
    return { publicKey: publicKey || null, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User declined")) return { publicKey: null, error: "Connection rejected." };
    return { publicKey: null, error: `Connection failed: ${msg}` };
  }
}

export async function getConnectedPublicKey(): Promise<string | null> {
  try {
    const allowedResult: unknown = await isAllowed();
    const isUserAllowed = extractBoolean("isAllowed", allowedResult, "isAllowed");
    if (!isUserAllowed) return null;

    const result: unknown = await getPublicKey();
    const publicKey = extractString("getPublicKey", result, ["publicKey", "address"]);
    return publicKey || null;
  } catch { return null; }
}

export interface SignTransactionResult {
  signedXDR: string | null;
  error: string | null;
  /**
   * True when the user declined in Freighter (happens before submission — this is
   * an expected, quiet outcome, not a scary error). False/undefined for any other
   * signing failure.
   */
  rejected?: boolean;
}

export async function signTransactionWithWallet(xdr: string): Promise<SignTransactionResult> {
  // Test seam: e2e tests can inject a deterministic signer via
  // window.__test_signTransaction__ so donate-flow tests don't have to drive the
  // real Freighter postMessage handshake (see the __test_publicKey__ seam in
  // pages/_app.tsx for the same rationale). Untouched in production.
  if (typeof window !== "undefined") {
    const testSigner = (window as unknown as {
      __test_signTransaction__?: (xdr: string) => Promise<SignTransactionResult> | SignTransactionResult;
    }).__test_signTransaction__;
    if (typeof testSigner === "function") {
      return testSigner(xdr);
    }
  }

  try {
    const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "MAINNET" : "TESTNET";
    const result: unknown = await signTransaction(xdr, { networkPassphrase: NETWORK_PASSPHRASE, network });
    const signedXDR = extractString("signTransaction", result, ["signedTransaction"]);
    return { signedXDR: signedXDR || null, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User declined") || msg.includes("rejected")) {
      return { signedXDR: null, error: "Transaction rejected.", rejected: true };
    }
    return { signedXDR: null, error: `Signing failed: ${msg}` };
  }
}
