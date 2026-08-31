# ADR-006: Evidence-First Environmental Impact Claims

## Status

Accepted

## Context and Problem Statement

GreenPay historically stored `projects.co2_offset_kg` as a bare number. The
impact API divided that number by XLM raised and multiplied the result by a
donor's XLM. That operation proved only the donation amount and repeated a
project operator's input; it did not measure an environmental outcome. The UI
then presented the result, and a tree conversion derived from it, as if both
were observed facts.

Environmental quantities are not interchangeable. Avoided emissions compare a
counterfactual baseline with observed activity. Sequestration is carbon removed
and retained over a stated period. An offset is a separately issued instrument
with its own ownership and retirement rules. Adding these into one number hides
material differences in time, baseline, leakage, permanence and double-counting
risk.

## Decision Drivers

- A donor must be able to distinguish the on-chain payment fact from a project
  operator's environmental assertion.
- Uncertainty, measurement period, baseline, methodology and limitations must
  survive from storage to every donor-facing surface.
- Independent verification must be a separate act by a separate party.
- Corrections and revocations must remain visible to people who retained or
  shared an older certificate.
- Only comparable claims may be aggregated.
- The transition must not silently promote historical unsourced values.

## Decision Outcome

### A claim is a record, not a donation conversion

`impact_claims` stores quantity, unit, claim type, uncertainty bounds,
confidence (when supplied), methodology, measurement period, vintage, baseline,
asserting party, expiry and lifecycle state. `impact_evidence` stores hashes and
public source references. An XLM donation is never used to calculate or allocate
one of these project-level outcomes.

### Claim types remain distinct

The allowed types are `avoided_emissions`, `sequestration` and `offset`.
GreenPay never combines types into one headline number. Even within one type,
the API groups quantities only when methodology code, methodology version and
unit all match. The group retains every constituent claim and status.

### Methodologies are registered explicitly

`impact_methodologies` records the method's claim type, unit, accounting
approach, comparison scope and limitations. A claim's type and unit must match
the registered method. A registry entry describes how a result was produced;
it does not by itself verify that a project applied the method correctly.

### Assertion and verification are separate

The claim row identifies the asserting party. `impact_attestations` is a
separate verifier record containing the canonical payload, evidence-set digest,
verifier identity, expiry and on-chain receipt. A claim is shown as
independently verified only while its latest attestation is anchored, current
and unrevoked. Otherwise it remains visibly operator-stated or unverified.

The Soroban admin allowlists verifier addresses. An allowlisted verifier must
authenticate the `anchor_impact_attestation` call. The contract stores only the
claim id, SHA-256, verifier, timestamps and revocation state; the public API
provides the exact canonical payload so anyone can recompute the hash.

### Revocation is permanent history

The verifier who anchored a record or the contract admin can revoke it on-chain.
The database also retains the old attestation, revocation reason and revocation
transaction. No row or hash is deleted. A correction is a new claim id; it does
not rewrite the old claim.

Certificates include stable claim ids and a verification endpoint. A downloaded
or shared certificate is a statement of what was displayed at issuance time,
not a promise that the claim can never change. Opening its verification link
returns current status. A withdrawn claim remains present with a prominent
withdrawn label and reason rather than disappearing.

### Existing `co2_offset_kg` values

Existing non-zero values are **retained as operator-stated**, not withdrawn and
not grandfathered as verified. The migration creates a deterministic claim id,
uses the migration-only `legacy-operator-stated-offset` methodology, marks the
missing source/baseline/method in `migration_note`, and uses a deliberately
broad `0..2x` range to expose the absence of recorded uncertainty. These rows
are never allocated to donors. `projects.co2_offset_kg`, the Soroban
`co2_per_xlm` field and old CO2 getters remain only as rollback/ABI fields; new
donations do not update them and donor-facing reads ignore them.

## Consequences

### Positive

- Donation facts remain independently auditable without being confused with
  environmental outcomes.
- Unverified work stays visible while its provenance is obvious.
- Revoked claims remain discoverable from old links and certificates.
- Methodology-aware grouping prevents unlike quantities from being added.

### Negative

- A donor cannot receive a convenient personal CO2 number unless a future
  methodology actually supports defensible attribution.
- Verification requires governance of the verifier allowlist and operational
  reconciliation of Soroban receipts.
- Historical values look less precise and less impressive, which is the honest
  consequence of missing evidence.

## More Information

- [Impact accounting for non-specialists](../impact-accounting.md)
- [Impact API implementation](../../backend/src/routes/impact.js)
- [Soroban attestation registry](../../contracts/greenpay-contract/src/lib.rs)
