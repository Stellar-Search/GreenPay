# Sponsorship Economics

Per-account cost, treasury capacity, abuse limits, and the recovery path for
locked reserves.

This was modelled and tested **before** any onboarding UI was written, because
the numbers decide whether the approach is viable at all — a per-account cost
that made the treasury run dry in a day would have ruled the whole design out,
and that is better discovered in a spreadsheet than in production. The model
lives in `backend/src/services/onboarding/reserveAccounting.js` and every
consumer — policy, API, UI copy, this document — reads from it. There is no
second copy of the arithmetic.

## Why reserves and not a faucet

The critical property is that a sponsored reserve is **locked, not spent**.

| | Faucet (give XLM) | Sponsorship (lock reserve) |
|---|---|---|
| Attacker gains | Spendable XLM | Nothing |
| Platform loses | The XLM, permanently | Use of the XLM, temporarily |
| Recoverable | No | Yes, by revoking |
| Worst case | Treasury drained | Treasury immobilised |

An attacker who requests ten thousand sponsored accounts cannot extract a single
stroop. They can immobilise reserve, which is griefing, and the limits below
bound how much. That asymmetry is the reason this approach is viable and a
faucet is not.

## Per-account cost

An account's minimum balance is:

```
(2 + numSubEntries + numSponsoring - numSponsored) × baseReserve
```

`numSponsored` **subtracts**. That is the whole mechanism: an account whose two
base entries are sponsored has a minimum balance of zero and can spend its
entire balance.

At today's base reserve of 0.5 XLM:

| What is sponsored | Entries | Locked | Notes |
|---|---|---|---|
| Bare account | 2 | **1.0000000 XLM** | The default path |
| Account + trustline | 3 | 1.5000000 XLM | Donor gives in USDC |
| Account + claimable balance | 4 | 2.0000000 XLM | On-ramp delivery path |

The base reserve is a network parameter changeable by validator vote, so it is a
named constant rather than a literal. A vote doubling it doubles every quote
automatically; `reserveAccounting.test.js` asserts this rather than trusting it.

### What is actually spent

Reserves come back. Fees do not:

| | Operations | Cost |
|---|---|---|
| Creation | 3 (`begin` / `createAccount` / `end`) | 300 stroops |
| Reclaim | 1 (`revokeAccountSponsorship`) | 100 stroops |
| **Total unrecoverable** | | **0.0000400 XLM** |

So the true marginal cost of onboarding a donor is four thousandths of a cent.
The 1 XLM is working capital, not expenditure.

## Treasury capacity

The treasury must keep its own minimum balance *and* an operating buffer; only
the remainder can be locked behind donors.

```
treasuryMinimum = 2 × baseReserve + (activeSponsorships × perAccountCost)
lockable        = balance - treasuryMinimum - buffer
capacity        = lockable / perAccountCost
```

Sponsoring raises `numSponsoring` on the sponsor, which raises the sponsor's own
floor. Missing that term is how a treasury wedges below its minimum and can no
longer afford the 100-stroop fee to revoke the sponsorships that would free its
funds. `SPONSORSHIP_TREASURY_FLOOR_ACCOUNTS` (default 20) exists precisely to
keep that from happening: sponsorship stops while fewer than that many
sponsorships' worth of lockable balance remain.

Worked examples, bare accounts, no buffer:

| Treasury | Capacity |
|---|---|
| 101 XLM | 100 donors |
| 1,001 XLM | 1,000 donors |
| 10,001 XLM | 10,000 donors |

Rule of thumb: **1 XLM of treasury per concurrently-sponsored donor**, plus the
floor. A treasury sized for a month of expected first-time donors, plus the
20-account floor, plus the sweep reclaiming idle accounts after 30 days, is a
stable steady state.

## Abuse limits

Defaults are deliberately conservative. A limit that is too tight costs a donor
"try again tomorrow"; one that is too loose costs a treasury that cannot serve
anybody.

