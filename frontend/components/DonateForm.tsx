/**
 * components/DonateForm.tsx
 * Donation form for a climate project.
 */
import { useState, useEffect } from "react";
import { buildDonationTransaction, buildContractDonationTransaction, buildChangeTrustTransaction, submitTransaction, submitAndConfirmDonation, DonationSubmissionError, explorerUrl, getXLMBalance, getAssetBalance, getDonorStats, hashMessage, validateHash, CONTRACT_ID, NATIVE_ASSET_CONTRACT_ID, getReserveStatus } from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";
import { loadStarterAccount, signWithStarterAccount, shouldPromptExport } from "@/lib/starterAccount";
import { track, completeFunnel } from "@/lib/funnel";
import { recordDonation } from "@/lib/api";
import { formatXLM } from "@/utils/format";
import { useI18n } from "@/lib/i18n";
import { parseToStroops, stroopsToXLM, isValidDonationAmount, hasSufficientBalance, multiply } from "@/utils/amount";
import type { ClimateProject } from "@/utils/types";

interface DonateFormProps {
  project: ClimateProject;
  publicKey: string;
  initialAmount?: string;
  initialMessage?: string;
  onSuccess?: () => void;
  /**
   * Which key signs. Defaults to "wallet", so every existing call site keeps
   * the Freighter flow byte for byte; "starter" routes signing through the
   * browser-held key created by the sponsored path. The two differ only in who
   * holds the key — the transaction built, submitted and recorded is the same,
   * which is what keeps a sponsored donation a first-class donation rather than
   * a lesser parallel flow.
   */
  signer?: "wallet" | "starter";
}

type Step = "idle" | "building" | "signing" | "submitting" | "recording" | "success" | "error";

/**
 * Distinguishes *why* a donation didn't complete, so the UI can react appropriately:
 *  - "wallet_rejected": user declined in Freighter before anything was submitted —
 *    expected, quiet, not an error.
 *  - "execution_failed": the transaction landed on-chain but the contract call
 *    failed/panicked — the donation did not apply; any optimistic state must revert.
 *  - "network_unknown": we could not determine the final outcome — must not claim
 *    success or failure, just point the donor at their transaction history.
 *  - "generic": any other failure (build/sign/validation errors, etc.).
 */
type ErrorKind = "wallet_rejected" | "execution_failed" | "network_unknown" | "record_failed" | "generic";

const PRESETS_XLM = ["10", "25", "50", "100", "250"];
const PRESETS_USDC = ["5", "10", "25", "50", "100"];

