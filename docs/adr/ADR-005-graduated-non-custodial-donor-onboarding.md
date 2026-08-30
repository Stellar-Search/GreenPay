# ADR-005: Graduated, Non-Custodial Donor Onboarding

## Status

Accepted

## Context and Problem Statement

GreenPay exists to get money to verified climate projects. Before this change,
a first-time donor had to complete every one of the following before they could
give anything at all:

1. Install a browser extension.
2. Understand and safely record a seed phrase.
3. Create an account on a centralised exchange, and pass its KYC.
4. Buy XLM and wait for it to settle.
5. Withdraw it to their own address.
6. Fund that address past Stellar's base reserve, because a Stellar account
   **cannot exist** below its minimum balance.
7. Only then, donate.

Every one of those steps is a point at which a well-intentioned person leaves.
Steps 1–6 have nothing to do with donating; they are the cost of participating
in the network at all. The platform could be flawless from step 7 onward and
still receive almost nothing, because almost nobody reaches step 7.

Step 6 is the sharpest edge and the least negotiable. Stellar's minimum balance
is `(2 + numSubEntries + numSponsoring - numSponsored) × baseReserve`. At
today's 0.5 XLM base reserve that is 1 XLM for a bare account. A donor with
0.9 XLM does not have "not much" — they have an address that is not an account,
and no transaction they sign can be submitted. The blocker is not economic; it
is ontological.

The decision was how to remove that friction **without becoming a custodian**,
because every fast answer to this problem is a custody answer.

## Decision Drivers

- The non-custodial guarantee in [ADR-002](ADR-002-why-direct-to-wallet-payments-over-platform-custody.md)
  is load-bearing. Everything else in the platform assumes GreenPay never holds
  donor funds or keys.
- The existing flow, for donors who already have a funded wallet, must not
  regress. It carries essentially all of today's donations.
- Any reserve the platform puts up is real, finite capital with a real abuse
  surface.
- Any fiat path attracts regulatory obligations that must be *assigned*, not
  assumed away.
- A donor must understand what they are accepting **before** they accept it.
- The whole justification is conversion, so conversion must be measured rather
  than asserted.

## Considered Options

1. **Do nothing.** Keep pointing donors at a wallet install page.
2. **Platform custody.** Hold donor funds; donate on their behalf.
3. **Managed keys.** Hold donor keys server-side; sign on their behalf.
4. **Friendbot-style faucet.** Give every new donor XLM.
5. **Graduated non-custodial onboarding.** *(chosen)*

## Decision Outcome

Chosen option: **graduated non-custodial onboarding** — several paths, with the
donor's actual situation selecting among them rather than the donor being asked
to self-diagnose.

| Donor's situation | Path | What changes |
|---|---|---|
| Wallet installed, account funded | `connected_wallet` | **Nothing.** Byte for byte the pre-existing flow. |
| Has (or will have) an asset, but no account | `sponsored_account` | GreenPay sponsors the base reserve. Donor holds their own key. |
| Has neither | `onramp` | Handoff to a licensed SEP-24 anchor. GreenPay never touches fiat. |
| Value must be committed before an account exists | `claimable_balance` | Value is committed to an address, claimable once the account exists. |

### How sponsorship stays non-custodial

The account-creation transaction is deliberately shaped so that neither party
can act alone:

```
op 1  beginSponsoringFutureReserves(sponsoredId: donor)    source: sponsor
op 2  createAccount(destination: donor, startingBalance: 0) source: sponsor
op 3  endSponsoringFutureReserves()                         source: donor
```

Operation 3 is **sourced by the donor**, so the transaction is invalid until the
donor signs it. GreenPay therefore cannot create an account it controls, and the
donor cannot receive a sponsorship without consenting to the exact transaction
that grants it. This is a structural property of the transaction, not a policy
we promise to follow.

`startingBalance: 0` is legal only because operation 1 makes the sponsor carry
the new account's reserves. That single argument is the funnel blocker being
removed.

The donor's keypair is generated in their browser (`localStorage`) or on their
device (iOS Keychain / Android Keystore). The secret is never transmitted. There
is no API field and no database column that could carry one.

### Rejected options, and why

**Do nothing** was rejected because the status quo is the problem. Every other
open issue improves the experience of people who can already donate; this one
determines how many of those there are.

**Platform custody** was rejected because it directly contradicts ADR-002 and
would make GreenPay a money transmitter in most jurisdictions it operates in,
with registration, sanctions screening, transaction monitoring, SAR filing and
record-retention duties attached. It would also make a backend compromise a
theft of donor funds rather than a defacement.

**Managed keys** was rejected for the same reason wearing a thinner disguise. A
platform that can sign for a donor *is* a custodian, whatever the marketing
copy says. It is arguably worse than holding funds, because it holds funds
*and* denies doing so.

