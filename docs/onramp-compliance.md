# Fiat On-Ramp: Compliance Obligations

Which duties sit with the provider, which with GreenPay, and which are shared.

## The boundary

**GreenPay never takes fiat.** Not by card, not by bank transfer, not held in
escrow for a moment. Every fiat path is a [SEP-24](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)
handoff: the donor authenticates to a licensed anchor, the anchor takes the
payment and performs its own KYC, and the anchor delivers XLM to an address the
donor holds the key for.

This is not a technical convenience. It is the reason a fiat path can be offered
at all. Taking card payments directly would make GreenPay a money services
business in most jurisdictions it operates in, attracting registration,
sanctions screening, transaction monitoring, suspicious-activity reporting and
record-retention duties. Delegating to an anchor that already holds those
licences moves the obligation to the party regulated for it.

What GreenPay learns from the whole flow: **that XLM arrived at a Stellar
address**. Not a name, not a document, not a card number.

## Why the matrix is code

"Which obligations sit with the provider and which with us" is exactly the kind
of answer that is written once, believed for two years, and turns out to be
wrong at the worst possible moment.

So it is encoded in `backend/src/services/onboarding/onramp.js`:

- every obligation must be assigned to `provider`, `platform`, `shared`, or
  `not_applicable` — there is no default, because an unassigned obligation is
  the failure mode;
- obligations that **cannot** be delegated are listed explicitly, and an entry
  that assigns one to the provider fails validation;
- a provider that would custody donor keys is rejected outright as incompatible
  with [ADR-002](adr/ADR-002-why-direct-to-wallet-payments-over-platform-custody.md);
- the registry is validated at module load, so a malformed entry fails the
  process rather than shipping;
- `onramp.test.js` asserts all of the above.

## The matrix

For the generic SEP-24 anchor entry:

| Obligation | Owner | Rationale |
|---|---|---|
| `kyc_identity_verification` | **Provider** | They are licensed for it; GreenPay never sees the documents. |
| `sanctions_screening` | **Provider** | Requires identity data GreenPay does not hold and does not want. |
| `transaction_monitoring` | **Provider** | For the fiat leg. GreenPay monitors the on-chain leg separately (see ADR-005). |
| `suspicious_activity_reporting` | **Provider** | Follows from monitoring and identity. |
| `travel_rule` | **Provider** | Requires originator/beneficiary identity. |
| `fiat_custody` | **Provider** | GreenPay never holds fiat. Non-negotiable. |
| `chargeback_liability` | **Provider** | They took the payment; a dispute is between the donor and them. |
| `jurisdiction_restriction` | **Provider** | Enforced during their onboarding — the only place it is reliable. GreenPay does not geolocate donors. |
| `consumer_disclosures` | **Platform** | *Not delegable.* GreenPay's own UI makes the claims a donor relies on. |
| `donor_support` | **Shared** | *Not delegable.* GreenPay owns donation questions; the provider owns payment questions. |
| `data_retention` | **Shared** | GreenPay retains donation records; the anchor retains identity records. |
| `tax_reporting` | **Shared** | Donation receipts are GreenPay's; fiat purchase records are the anchor's. Neither issues tax advice. |

### The non-delegable two

`consumer_disclosures` and `donor_support` are enforced as non-delegable in
code. A platform does not stop owing its own users clear, accurate disclosures
because its anchor holds a licence — the donor is reading GreenPay's screen, and
GreenPay wrote it.

## What the donor is told, before they leave

Rendered verbatim from `handoffDisclosure()`, so the words in the UI and the
words in this repository cannot drift:

> - You will be handed to **{provider}** to buy XLM. They take the payment, not GreenPay.
> - They will ask you to verify your identity. That is their requirement as a regulated provider, and GreenPay never sees what you give them.
> - The XLM they send goes to an address only you hold the key for. GreenPay cannot spend it, and cannot get it back for you if you lose the key.
> - If something goes wrong with the payment itself — a wrong amount, a card dispute, a refund — that is between you and the provider. GreenPay never holds your money and cannot reverse it.
> - GreenPay will see that XLM arrived at your address. It will not see your name, your documents, or your card.

Statements of fact about what happens next, not reassurance. A donor about to
hand identity documents to a third party is entitled to know that before they
click.

## Delivery before the account exists

An anchor cannot pay an address that is not yet an account. Two ways round it,
both supported:

1. **Sponsor first.** GreenPay sponsors the account into existence, then the
   anchor pays it normally. Costs 1 XLM of locked reserve.
2. **Claimable balance.** The anchor commits the value to the address as a
   claimable balance, which is legal for a claimant that does not yet exist.
   The donor claims it once the account exists.

The honest statement of what (2) buys: **value can be committed to a donor
before their account exists, and is claimable the moment it does.** It is not a
way to skip account creation — claiming still needs an account, because claiming
needs a transaction and a transaction needs a source account. It removes the
ordering constraint, not the requirement. Wherever this is presented to a donor,
it is presented in those terms.

Every claimable balance carries two claimants: the recipient unconditionally,
and the creator under `not(before relative time T)` — 14 days by default. A
single-claimant balance is a way to lose money permanently to a typo.

## Enabling a provider

Providers ship **disabled**. Two things are required, and configuration alone is
not enough:

1. A registry entry in `onramp.js` with a complete, reviewed obligation matrix
   and `enabled: true`. This is where the compliance review is recorded.
2. `ONRAMP_ANCHOR_URL` and `ONRAMP_ANCHOR_HOME_DOMAIN` set for the deployment.

An un-reviewed provider cannot be switched on with an environment variable. If
neither is configured, the fiat path is simply not offered, and the UI says so
with a reason rather than dead-ending.

## Adding a new provider

1. Add the entry with every obligation in `OBLIGATIONS` assigned.
2. Run `npx jest src/services/onboarding/onramp.test.js`. Any gap fails.
3. Have the split reviewed by whoever owns compliance for the deployment.
4. Update this document's matrix.
5. Set `enabled: true` in the same change as the review, not before.

A provider that requires GreenPay to take card details, hold fiat, or receive
funds on the donor's behalf is out of scope by construction and cannot be added
without changing ADR-002.

## See also

- [ADR-005](adr/ADR-005-graduated-non-custodial-donor-onboarding.md)
- [ADR-002](adr/ADR-002-why-direct-to-wallet-payments-over-platform-custody.md)
- [docs/threat-model.md](threat-model.md)