export default function DonateForm({ project, publicKey, initialAmount, initialMessage, onSuccess, signer = "wallet" }: DonateFormProps) {
  const { t, localeTag } = useI18n();
  const [amount, setAmount]   = useState("");
  const [message, setMessage] = useState("");
  const [currency, setCurrency] = useState<"XLM" | "USDC">("XLM");
  const [step, setStep]       = useState<Step>("idle");
  const [error, setError]     = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [txHash, setTxHash]   = useState<string | null>(null);
  // Set only for a transaction that genuinely landed on-chain but failed to
  // execute — kept separate from txHash so a failed donation can never fall
  // into the `step === "success" && txHash` success-screen branch below.
  const [failedTxHash, setFailedTxHash] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [trustlineMissing, setTrustlineMissing] = useState<boolean>(false);
  const [donorBadge, setDonorBadge] = useState<string | null>(null);

  // Trustline-addition flow state
  type TrustlineStep = "idle" | "building" | "signing" | "submitting" | "done" | "error";
  const [trustlineStep, setTrustlineStep] = useState<TrustlineStep>("idle");
  const [trustlineError, setTrustlineError] = useState<string | null>(null);
  // Counter to force a balance re-fetch after a trustline is added
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  // What this account can actually send, as opposed to what it holds. An
  // account at the base-reserve boundary looks funded and is not: 1.4 XLM with
  // a trustline has 1.5 XLM locked and can send nothing. Surfacing that before
  // the donor signs turns an opaque `tx_insufficient_balance` into a sentence.
  const [spendableXlm, setSpendableXlm] = useState<string | null>(null);

  const isStarterAccount = signer === "starter";

  /**
   * Signs with whichever key this donor actually holds.
   *
   * Both branches return the same shape, so nothing downstream — building,
   * submitting, confirming, recording — needs to know which one ran. A
   * sponsored donor's donation takes exactly the same path as anyone else's.
   */
  const signDonation = async (xdr: string) => {
    if (isStarterAccount) {
      try {
        return { signedXDR: signWithStarterAccount(xdr), error: null, rejected: false };
      } catch (err) {
        return {
          signedXDR: null,
          error: err instanceof Error ? err.message : "Could not sign with your saved key.",
          rejected: false,
        };
      }
    }
    return signTransactionWithWallet(xdr);
  };

  useEffect(() => {
    if (!initialAmount) return;
    setAmount(initialAmount);
  }, [initialAmount]);

  useEffect(() => {
    if (!initialMessage) return;
    setMessage(initialMessage);
  }, [initialMessage]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pendingDonationRecord");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.projectId === project.id) {
          setTxHash(parsed.hash);
          setAmount(parsed.amount);
          if (parsed.message) setMessage(parsed.message);
          setCurrency(parsed.currency);
          setErrorKind("record_failed");
          setError("We received your donation on-chain, but couldn't record it on the server.");
          setStep("error");
        }
      }
    } catch (e) {}
  }, [project.id]);

  useEffect(() => {
    let mounted = true;
    async function loadBalances() {
      if (!publicKey) return;
      try {
        const xlm = await getXLMBalance(publicKey);
        if (!mounted) return;
        setXlmBalance(xlm);
        if (currency === "USDC") {
          const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
          if (!issuer) {
            setUsdcBalance(null);
            setTrustlineMissing(true);
            return;
          }
          const usdc = await getAssetBalance(publicKey, "USDC", issuer);
          if (!mounted) return;
          setUsdcBalance(usdc);
          setTrustlineMissing(usdc === null);
        } else {
          setUsdcBalance(null);
          setTrustlineMissing(false);
        }
      } catch (err) {
        // ignore balance fetch errors; leave values as null
      }
    }

    loadBalances();
    return () => { mounted = false; };
  }, [publicKey, currency, balanceRefresh]);

  useEffect(() => {
    let mounted = true;
    if (!publicKey) return;
    getReserveStatus(publicKey)
      .then((status) => {
        if (!mounted) return;
        // "unknown" means Horizon did not answer. Leaving this null renders no
        // claim at all, which is the only honest thing to show.
        setSpendableXlm(status.readiness === "unknown" ? null : status.spendableXlm);
        if (status.readiness === "ready") {
          void track("funds_available", {
            path: isStarterAccount ? "sponsored_account" : "connected_wallet",
            projectId: project.id,
          });
        }
      })
      .catch(() => {
        if (mounted) setSpendableXlm(null);
      });
    return () => { mounted = false; };
  }, [publicKey, balanceRefresh, isStarterAccount, project.id]);

  const amountNum = Number.parseFloat(amount);
  const amountStroops = parseToStroops(amount);
  const isValid = isValidDonationAmount(amount) && parseToStroops(amount) >= parseToStroops("1");

    const charCount = message.length;

      const getCounterColor = () => {
        if (charCount >= 96) return "text-red-500";
        if (charCount >= 80) return "text-amber-500";
        return "text-green-600";
      };

  /**
   * Builds, signs, and submits a changeTrust operation for USDC so the donor
   * can proceed to donate without leaving the app.
   */
  const handleAddTrustline = async () => {
    const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
    if (!issuer) {
      setTrustlineError("USDC issuer not configured.");
      setTrustlineStep("error");
      return;
    }

    setTrustlineError(null);
    try {
      setTrustlineStep("building");
      const tx = await buildChangeTrustTransaction({
        publicKey,
        assetCode: "USDC",
        assetIssuer: issuer,
      });

      setTrustlineStep("signing");
      const { signedXDR, error: signErr, rejected } = await signTransactionWithWallet(tx.toXDR());
      if (rejected) {
        // User cancelled — quiet reset, not an error.
        setTrustlineStep("idle");
        return;
      }
      if (signErr || !signedXDR) throw new Error(signErr || "Signing failed.");

      setTrustlineStep("submitting");
      await submitTransaction(signedXDR);

      setTrustlineStep("done");
      // Trigger a balance re-fetch so trustlineMissing flips to false
      setBalanceRefresh((n) => n + 1);
      // Reset back to idle after a brief success flash
      setTimeout(() => setTrustlineStep("idle"), 1500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface a specific hint when the real problem is insufficient XLM
      if (/underfunded|insufficient/i.test(msg)) {
        setTrustlineError("You need at least 0.5 XLM to add a trustline (Stellar base reserve).");
      } else {
        setTrustlineError(msg);
      }
      setTrustlineStep("error");
      setTimeout(() => setTrustlineStep("idle"), 5000);
    }
  };

  const handleDonate = async () => {
    if (!isValid || (step !== "idle" && !(step === "error" && errorKind === "record_failed"))) return;
    setError(null);
    setErrorKind(null);
    setFailedTxHash(null);

    // Snapshot every piece of state this donation could optimistically touch,
    // so a failure after submission has something concrete to revert to.
    const preDonationBadge = donorBadge;

    try {
      if (step === "error" && errorKind === "record_failed" && txHash) {
        setStep("recording");
        let recordAmount = currency === "XLM" ? stroopsToXLM(amountStroops) : amountNum.toFixed(2);
        let recordCurrency = currency;
        let recordMessage = message.trim() || undefined;
        try {
          const saved = localStorage.getItem("pendingDonationRecord");
          if (saved) {
            const parsed = JSON.parse(saved);
            recordAmount = parsed.currency === "XLM" ? stroopsToXLM(parseToStroops(parsed.amount)) : Number.parseFloat(parsed.amount).toFixed(2);
            recordCurrency = parsed.currency;
            recordMessage = parsed.message?.trim() || undefined;
          }
        } catch (e) {}
        
        await recordDonation({
          projectId: project.id,
          donorAddress: publicKey,
          amount: recordAmount,
          currency: recordCurrency,
          message: recordMessage,
          transactionHash: txHash,
        });
        localStorage.removeItem("pendingDonationRecord");
        setStep("success");
        onSuccess?.();
        return;
      }

      const useContract = CONTRACT_ID && currency === "XLM";

      let tx;
      if (useContract) {
        setStep("building");

        const msgHash = hashMessage(message.trim());
        if (!validateHash(msgHash)) {
          throw new Error("Invalid donation message hash");
        }

        tx = await buildContractDonationTransaction({
          contractId: CONTRACT_ID,
          tokenAddress: NATIVE_ASSET_CONTRACT_ID,
          donor: publicKey,
          projectId: project.id,
          amount: stroopsToXLM(amountStroops),
          msgHash,
        });
      } else {
        // Fallback to standard payment
        setStep("building");
        const asset = currency === "USDC"
          ? { code: "USDC", issuer: process.env.NEXT_PUBLIC_USDC_ISSUER }
          : undefined;

        if (currency === "USDC") {
          if (!process.env.NEXT_PUBLIC_USDC_ISSUER) throw new Error("USDC issuer not configured (NEXT_PUBLIC_USDC_ISSUER).");
          if (trustlineMissing) throw new Error("No USDC trustline on your account. Add a trustline to receive/send USDC.");
        }

        tx = await buildDonationTransaction({
          fromPublicKey: publicKey,
          toPublicKey: project.walletAddress,
          amount: currency === "XLM" ? stroopsToXLM(amountStroops) : parseFloat(amount).toFixed(2),
          memo: `GreenPay:${project.id.slice(0, 16)}`,
          asset,
        });
      }

      setStep("signing");
      const { signedXDR, error: signErr, rejected } = await signDonation(tx.toXDR());
      if (rejected) {
        // Wallet rejection happens before anything is submitted — nothing to
        // revert, and it isn't an error the donor needs to be alarmed by.
        setErrorKind("wallet_rejected");
        setError(signErr || "Transaction rejected.");
        setStep("error");
        setTimeout(() => setStep("idle"), 1200);
        return;
      }
      if (signErr || !signedXDR) throw new Error(signErr || "Signing failed");

      // submitAndConfirmDonation only resolves once the transaction's *final*
      // on-chain outcome is known — a Soroban donate() call can still panic
      // after a successful simulation (e.g. a checked-arithmetic overflow), so
      // nothing below this point may run until execution is actually confirmed.
      setStep("submitting");
      void track("donation_submitted", { path: isStarterAccount ? "sponsored_account" : "connected_wallet", projectId: project.id });
      const { hash } = await submitAndConfirmDonation(signedXDR);
      setTxHash(hash);
      void track("donation_confirmed", { path: isStarterAccount ? "sponsored_account" : "connected_wallet", projectId: project.id });
      
      localStorage.setItem("pendingDonationRecord", JSON.stringify({
        hash,
        amount,
        message,
        currency,
        projectId: project.id,
      }));

      setStep("recording");
      if (useContract) {
        // Query updated donor stats from contract
        const stats = await getDonorStats(publicKey);
        if (stats && stats.badge) {
          const badgeNames: Record<string, string> = {
            Seedling: "🌱 Seedling",
            Tree: "🌳 Tree",
            Forest: "🌲 Forest",
            EarthGuardian: "🌍 Earth Guardian",
          };
          setDonorBadge(badgeNames[stats.badge] || null);
        }
      }

      // Only record — and thus only affect the donation total / leaderboard —
      // once the transaction is confirmed successful.
      await recordDonation({
        projectId: project.id,
        donorAddress: publicKey,
        amount: currency === "XLM" ? stroopsToXLM(amountStroops) : amountNum.toFixed(2),
        currency: currency,
        message: message.trim() || undefined,
        transactionHash: hash,
      });
      
      localStorage.removeItem("pendingDonationRecord");

      void track("donation_recorded", { path: isStarterAccount ? "sponsored_account" : "connected_wallet", projectId: project.id });
      void completeFunnel("completed", isStarterAccount ? "sponsored_account" : "connected_wallet");

      setStep("success");
      onSuccess?.();
    } catch (err: unknown) {
      // Revert any optimistic state a previous attempt (or this one, before
      // hitting the confirmed-failure branch above) may have set.
      setDonorBadge(preDonationBadge);
      
      const isRecordPhase = localStorage.getItem("pendingDonationRecord") !== null;
      if (isRecordPhase) {
        setErrorKind("record_failed");
        setError(err instanceof Error ? err.message : "Failed to record donation.");
        setStep("error");
      } else {
        setTxHash(null);

      if (err instanceof DonationSubmissionError) {
        if (err.outcome === "execution_failed") {
          setErrorKind("execution_failed");
          if (err.hash) setFailedTxHash(err.hash);
        } else if (err.outcome === "unknown") {
          setErrorKind("network_unknown");
        } else {
          setErrorKind("generic");
        }
        setError(err.message);
      } else {
        setErrorKind("generic");
        setError(err instanceof Error ? err.message : "An error occurred");
      }
      }
      if (!isRecordPhase) {
        setStep("error");
        setTimeout(() => setStep("idle"), 6000);
      }
    }
  };

  if (step === "success" && txHash) {
    return (
      <div className="card text-center animate-slide-up">
        <div className="text-4xl mb-3">🌱</div>
        <h3 className="font-display text-xl font-semibold text-forest-900 mb-2">Thank you!</h3>
        <p className="text-[#4b654b] text-sm mb-4 font-body">
          Your donation of <span className="font-semibold text-forest-700">{currency === "XLM" ? formatXLM(parseFloat(stroopsToXLM(amountStroops)), 2, localeTag) : `${parseFloat(amount).toFixed(2)} ${currency}`}</span> has been sent to <span className="font-semibold">{project.name}</span>.
        </p>
        {donorBadge && (
          <div className="mb-4 p-3 bg-forest-50 border border-forest-200 rounded-xl">
            <p className="text-sm font-semibold text-forest-900 mb-1">🎉 Congrats! You earned a new badge!</p>
            <p className="text-lg font-bold text-forest-700">{donorBadge}</p>
          </div>
        )}
        <a href={explorerUrl(txHash)} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-forest-600 hover:text-forest-700 transition-colors font-body">
          View on Stellar Expert ↗
        </a>
      </div>
    );
  }
  return (
    <div className="card animate-fade-in">
      <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">Make a Donation</h3>
          <p className="text-[#4b654b] text-sm mb-5 font-body">100% goes directly to the project wallet.</p>

      <div className="space-y-4">
        {/* Currency selector */}
        <div>
          <label className="label">Currency</label>
          <div className="flex gap-2">
            <button onClick={() => setCurrency("XLM")}
              className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all font-body ${currency === "XLM" ? "bg-forest-500 text-white" : "bg-white"}`}>
              XLM
            </button>
            <button onClick={() => setCurrency("USDC")}
              className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all font-body ${currency === "USDC" ? "bg-forest-500 text-white" : "bg-white"}`}>
              USDC
            </button>
          </div>
        </div>
        {/* Preset amounts */}
        <div>
          <label className="label">Choose Amount ({currency})</label>
          <div className="flex flex-wrap gap-2 mb-3">
            {(currency === "XLM" ? PRESETS_XLM : PRESETS_USDC).map((p) => (
              <button key={p} onClick={() => setAmount(p)}
                className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all font-body ${
                  amount === p
                    ? "bg-forest-500 text-white border-forest-500"
                    : "bg-forest-50 text-forest-700 border-forest-200 hover:border-forest-400"
                }`}>
                {p} {currency}
              </button>
            ))}
          </div>
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="Or enter custom amount..." min="1" step="1"
            className="input-field" />
          {amount && !isValid && <p className="mt-1 text-xs text-red-500">Minimum donation is 1 {currency}</p>}
          
          <div className="mt-3 p-3 bg-forest-50 border border-forest-200 rounded-xl">
            <p className="text-xs text-forest-700">
              Your payment is recorded on-chain. Environmental outcomes are reported separately as measured project claims; this amount does not generate an automatic CO₂ estimate.
            </p>
          </div>
        </div>

        {/* Message */}
        <div>
          <label className="label">Message <span className="normal-case text-[#547454] font-normal">(optional)</span></label>
          <input type="text" value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder="Leave a message of support..." maxLength={100}
            className="input-field" />
        </div>

        {/*  Helper text */}
          <p className="text-xs text-muted-foreground mt-1">
            Your message will appear in the public donation feed
          </p>

          {/* Character counter */}
          <p className={`text-xs mt-1 ${getCounterColor()}`}>
            {charCount} / 100 characters
          </p>
        </div>

        {/* The base-reserve boundary, before the donor signs rather than after
            Horizon rejects them. Only shown when we actually know the number:
            a null spendable means Horizon did not answer, and inventing a
            reassurance would be worse than saying nothing. */}
        {currency === "XLM" && spendableXlm !== null && isValid && (
          (() => {
            const spendable = Number.parseFloat(spendableXlm);
            const requested = Number.parseFloat(stroopsToXLM(amountStroops));
            if (!Number.isFinite(spendable) || spendable >= requested) return null;
            return (
              <div
                data-testid="donate-reserve-warning"
                className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-body"
              >
                <p className="font-semibold mb-1">Your account can&apos;t send this much yet</p>
                <p>
                  It can send {spendableXlm} XLM. Stellar keeps a minimum balance locked in every
                  account, so part of your balance can never be spent.
                </p>
              </div>
            );
          })()
        )}

        {/* Shown once a sponsored donor has something to lose. Nudging someone
            with an empty account to back it up trains them to ignore the
            warning that matters. */}
        {isStarterAccount && shouldPromptExport(loadStarterAccount(), Boolean(txHash)) && (
          <div
            data-testid="donate-export-nudge"
            className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-body"
          >
            <p className="font-semibold mb-1">Save your key</p>
            <p>
              You&apos;ve donated from an account whose key only exists in this browser. Save it
              somewhere else, or connect a full wallet and bring your history across.
            </p>
          </div>
        )}

        {step === "error" && error && errorKind === "wallet_rejected" && (
          <div
            data-testid="donate-error-wallet-rejected"
            className="p-3 rounded-xl bg-forest-50 border border-forest-200 text-[#4b654b] text-sm font-body"
          >
            Signing cancelled — no donation was made.
          </div>
        )}

        {step === "error" && error && errorKind === "execution_failed" && (
          <div
            data-testid="donate-error-execution-failed"
            className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body"
          >
            <p className="font-semibold mb-1">Your donation didn&apos;t go through</p>
            <p>{error}</p>
            {failedTxHash && (
              <a href={explorerUrl(failedTxHash)} target="_blank" rel="noopener noreferrer"
                className="underline text-red-700 hover:text-red-800">
                View the failed transaction ↗
              </a>
            )}
          </div>
        )}

        {step === "error" && error && errorKind === "network_unknown" && (
          <div
            data-testid="donate-error-network-unknown"
            className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm font-body"
          >
            <p className="font-semibold mb-1">We couldn&apos;t confirm this donation</p>
            <p>{error}</p>
          </div>
        )}

        {step === "error" && error && errorKind === "record_failed" && (
          <div
            data-testid="donate-error-record-failed"
            className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm font-body"
          >
            <p className="font-semibold mb-1">We couldn&apos;t record this donation</p>
            <p>{error}</p>
            {txHash && (
              <a href={explorerUrl(txHash)} target="_blank" rel="noopener noreferrer"
                className="underline text-amber-800 hover:text-amber-900 block mt-2">
                View on Stellar Expert ↗
              </a>
            )}
          </div>
        )}

        {step === "error" && error && (errorKind === "generic" || errorKind === null) && (
          <div
            data-testid="donate-error-generic"
            className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body"
          >
            {error}
          </div>
        )}

        {currency === "USDC" && (
          <div className="text-xs text-muted-foreground">
            <p>Balances:</p>
            <p>XLM: <span className="font-medium">{xlmBalance ?? "—"}</span></p>
            <p>USDC: <span className="font-medium">{usdcBalance === null ? "No trustline" : usdcBalance}</span></p>
            {trustlineMissing && (
              <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
                <p className="text-sm text-amber-700 mb-2 font-body">
                  Your account doesn&apos;t have a USDC trustline yet. Add one to donate with USDC.
                </p>
                {trustlineError && (
                  <p className="text-xs text-red-500 mb-2">{trustlineError}</p>
                )}
                <button
                  onClick={handleAddTrustline}
                  disabled={trustlineStep !== "idle" && trustlineStep !== "error"}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border transition-all font-body bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60"
                >
                  {trustlineStep === "building"   && <><Spinner />Building…</>}
                  {trustlineStep === "signing"    && <><Spinner />Sign in Freighter…</>}
                  {trustlineStep === "submitting" && <><Spinner />Submitting…</>}
                  {trustlineStep === "done"       && <>✓ Trustline added!</>}
                  {trustlineStep === "error"      && <>Retry</>}
                  {trustlineStep === "idle"       && <>Add USDC Trustline</>}
                </button>
              </div>
            )}
          </div>
        )}

        <button onClick={handleDonate} disabled={!isValid || (step !== "idle" && !(step === "error" && errorKind === "record_failed"))}
          className="btn-primary w-full flex items-center justify-center gap-2">
          {step === "building"   && <><Spinner />Building transaction...</>}
          {step === "signing"    && <><Spinner />{isStarterAccount ? "Signing..." : "Sign in Freighter..."}</>}
          {step === "submitting" && <><Spinner />Submitting &amp; confirming...</>}
          {step === "recording"  && <>Done</>}
          {step === "idle"       && <>🌱 Donate {amount ? (currency === "XLM" ? formatXLM(parseFloat(stroopsToXLM(amountStroops)), 2, localeTag) : `$${parseFloat(amount).toFixed(2)} ${currency}`) : currency}</>}
          {step === "error"      && (errorKind === "record_failed" ? "Retry Recording" : "Retry")}
        </button>

        {step === "signing" && (
          <p className="text-center text-xs text-[#4b654b] animate-pulse font-body">
            {isStarterAccount
              ? "Signing with the key saved in this browser..."
              : "Please confirm in your Freighter wallet..."}
          </p>
        )}
      </div>
  );
}

function Spinner() {
  return <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>;
}