**A faucet** was rejected because giving away spendable XLM to anonymous callers
is a faucet with a climate logo on it — the funds are gone, not locked, and the
economics fail at the first script. Sponsored reserves have the crucial property
that the platform's XLM is **immobilised, not spent**: an attacker can grief the
treasury but cannot extract a stroop of it. That difference is what makes the
sponsored path viable at all, and it is why the economics were prototyped before
any UI was written (see [docs/sponsorship-economics.md](../sponsorship-economics.md)).

## Positive Consequences

- A donor with no wallet and no XLM can complete a donation. The platform holds
  neither their keys nor their funds at any point.
- The pre-existing flow is untouched and covered by explicit regression tests
  that assert its copy, its branches and its network behaviour are unchanged.
- Reserve cost is modelled in integer stroops from one module, so the quote a
  donor is shown and the capacity the treasury enforces cannot drift apart.
- An attacker's best outcome against the sponsorship path is temporary reserve
  immobilisation, bounded by per-IP, per-session, per-hour, per-day and treasury
  limits, and fully recoverable.
- The compliance split with any fiat provider is encoded, versioned and
  test-enforced rather than living in a document nobody re-reads.
- Conversion is instrumented on every path, including the pre-change one, so the
  change can be judged against a real baseline.

## Negative Consequences

These are real and are stated to donors rather than minimised.

- **A browser-held key can be lost, and no one can recover it.** Clearing site
  data destroys it. This is disclosed before the account is created, with an
  export prompt and a free upgrade path, but it remains the sharpest edge of the
  design.
- **Sponsored reserves are locked capital.** 1 XLM per account, immobilised
  until revoked. A treasury at its floor stops sponsoring, which means the
  cheapest denial-of-service against this feature is to request many accounts.
  The limits bound it; they do not eliminate it.
- **Revocation is conditional.** `revokeAccountSponsorship` only succeeds if the
  account can then meet its own minimum balance. An empty, idle sponsored
  account cannot be released, so some reserve stays locked until the donor
  merges or funds the account. The reclaim job reports this honestly rather than
  retrying into a failure.
- **Sponsored accounts are capped** (250 XLM per donation, 1000 XLM lifetime by
  default). A generous first-time donor will hit a limit and be asked to bring a
  real wallet.
- **The leaderboard does not follow an upgrade immediately.** Donation history
  and profile totals resolve through the address link at read time; the all-time
  leaderboard is a projection and keeps ranking the starter address until it is
  rebuilt. Stated up front on the upgrade screen.
- **Offline mobile sessions are under-counted** in the funnel, because telemetry
  is deliberately silent on an offline device (see
  [docs/onboarding-funnel.md](../onboarding-funnel.md)).

## The laundering surface, assessed

Sponsored account creation builds a rail: the platform helps an anonymous party
bring an account into existence. If that account could then move arbitrary value
to an arbitrary address, GreenPay would have built a funding channel with its own
name on it.

The control is **destination, not identity**. The platform cannot know who a
pseudonymous donor is, and pretending otherwise would be theatre. What it can
enforce with certainty is where the value goes:

- A sponsored account may only pay a **verified project wallet**. Enforced in
  `backend/src/routes/donations.js` at record time.
- Per-donation and lifetime caps bound throughput.
- Every sponsorship is attributable to the funnel session that requested it.
- The sponsored account never receives platform funds — only its reserve is
  sponsored, and a reserve cannot be spent or transferred by the account holder.

Value that can only ever reach a verified climate project, in bounded amounts,
from an account that never received platform funds, is not a laundering channel
however anonymous its source. The residual risk is reputational rather than
financial: a bad actor could donate tainted funds to a real project, which is a
risk the platform already carries for every donor and which sponsorship does not
increase.

## Compliance

GreenPay never takes fiat. Every fiat path is a SEP-24 handoff to a licensed
anchor that performs its own KYC and holds the money. The full obligation split
— which duties sit with the provider, which with the platform, and which are
shared — is encoded in `backend/src/services/onboarding/onramp.js`, validated at
module load, asserted by tests, and documented in
[docs/onramp-compliance.md](../onramp-compliance.md). Obligations that cannot be
delegated (consumer disclosures, donor support) are listed explicitly and a
provider entry that tries to delegate them fails validation.

Providers ship **disabled**. Configuration alone cannot enable one; the registry
entry is where the compliance review is recorded.

## Links

- [ADR-002: Why Direct-to-Wallet Payments Over Platform Custody](ADR-002-why-direct-to-wallet-payments-over-platform-custody.md)
- [ADR-003: Authentication Approach — Wallet as Identity](ADR-003-authentication-approach-wallet-as-identity.md)
- [docs/sponsorship-economics.md](../sponsorship-economics.md) — per-account cost, treasury capacity, abuse limits, recovery
- [docs/onramp-compliance.md](../onramp-compliance.md) — the obligation matrix
- [docs/onboarding-funnel.md](../onboarding-funnel.md) — stages, baseline, measurement
- [CAP-33: Sponsored Reserves](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0033.md)
- [CAP-23: Claimable Balances](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0023.md)
- [SEP-24: Hosted Deposit and Withdrawal](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)
