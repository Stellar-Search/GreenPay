/**
 * components/FirstDonationPaths.tsx
 *
 * The choice a donor without a funded wallet is offered, and the flows behind
 * each option.
 *
 * ── Why the situation is diagnosed before the choice is shown ───────────────
 * The naive version asks the donor which of three paths they want, which
 * requires them to already understand base reserves, sponsorship and anchors —
 * the exact knowledge the feature exists to make unnecessary. Instead the
 * component asks Horizon what is actually true about their address, recommends
 * the path that removes their real blocker, and leaves the others visible so
 * the recommendation is a suggestion rather than a rail.
 */
import { useCallback, useEffect, useState } from "react";
import {
  assessDonorSituation,
  fetchOnboardingPaths,
  type DonorSituation,
  type OnboardingPathId,
  type OnboardingPathOption,
} from "@/lib/onboarding";
import { loadStarterAccount } from "@/lib/starterAccount";
import { getSessionId, track } from "@/lib/funnel";
import StarterAccountSetup from "./StarterAccountSetup";
import OnRampHandoff from "./OnRampHandoff";

interface FirstDonationPathsProps {
  /** Whether a signing extension was detected. The network can't tell us this. */
  walletDetected: boolean;
  projectId?: string;
  /** Called with the address the donor will donate from. */
  onAccountReady: (publicKey: string) => void;
  /** Escape hatch back to the ordinary wallet-connect card. */
  onUseWallet?: () => void;
}

type View = "choosing" | "sponsored" | "onramp";

export default function FirstDonationPaths({
  walletDetected,
  projectId,
  onAccountReady,
  onUseWallet,
}: FirstDonationPathsProps) {
  const [view, setView] = useState<View>("choosing");
  const [situation, setSituation] = useState<DonorSituation | null>(null);
  const [options, setOptions] = useState<OnboardingPathOption[] | null>(null);
  const [guarantee, setGuarantee] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const starter = typeof window === "undefined" ? null : loadStarterAccount();

  useEffect(() => {
    let mounted = true;

    void getSessionId({ projectId }).then((id) => {
      if (mounted) setSessionId(id);
    });
    void track("donate_intent", { projectId });

    // A failed paths fetch must not blank the screen: the donor still has the
    // ordinary wallet route, and the fallback below keeps it reachable.
    fetchOnboardingPaths()
      .then((res) => {
        if (!mounted) return;
        setOptions(res.paths);
        setGuarantee(res.guarantee);
        void track("path_offered", { projectId });
      })
      .catch(() => {
        if (mounted) setOptions([]);
      });

    void assessDonorSituation({
      walletDetected,
      address: starter?.publicKey ?? null,
    }).then((result) => {
      if (mounted) setSituation(result);
    });

    return () => {
      mounted = false;
    };
    // starter?.publicKey is read once on mount by design: re-assessing on every
    // render would hammer Horizon for an answer that cannot change mid-choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletDetected, projectId]);

  const choose = useCallback(
    (path: OnboardingPathId) => {
      void track("path_selected", { path, projectId });
      if (path === "connected_wallet") {
        onUseWallet?.();
        return;
      }
      setView(path === "onramp" ? "onramp" : "sponsored");
    },
    [onUseWallet, projectId],
  );

  if (view === "sponsored") {
    return (
      <StarterAccountSetup
        sessionId={sessionId}
        projectId={projectId}
        onReady={onAccountReady}
        onCancel={() => setView("choosing")}
      />
    );
  }

  if (view === "onramp") {
    return (
      <OnRampHandoff
        destinationAddress={starter?.publicKey ?? null}
        projectId={projectId}
        onBack={() => setView("choosing")}
      />
    );
  }

  const recommended = situation?.recommendedPath;
  const available = (options ?? []).filter((option) => option.id !== "claimable_balance");

  return (
    <div className="card animate-fade-in" data-testid="first-donation-paths">
      <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">
        How would you like to donate?
      </h3>

      {situation && (
        <p className="text-sm text-[#4b654b] mb-4 font-body" data-testid="donor-situation">
          {situation.reason}
        </p>
      )}

      {available.length === 0 && (
        // Every fetch failed, or nothing is configured. The wallet route still
        // works, so say that rather than showing an empty card.
        <p className="text-sm text-[#4b654b] mb-4 font-body">
          Connect a Stellar wallet to donate.
        </p>
      )}

      <div className="space-y-3">
        {available.map((option) => {
          const isRecommended = option.id === recommended;
          return (
            <button
              key={option.id}
              onClick={() => choose(option.id)}
              disabled={!option.available}
              data-testid={`path-option-${option.id}`}
              className={`w-full text-left p-3 rounded-xl border transition-all font-body ${
                isRecommended
                  ? "border-forest-500 bg-forest-50"
                  : "border-forest-200 bg-white hover:border-forest-400"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-forest-900 text-sm">{option.title}</span>
                {isRecommended && option.available && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-forest-500 text-white shrink-0">
                    Suggested
                  </span>
                )}
              </div>

              {option.available ? (
                <>
                  {option.requires && option.requires.length > 0 && (
                    <p className="text-xs text-[#547454] mt-1">
                      Needs: {option.requires.join(" · ")}
                    </p>
                  )}
                  {/* The headline cost, on the choice itself. A donor should
                      not have to open a path to find out what it costs them. */}
                  {option.tradeoffs.giveUp.length > 0 && (
                    <p className="text-xs text-amber-700 mt-1">{option.tradeoffs.giveUp[0]}</p>
                  )}
                  {option.limits && (
                    <p className="text-xs text-[#547454] mt-1">
                      Up to {option.limits.maxDonationXlm} XLM per donation.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-[#547454] mt-1">{option.unavailableReason}</p>
              )}
            </button>
          );
        })}
      </div>

      {guarantee && (
        <p className="text-xs text-[#547454] mt-4 font-body leading-relaxed" data-testid="onboarding-guarantee">
          {guarantee}
        </p>
      )}
    </div>
  );
}
