import type { ImpactClaim, ImpactClaimStatus } from "@/lib/api";

const STATUS_STYLES: Record<ImpactClaimStatus, string> = {
  verified: "border-emerald-300 bg-emerald-50 text-emerald-800",
  operator_stated: "border-amber-300 bg-amber-50 text-amber-900",
  unverified: "border-slate-300 bg-slate-50 text-slate-700",
  revoked: "border-red-300 bg-red-50 text-red-800",
  expired: "border-orange-300 bg-orange-50 text-orange-800",
};

const TYPE_LABELS: Record<ImpactClaim["claimType"], string> = {
  avoided_emissions: "Avoided emissions",
  sequestration: "Sequestration",
  offset: "Offset",
};

function formatQuantity(value: string, locale: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(parsed);
}

export function impactUnitLabel(unit: string) {
  return {
    kg_co2e: "kg CO₂e",
    t_co2e: "t CO₂e",
  }[unit] || unit.replaceAll("_", " ");
}

export function ImpactRange({ claim, locale = "en-US" }: { claim: ImpactClaim; locale?: string }) {
  const { lowerBound, upperBound, unit } = claim.quantity;
  const range = lowerBound === upperBound
    ? `≈ ${formatQuantity(lowerBound, locale)}`
    : `${formatQuantity(lowerBound, locale)}–${formatQuantity(upperBound, locale)}`;
  return <>{`${range} ${impactUnitLabel(unit)}`}</>;
}

export function ProvenanceBadge({ status, label }: { status: ImpactClaimStatus; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${STATUS_STYLES[status]}`}>
      {status === "verified" ? "✓ " : status === "revoked" ? "⚠ " : ""}{label}
    </span>
  );
}

export default function ImpactClaimCard({
  claim,
  locale = "en-US",
  compact = false,
}: {
  claim: ImpactClaim;
  locale?: string;
  compact?: boolean;
}) {
  const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
  const verificationUrl = `${apiBase}/api/v1/impact/claims/${claim.id}/verification`;
  const status = claim.provenance.status;

  return (
    <article className={`rounded-2xl border p-5 ${status === "revoked" ? "border-red-300 bg-red-50/40" : "border-forest-100 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-forest-500">
            {TYPE_LABELS[claim.claimType]}
          </p>
          <p className="mt-1 font-display text-xl font-bold text-forest-900">
            <ImpactRange claim={claim} locale={locale} />
          </p>
          {claim.uncertainty.confidencePercent !== null && (
            <p className="mt-1 text-xs text-forest-600">
              {claim.uncertainty.confidencePercent}% confidence range
            </p>
          )}
        </div>
        <ProvenanceBadge status={status} label={claim.provenance.label} />
      </div>

      {status === "revoked" && (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-100 px-3 py-2 text-sm font-semibold text-red-900">
          This claim was withdrawn{claim.provenance.revocationReason ? `: ${claim.provenance.revocationReason}` : "."}
        </p>
      )}

      <dl className={`mt-4 grid gap-3 text-sm ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-forest-500">Methodology</dt>
          <dd className="mt-1 text-forest-900">{`${claim.methodology.name} v${claim.methodology.version}`}</dd>
        </div>
        <div>
          <dt className="text-xs font-bold uppercase tracking-wide text-forest-500">Measured</dt>
          <dd className="mt-1 text-forest-900">{`${claim.measurementPeriod.start} — ${claim.measurementPeriod.end}`}</dd>
        </div>
        {!compact && (
          <>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-forest-500">Asserted by</dt>
              <dd className="mt-1 text-forest-900">{claim.provenance.assertedBy}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-wide text-forest-500">Evidence</dt>
              <dd className="mt-1 text-forest-900">{claim.evidence.length} public evidence record{claim.evidence.length === 1 ? "" : "s"}</dd>
            </div>
          </>
        )}
      </dl>

      {!compact && (
        <details className="mt-4 rounded-xl bg-forest-50 p-3 text-sm text-forest-800">
          <summary className="cursor-pointer font-semibold">Baseline and limitations</summary>
          <p className="mt-2"><strong>Baseline:</strong> {claim.baseline}</p>
          <p className="mt-2"><strong>Limitations:</strong> {claim.methodology.limitations}</p>
        </details>
      )}

      <div className="mt-4 border-t border-forest-100 pt-3 text-xs text-forest-600">
        <p className="font-mono break-all">{`Claim ${claim.id}`}</p>
        {claim.provenance.attestation ? (
          <p className="mt-1 font-mono break-all">
            Anchor {claim.provenance.attestation.attestationHash}
          </p>
        ) : (
          <p className="mt-1">No independent on-chain attestation is recorded.</p>
        )}
        <a href={verificationUrl} className="mt-2 inline-block font-bold text-forest-700 underline underline-offset-2">
          Verify current claim and revocation status
        </a>
      </div>
    </article>
  );
}
