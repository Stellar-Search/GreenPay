/**
 * components/TradeoffNotice.tsx
 *
 * The screen a donor sees before they accept a starter account.
 *
 * It leads with what they give up. That ordering is deliberate and is the
 * single most important thing about this component: people will accept a
 * constrained first donation if they understand it, and will not forgive
 * discovering afterwards that they cannot recover something they thought they
 * owned. Putting the benefits first and the caveats in small grey text below is
 * how that second outcome happens.
 *
 * The acknowledgement is a real checkbox, not a "by continuing you agree".
 */
import { useState } from "react";

interface TradeoffNoticeProps {
  title: string;
  keep: readonly string[];
  giveUp: readonly string[];
  mitigation?: readonly string[];
  /** Rendered above the lists — e.g. the reserve the platform locks. */
  cost?: { label: string; value: string; note?: string };
  confirmLabel?: string;
  onAcknowledge: () => void;
  onCancel?: () => void;
}

export default function TradeoffNotice({
  title,
  keep,
  giveUp,
  mitigation,
  cost,
  confirmLabel = "I understand — continue",
  onAcknowledge,
  onCancel,
}: TradeoffNoticeProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="card animate-fade-in" data-testid="tradeoff-notice">
      <h3 className="font-display text-lg font-semibold text-forest-900 mb-1">{title}</h3>
      <p className="text-[#4b654b] text-sm mb-4 font-body">
        Read this before you continue. Some of it cannot be undone later.
      </p>

      {cost && (
        <div className="mb-4 p-3 rounded-xl bg-forest-50 border border-forest-200">
          <p className="text-sm text-forest-900 font-body">
            <span className="font-semibold">{cost.label}:</span>{" "}
            <span className="font-semibold text-forest-700">{cost.value}</span>
          </p>
          {cost.note && <p className="text-xs text-[#4b654b] mt-1 font-body">{cost.note}</p>}
        </div>
      )}

      {/* Give-ups first. See the component header for why. */}
      <div className="mb-4" data-testid="tradeoff-giveup">
        <p className="text-sm font-semibold text-amber-800 mb-2 font-body">What you are giving up</p>
        <ul className="space-y-2">
          {giveUp.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-[#4b654b] font-body leading-relaxed">
              <span aria-hidden="true" className="text-amber-600 shrink-0">
                !
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mb-4" data-testid="tradeoff-keep">
        <p className="text-sm font-semibold text-forest-800 mb-2 font-body">What you keep</p>
        <ul className="space-y-2">
          {keep.map((line) => (
            <li key={line} className="flex gap-2 text-sm text-[#4b654b] font-body leading-relaxed">
              <span aria-hidden="true" className="text-forest-600 shrink-0">
                ✓
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      {mitigation && mitigation.length > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-forest-50 border border-forest-100">
          <p className="text-sm font-semibold text-forest-800 mb-2 font-body">What you can do about it</p>
          <ul className="space-y-1">
            {mitigation.map((line) => (
              <li key={line} className="text-sm text-[#4b654b] font-body leading-relaxed">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-start gap-2 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-1"
          data-testid="tradeoff-acknowledge"
        />
        <span className="text-sm text-[#4b654b] font-body">
          I understand that GreenPay cannot recover my key, and that losing it means losing access to
          this account.
        </span>
      </label>

      <div className="flex gap-2">
        <button
          onClick={onAcknowledge}
          disabled={!acknowledged}
          className="btn-primary flex-1 disabled:opacity-50"
          data-testid="tradeoff-continue"
        >
          {confirmLabel}
        </button>
        {onCancel && (
          <button onClick={onCancel} className="btn-secondary px-4" data-testid="tradeoff-cancel">
            Back
          </button>
        )}
      </div>
    </div>
  );
}
