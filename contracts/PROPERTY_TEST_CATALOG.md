# Property test catalog

This document maps each money-path invariant in `INVARIANTS.md` to the
property-based test that encodes it. Use it when adding new contract logic or
when triaging a proptest regression seed.

## Running property tests

```bash
cd contracts

# Fast CI profile (32 cases, single-threaded)
PROPTEST_CASES=32 cargo test --features testutils property -- --test-threads=1

# Deep nightly profile
PROPTEST_CASES=2000 cargo test --features testutils property -- --test-threads=1
```

Regression seeds live under `*/proptest-regressions/` — commit updated seeds
when a shrink finds a new minimal counterexample.

---

## GreenPay (`greenpay-contract`)

| Invariant | Test module | Property / regression |
|-----------|-------------|------------------------|
| Global total equals sum of donations | `fuzz_tests` | `prop_realistic_co2_and_amount_no_overflow` |
| Multi-project totals conserved | `fuzz_tests` | `prop_multi_project_global_total` |
| Badge rank never decreases | `fuzz_tests`, `badge_property_tests` | `prop_badge_monotonic`, `prop_badge_rank_monotonic` |
| CO₂ truncation at stroop boundary | `fuzz_tests` | `prop_co2_truncates_at_stroop_boundary` |
| Overflow on pathological amount rolls back | `fuzz_tests`, `overflow_property_tests` | `prop_try_donate_max_rejected`, `regression_i128_max_donation_rejected_or_rollback` |
| Donation count increments per success | `overflow_property_tests` | `prop_donation_count_increments` |
| Global total equals sum in sequences | `overflow_property_tests` | `prop_global_total_equals_sum` |
| CO₂ accumulators stay non-negative | `overflow_property_tests` | `prop_co2_non_negative` |
| One NFT per tier per donor | `badge_property_tests` | `prop_at_most_one_nft_per_tier` |
| NFT transfer updates owner | `badge_property_tests` | `prop_nft_transfer_updates_owner` |
| balance_of bounded by minted tiers | `badge_property_tests` | `prop_balance_of_matches_minted_tiers` |

### Known limits

- `prop_many_small_donations` caps sequence length at **16** — longer sequences
  segfault in the Soroban test harness.
- Run GreenPay fuzz/property tests with `--test-threads=1`.

---

## Escrow (`escrow-contract`)

| Invariant | Test module | Property / regression |
|-----------|-------------|------------------------|
| Released + remaining = deposit | `property_tests` | `prop_partial_release_conserves_funds` |
| Full release zeros remaining | `property_tests` | `prop_full_release_zeros_balance` |
| Dispute blocks release until resolved | `property_tests` | `prop_dispute_blocks_release_until_resolved` |
| Admin resolve restores releasable balance | `property_tests` | `prop_admin_resolve_restores_release` |
| Cancel returns funds to depositor | `property_tests` | `prop_cancel_returns_to_depositor` |
| Odd stroop amounts in stale dispute | `property_tests` | `prop_stale_dispute_odd_stroops` |
| Partial release overflow rejected | `property_tests` | `prop_partial_release_overflow_rejected` |

---

## DAO Governance (`dao-governance-contract`)

| Invariant | Test module | Property / regression |
|-----------|-------------|------------------------|
| total_locked matches active lock | `property_tests` | `prop_total_locked_matches_active_lock` |
| Voting power ≥ 0 | `property_tests` | `prop_voting_power_non_negative` |
| Relock after expiry succeeds | `property_tests` | `prop_relock_after_expiry` |
| Lock overflow rejected | `property_tests` | `prop_lock_overflow_rejected` |
| Proposal IDs monotonic | `governance_property_tests` | `prop_proposal_ids_monotonic` |
| Vote tallies bounded by cast power | `governance_property_tests` | `prop_vote_tallies_bounded_by_cast_power` |
| Quorum frozen at snapshot | `governance_property_tests` | `prop_quorum_frozen_at_snapshot` |
| Unanimous approval → Execution | `governance_property_tests` | `prop_unanimous_approval_reaches_execution` |
| Majority against → Defeated | `governance_property_tests` | `prop_majority_against_defeats_proposal` |

### Ledger TTL notes

When advancing ledger sequence in DAO tests, extend TTL on the governance and
GP token contracts via `env.as_contract` to avoid storage expiry panics.

---

## Coverage

Money-path line coverage is collected by:

```bash
./contracts/scripts/money-path-coverage.sh
```

Deep property runs are scheduled in `.github/workflows/contracts-property-deep.yml`.

---

## Adding a new property test

1. State the invariant in plain language in `INVARIANTS.md`.
2. Add a `proptest!` block or regression `#[test]` in the appropriate
   `*_property_tests.rs` module.
3. Register the module in the contract's `lib.rs` under
   `#[cfg(all(test, feature = "testutils"))]`.
4. Run locally with `PROPTEST_CASES=32` and `--test-threads=1`.
5. If proptest writes a regression file, commit it under `proptest-regressions/`.
6. Update this catalog with the invariant → test mapping.
