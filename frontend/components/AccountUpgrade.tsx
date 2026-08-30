/**
 * components/AccountUpgrade.tsx
 *
 * Moving a donor from a browser-held starter account to a wallet they properly
 * control, carrying their history with them.
 *
 * ── Why both keys sign ──────────────────────────────────────────────────────
 * The migration moves donation history and badge progress between addresses.
 * With only the destination proving control, anyone could adopt a stranger's
 * leaderboard history by naming their address; with only the source, someone
 * could dump history onto an address they do not own. So the donor signs one
 * single-use challenge twice — once with the starter key held here, once with
 * the wallet — and the backend verifies both.
 *
 * ── Why the limitations are on this screen ──────────────────────────────────
 * A donor arrives here believing everything moves. Some of it does not: the
 * donations stay on-chain under the address that made them, and any XLM left
 * behind stays behind. That is stated before they sign, not in a success
 * message afterwards.
 */
import { useState } from "react";
import { completeUpgrade, requestUpgradeChallenge } from "@/lib/onboarding";
import { loadStarterAccount, markUpgraded, signUpgradeWithStarterAccount } from "@/lib/starterAccount";
import { connectWallet, signTransactionWithWallet } from "@/lib/wallet";
import { assertSignedChallenge, buildChallengeTransaction } from "@/lib/challenge";
import { getApiErrorMessage } from "@/lib/api";

const UPGRADE_LIMITATIONS = {
  moves: [
    "Your donation history on GreenPay — every donation you made from the starter account appears under your new wallet.",
    "Your badge progress, which is derived from that history.",
    "Your profile, so there is one page instead of two.",
  ],
  doesNotMove: [
    "The donations themselves. They stay recorded on Stellar under the address that made them — that is the point of an immutable ledger, and nothing can or should change it.",
    "Any XLM still sitting in the starter account. Send it across yourself, or merge the account, before you stop using that key.",
    "Your all-time leaderboard position, until the leaderboard is next rebuilt. Your starter address keeps its rank in the meantime.",
  ],
} as const;

type Step = "idle" | "connecting" | "signing" | "migrating" | "done" | "error";

interface AccountUpgradeProps {
  onComplete?: (walletAddress: string) => void;
}

export default function AccountUpgrade({ onComplete }: AccountUpgradeProps) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [migrated, setMigrated] = useState<number | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  const starter = typeof window === "undefined" ? null : loadStarterAccount();

  if (!starter) {
    return null;
  }

  const run = async () => {
    setError(null);
    try {
      setStep("connecting");
      const { publicKey, error: connectError } = await connectWallet();
      if (connectError || !publicKey) {
        throw new Error(connectError || "Could not connect a wallet.");
      }
      if (publicKey === starter.publicKey) {
        throw new Error("That is the same account. Connect the wallet you want to move to.");
      }
      setWalletAddress(publicKey);

      setStep("signing");
      const challenge = await requestUpgradeChallenge({
        fromAddress: starter.publicKey,
        toAddress: publicKey,
      });

      // Two different proofs, because the two keys can do different things.
      // The starter key is ours to use directly, so it signs the challenge
      // bytes. The wallet will only sign a transaction envelope, so it signs
      // the unsubmittable SEP-10-style challenge built in lib/challenge.ts.
      const fromSignature = signUpgradeWithStarterAccount(challenge.message);

      const challengeXdr = buildChallengeTransaction({
        address: publicKey,
        nonce: challenge.nonce,
      });
      const { signedXDR, error: signError } = await signTransactionWithWallet(challengeXdr);
      if (signError || !signedXDR) {
        throw new Error(signError || "The wallet did not sign the verification challenge.");
      }
      assertSignedChallenge(signedXDR, publicKey);

      setStep("migrating");
      const result = await completeUpgrade({
        upgradeId: challenge.upgradeId,
        fromSignature,
        toChallengeXdr: signedXDR,
      });

      markUpgraded(publicKey);
      setMigrated(result.migrated);
      setStep("done");
      onComplete?.(publicKey);
    } catch (err) {
      setError(getApiErrorMessage(err, err instanceof Error ? err.message : "The move didn't complete."));
      setStep("error");
    }
  };

  if (step === "done") {
    return (
      <div className="card animate-slide-up" data-testid="account-upgrade-done">
        <div className="text-3xl mb-2">🎉</div>
        <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">
          Your history moved across
        </h3>
        <p className="text-sm text-[#4b654b] mb-3 font-body">
          {migrated === 1 ? "1 donation" : `${migrated ?? 0} donations`} now appear under your
          wallet.
        </p>
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800 font-body">
          <p className="font-semibold mb-1">Don&apos;t delete your old key yet</p>
          <p>
            If any XLM is still in the starter account, that key is the only way to move it. Send it
            across first.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card animate-fade-in" data-testid="account-upgrade">
      <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">
        Move to a wallet you control
      </h3>
      <p className="text-sm text-[#4b654b] mb-4 font-body">
        Your donations are currently tied to a key that only exists in this browser. Connect a real
        wallet and bring your history with you — it&apos;s free and takes a moment.
      </p>

      <div className="mb-3">
        <p className="text-sm font-semibold text-forest-800 mb-2 font-body">What moves</p>
        <ul className="space-y-1">
          {UPGRADE_LIMITATIONS.moves.map((line) => (
            <li key={line} className="text-sm text-[#4b654b] font-body leading-relaxed">
              ✓ {line}
            </li>
          ))}
        </ul>
      </div>

      {/* Stated before the donor signs, not in the success screen. */}
      <div className="mb-4" data-testid="upgrade-limitations">
        <p className="text-sm font-semibold text-amber-800 mb-2 font-body">What does not move</p>
        <ul className="space-y-1">
          {UPGRADE_LIMITATIONS.doesNotMove.map((line) => (
            <li key={line} className="text-sm text-[#4b654b] font-body leading-relaxed">
              ! {line}
            </li>
          ))}
        </ul>
      </div>

      {error && (
        <div className="mb-3 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body">
          {error}
        </div>
      )}

      <button
        onClick={run}
        disabled={step !== "idle" && step !== "error"}
        className="btn-primary w-full"
        data-testid="account-upgrade-start"
      >
        {step === "connecting" && "Connecting your wallet…"}
        {step === "signing" && "Sign to prove both accounts are yours…"}
        {step === "migrating" && "Moving your history…"}
        {(step === "idle" || step === "error") && "Connect a wallet and move my history"}
      </button>

      {walletAddress && step !== "error" && (
        <p className="mt-2 text-xs text-[#547454] font-mono break-all">{walletAddress}</p>
      )}
    </div>
  );
}
