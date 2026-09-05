/**
 * components/StarterAccountSetup.tsx
 *
 * The sponsored-account flow, end to end.
 *
 * The sequence matters and is not rearrangeable:
 *
 *   1. Show the trade-offs. Nothing exists yet, so declining costs nothing.
 *   2. Generate the keypair *in this browser*. The secret never leaves it.
 *   3. Ask the backend to sponsor the account. It returns a transaction the
 *      sponsor has already signed and that cannot be submitted without ours.
 *   4. Sign it here with the browser-held key and send it back for submission.
 *   5. Offer the key for export, prominently, before anything else happens.
 *
 * Step 3's transaction is the non-custodial guarantee made structural rather
 * than promised: the platform physically cannot create an account it controls,
 * because the closing operation is sourced by the donor.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  STARTER_ACCOUNT_TRADEOFFS,
  createStarterAccount,
  isPersisted,
  loadStarterAccount,
  markExported,
  signWithStarterAccount,
  type StarterAccount,
} from "@/lib/starterAccount";
import { abandonSponsorship, requestSponsorship, submitSponsorship } from "@/lib/onboarding";
import { getApiErrorMessage } from "@/lib/api";
import { track } from "@/lib/funnel";
import TradeoffNotice from "./TradeoffNotice";

type Step = "disclosure" | "creating" | "signing" | "submitting" | "ready" | "error";

interface StarterAccountSetupProps {
  sessionId: string | null;
  projectId?: string;
  onReady: (publicKey: string) => void;
  onCancel?: () => void;
}

export default function StarterAccountSetup({
  sessionId,
  projectId,
  onReady,
  onCancel,
}: StarterAccountSetupProps) {
  const [step, setStep] = useState<Step>("disclosure");
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<StarterAccount | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [storageWarning, setStorageWarning] = useState(false);

  // Held in a ref rather than state: it must be readable by the unmount
  // cleanup below, which a state value captured at render time would not be.
  const pendingSponsorshipId = useRef<string | null>(null);

  /**
   * Abandoning on unmount is what makes "an abandoned donation leaves no
   * partial state" true from the donor's side. The server sweeps expired
   * offers anyway, so this is a courtesy that returns the treasury's capacity
   * in seconds instead of minutes — never the only guarantee.
   */
  useEffect(() => {
    return () => {
      if (pendingSponsorshipId.current) {
        void abandonSponsorship(pendingSponsorshipId.current);
        pendingSponsorshipId.current = null;
      }
    };
  }, []);

  const runSetup = useCallback(async () => {
    setError(null);
    void track("tradeoff_acknowledged", { path: "sponsored_account", projectId });

    let created: StarterAccount;
    try {
      setStep("creating");
      // An existing key in this browser is reused rather than replaced —
      // overwriting it would destroy the only copy of a key that may hold XLM.
      created = loadStarterAccount() ?? createStarterAccount(true);
      setAccount(created);
      // A browser that accepted the write and dropped it leaves the donor with
      // an account they will not have tomorrow. Say so now, not tomorrow.
      setStorageWarning(!isPersisted());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a key in this browser.");
      setStep("error");
      return;
    }

    try {
      const offer = await requestSponsorship({
        publicKey: created.publicKey,
        sessionId: sessionId ?? "",
      });
      pendingSponsorshipId.current = offer.id;

      setStep("signing");
      const signedXdr = signWithStarterAccount(offer.xdr);

      setStep("submitting");
      await submitSponsorship(offer.id, signedXdr);
      // Submitted successfully: there is no capacity left to release, so the
      // unmount cleanup must not try to abandon it.
      pendingSponsorshipId.current = null;

      setStep("ready");
      void track("account_ready", { path: "sponsored_account", projectId });
      onReady(created.publicKey);
    } catch (err) {
      if (pendingSponsorshipId.current) {
        void abandonSponsorship(pendingSponsorshipId.current);
        pendingSponsorshipId.current = null;
      }
      setError(getApiErrorMessage(err, "Your account could not be set up. Nothing was created."));
      setStep("error");
    }
  }, [onReady, projectId, sessionId]);

  const handleCopy = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.secret);
      setCopied(true);
      markExported();
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked — the key is on screen and can be copied by hand,
      // so this is a convenience failure rather than a dead end.
      setSecretVisible(true);
    }
  };

  if (step === "disclosure") {
    return (
      <TradeoffNotice
        title={STARTER_ACCOUNT_TRADEOFFS.title}
        keep={STARTER_ACCOUNT_TRADEOFFS.keep}
        giveUp={STARTER_ACCOUNT_TRADEOFFS.giveUp}
        mitigation={STARTER_ACCOUNT_TRADEOFFS.mitigation}
        cost={{
          label: "GreenPay locks",
          value: "1.0000000 XLM",
          note: "Stellar requires a minimum balance before an account can exist. GreenPay puts that up so you don't have to, and gets it back when the sponsorship ends. It is not a gift, and it is not yours to spend.",
        }}
        confirmLabel="Set up my account"
        onAcknowledge={runSetup}
        onCancel={onCancel}
      />
    );
  }

  if (step === "error") {
    return (
      <div className="card animate-fade-in" data-testid="starter-account-error">
        <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body mb-4">
          <p className="font-semibold mb-1">We couldn&apos;t set up your account</p>
          <p>{error}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={runSetup} className="btn-primary flex-1">
            Try again
          </button>
          {onCancel && (
            <button onClick={onCancel} className="btn-secondary px-4">
              Back
            </button>
          )}
        </div>
      </div>
    );
  }

  if (step === "ready" && account) {
    return (
      <div className="card animate-slide-up" data-testid="starter-account-ready">
        <div className="text-3xl mb-2">🌱</div>
        <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">
          Your account is ready
        </h3>
        <p className="text-[#4b654b] text-sm mb-4 font-body">
          You own it. GreenPay covered the minimum balance Stellar requires, and holds nothing else.
        </p>

        {storageWarning && (
          <div
            className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-body"
            data-testid="starter-storage-warning"
          >
            <p className="font-semibold mb-1">This browser isn&apos;t saving your key</p>
            <p>
              Private browsing or blocked site data means your key will be gone when you close this
              tab. Save it below before you donate, or you will lose access to this account.
            </p>
          </div>
        )}

        <div className="mb-4 p-3 rounded-xl bg-forest-50 border border-forest-200">
          <p className="text-xs uppercase tracking-wide text-forest-700 font-semibold mb-1 font-body">
            Your address
          </p>
          <p className="text-xs font-mono break-all text-forest-900">{account.publicKey}</p>
        </div>

        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200">
          <p className="text-sm font-semibold text-amber-900 mb-1 font-body">Save your key now</p>
          <p className="text-xs text-amber-800 mb-2 font-body">
            This is the only copy. GreenPay does not have it and cannot recover it for you. It works
            in any Stellar wallet.
          </p>

          {secretVisible ? (
            <p
              className="text-xs font-mono break-all text-amber-900 mb-2 select-all"
              data-testid="starter-secret"
            >
              {account.secret}
            </p>
          ) : (
            <button
              onClick={() => setSecretVisible(true)}
              className="text-xs underline text-amber-900 mb-2 font-body"
              data-testid="starter-reveal"
            >
              Show my key
            </button>
          )}

          <button onClick={handleCopy} className="btn-secondary w-full text-sm py-2">
            {copied ? "✓ Copied — store it somewhere safe" : "Copy my key"}
          </button>
        </div>

        <button onClick={() => onReady(account.publicKey)} className="btn-primary w-full">
          Continue to donate
        </button>
      </div>
    );
  }

  const message =
    step === "creating"
      ? "Creating your key in this browser…"
      : step === "signing"
        ? "Signing with your key…"
        : "Setting up your account on Stellar…";

  return (
    <div className="card text-center animate-fade-in" data-testid="starter-account-progress">
      <Spinner />
      <p className="text-[#4b654b] text-sm mt-3 font-body">{message}</p>
      <p className="text-xs text-[#547454] mt-2 font-body">
        Your key is generated here and never sent anywhere.
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-6 h-6 mx-auto text-forest-600" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
