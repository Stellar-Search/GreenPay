# Contract Money-Path Invariants

Plain-language properties that must hold for **every** valid input sequence across
GreenPay, Escrow, and DAO Governance. Review this document before encoding any
property test; if an invariant here is wrong, fix the spec before fixing the test.

Multilingual strategy for off-chain search (issue #500) is documented separately in
`backend/docs/project-search.md`. On-chain contracts operate on stroops and addresses
only.

---

## GreenPay Donation Contract

### Conservation

1. **Global total equals sum of project totals.** After any sequence of successful
   `donate` calls, `get_global_total()` equals the sum of every registered project's
   `total_raised`.

2. **Project total equals sum of donations to that project.** Each project's
   `total_raised` equals the sum of all successful donation amounts applied to it.

3. **No phantom funds.** Tokens transferred out of a donor wallet via `donate` are
   exactly reflected in project/global counters before the external transfer completes
   (CEI ordering).

### Monotonicity and bounds

4. **Totals are non-negative.** `total_raised`, `get_global_total()`, and donor
   `total_donated` never decrease on successful donations.

5. **Donation count is monotonic.** `get_donation_count()` increases by exactly one
   per successful `donate`.

6. **Unique donor count is correct.** A project's `donor_count` equals the number of
   distinct donor addresses that have donated to it.

### CO₂ arithmetic (fixed-point)

7. **CO₂ increment is truncating division.** Per donation,
   `co2_added = (amount / STROOP) * co2_per_xlm` — fractional XLM below one stroop
   unit does not accrue CO₂.

8. **Global CO₂ equals sum of per-donation increments.** `get_global_co2()` equals
   the sum of CO₂ increments from every successful donation.

9. **CO₂ registration ceiling.** Projects cannot be registered with
   `co2_per_xlm > MAX_CO2_PER_XLM`.

10. **Overflow rolls back.** If any checked arithmetic in `donate` would overflow,
    the entire donation fails and no counters or transfers occur.

---

## Escrow Contract

### Conservation

1. **Released never exceeds held.** At all times while a job exists,
   `0 <= remaining_amount <= amount` (original escrow).

2. **Funds are accounted for.** For any terminal job state (Released, Refunded),
   `(amount - remaining_amount)` equals the sum of all token transfers out of the
   contract for that job.

3. **Partial releases are additive.** A sequence of `release_partial` calls that
   fully releases a job sends exactly `amount` stroops to the freelancer in total.

4. **Dispute resolution is total.** `resolve_dispute` transfers exactly
   `remaining_amount` to either the client or the freelancer, leaving zero remaining.

5. **Stale dispute split is exact.** `resolve_stale_dispute` splits
   `remaining_amount` into `freelancer_share = remaining / 2` and
   `client_share = remaining - freelancer_share` (odd stroop goes to client).

6. **Cancellation returns remainder.** `cancel_job` refunds exactly
   `remaining_amount` to the client.

### State machine

7. **Terminal states are absorbing.** Once Released or Refunded, no further release,
   dispute, or cancel succeeds.

8. **Dispute freezes releases.** While Disputed, `release_escrow` and `release_partial`
   fail.

---

## DAO Governance Contract

### Token conservation

1. **Total locked equals active locks.** `get_total_locked()` equals the sum of
   `Lock.amount` for every voter with a non-expired lock.

2. **Lock then withdraw is round-trip.** Locking `amount` and withdrawing after
   expiry returns exactly `amount` tokens to the voter; `get_total_locked()` returns
   to its pre-lock value.

3. **Re-lock replaces prior lock.** A second `lock_tokens` from the same voter
   replaces the prior lock; total locked adjusts by the delta, not double-counted.

4. **Withdraw only after expiry.** `withdraw` before `unlock_ledger` fails and leaves
   total locked unchanged.

### Voting power

5. **Voting power is non-negative.** `get_voting_power` never returns a negative
   value.

6. **Checkpoints are immutable.** A snapshot taken at ledger L uses checkpoint records
   with `effective_from_ledger <= L`; later `extend_lock` cannot retroactively
   increase power at L.

---

## Test Profiles

| Profile | `PROPTEST_CASES` | Where | Purpose |
|---------|------------------|-------|---------|
| Fast    | 32 (default)     | CI on every PR | Smoke property coverage |
| Deep    | 2000             | Nightly scheduled workflow | Exploration & shrinking |

Property tests generate **operation sequences** (not isolated calls) for escrow and
GreenPay donation paths. Failures are shrunk by `proptest` and saved under
`proptest-regressions/` as regression seeds.
