/**
 * components/OnRampHandoff.tsx
 *
 * The screen a donor sees before leaving for a fiat provider.
 *
 * It exists to make one thing unmissable: from here on, someone other than
 * GreenPay is taking the money and asking for identity documents. A donor is
 * entitled to know that before they click, not from a footnote afterwards.
 *
 * When no provider is configured this renders an honest dead end rather than a
 * spinner or a button that goes nowhere. "Not available here, and here is what
 * you can do instead" is a better answer than a broken flow.
 */
import { useEffect, useState } from "react";
import { fetchOnrampProviders, type OnrampDisclosure } from "@/lib/onboarding";
import { track } from "@/lib/funnel";

interface OnRampHandoffProps {
  /** Where the provider should deliver the asset. */
  destinationAddress: string | null;
  projectId?: string;
  onBack?: () => void;
}

interface Provider {
  id: string;
  name: string;
  anchorUrl: string | null;
  disclosure: OnrampDisclosure;
}

export default function OnRampHandoff({ destinationAddress, projectId, onBack }: OnRampHandoffProps) {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchOnrampProviders()
      .then((res) => {
        if (mounted) setProviders(res.providers);
      })
      .catch(() => {
        if (mounted) setFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (failed) {
    return (
      <div className="card" data-testid="onramp-error">
        <p className="text-sm text-[#4b654b] font-body">
          We couldn&apos;t check which payment providers are available. Please try again in a moment.
        </p>
        {onBack && (
          <button onClick={onBack} className="btn-secondary w-full mt-3">
            Back
          </button>
        )}
      </div>
    );
  }

  if (providers === null) {
    return (
      <div className="card text-center" data-testid="onramp-loading">
        <p className="text-sm text-[#4b654b] font-body">Checking payment options…</p>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="card" data-testid="onramp-unavailable">
        <h3 className="font-display text-lg font-semibold text-forest-900 mb-2">
          Buying XLM isn&apos;t available here yet
        </h3>
        <p className="text-sm text-[#4b654b] mb-3 font-body">
          GreenPay never takes card payments itself — that has to go through a licensed provider, and
          this deployment doesn&apos;t have one connected.
        </p>
        <p className="text-sm text-[#4b654b] mb-4 font-body">
          You can still donate if you get XLM elsewhere. Send it to the address below and come back —
          your account is already set up and waiting.
        </p>
        {destinationAddress && (
          <div className="p-3 rounded-xl bg-forest-50 border border-forest-200 mb-4">
            <p className="text-xs uppercase tracking-wide text-forest-700 font-semibold mb-1 font-body">
              Your address
            </p>
            <p className="text-xs font-mono break-all text-forest-900">{destinationAddress}</p>
          </div>
        )}
        {onBack && (
          <button onClick={onBack} className="btn-secondary w-full">
            Back
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card animate-fade-in" data-testid="onramp-handoff">
      <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">Buy XLM to donate</h3>
      <p className="text-sm text-[#4b654b] mb-4 font-body">
        GreenPay doesn&apos;t take card payments. A licensed provider does that part.
      </p>

      {providers.map((provider) => (
        <div key={provider.id} className="mb-4 p-3 rounded-xl border border-forest-200 bg-white">
          <p className="font-semibold text-forest-900 mb-2 font-body">{provider.name}</p>

          <ul className="space-y-2 mb-3">
            {provider.disclosure.statements.map((statement) => (
              <li
                key={statement}
                className="flex gap-2 text-sm text-[#4b654b] font-body leading-relaxed"
              >
                <span aria-hidden="true" className="text-forest-600 shrink-0">
                  •
                </span>
                <span>{statement}</span>
              </li>
            ))}
          </ul>

          <a
            href={provider.anchorUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => void track("path_selected", { path: "onramp", projectId })}
            className="btn-primary w-full text-center block"
            data-testid={`onramp-continue-${provider.id}`}
          >
            Continue to {provider.name} ↗
          </a>
        </div>
      ))}

      {destinationAddress && (
        <div className="p-3 rounded-xl bg-forest-50 border border-forest-200 mb-3">
          <p className="text-xs uppercase tracking-wide text-forest-700 font-semibold mb-1 font-body">
            They will send your XLM here
          </p>
          <p className="text-xs font-mono break-all text-forest-900">{destinationAddress}</p>
          <p className="text-xs text-[#4b654b] mt-1 font-body">
            Only you hold the key to this address.
          </p>
        </div>
      )}

      {onBack && (
        <button onClick={onBack} className="btn-secondary w-full">
          Back
        </button>
      )}
    </div>
  );
}
