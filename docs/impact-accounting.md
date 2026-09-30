# How GreenPay Reports Environmental Outcomes

## The short version

A Stellar transaction can prove that a donor sent a stated amount to a stated
wallet. It does not prove what later happened to emissions, trees, soil, an
electricity grid or an offset credit. GreenPay therefore displays donation
records and environmental claims beside one another, but never turns the first
into the second with a fixed rate.

Every environmental figure is shown as a range with its type, unit, method,
measurement dates, baseline, asserting party and current verification status.

## Three different quantities

### Avoided emissions

An avoided-emissions claim estimates the difference between what happened and a
counterfactual baseline. For example, a solar installation may displace some
grid generation. The answer depends on which generators would otherwise have
run, the time of generation, system losses and whether the baseline stays
plausible. It is not carbon removed from the atmosphere.

### Sequestration

A sequestration claim concerns carbon removed and stored. Forest and soil
claims depend on sampling, growth models, leakage, future loss and permanence.
The period matters: a forecast over decades is not an amount already measured
this year.

### Offset

An offset is an instrument issued under a program and normally needs ownership,
serial and retirement evidence. It is not interchangeable with an activity's
raw avoided-emissions estimate, and the same underlying outcome must not be
counted twice.

GreenPay keeps these types separate. There is no global “CO2 impact” scalar.

## Reading a claim

Each card contains:

- **Range and unit** — lower and upper bounds remain visible. A confidence
  percentage appears only when the source supplies one.
- **Methodology and version** — the registered recipe and comparison scope.
- **Measurement period and vintage** — when the activity/outcome occurred and,
  where relevant, which issuance period it belongs to.
- **Baseline** — the counterfactual or starting condition used for comparison.
- **Asserting party** — who says the claim is true.
- **Evidence** — public source links and SHA-256 content hashes.
- **Provenance label** — independently verified, operator-stated, unverified,
  expired or withdrawn.
- **Claim id and anchor hash** — stable values used for independent checks.

“Independently verified” means an approved verifier reviewed a particular
canonical payload and anchored its SHA-256 in Soroban. It does not mean the
result is certain, permanent, equivalent to another methodology, or endorsed by
GreenPay. Read the range and limitations even when the badge is green.

## What is aggregated

GreenPay groups claims only when all of these match:

1. claim type;
2. methodology code;
3. methodology version; and
4. unit.

The displayed group range is the sum of constituent lower bounds through the
sum of constituent upper bounds, and the constituent cards remain attached.
This simple interval sum does not model correlated uncertainty, so it is a
navigation aid rather than a portfolio confidence interval. Claims from
different groups are never summed into a headline.

## What a donor certificate means

The donation amount and destination are payment facts. Outcome claims on the
certificate belong to projects the donor supported; they are not a pro-rata
share credited to that donor. Giving twice as much does not cause the interface
to display twice the project outcome.

A certificate records claim ids and links to their current verification data.
If a verifier or operator later withdraws a claim, the verification page shows
the withdrawal, reason and transaction. The historical claim remains visible
so an older screenshot cannot be mistaken for a currently valid attestation.

## Known limitations

- GreenPay registers and exposes methodologies but does not declare that one
  standard is universally correct.
- An on-chain hash proves payload integrity and signer authorization, not the
  physical truth of measurements.
- Verifier independence depends on governance of the allowlist and disclosure
  of conflicts outside the contract.
- Public evidence may be incomplete where documents contain confidential or
  personal information; such a claim should remain unverified until the public
  record is sufficient for the claimed status.
- Ranges may still omit structural uncertainty or correlated errors.
- Legacy values lacked source data. Their broad migration range communicates
  missing information; it is not a reconstructed measurement.

For the schema and migration decision, see
[ADR-006](adr/ADR-006-evidence-first-impact-claims.md).
