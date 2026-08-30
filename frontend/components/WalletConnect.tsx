/**
 * components/WalletConnect.tsx
 *
 * The connect card, unchanged for donors who already have a wallet.
 *
 * The one addition is `allowGuidedOnboarding`, which is opt-in per call site
 * and off by default. With it off this component renders and behaves exactly as
 * it did before — same copy, same heading, same single button — because the
 * donors it already serves are not the ones with a problem. With it on, a
 * second, quieter affordance appears for the donor who has no wallet at all,
 * whose only previous option was a link to go and install one and, in practice,
 * to leave.
 */
import { useState } from "react";
import { connectWallet, isFreighterInstalled } from "@/lib/wallet";
import { track } from "@/lib/funnel";
import FirstDonationPaths from "./FirstDonationPaths";

interface WalletConnectProps {
  onConnect: (pk: string) => void;
  /**
   * Offer the no-wallet paths alongside the Freighter button. Enabled on
   * donation surfaces only: the admin and job pages need a *specific* wallet to
   * be connected, and a starter account cannot be that wallet.
   */
  allowGuidedOnboarding?: boolean;
  projectId?: string;
}

export default function WalletConnect({
  onConnect,
  allowGuidedOnboarding = false,
  projectId,
}: WalletConnectProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(false);
  const [walletDetected, setWalletDetected] = useState(false);

  const handleConnect = async () => {
    setLoading(true); setError(null);
    const installed = await isFreighterInstalled();
    setWalletDetected(installed);
    if (!installed) {
      // Previously the only outcome here was a new tab to freighter.app, which
      // is where most first-time donors stopped. With guided onboarding on,
      // there is somewhere else to go.
      if (allowGuidedOnboarding) {
        setShowPaths(true);
        setLoading(false);
        return;
      }
      window.open("https://freighter.app", "_blank");
      setLoading(false);
      return;
    }
    const { publicKey, error: e } = await connectWallet();
    setLoading(false);
    if (e) { setError(e); return; }
    if (publicKey) {
      void track("account_ready", { path: "connected_wallet", projectId });
      onConnect(publicKey);
    }
  };

  if (showPaths) {
    return (
      <FirstDonationPaths
        walletDetected={walletDetected}
        projectId={projectId}
        onAccountReady={onConnect}
        onUseWallet={() => setShowPaths(false)}
      />
    );
  }

  return (
    <div className="card max-w-sm mx-auto text-center animate-slide-up shadow-green">
      <div className="text-4xl mb-4">🌿</div>
      <h3 className="font-display text-xl font-semibold text-forest-900 mb-2">Connect Your Wallet</h3>
      <p className="text-[#4b654b] text-sm mb-5 font-body leading-relaxed">
        Use <a href="https://freighter.app" target="_blank" rel="noopener noreferrer" className="text-forest-600 hover:underline font-semibold">Freighter</a> to donate XLM directly to climate projects with zero platform fees.
      </p>
      {error && <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body">{error}</div>}
      <button onClick={handleConnect} disabled={loading} className="btn-primary w-full flex items-center justify-center gap-2">
        {loading ? <><Spinner />Connecting...</> : "🔗 Connect Freighter Wallet"}
      </button>
      {allowGuidedOnboarding ? (
        <p className="mt-3 text-xs text-[#547454] font-body">
          No wallet?{" "}
          <button
            type="button"
            onClick={() => setShowPaths(true)}
            className="text-forest-600 hover:underline"
            data-testid="wallet-connect-no-wallet"
          >
            Donate without one →
          </button>
        </p>
      ) : (
        <p className="mt-3 text-xs text-[#547454] font-body">
          No wallet? <a href="https://freighter.app" target="_blank" rel="noopener noreferrer" className="text-forest-600 hover:underline">Install Freighter →</a>
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>;
}