| Limit | Default | Env var | Stops |
|---|---|---|---|
| Per source address, per day | 3 | `SPONSORSHIP_PER_IP_DAILY` | Casual scripted abuse |
| Per onboarding session | 1 | `SPONSORSHIP_PER_SESSION_TOTAL` | Accidental duplicates |
| Global, per hour | 60 | `SPONSORSHIP_GLOBAL_HOURLY` | A burst, before the daily cap notices |
| Global, per day | 500 | `SPONSORSHIP_GLOBAL_DAILY` | Sustained distributed abuse |
| Treasury floor | 20 accounts | `SPONSORSHIP_TREASURY_FLOOR_ACCOUNTS` | Wedging below the revoke fee |
| Per-donation cap | 250 XLM | `SPONSORSHIP_MAX_DONATION_XLM` | Value throughput |
| Lifetime cap | 1000 XLM | `SPONSORSHIP_MAX_LIFETIME_XLM` | Value throughput |
| Idle reclaim | 30 days | `SPONSORSHIP_RECLAIM_IDLE_DAYS` | Reserve locked for nothing |

Source addresses are stored **hashed and salted** per deployment
(`ONBOARDING_IP_HASH_SALT`), not in the clear. The rate-limit table is a rate
limiter, not an IP log.

### The race that matters

Capacity is decided under a Postgres advisory lock
(`pg_advisory_xact_lock('greenpay_sponsorship')`) inside the same transaction
that writes the row. Without it, the read-decide-write is a textbook TOCTOU: two
simultaneous requests both read "one slot left" and both take it, oversubscribing
the treasury.

Capacity is held in `reserved_stroops` from the moment it is committed and only
becomes `locked_stroops` when the ledger confirms. Failure, abandonment, and
expiry all release it through one code path (`releaseCapacity`), so "an
abandoned donation leaves no partial state" is one function rather than a promise
repeated at four call sites.

## Recovery: getting the XLM back

`revokeAccountSponsorship` hands the reserve requirement back to the account,
which **only succeeds if the account can then meet its own minimum balance**.
That is a protocol constraint, not an implementation choice, and it produces
three honest outcomes:

| Account state | Outcome |
|---|---|
| Funded ≥ 1 XLM | Revoked. Reserve returns to the treasury. |
| Empty or under-funded | **Cannot be revoked.** Reported to the operator with the exact shortfall, rather than retried into a guaranteed failure. |
| Merged away by the donor | Reserve already returned automatically when the entry was removed. Marked reclaimed. |

The second row is a genuine limitation, not a bug: an empty sponsored account
holds locked reserve that cannot be released until the donor funds or merges it.
The mitigations are the idle-reclaim sweep (which catches accounts that were
funded and then abandoned), the treasury floor (which keeps the platform
solvent regardless), and the caps (which bound how much can accumulate).

Failed revocations increment `reclaim_failures` and raise a **critical** signal:
reserve that is not coming back is the one failure mode that silently erodes the
treasury.

## Monitoring

`GET /api/v1/onboarding/sponsorship/ledger` (admin) returns the reserve position
and any active signals. None of these is proof of abuse on its own — they are the
shapes that distinguish an attack from a good week.

| Signal | Severity | Means |
|---|---|---|
| `LOW_SPONSORSHIP_CONVERSION` | warning | Fewer than 1 in 5 sponsored accounts donated. Reserve is being locked without donations arriving — most likely automated requests. |
| `SPONSORSHIP_IP_CONCENTRATION` | warning | A handful of sources account for most sponsorships. |
| `TREASURY_LOW` | warning / critical | Approaching the floor; sponsorship will start refusing. |
| `RECLAIM_FAILING` | critical | Revocation is failing; locked reserve is not returning. |

The conversion signal deliberately stays quiet below 10 accounts. Two accounts
and no donations is a Tuesday, not an attack.

## Operating

```bash
# Enable sponsorship (unset = the whole path is simply not offered)
SPONSOR_SECRET_KEY=S...

# Reserve position and signals
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.example/api/v1/onboarding/sponsorship/ledger

# Reclaim one sponsorship
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.example/api/v1/onboarding/sponsorship/$ID/reclaim
```

Leaving `SPONSOR_SECRET_KEY` unset disables sponsorship entirely. Every other
flow, including the pre-existing connected-wallet donation, is unaffected — the
paths endpoint reports the sponsored option as unavailable with a reason, and
the UI says so instead of dead-ending.

## See also

- [ADR-005](adr/ADR-005-graduated-non-custodial-donor-onboarding.md) — the decision and the rejected alternatives
- [docs/onramp-compliance.md](onramp-compliance.md) — the fiat obligation split
- [docs/onboarding-funnel.md](onboarding-funnel.md) — measuring whether any of this worked
